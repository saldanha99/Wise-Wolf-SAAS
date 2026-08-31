// O `tsconfig.json` da raiz (lib DOM, do Vite) é lido pelo Deno e apaga
// `deno.ns`. Mesma diretiva que o `process-outbox` já carrega.
/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { handoffAtivo } from "../_shared/lead-contact.ts";
import { sendWhatsText } from "../_shared/evolution-send.ts";
import {
  evaluateCommercialSuppression,
  loadCommercialContactFacts,
  reconcileSuppressedLead,
} from "../_shared/commercial-contact-policy.ts";
import { loadTenantWhatsAppRoute } from "../_shared/tenant-communication.ts";
import {
  buildInterviewReminderMessages,
  type InterviewNotificationAudience,
  normalizeInterviewPhone,
  parseInterviewQueueOutcome,
} from "../_shared/interview-notifications.ts";

// SDR-FOLLOWUPS — cron horário (09h-19h BRT). Sem IA: templates determinísticos.
// 1) Follow-up de lead que não respondeu à atendente (máx 2 toques, ~20h de espaço)
// 2) Lembrete de pré-entrevista de RH não respondida (1 toque, após 24h)
// 3) Lembrete de entrevista agendada no dia (candidato + diretor)
// TRAVA: leads cujo telefone é de um CANDIDATO (job_applications) nunca recebem
// follow-up de SDR — evita cruzamento RH x comercial.

