import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// FUNNEL-SWEEPER — cron a cada 15 min. Três varreduras anti-vazamento do funil de alunos:
//
// A) PRIMEIRO TOQUE: leads NEW que nunca receberam NADA da IA. Leads de site/quiz/blog caem
//    aqui — o whatsapp-inbound só atende quem manda mensagem primeiro, e o sdr-followups
//    exige last_outbound_at preenchido. Resultado histórico: 74 de 92 leads NUNCA tocados.
//    Lotes pequenos (4/run) em horário comercial = ban-safety da instância central.
//    Após o toque: ai_handled=true + last_outbound_at=now() → o lead ENTRA na cadência
//    existente do sdr-followups (2 toques extras) e a resposta dele cai no SDR IA normal.
//
// B) ESCALONAMENTO DE CLAIM: oportunidade TRIAL OPEN sem aceite de professor morria no vácuo
//    (69% nunca aceitas; lead sem retorno). Agora: >20min → re-broadcast no grupo de
//    professores (1x); >60min → alerta ao diretor (1x). Só oportunidades <48h e slot futuro.
//
// C) EXPIRAÇÃO: OPEN >48h ou com slot no passado → LOST (silencioso). Havia 58 zumbis com
//    idade média de 75 dias poluindo os painéis e o funil.
//
// D) CONVITE DE ENTREVISTA (RH): a Rita aprovava (ai_recommendation=ENTREVISTAR) e o funil
//    morria — nenhum código escrevia interview_slot (~60 candidaturas paradas, ~2 entrevistas
//    em 2 meses). Agora: convite com link de agendamento (edge book-interview) + follow-ups
//    24h/72h enquanto não agendar. O lembrete no dia da entrevista já existia (sdr-followups).
//
// Dedupe: automation_sent com verificação "ever" (sem ref_date) — cada lead/opp recebe cada
// tipo de mensagem UMA vez na vida, mesmo com cron rodando a cada 15 min.

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const EVOLUTION_KEYS = Array.from(new Set([
  (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
  "8828462c98512411df3acfe3df4e48a1",
].filter(Boolean)));
const CLAIM_BASE = "https://system.wisewolflanguage.com.br/claim-opportunity";
// Página no frontend (não a edge): Supabase força text/plain em HTML no *.supabase.co
const BOOK_BASE = "https://system.wisewolflanguage.com.br/book-interview";
const DEFAULT_TEACHERS_GROUP = "120363403699904869@g.us";
const FIRST_TOUCH_BATCH = 4;      // por execução — ban-safety
const FIRST_TOUCH_DAILY_CAP = 24; // por dia — primeiro contato frio tem risco maior de report/block
const INTERVIEW_INVITE_DAILY_CAP = 5; // agenda do diretor tem ~6 slots/noite — convidar mais rápido só gera fila

async function sendWhats(instance: string, number: string, text: string): Promise<boolean> {
  for (const key of EVOLUTION_KEYS) {
    try {
      const resp = await fetch(`${EVOLUTION_API_BASE}/${encodeURIComponent(instance)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key },
        body: JSON.stringify({ number, text, delay: 1200, linkPreview: false }),
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 401) continue; // chave rotacionada → tenta a próxima
      return resp.ok;
    } catch { return false; }
  }
  return false;
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

// Dedup "ever": este kind+subject já foi enviado ALGUMA vez (qualquer data)?
async function sentEver(sb: any, kind: string, subjectId: string): Promise<boolean> {
  const { data } = await sb.from("automation_sent").select("id").eq("kind", kind).eq("subject_id", subjectId).limit(1);
  return !!(data && data.length);
}
async function markSent(sb: any, kind: string, subjectId: string) {
  await sb.from("automation_sent").insert({ kind, subject_id: subjectId, ref_date: todayBRT() });
}
// Claim ATÔMICO: insere a marca ANTES de enviar (o índice único kind+subject+ref_date
// derruba a corrida entre duas execuções paralelas — ex.: cron + disparo manual).
// Retorna false se outra execução já reivindicou. Em falha de envio, o caller desfaz a marca.
async function claim(sb: any, kind: string, subjectId: string): Promise<{ ok: boolean; undo: () => Promise<void> }> {
  if (await sentEver(sb, kind, subjectId)) return { ok: false, undo: async () => {} };
  const { error } = await sb.from("automation_sent").insert({ kind, subject_id: subjectId, ref_date: todayBRT() });
  if (error) return { ok: false, undo: async () => {} }; // 23505 = outra execução chegou antes
  return {
    ok: true,
    undo: async () => { await sb.from("automation_sent").delete().eq("kind", kind).eq("subject_id", subjectId).eq("ref_date", todayBRT()); },
  };
}
// Nome utilizável na saudação? (lead de formulário às vezes tem e-mail/telefone no campo nome)
function greetName(raw: string | null): string {
  const first = (raw || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$/.test(first) ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}

function isServiceRole(bearer: string, serviceKey: string): boolean {
  if (bearer && bearer === serviceKey) return true;
  try {
    const b64 = bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64))?.role === "service_role";
  } catch { return false; }
}

serve(async (req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!isServiceRole(bearer, serviceKey)) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    const sb = createClient(url, serviceKey);

    const hourBRT = nowBRT().getUTCHours();
    const businessHours = hourBRT >= 9 && hourBRT < 20;

    const result = {
      first_touch: 0, first_touch_skipped: 0,
      rebroadcasts: 0, director_alerts: 0,
      interview_invites: 0, interview_followups: 0,
      expired: 0, failures: [] as string[],
    };

    // Admin/instância central por tenant (mesmo padrão do sdr-followups)
    const { data: admins } = await sb.from("profiles")
      .select("tenant_id, phone, whatsapp_instance, teachers_group_id, role")
      .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"]).not("whatsapp_instance", "is", null).neq("whatsapp_instance", "");
    const byTenant: Record<string, { instance: string; ownerPhone: string; groupJid: string }> = {};
    for (const a of (admins || [])) {
      if (!byTenant[a.tenant_id]) byTenant[a.tenant_id] = {
        instance: a.whatsapp_instance,
        ownerPhone: cleanPhone(a.phone || ""),
        groupJid: a.teachers_group_id || DEFAULT_TEACHERS_GROUP,
      };
      else if (!byTenant[a.tenant_id].groupJid && a.teachers_group_id) byTenant[a.tenant_id].groupJid = a.teachers_group_id;
    }

    const { data: tenants } = await sb.from("tenants").select("id, ai_team_config");
    const cfgOf = (t: string) => (tenants || []).find((x: any) => x.id === t)?.ai_team_config || {};

    // TRAVA: telefone de candidato (RH) nunca recebe mensagem de SDR
    const { data: allApps } = await sb.from("job_applications").select("tenant_id, whatsapp");
    const isCandidatePhone = (tenantId: string, phone: string) =>
      (allApps || []).some((a: any) => a.tenant_id === tenantId && phonesMatch(a.whatsapp, phone));

    // ============ A) PRIMEIRO TOQUE ============
    if (businessHours) {
      // Teto diário: primeiro contato frio em volume é o maior risco de block do número
      const { count: sentToday } = await sb.from("automation_sent")
        .select("id", { count: "exact", head: true })
        .eq("kind", "SDR_FIRST_TOUCH").eq("ref_date", todayBRT());
      const remainingToday = Math.max(0, FIRST_TOUCH_DAILY_CAP - (sentToday ?? 0));

      const { data: leads } = await sb.from("crm_leads")
        .select("id, tenant_id, name, phone, status, source, created_at, ai_handled, ai_handoff, last_outbound_at")
        .eq("status", "NEW").eq("ai_handoff", false)
        .or("ai_handled.is.null,ai_handled.eq.false,last_outbound_at.is.null")
        .order("created_at", { ascending: false })
        .limit(80);

      for (const lead of (leads || [])) {
        if (result.first_touch >= Math.min(FIRST_TOUCH_BATCH, remainingToday)) break;
        const t = byTenant[lead.tenant_id];
        const cfg = cfgOf(lead.tenant_id);
        if (!t || cfg?.sdr?.enabled === false || cfg?.sdr?.first_touch === false) continue;
        const phone = cleanPhone(lead.phone || "");
        if (phone.length < 12) { result.first_touch_skipped++; continue; }
        if (isCandidatePhone(lead.tenant_id, lead.phone || "")) { result.first_touch_skipped++; continue; }

        const c = await claim(sb, "SDR_FIRST_TOUCH", String(lead.id));
        if (!c.ok) continue;

        const sdrName = cfg?.agents?.atendente?.name || "Bia";
        const first = greetName(lead.name);
        const isFresh = new Date(lead.created_at).getTime() > Date.now() - 72 * 3600 * 1000;
        const msg = isFresh
          ? `Oi${first ? ", " + first : ""}! Aqui é a ${sdrName}, da Wise Wolf Language 😊 Vi seu interesse nas nossas aulas de inglês. Quer marcar uma aula experimental gratuita? Me conta rapidinho: o inglês é pra trabalho, viagem ou outro objetivo?`
          : `Oi${first ? ", " + first : ""}! ${sdrName} da Wise Wolf Language por aqui 😊 Você deixou seu contato interessado(a) nas nossas aulas de inglês e eu não queria te deixar sem retorno. Ainda faz sentido pra você? A primeira aula é experimental e gratuita — é só me responder por aqui!`;

        if (await sendWhats(t.instance, phone, msg)) {
          await sb.from("crm_leads").update({ ai_handled: true, last_outbound_at: new Date().toISOString() }).eq("id", lead.id);
          await sb.from("ai_wa_messages").insert({ tenant_id: lead.tenant_id, phone, agent: "sdr", direction: "out", content: msg, meta: { lead_id: lead.id, kind: "first_touch", source: lead.source || null } });
          result.first_touch++;
        } else { await c.undo(); result.failures.push(`first_touch ${lead.id}`); }
      }
    }

    // ============ D) CONVITE + FOLLOW-UP DE ENTREVISTA (RH) ============
    if (businessHours) {
      const { count: invitesToday } = await sb.from("automation_sent")
        .select("id", { count: "exact", head: true })
        .eq("kind", "INTERVIEW_INVITE").eq("ref_date", todayBRT());
      let inviteBudget = Math.max(0, INTERVIEW_INVITE_DAILY_CAP - (invitesToday ?? 0));

      // Aprovados pela Rita, sem entrevista marcada, ainda vivos no processo
      const { data: cands } = await sb.from("job_applications")
        .select("id, tenant_id, name, whatsapp, booking_token, status")
        .eq("ai_recommendation", "ENTREVISTAR").is("interview_slot", null)
        .not("status", "in", "(Contratado,Rejeitado,Entrevistado)")
        .order("created_at", { ascending: true }); // mais antigos primeiro (fila justa)

      // Momento do convite/FU1 já enviados (para calcular idade dos follow-ups)
      const { data: rhMarks } = await sb.from("automation_sent")
        .select("kind, subject_id, created_at").in("kind", ["INTERVIEW_INVITE", "INTERVIEW_INVITE_FU1", "INTERVIEW_INVITE_FU2"]);
      const markAt = (kind: string, id: string) =>
        (rhMarks || []).find((m: any) => m.kind === kind && m.subject_id === id)?.created_at || null;

      for (const cand of (cands || [])) {
        const t = byTenant[cand.tenant_id];
        const cfg = cfgOf(cand.tenant_id);
        if (!t || cfg?.rh?.enabled === false || cfg?.rh?.interview_invites === false) continue;
        if (!cand.booking_token) continue; // linha anterior à migration do token
        const phone = cleanPhone(cand.whatsapp || "");
        if (phone.length < 12) continue;
        const id = String(cand.id);
        const first = greetName(cand.name);
        const link = `${BOOK_BASE}?t=${cand.booking_token}`;

        const invitedAt = markAt("INTERVIEW_INVITE", id);
        if (!invitedAt) {
          // Convite inicial — respeita o teto diário
          if (inviteBudget <= 0) continue;
          const c = await claim(sb, "INTERVIEW_INVITE", id);
          if (!c.ok) continue;
          const msg = `Oi${first ? ", " + first : ""}! Michelle da Wise Wolf por aqui 🐺 Ótima notícia: seu perfil foi aprovado na triagem e o diretor quer te conhecer! 🎉 É uma conversa online de ~30 minutos, pelo WhatsApp. Escolha o melhor horário pra você aqui:\n\n${link}\n\nQualquer dúvida, é só me responder 😊`;
          if (await sendWhats(t.instance, phone, msg)) {
            await sb.from("ai_wa_messages").insert({ tenant_id: cand.tenant_id, phone, agent: "rita", direction: "out", content: msg, meta: { application_id: cand.id, kind: "interview_invite" } });
            result.interview_invites++;
            inviteBudget--;
          } else { await c.undo(); result.failures.push(`interview_invite ${id}`); }
          continue;
        }

        // Follow-ups: só enquanto o convite tem menos de 10 dias (não ressuscitar processo morto)
        const inviteAgeH = (Date.now() - new Date(invitedAt).getTime()) / 3600000;
        if (inviteAgeH > 240) continue;

        const fu1At = markAt("INTERVIEW_INVITE_FU1", id);
        if (!fu1At && inviteAgeH >= 24) {
          const c = await claim(sb, "INTERVIEW_INVITE_FU1", id);
          if (!c.ok) continue;
          const msg = `Oi${first ? ", " + first : ""}! Michelle de novo 😊 Vi que você ainda não escolheu o horário da sua entrevista com o diretor. Os horários da semana estão preenchendo — garante o seu aqui:\n\n${link}`;
          if (await sendWhats(t.instance, phone, msg)) result.interview_followups++;
          else { await c.undo(); result.failures.push(`interview_fu1 ${id}`); }
          continue;
        }

        // FU2: 72h após o convite E pelo menos 24h após o FU1 (se o sweeper ficou fora do ar,
        // não manda os dois lembretes em sequência)
        if (fu1At && inviteAgeH >= 72 && (Date.now() - new Date(fu1At).getTime()) >= 24 * 3600000
            && !markAt("INTERVIEW_INVITE_FU2", id)) {
          const c = await claim(sb, "INTERVIEW_INVITE_FU2", id);
          if (!c.ok) continue;
          const msg = `Oi${first ? ", " + first : ""}! Última chamada 🐺 Seu processo na Wise Wolf está quase lá — falta só agendar a entrevista com o diretor:\n\n${link}\n\nSe não fizer mais sentido pra você, sem problemas — me avisa que encerro por aqui 😊`;
          if (await sendWhats(t.instance, phone, msg)) result.interview_followups++;
          else { await c.undo(); result.failures.push(`interview_fu2 ${id}`); }
        }
      }
    }

    // ============ B) ESCALONAMENTO DE CLAIM + C) EXPIRAÇÃO ============
    const cutoff48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const cutoff20m = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const cutoff60m = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    // C) zumbis: OPEN com mais de 48h → EXPIRED (status só aceita OPEN/CLAIMED/EXPIRED/CANCELED;
    // o desfecho de funil vai em conversion_status='LOST'). Silencioso, sem mensagem.
    const { data: expired, error: expErr } = await sb.from("opportunities")
      .update({ status: "EXPIRED", conversion_status: "LOST" })
      .eq("status", "OPEN").lt("created_at", cutoff48h)
      .select("id");
    if (expErr) result.failures.push(`expire_bulk: ${expErr.message}`);
    result.expired += (expired || []).length;

    // B) recentes sem aceite
    const { data: opps } = await sb.from("opportunities")
      .select("id, tenant_id, student_name, student_phone, interests, kind, created_at, slots_proposed")
      .eq("status", "OPEN").eq("kind", "TRIAL")
      .gte("created_at", cutoff48h).lt("created_at", cutoff20m);

    for (const opp of (opps || [])) {
      const slot = Array.isArray(opp.slots_proposed) ? opp.slots_proposed[0] : null;
      if (!slot?.date || !slot?.time) continue;

      // slot já passou → expira silenciosamente (não adianta escalonar aula no passado)
      const slotPast = slot.date < todayBRT() || (slot.date === todayBRT() && slot.time <= hhmmBRT());
      if (slotPast) {
        const { error: pastErr } = await sb.from("opportunities")
          .update({ status: "EXPIRED", conversion_status: "LOST" }).eq("id", opp.id).eq("status", "OPEN");
        if (pastErr) result.failures.push(`expire_past ${opp.id}: ${pastErr.message}`);
        else result.expired++;
        continue;
      }

      const t = byTenant[opp.tenant_id];
      if (!t || !businessHours) continue;

      const formatted = slot.formatted || `${String(slot.date).split("-").reverse().join("/")}`;
      const params = new URLSearchParams({
        id: opp.id, date: slot.date, time: slot.time,
        studentName: opp.student_name || "Aluno", studentPhone: opp.student_phone || "", kind: "TRIAL",
      });
      const claimLink = `${CLAIM_BASE}?${params.toString()}`;

      // Degrau 1 (>20min): re-broadcast no grupo de professores — 1x na vida da opp
      if (!(await sentEver(sb, "OPP_REBROADCAST", String(opp.id)))) {
        const c1 = await claim(sb, "OPP_REBROADCAST", String(opp.id));
        if (c1.ok) {
          const msg = `⏳🐺 *Ainda sem professor!* Experimental aguardando aceite:\n\n📅 *${formatted} às ${slot.time}*\n📋 *Aluno:* ${opp.student_name || "-"}\n🎯 *Objetivo:* ${opp.interests || "Não informado"}\n\n🏆 O primeiro a clicar garante a aula:\n👇 ${claimLink}`;
          if (await sendWhats(t.instance, t.groupJid, msg)) result.rebroadcasts++;
          else { await c1.undo(); result.failures.push(`rebroadcast ${opp.id}`); }
        }
        continue; // dá tempo do grupo reagir antes de alarmar o diretor
      }

      // Degrau 2 (>60min): alerta ao diretor — 1x na vida da opp
      const isOld = opp.created_at < cutoff60m;
      if (isOld && t.ownerPhone.length >= 12 && !(await sentEver(sb, "OPP_DIRECTOR_ALERT", String(opp.id)))) {
        const c2 = await claim(sb, "OPP_DIRECTOR_ALERT", String(opp.id));
        if (c2.ok) {
          const ageMin = Math.round((Date.now() - new Date(opp.created_at).getTime()) / 60000);
          const msg = `⚠️ *Experimental sem aceite há ${ageMin} min*\n\n📋 *${opp.student_name || "-"}* — ${formatted} às ${slot.time}\n🎯 ${opp.interests || "-"}\n📱 Lead: ${cleanPhone(opp.student_phone || "") || "-"}\n\nNenhum professor pegou (grupo já foi avisado 2x). Vale atribuir manualmente ou falar com o lead.\n${claimLink}`;
          if (await sendWhats(t.instance, t.ownerPhone, msg)) result.director_alerts++;
          else { await c2.undo(); result.failures.push(`alert ${opp.id}`); }
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, business_hours: businessHours, ...result }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
