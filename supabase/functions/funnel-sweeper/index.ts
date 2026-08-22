// O `tsconfig.json` da raiz (lib DOM, do Vite) é lido pelo Deno e apaga `deno.ns`.
/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { pickAlternatives } from "../_shared/lead-contact.ts";
import { sendWhatsText } from "../_shared/evolution-send.ts";
import {
  evaluateCommercialSuppression,
  loadCommercialContactFacts,
  reconcileSuppressedLead,
} from "../_shared/commercial-contact-policy.ts";
import {
  loadTenantWhatsAppRoute,
  resolveTenantCommunicationIdentity,
  safeCommunicationText,
  type TenantCommunicationIdentity,
} from "../_shared/tenant-communication.ts";
import { loadOpportunityDispatchGuard } from "../_shared/opportunity-dispatch.ts";

// FUNNEL-SWEEPER — cron a cada 15 min. Três varreduras anti-vazamento do funil de alunos:
//
// A) PRIMEIRO TOQUE: leads NEW que nunca receberam NADA da IA. Dedup por TELEFONE (não
//    lead.id) — dois leads duplicados do mesmo número NÃO disparam 2 boas-vindas (foi a
//    causa da restrição do número).
// B) ESCALONAMENTO DE CLAIM: oportunidade TRIAL OPEN sem aceite. >20min re-envia aos
//    professores ATIVOS (individual); >60min alerta ao diretor.
// C) EXPIRAÇÃO: OPEN >48h ou slot no passado → LOST (silencioso).
// D) CONVITE DE ENTREVISTA (RH): aprovados recebem link de agendamento + follow-ups.
//
// Dedupe: automation_sent com verificação "ever" — cada lead/opp recebe cada tipo UMA vez.

const EVOLUTION_API_URL = "https://api.2b.app.br";
const EVOLUTION_KEYS = Array.from(
  new Set([
    (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
  ].filter(Boolean)),
);
const DAY_MAP: Record<number, string> = {
  1: "Segunda",
  2: "Terça",
  3: "Quarta",
  4: "Quinta",
  5: "Sexta",
  6: "Sábado",
  0: "Domingo",
};
const dowOf = (dateStr: string): number =>
  new Date(`${dateStr}T12:00:00Z`).getUTCDay();
// Anti-ban: primeiro contato frio é o maior risco de restrição do número. Volume baixo e
// espaçado (o número já foi restringido uma vez). Lote pequeno por run + teto diário menor.
const FIRST_TOUCH_BATCH = 2;
const FIRST_TOUCH_DAILY_CAP = 12;
const INTERVIEW_INVITE_DAILY_CAP = 5;
// Retorno ao lead cuja experimental não teve professor. Cabe mais volume que o
// primeiro toque (é gente que JÁ conversou com a escola, não contato frio),
// mas segue com teto — o número já foi restringido uma vez.
const ORPHAN_LEAD_DAILY_CAP = 15;

// Professor inativo (suspenso/desligado) NUNCA recebe convite de experimental —
// mesma regra do is_teacher_notifiable. lifecycle_status é a fonte de verdade.
const INACTIVE_STATUS = [
  "Inativo",
  "INACTIVE",
  "Inactive",
  "Arquivado",
  "Cancelado",
  "Trancado",
];

// Resolução de JID + envio vivem em `_shared/evolution-send.ts` — o
// `sdr-followups` e o `whatsapp-inbound` precisam exatamente do mesmo
// comportamento (DDD antigo registrado sem o 9º dígito).
async function sendWhats(
  instance: string,
  number: string,
  text: string,
): Promise<boolean> {
  return await sendWhatsText({
    base: EVOLUTION_API_URL,
    keys: EVOLUTION_KEYS,
    instance,
    to: number,
    text,
  });
}

const nowBRT = () => new Date(Date.now() - 3 * 3600 * 1000);
const todayBRT = () => nowBRT().toISOString().split("T")[0];
const hhmmBRT = () => nowBRT().toISOString().split("T")[1].slice(0, 5);

function cleanPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}