const EVOLUTION_API_URL = "https://api.2b.app.br";
const EVOLUTION_KEYS = Array.from(
  new Set([
    (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
  ].filter(Boolean)),
);

async function sendWhats(
  instance: string,
  number: string,
  text: string,
): Promise<boolean> {
  // Resolve o JID antes de enviar: 9 leads da base têm telefone de 12 dígitos
  // (DDD antigo, sem o 9º) e o envio "no chute" nunca chega. Ver
  // `_shared/evolution-send.ts`.
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

function cleanPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}

// Compara telefones BR ignorando o 9 extra / DDI (casa pelos últimos 8 + DDD)
function phonesMatch(a: string, b: string): boolean {
  const ca = (a || "").replace(/\D/g, "");
  const cb = (b || "").replace(/\D/g, "");
  if (!ca || !cb || ca.length < 8 || cb.length < 8) return false;
  if (ca.slice(-8) !== cb.slice(-8)) return false;
  const dddA = ca.slice(0, -8).replace(/^55/, "").replace(/9$/, "").slice(-2);
  const dddB = cb.slice(0, -8).replace(/^55/, "").replace(/9$/, "").slice(-2);
  return !dddA || !dddB || dddA === dddB;
}

async function alreadySent(
  sb: any,
  kind: string,
  subjectId: string,
): Promise<boolean> {
  const { data } = await sb.from("automation_sent").select("id").eq(
    "kind",
    kind,
  ).eq("subject_id", subjectId).eq("ref_date", todayBRT()).limit(1);
  return !!(data && data.length);
}
async function markSent(sb: any, kind: string, subjectId: string) {
  await sb.from("automation_sent").insert({
    kind,
    subject_id: subjectId,
    ref_date: todayBRT(),
  });
}

function isServiceRole(bearer: string, serviceKey: string): boolean {
  return Boolean(serviceKey && bearer === serviceKey);
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
    if (hourBRT < 9 || hourBRT >= 20) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "fora do horário" }),
        { status: 200 },
      );
    }

    const result = {
      followups: 0,
      preinterview_reminders: 0,
      interview_reminders: 0,
      interview_candidate_reminders: 0,
      interview_management_reminders: 0,
      interview_reminder_duplicates: 0,
      skipped_candidates: 0,
      skipped_contracted: 0,
      skipped_handoff: 0,
      failures: [] as string[],
    };
    const routeCache = new Map<
      string,
      ReturnType<typeof loadTenantWhatsAppRoute>
    >();
    const routeFor = (tenantId: string, audience: "student" | "teacher") => {
      const normalizedTenantId = String(tenantId || "").trim();
      const key = `${normalizedTenantId}:${audience}`;
      if (!normalizedTenantId) return Promise.resolve(null);
      let pending = routeCache.get(key);
      if (!pending) {
        pending = loadTenantWhatsAppRoute(sb, normalizedTenantId, audience)
          .catch((error) => {
            result.failures.push(
              `whatsapp_route ${normalizedTenantId}: ${
                (error as Error).message
              }`,
            );
            return null;
          });
        routeCache.set(key, pending);
      }
      return pending;
    };

    const { data: tenants } = await sb.from("tenants").select(
      "id, ai_team_config",
    );
    const cfgOf = (t: string) =>
      (tenants || []).find((x: any) => x.id === t)?.ai_team_config || {};
    const commercialFacts = new Map<string, Promise<any | null>>();
    const factsFor = (tenantId: string) => {
      const key = String(tenantId || "").trim();
      if (!key) return Promise.resolve(null);
      let pending = commercialFacts.get(key);
      if (!pending) {
        pending = loadCommercialContactFacts(sb, key).catch((error) => {
          result.failures.push(
            `commercial_state ${key}: ${(error as Error).message}`,
          );
          return null;
        });
        commercialFacts.set(key, pending);
      }
      return pending;
    };

    // TRAVA: telefones que pertencem a CANDIDATOS (qualquer vaga) — nunca recebem SDR.
    const { data: allApps } = await sb.from("job_applications").select(
      "tenant_id, whatsapp",
    );
    const isCandidatePhone = (tenantId: string, phone: string) =>
      (allApps || []).some((a: any) =>
        a.tenant_id === tenantId && phonesMatch(a.whatsapp, phone)
      );

    // ---- 1) Follow-up de leads ----
    //
    // O HANDOFF HUMANO AQUI TAMBÉM VENCE (mudou em 13/08/2026).
    //
    // O filtro era `ai_handoff = false` sem prazo nenhum: uma única resposta
    // manual tirava o lead da prospecção ATIVA para sempre. Medido antes da
    // mudança: 28 dos 47 leads CONTACTED estavam nesse limbo, e 73 leads nunca
    // receberam follow-up nenhum. "O humano assumiu" vira, depois de 72h em
    // silêncio, apenas "ninguém está cuidando deste lead".
    //
    // O filtro sai do SQL e vira `handoffAtivo` (mesma regra do caminho
    // reativo, em `_shared/lead-contact.ts`), porque a decisão depende do
    // carimbo e não só do booleano.
    const cutoff = new Date(Date.now() - 20 * 3600 * 1000).toISOString();
    const { data: leads } = await sb.from("crm_leads").select(
      "id, tenant_id, name, phone, status, last_inbound_at, last_outbound_at, followup_count, ai_handoff, ai_handoff_at, ai_handled",
    )
      .eq("ai_handled", true).in("status", ["NEW", "CONTACTED"]).not(
        "last_outbound_at",
        "is",
        null,
      ).lt("last_outbound_at", cutoff);
    for (const lead of (leads || [])) {
      if (handoffAtivo(lead)) {
        result.skipped_handoff++;
        continue;
      }
      if ((lead.followup_count ?? 0) >= 2) continue;
      if (
        lead.last_inbound_at && lead.last_inbound_at > lead.last_outbound_at
      ) continue;
      const t = await routeFor(lead.tenant_id, "student");
      if (!t || cfgOf(lead.tenant_id)?.sdr?.enabled === false) continue;
      const facts = await factsFor(lead.tenant_id);
      if (!facts) continue; // fail closed: sem fonte de verdade, não envia venda
      const suppression = evaluateCommercialSuppression({
        tenantId: lead.tenant_id,
        phone: lead.phone,
        name: lead.name,
        leadStatus: lead.status,
      }, facts);
      if (suppression.suppressed) {
        await reconcileSuppressedLead(sb, lead.id, suppression);
        result.skipped_contracted++;
        continue;
      }
      // TRAVA: se o telefone é de um candidato (professor/vendedor), não cutuca como lead.
      if (isCandidatePhone(lead.tenant_id, lead.phone || "")) {
        result.skipped_candidates++;
        continue;
      }
      if (await alreadySent(sb, "SDR_FOLLOWUP", String(lead.id))) continue;
      const phone = cleanPhone(lead.phone || "");
      if (phone.length < 12) continue;
      const first = (lead.name || "").trim().split(" ")[0];
      const msg = (lead.followup_count ?? 0) === 0
        ? `Oi${
          first ? ", " + first : ""
        }! 😊 Passando pra saber se ainda tem interesse na aula experimental de inglês da ${t.identity.brandName}. Posso te ajudar a escolher um dia e horário?`
        : `Oi${
          first ? ", " + first : ""
        }! Vou deixar seu atendimento por aqui pra não incomodar 🙏 Quando quiser retomar, é só mandar um \"oi\" que a gente agenda sua aula experimental!`;
      // Log sempre, entrega como campo (mesma convenção do `whatsapp-inbound`):
      // sem isso, o follow-up que a Evolution recusa não deixa rastro nenhum e
      // parece que o lead nunca foi procurado.
      const entregue = await sendWhats(t.instanceName, phone, msg);
      await sb.from("ai_wa_messages").insert({
        tenant_id: lead.tenant_id,
        phone,
        agent: "sdr",
        direction: "out",
        content: msg,
        meta: { lead_id: lead.id, kind: "followup", entregue },
      });
      if (entregue) {
        await sb.from("crm_leads").update({
          followup_count: (lead.followup_count ?? 0) + 1,
          last_outbound_at: new Date().toISOString(),
        }).eq("id", lead.id);
        await markSent(sb, "SDR_FOLLOWUP", String(lead.id));
        result.followups++;
      } else result.failures.push(`followup ${lead.id}`);
    }

    // ---- 2) Lembrete de pré-entrevista (RH) ----
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: apps } = await sb.from("job_applications").select(
      "id, tenant_id, name, whatsapp, preinterview_status, preinterview_sent_at",
    )
      .eq("preinterview_status", "SENT").lt("preinterview_sent_at", dayAgo).gt(
        "preinterview_sent_at",
        weekAgo,
      );
    for (const app of (apps || [])) {
      const t = await routeFor(app.tenant_id, "teacher");
      if (!t || cfgOf(app.tenant_id)?.rh?.enabled === false) continue;
      if (await alreadySent(sb, "RITA_PREINT_REMIND", String(app.id))) continue;
      const { data: ever } = await sb.from("automation_sent").select("id").eq(
        "kind",
        "RITA_PREINT_REMIND",
      ).eq("subject_id", String(app.id)).limit(1);
      if (ever && ever.length) continue;
      const phone = cleanPhone(app.whatsapp || "");
      if (phone.length < 12) continue;
      const first = (app.name || "").trim().split(" ")[0];
      const msg =
        `Oi, ${first}! Michelle da ${t.identity.brandName} por aqui 👋 Só lembrando da nossa conversa da triagem — quando puder responder, seu processo anda mais rápido! 😊`;
      if (await sendWhats(t.instanceName, phone, msg)) {
        await sb.from("ai_wa_messages").insert({
          tenant_id: app.tenant_id,
          phone,
          agent: "rita",
          direction: "out",
          content: msg,
          meta: { application_id: app.id, kind: "preinterview_reminder" },
        });
        await markSent(sb, "RITA_PREINT_REMIND", String(app.id));
        result.preinterview_reminders++;
      } else result.failures.push(`preint ${app.id}`);
    }

    // ---- 3) Lembrete de entrevista hoje ----
    const { data: interviews } = await sb.from("job_applications").select(
      "id, tenant_id, name, whatsapp, interview_slot",
    ).not("interview_slot", "is", null);
    for (const app of (interviews || [])) {
      const slotBRT = new Date(
        new Date(app.interview_slot).getTime() - 3 * 3600 * 1000,
      ).toISOString();
      if (slotBRT.split("T")[0] !== todayBRT()) continue;
      const t = await routeFor(app.tenant_id, "teacher");
      if (!t) continue;
      const hhmm = slotBRT.split("T")[1].slice(0, 5);
      const messages = buildInterviewReminderMessages({
        candidateName: app.name || "",
        candidatePhone: app.whatsapp || "",
        brandName: t.identity.brandName,
        time: hhmm,
      });
      const recipients: Array<{
        audience: InterviewNotificationAudience;
        destination: string;
        message: string;
      }> = [
        {
          audience: "CANDIDATE",
          destination: normalizeInterviewPhone(app.whatsapp || ""),
          message: messages.candidate,
        },
        {
          audience: "MANAGEMENT",
          destination: normalizeInterviewPhone(t.ownerPhone || ""),
          message: messages.management,
        },
      ];

      for (const recipient of recipients) {
        if (recipient.destination.length < 12) {
          result.failures.push(
            `interview reminder ${app.id} ${recipient.audience.toLowerCase()}: telefone inválido`,
          );
          continue;
        }
        const { data, error } = await sb.rpc("enqueue_interview_notification", {
          p_application_id: app.id,
          p_expected_slot: app.interview_slot,
          p_event: "REMINDER",
          p_audience: recipient.audience,
          p_destination: recipient.destination,
          p_message_body: recipient.message,
        });
        if (error) {
          result.failures.push(
            `interview reminder ${app.id} ${recipient.audience.toLowerCase()}: ${
              error.code || "queue_error"
            }`,
          );
          continue;
        }
        const outcome = parseInterviewQueueOutcome(data);
        if (outcome.duplicate) {
          result.interview_reminder_duplicates++;
          continue;
        }
        if (!outcome.ok || !outcome.queued) {
          result.failures.push(
            `interview reminder ${app.id} ${recipient.audience.toLowerCase()}: ${
              outcome.reason || "queue_rejected"
            }`,
          );
          continue;
        }
        result.interview_reminders++;
        if (recipient.audience === "CANDIDATE") {
          result.interview_candidate_reminders++;
        } else {
          result.interview_management_reminders++;
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
