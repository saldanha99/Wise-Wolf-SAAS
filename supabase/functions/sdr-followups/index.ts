// O `tsconfig.json` da raiz (lib DOM, do Vite) é lido pelo Deno e apaga
// `deno.ns`. Mesma diretiva que o `process-outbox` já carrega.
/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  claimSdrNotice,
  readAllTimeoutRows,
} from "../_shared/trial-timeout.ts";
import { handoffAtivo } from "../_shared/lead-contact.ts";
import {
  claimSdrEvent,
  followupStage,
  stageFollowupMessage,
} from "../_shared/sdr-lifecycle.ts";
import {
  sendWhatsText,
  sendWhatsTextDetailed,
} from "../_shared/evolution-send.ts";
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

    // Stage-specific follow-ups share the reactive conversation lease. Existing
    // appointment reminders own pre-class messages, and pending teachers own their timeout.
    const cutoff = new Date(Date.now() - 20 * 3600000).toISOString();
    const leads = await readAllTimeoutRows(() =>
      sb.from("crm_leads").select(
        "id,tenant_id,phone",
      ).eq("ai_handled", true).in("status", ["NEW", "CONTACTED", "TRIAL_DONE"])
        .not("last_outbound_at", "is", null).lt("last_outbound_at", cutoff)
        .order("last_outbound_at").order("id")
    );
    for (const candidate of leads || []) {
      if (result.followups >= 15) break;
      const phone = cleanPhone(candidate.phone || "");
      if (phone.length < 12 || isCandidatePhone(candidate.tenant_id, phone)) {
        continue;
      }
      const t = await routeFor(candidate.tenant_id, "student");
      if (!t || cfgOf(candidate.tenant_id)?.sdr?.enabled === false) continue;
      const lease = await claimSdrNotice(sb, candidate.tenant_id, phone);
      if (!lease.ok) continue;
      let success = true;
      try {
        const [current, requests, trials] = await Promise.all([
          sb.from("crm_leads").select("*").eq("tenant_id", candidate.tenant_id)
            .eq("id", candidate.id).maybeSingle(),
          sb.from("trial_reschedule_requests").select("id").eq(
            "tenant_id",
            candidate.tenant_id,
          ).eq("lead_id", candidate.id).eq("status", "PENDING").limit(1),
          sb.from("opportunities").select(
            "id,student_phone,status,trial_status,created_at,trial_appointment_id,conversion_status",
          )
            .eq("tenant_id", candidate.tenant_id).eq("kind", "TRIAL")
            .gte(
              "created_at",
              new Date(Date.now() - 30 * 86400000).toISOString(),
            ).order("created_at", { ascending: false }),
        ]);
        if ([current, requests, trials].some((r) => r.error)) {
          throw new Error("sdr_followup_state_unavailable");
        }
        const lead = current.data;
        if (
          !lead || !lead.ai_handled || !lead.last_outbound_at ||
          lead.last_outbound_at >= cutoff ||
          (lead.last_inbound_at &&
            lead.last_inbound_at >= cutoff) ||
          requests.data?.length
        ) continue;
        if (handoffAtivo(lead)) {
          result.skipped_handoff++;
          continue;
        }
        const matchingTrials = (trials.data || []).filter((o: any) =>
          phonesMatch(o.student_phone, phone)
        );
        const ongoing = matchingTrials.some((o: any) =>
          ["OPEN", "CLAIMED", "FILLED", "TAKEN"].includes(o.status) &&
          ![
            "DONE",
            "COMPLETED",
            "CANCELLED",
            "CANCELED",
            "NO_SHOW",
            "NO_SHOW_STUDENT",
            "NO_SHOW_TEACHER",
          ].includes(String(o.trial_status || "").toUpperCase())
        );
        if (ongoing) continue;
        const trial = matchingTrials.find((o: any) =>
          o.id === lead.opportunity_id
        ) || matchingTrials[0];
        // Refresh financial truth within the lease, never reuse an earlier tenant snapshot.
        const facts = await loadCommercialContactFacts(sb, lead.tenant_id);
        const suppression = evaluateCommercialSuppression({
          tenantId: lead.tenant_id,
          phone,
          name: lead.name,
          leadStatus: lead.status,
          opportunityId: lead.opportunity_id,
        }, facts);
        const enrollmentPending =
          suppression.reason === "enrollment_in_progress";
        if (suppression.suppressed && !enrollmentPending) {
          await reconcileSuppressedLead(sb, lead.id, suppression);
          result.skipped_contracted++;
          continue;
        }
        const stage = followupStage(
          lead.status,
          trial?.trial_status || null,
          enrollmentPending,
        );
        if (!stage) continue;
        if (
          stage !== "qualification" &&
          lead.last_outbound_at <
            new Date(Date.now() - 14 * 86400000).toISOString()
        ) continue;
        if (
          stage === "after_trial" &&
          (!lead.last_status_change || lead.last_status_change >= cutoff)
        ) continue;
        const scope = `${lead.tenant_id}:${lead.id}:${stage}:${
          stage === "qualification" ? "initial" : trial?.id || "enrollment"
        }`;
        const { data: marks, error: marksError } = await sb.from(
          "automation_sent",
        ).select("subject_id")
          .eq("kind", "SDR_STAGE_FOLLOWUP").in("subject_id", [
            `${scope}:0`,
            `${scope}:1`,
          ]);
        if (marksError) throw new Error("sdr_followup_history_unavailable");
        const used = new Set((marks || []).map((m: any) => m.subject_id));
        const touch = stage === "qualification"
          ? Math.max(used.size, lead.followup_count || 0)
          : used.size;
        if (touch >= 2) continue;
        const event = await claimSdrEvent(
          sb,
          "SDR_STAGE_FOLLOWUP",
          `${scope}:${touch}`,
        );
        if (!event.ok) continue;
        const msg = stageFollowupMessage(
          stage,
          lead.name || "",
          t.identity.brandName,
          touch,
          lead.goal || "",
        );
        const delivery = await sendWhatsTextDetailed({
          base: EVOLUTION_API_URL,
          keys: EVOLUTION_KEYS,
          instance: t.instanceName,
          to: phone,
          text: msg,
        });
        const { error: logError } = await sb.from("ai_wa_messages").insert({
          tenant_id: lead.tenant_id,
          phone,
          agent: "sdr",
          direction: "out",
          content: msg,
          meta: {
            lead_id: lead.id,
            kind: "stage_followup",
            stage,
            touch,
            entregue: delivery.outcome === "accepted",
            delivery_outcome: delivery.outcome,
          },
        });
        if (delivery.outcome === "rejected") await event.undo();
        if (delivery.outcome === "ambiguous") success = false;
        if (logError) throw new Error("sdr_followup_log_failed");
        if (delivery.outcome === "accepted") {
          const { error } = await sb.from("crm_leads").update({
            last_outbound_at: new Date().toISOString(),
            ...(stage === "qualification" ? { followup_count: touch + 1 } : {}),
          }).eq("tenant_id", lead.tenant_id).eq("id", lead.id);
          if (error) throw new Error("sdr_followup_lead_update_failed");
          result.followups++;
        } else result.failures.push(`followup ${lead.id}: ${delivery.outcome}`);
      } catch (error) {
        success = false;
        result.failures.push(
          `followup ${candidate.id}: ${(error as Error).message}`,
        );
      } finally {
        await lease.finish(success);
      }
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