function phonesMatch(a: string, b: string): boolean {
  const ca = (a || "").replace(/\D/g, "");
  const cb = (b || "").replace(/\D/g, "");
  if (!ca || !cb || ca.length < 8 || cb.length < 8) return false;
  if (ca.slice(-8) !== cb.slice(-8)) return false;
  const dddA = ca.slice(0, -8).replace(/^55/, "").replace(/9$/, "").slice(-2);
  const dddB = cb.slice(0, -8).replace(/^55/, "").replace(/9$/, "").slice(-2);
  return !dddA || !dddB || dddA === dddB;
}

async function sentEver(
  sb: any,
  kind: string,
  subjectId: string,
): Promise<boolean> {
  const { data } = await sb.from("automation_sent").select("id").eq(
    "kind",
    kind,
  ).eq("subject_id", subjectId).limit(1);
  return !!(data && data.length);
}
async function claim(
  sb: any,
  kind: string,
  subjectId: string,
): Promise<{ ok: boolean; undo: () => Promise<void> }> {
  if (await sentEver(sb, kind, subjectId)) {
    return { ok: false, undo: async () => {} };
  }
  const { error } = await sb.from("automation_sent").insert({
    kind,
    subject_id: subjectId,
    ref_date: todayBRT(),
  });
  if (error) return { ok: false, undo: async () => {} };
  return {
    ok: true,
    undo: async () => {
      await sb.from("automation_sent").delete().eq("kind", kind).eq(
        "subject_id",
        subjectId,
      ).eq("ref_date", todayBRT());
    },
  };
}
function greetName(raw: string | null): string {
  const first = (raw || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$/.test(first)
    ? first.charAt(0).toUpperCase() + first.slice(1)
    : "";
}

function isServiceRole(bearer: string, serviceKey: string): boolean {
  return Boolean(serviceKey && bearer === serviceKey);
}

// Telefones dos professores ATIVOS de um tenant (cache por execução).
const _activeTeacherCache: Record<string, string[]> = {};
async function activeTeacherPhones(
  sb: any,
  tenantId: string,
): Promise<string[]> {
  if (tenantId in _activeTeacherCache) return _activeTeacherCache[tenantId];
  const { data: memberships } = await sb.from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", tenantId).eq("role", "TEACHER").eq("status", "ACTIVE");
  const userIds = (memberships || []).map((row: any) => row.user_id).filter(
    Boolean,
  );
  const { data } = userIds.length
    ? await sb.from("profiles")
      .select("id, phone, status")
      .in("id", userIds).eq("lifecycle_status", "active")
    : { data: [] };
  const phones = (data || [])
    .filter((x: any) => !INACTIVE_STATUS.includes(x.status || ""))
    .map((x: any) => cleanPhone(x.phone || ""))
    .filter((p: string) => p.length >= 12);
  _activeTeacherCache[tenantId] = phones;
  return phones;
}

serve(async (req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const bearer = (req.headers.get("Authorization") || "").replace(
      "Bearer ",
      "",
    ).trim();
    if (!isServiceRole(bearer, serviceKey)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
      });
    }
    const sb = createClient(url, serviceKey);

    const hourBRT = nowBRT().getUTCHours();
    const businessHours = hourBRT >= 9 && hourBRT < 20;

    const result = {
      first_touch: 0,
      first_touch_skipped: 0,
      first_touch_suppressed: 0,
      rebroadcasts: 0,
      director_alerts: 0,
      interview_invites: 0,
      interview_followups: 0,
      expired: 0,
      orphan_leads: 0,
      orphan_skipped: 0,
      failures: [] as string[],
    };

    const { data: tenants, error: tenantsError } = await sb.from("tenants")
      .select(
        "id,name,domain,slug,custom_domain,custom_domain_verified,branding,school_info,saas_status,talent_group_link,whatsapp_enabled,ai_team_config",
      );
    if (tenantsError) throw new Error("tenant_runtime_lookup_failed");
    const tenantRows = new Map<string, any>();
    const byTenant: Record<string, {
      centralInstance: string;
      studentInstance: string | null;
      teacherInstance: string | null;
      ownerPhone: string;
      identity: TenantCommunicationIdentity;
    }> = {};
    for (const tenant of (tenants || [])) {
      const tenantId = String(tenant.id || "");
      const identity = resolveTenantCommunicationIdentity(tenant, tenantId);
      if (!identity) continue;
      tenantRows.set(tenantId, tenant);
      try {
        const [route, studentRoute, teacherRoute] = await Promise.all([
          loadTenantWhatsAppRoute(sb, tenantId),
          loadTenantWhatsAppRoute(sb, tenantId, "student"),
          loadTenantWhatsAppRoute(sb, tenantId, "teacher"),
        ]);
        if (!route) continue;
        byTenant[tenantId] = {
          centralInstance: route.instanceName,
          studentInstance: studentRoute?.instanceName || null,
          teacherInstance: teacherRoute?.instanceName || null,
          ownerPhone: route.ownerPhone || "",
          identity,
        };
      } catch (error) {
        result.failures.push(
          `whatsapp_route ${tenantId}: ${(error as Error).message}`,
        );
      }
    }
    const cfgOf = (tenantId: string) =>
      tenantRows.get(tenantId)?.ai_team_config || {};
    const commercialFacts = new Map<string, any>();
    for (const tenantId of Object.keys(byTenant)) {
      try {
        commercialFacts.set(
          tenantId,
          await loadCommercialContactFacts(sb, tenantId),
        );
      } catch (e) {
        result.failures.push(
          `commercial_state ${tenantId}: ${(e as Error).message}`,
        );
      }
    }

    const { data: allApps } = await sb.from("job_applications").select(
      "tenant_id, whatsapp",
    );
    const isCandidatePhone = (tenantId: string, phone: string) =>
      (allApps || []).some((a: any) =>
        a.tenant_id === tenantId && phonesMatch(a.whatsapp, phone)
      );

    // ============ A) PRIMEIRO TOQUE ============
    if (businessHours) {
      const { count: sentToday } = await sb.from("automation_sent")
        .select("id", { count: "exact", head: true })
        .eq("kind", "SDR_FIRST_TOUCH").eq("ref_date", todayBRT());
      const remainingToday = Math.max(
        0,
        FIRST_TOUCH_DAILY_CAP - (sentToday ?? 0),
      );

      const { data: leads } = await sb.from("crm_leads")
        .select(
          "id, tenant_id, name, phone, status, source, created_at, ai_handled, ai_handoff, last_outbound_at",
        )
        .eq("status", "NEW").eq("ai_handoff", false)
        .or("ai_handled.is.null,ai_handled.eq.false,last_outbound_at.is.null")
        .order("created_at", { ascending: false })
        .limit(80);

      for (const lead of (leads || [])) {
        if (result.first_touch >= Math.min(FIRST_TOUCH_BATCH, remainingToday)) {
          break;
        }
        const t = byTenant[lead.tenant_id];
        const cfg = cfgOf(lead.tenant_id);
        if (
          !t?.studentInstance || cfg?.sdr?.enabled === false ||
          cfg?.sdr?.first_touch === false
        ) continue;
        const facts = commercialFacts.get(lead.tenant_id);
        if (!facts) {
          result.first_touch_skipped++;
          continue;
        }
        const suppression = evaluateCommercialSuppression({
          tenantId: lead.tenant_id,
          phone: lead.phone,
          name: lead.name,
          leadStatus: lead.status,
        }, facts);
        if (suppression.suppressed) {
          await reconcileSuppressedLead(sb, lead.id, suppression);
          result.first_touch_suppressed++;
          continue;
        }
        const phone = cleanPhone(lead.phone || "");
        if (phone.length < 12) {
          result.first_touch_skipped++;
          continue;
        }
        if (isCandidatePhone(lead.tenant_id, lead.phone || "")) {
          result.first_touch_skipped++;
          continue;
        }

        // Dedup por TELEFONE (não lead.id): mesmo com leads duplicados, o número recebe o
        // primeiro-toque UMA vez na vida. Foi a boas-vindas duplicada que travou o número.
        const c = await claim(sb, "SDR_FIRST_TOUCH", phone);
        if (!c.ok) continue;

        const configuredSdrName = safeCommunicationText(
          cfg?.agents?.atendente?.name,
          80,
        );
        const sdrName = configuredSdrName || "a equipe de atendimento";
        const first = greetName(lead.name);
        const isFresh =
          new Date(lead.created_at).getTime() > Date.now() - 72 * 3600 * 1000;
        const msg = isFresh
          ? `Oi${
            first ? ", " + first : ""
          }! Aqui é ${sdrName}, da ${t.identity.brandName} 😊 Vi seu interesse nas nossas aulas de inglês. Quer marcar uma aula experimental gratuita? Me conta rapidinho: o inglês é pra trabalho, viagem ou outro objetivo?`
          : `Oi${
            first ? ", " + first : ""
          }! Aqui é ${sdrName}, da ${t.identity.brandName} 😊 Você deixou seu contato interessado(a) nas nossas aulas de inglês e eu não queria te deixar sem retorno. Ainda faz sentido pra você? A primeira aula é experimental e gratuita — é só me responder por aqui!`;

        if (await sendWhats(t.studentInstance, phone, msg)) {
          await sb.from("crm_leads").update({
            ai_handled: true,
            last_outbound_at: new Date().toISOString(),
          }).eq("id", lead.id);
          await sb.from("ai_wa_messages").insert({
            tenant_id: lead.tenant_id,
            phone,
            agent: "sdr",
            direction: "out",
            content: msg,
            meta: {
              lead_id: lead.id,
              kind: "first_touch",
              source: lead.source || null,
            },
          });
          result.first_touch++;
        } else {
          await c.undo();
          result.failures.push(`first_touch ${lead.id}`);
        }
      }
    }

    // ============ D) CONVITE + FOLLOW-UP DE ENTREVISTA (RH) ============
    if (businessHours) {
      const { count: invitesToday } = await sb.from("automation_sent")
        .select("id", { count: "exact", head: true })
        .eq("kind", "INTERVIEW_INVITE").eq("ref_date", todayBRT());
      let inviteBudget = Math.max(
        0,
        INTERVIEW_INVITE_DAILY_CAP - (invitesToday ?? 0),
      );

      const { data: cands } = await sb.from("job_applications")
        .select("id, tenant_id, name, whatsapp, booking_token, status")
        .eq("ai_recommendation", "ENTREVISTAR").is("interview_slot", null)
        .not("status", "in", "(Contratado,Rejeitado,Entrevistado)")
        .order("created_at", { ascending: true });

      const { data: rhMarks } = await sb.from("automation_sent")
        .select("kind, subject_id, created_at").in("kind", [
          "INTERVIEW_INVITE",
          "INTERVIEW_INVITE_FU1",
          "INTERVIEW_INVITE_FU2",
        ]);
      const markAt = (kind: string, id: string) =>
        (rhMarks || []).find((m: any) => m.kind === kind && m.subject_id === id)
          ?.created_at || null;

      for (const cand of (cands || [])) {
        const t = byTenant[cand.tenant_id];
        const cfg = cfgOf(cand.tenant_id);
        if (
          !t?.teacherInstance || cfg?.rh?.enabled === false ||
          cfg?.rh?.interview_invites === false
        ) continue;
        if (!cand.booking_token) continue;
        const phone = cleanPhone(cand.whatsapp || "");
        if (phone.length < 12) continue;
        if (!t.identity.portalUrl) continue;
        const id = String(cand.id);
        const first = greetName(cand.name);
        const link =
          `${t.identity.portalUrl}/book-interview?t=${cand.booking_token}`;
        const configuredRecruiter = safeCommunicationText(
          cfg?.agents?.recrutadora?.name || cfg?.agents?.rh?.name,
          80,
        );
        const recruiter = configuredRecruiter || "a equipe de recrutamento";

        const invitedAt = markAt("INTERVIEW_INVITE", id);
        if (!invitedAt) {
          if (inviteBudget <= 0) continue;
          const c = await claim(sb, "INTERVIEW_INVITE", id);
          if (!c.ok) continue;
          const msg = `Oi${
            first ? ", " + first : ""
          }! Aqui é ${recruiter}, da ${t.identity.brandName}. Ótima notícia: seu perfil foi aprovado na triagem e a direção quer te conhecer! 🎉 É uma conversa online de ~30 minutos, pelo WhatsApp. Escolha o melhor horário pra você aqui:\n\n${link}\n\nQualquer dúvida, é só me responder 😊`;
          if (await sendWhats(t.teacherInstance, phone, msg)) {
            await sb.from("ai_wa_messages").insert({
              tenant_id: cand.tenant_id,
              phone,
              agent: "rh",
              direction: "out",
              content: msg,
              meta: { application_id: cand.id, kind: "interview_invite" },
            });
            result.interview_invites++;
            inviteBudget--;
          } else {
            await c.undo();
            result.failures.push(`interview_invite ${id}`);
          }
          continue;
        }

        const inviteAgeH = (Date.now() - new Date(invitedAt).getTime()) /
          3600000;
        if (inviteAgeH > 240) continue;

        const fu1At = markAt("INTERVIEW_INVITE_FU1", id);
        if (!fu1At && inviteAgeH >= 24) {
          const c = await claim(sb, "INTERVIEW_INVITE_FU1", id);
          if (!c.ok) continue;
          const msg = `Oi${
            first ? ", " + first : ""
          }! Aqui é ${recruiter}, da ${t.identity.brandName}, novamente 😊 Vi que você ainda não escolheu o horário da sua entrevista com a direção. Os horários da semana estão preenchendo — garanta o seu aqui:\n\n${link}`;
          if (await sendWhats(t.teacherInstance, phone, msg)) {
            result.interview_followups++;
          } else {
            await c.undo();
            result.failures.push(`interview_fu1 ${id}`);
          }
          continue;
        }

        if (
          fu1At && inviteAgeH >= 72 &&
          (Date.now() - new Date(fu1At).getTime()) >= 24 * 3600000 &&
          !markAt("INTERVIEW_INVITE_FU2", id)
        ) {
          const c = await claim(sb, "INTERVIEW_INVITE_FU2", id);
          if (!c.ok) continue;
          const msg = `Oi${
            first ? ", " + first : ""
          }! Última chamada: seu processo na ${t.identity.brandName} está quase lá — falta só agendar a entrevista com a direção:\n\n${link}\n\nSe não fizer mais sentido pra você, sem problemas — me avise que encerro por aqui 😊`;
          if (await sendWhats(t.teacherInstance, phone, msg)) {
            result.interview_followups++;
          } else {
            await c.undo();
            result.failures.push(`interview_fu2 ${id}`);
          }
        }
      }
    }

    // ============ B) ESCALONAMENTO DE CLAIM + C) EXPIRAÇÃO ============
    const cutoff48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const cutoff20m = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const cutoff60m = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { data: expiredCandidates, error: expErr } = await sb.from(
      "opportunities",
    )
      .select("id,tenant_id")
      .eq("status", "OPEN").lt("opened_at", cutoff48h);
    if (expErr) result.failures.push(`expire_bulk: ${expErr.message}`);
    for (const candidate of (expiredCandidates || [])) {
      const dispatchGuard = await loadOpportunityDispatchGuard(
        sb,
        candidate.tenant_id,
        candidate.id,
      );
      if (!dispatchGuard.ok || dispatchGuard.dispatchMode !== "GENERIC") {
        continue;
      }
      const { data: expired, error: expireError } = await sb.from(
        "opportunities",
      )
        .update({ status: "EXPIRED", conversion_status: "LOST" })
        .eq("id", candidate.id).eq("status", "OPEN").select("id");
      if (expireError) {
        result.failures.push(`expire ${candidate.id}: ${expireError.message}`);
      } else {
        result.expired += (expired || []).length;
      }
    }

    const { data: opps } = await sb.from("opportunities")
      .select(
        "id, tenant_id, student_name, student_phone, interests, kind, opened_at, claim_generation, slots_proposed",
      )
      .eq("status", "OPEN").eq("kind", "TRIAL")
      .gte("opened_at", cutoff48h).lt("opened_at", cutoff20m);

    for (const opp of (opps || [])) {
      const dispatchGuard = await loadOpportunityDispatchGuard(
        sb,
        opp.tenant_id,
        opp.id,
      );
      if (!dispatchGuard.ok || dispatchGuard.dispatchMode !== "GENERIC") {
        continue;
      }
      const slot = Array.isArray(opp.slots_proposed)
        ? opp.slots_proposed[0]
        : null;
      if (!slot?.date || !slot?.time) continue;

      const slotPast = slot.date < todayBRT() ||
        (slot.date === todayBRT() && slot.time <= hhmmBRT());
      if (slotPast) {
        const { error: pastErr } = await sb.from("opportunities")
          .update({ status: "EXPIRED", conversion_status: "LOST" }).eq(
            "id",
            opp.id,
          ).eq("status", "OPEN");
        if (pastErr) {
          result.failures.push(`expire_past ${opp.id}: ${pastErr.message}`);
        } else result.expired++;
        continue;
      }

      const t = byTenant[opp.tenant_id];
      if (!t || !businessHours) continue;
      if (!t.identity.portalUrl) continue;

      const formatted = slot.formatted ||
        `${String(slot.date).split("-").reverse().join("/")}`;
      const claimLink = `${t.identity.portalUrl}/claim-opportunity?id=${
        encodeURIComponent(opp.id)
      }&g=${opp.claim_generation}`;
      const roundSubject = `${opp.id}:${opp.claim_generation}`;

      // Degrau 1 (>20min): reenvio individual uma vez por rodada da oportunidade.
      if (!(await sentEver(sb, "OPP_REBROADCAST", roundSubject))) {
        const c1 = await claim(sb, "OPP_REBROADCAST", roundSubject);
        if (c1.ok) {
          const msg =
            `⏳ *Ainda sem professor!* Experimental aguardando aceite:\n\n📅 *${formatted} às ${slot.time}*\n📋 *Aluno:* ${
              opp.student_name || "-"
            }\n🎯 *Objetivo:* ${
              opp.interests || "Não informado"
            }\n\n🏆 O primeiro a clicar garante a aula:\n👇 ${claimLink}`;
          const phones = await activeTeacherPhones(sb, opp.tenant_id);
          let anySent = false;
          if (!t.teacherInstance) {
            await c1.undo();
            continue;
          }
          for (const ph of phones) {
            if (await sendWhats(t.teacherInstance, ph, msg)) anySent = true;
          }
          if (anySent) result.rebroadcasts++;
          else {
            await c1.undo();
            result.failures.push(`rebroadcast ${opp.id}`);
          }
        }
        continue;
      }

      const isOld = opp.opened_at < cutoff60m;
      if (
        isOld && t.ownerPhone.length >= 12 &&
        !(await sentEver(sb, "OPP_DIRECTOR_ALERT", roundSubject))
      ) {
        const c2 = await claim(sb, "OPP_DIRECTOR_ALERT", roundSubject);
        if (c2.ok) {
          const ageMin = Math.round(
            (Date.now() - new Date(opp.opened_at).getTime()) / 60000,
          );
          const msg = `⚠️ *Experimental sem aceite há ${ageMin} min*\n\n📋 *${
            opp.student_name || "-"
          }* — ${formatted} às ${slot.time}\n🎯 ${
            opp.interests || "-"
          }\n📱 Lead: ${
            cleanPhone(opp.student_phone || "") || "-"
          }\n\nNenhum professor pegou (equipe já foi avisada 2x). Vale atribuir manualmente ou falar com o lead.\n${claimLink}`;
          if (await sendWhats(t.centralInstance, t.ownerPhone, msg)) {
            result.director_alerts++;
          } else {
            await c2.undo();
            result.failures.push(`alert ${opp.id}`);
          }
        }
      }
    }

    // ============ C2) LEAD ÓRFÃO — a experimental expirou sem professor ============
    //
    // Medido em 13/08/2026: de 125 experimentais da história, **69 expiraram sem
    // ninguém aceitar** (55%). O lead tinha ouvido "vou verificar o professor e
    // já te confirmo" — e depois disso 18 ficaram em silêncio TOTAL e 16
    // tiveram que cobrar. A escola avisava o diretor aos 60 min e marcava LOST
    // em 48h, mas nunca falava com quem pediu a aula.
    //
    // Esta varredura fecha o circuito: quem ficou sem professor recebe o que a
    // escola de fato tem. É a mensagem mais barata do funil — o interesse já
    // existe, só o horário não deu.
    //
    // ⚠️ Roda separada do momento da expiração de propósito. Expirar às 3h da
    // manhã e mandar mensagem na hora seria pior que não mandar; aqui a
    // oportunidade só é varrida no horário comercial seguinte, e a idempotência
    // (`automation_sent`) garante um único toque por experimental.
    if (businessHours) {
      const { count: orfaosHoje } = await sb.from("automation_sent")
        .select("id", { count: "exact", head: true })
        .eq("kind", "TRIAL_NO_TEACHER").eq("ref_date", todayBRT());
      let restam = Math.max(0, ORPHAN_LEAD_DAILY_CAP - (orfaosHoje ?? 0));

      // Janela de 3 dias: passar disso é remexer em lead frio com uma desculpa
      // velha — e evita que a primeira execução dispare para os 69 do histórico.
      const desde = new Date(Date.now() - 3 * 86400000).toISOString();
      const { data: orfas } = await sb.from("opportunities")
        .select(
          "id, tenant_id, student_name, student_phone, slots_proposed, lost_reason, created_at",
        )
        .eq("kind", "TRIAL").eq("status", "EXPIRED").gte("created_at", desde)
        .order("created_at", { ascending: false }).limit(40);

      for (const opp of (orfas || [])) {
        if (restam <= 0) break;
        // Expirada porque o PRÓPRIO aluno remarcou (supersedeOpenTrials marca o
        // motivo): ele já tem aula com professor. Dizer "não achei professor"
        // aqui seria mentira, e assustaria quem está tudo certo.
        if (opp.lost_reason) {
          result.orphan_skipped++;
          continue;
        }

        const slot = Array.isArray(opp.slots_proposed)
          ? opp.slots_proposed[0]
          : null;
        if (!slot?.date || !slot?.time) {
          result.orphan_skipped++;
          continue;
        }

        const t = byTenant[opp.tenant_id];
        if (
          !t?.studentInstance || cfgOf(opp.tenant_id)?.sdr?.enabled === false
        ) continue;

        const phone = cleanPhone(opp.student_phone || "");
        if (phone.length < 12) {
          result.orphan_skipped++;
          continue;
        }
        if (isCandidatePhone(opp.tenant_id, opp.student_phone || "")) {
          result.orphan_skipped++;
          continue;
        }

        // Conseguiu aula por outro caminho (outra oportunidade aceita)? Então
        // não existe órfão nenhum — e mandar isso derrubaria uma aula marcada.
        const { data: comDono } = await sb.from("opportunities")
          .select("id, student_phone").eq("tenant_id", opp.tenant_id).eq(
            "kind",
            "TRIAL",
          )
          .in("status", ["CLAIMED", "FILLED", "TAKEN"]).gte(
            "created_at",
            desde,
          );
        if (
          (comDono || []).some((o: any) =>
            phonesMatch(String(o.student_phone || ""), phone)
          )
        ) {
          result.orphan_skipped++;
          continue;
        }

        // Virou aluno no meio do caminho? A trava comercial vale aqui como em
        // todo contato de venda — e falha fechada quando não há fonte de verdade.
        const facts = commercialFacts.get(opp.tenant_id);
        if (!facts) {
          result.orphan_skipped++;
          continue;
        }
        const { data: leadRows } = await sb.from("crm_leads")
          .select("id, name, phone, status").eq("tenant_id", opp.tenant_id).not(
            "phone",
            "is",
            null,
          );
        const lead = (leadRows || []).find((l: any) =>
          phonesMatch(String(l.phone || ""), phone)
        );
        const suppression = evaluateCommercialSuppression({
          tenantId: opp.tenant_id,
          phone: opp.student_phone || "",
          name: lead?.name ?? opp.student_name,
          leadStatus: lead?.status,
        }, facts);
        if (suppression.suppressed) {
          if (lead?.id) await reconcileSuppressedLead(sb, lead.id, suppression);
          result.orphan_skipped++;
          continue;
        }

        const c = await claim(sb, "TRIAL_NO_TEACHER", String(opp.id));
        if (!c.ok) continue;

        const dow = dowOf(String(slot.date));
        const { data: grade } = await sb.from("teacher_availability")
          .select("day_of_week, start_time").eq("tenant_id", opp.tenant_id);
        const alt = pickAlternatives(grade || [], dow, String(slot.time));
        const partes: string[] = [];
        if (alt.days.length) {
          partes.push(
            `o horário das ${slot.time} eu tenho livre na ${
              alt.days.map((d) => DAY_MAP[d]).join(", ")
            }`,
          );
        }
        if (alt.times.length) {
          partes.push(
            `na ${DAY_MAP[dow]} consigo nesses horários: ${
              alt.times.slice(0, 8).join(", ")
            }`,
          );
        }

        const first = greetName(opp.student_name);
        const quando = `${
          String(slot.date).split("-").reverse().join("/")
        } às ${slot.time}`;
        const msg = partes.length
          ? `Oi${
            first ? ", " + first : ""
          }! Sobre sua aula experimental de ${quando}: não consegui encaixar um professor nesse horário 😕 Mas ${
            partes.join("; e ")
          }. Qual fica melhor pra você?`
          : `Oi${
            first ? ", " + first : ""
          }! Sobre sua aula experimental de ${quando}: não consegui encaixar um professor nesse horário 😕 Me diz outro dia e horário que eu verifico a disponibilidade pra você!`;

        const entregue = await sendWhats(t.studentInstance, phone, msg);
        // O registro não depende do envio — mesma regra do `whatsapp-inbound`:
        // envio é entrega, log é memória.
        await sb.from("ai_wa_messages").insert({
          tenant_id: opp.tenant_id,
          phone,
          agent: "sdr",
          direction: "out",
          content: msg,
          meta: {
            lead_id: lead?.id ?? null,
            opportunity_id: opp.id,
            kind: "trial_no_teacher",
            entregue,
          },
        });
        if (entregue) {
          if (lead?.id) {
            await sb.from("crm_leads").update({
              last_outbound_at: new Date().toISOString(),
            }).eq("id", lead.id);
          }
          result.orphan_leads++;
          restam--;
        } else {
          await c.undo();
          result.failures.push(`orphan_lead ${opp.id}`);
        }
      }
    }

    return new Response(
      JSON.stringify({ ok: true, business_hours: businessHours, ...result }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
