/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import { loadTenantCentralWhatsAppContext } from "../_shared/tenant-communication.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};
type Row = Record<string, unknown>;
const object = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const date = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
function validSource(v: unknown) {
  const s = object(v);
  return typeof s.id === "string" && typeof s.offer_id === "string" &&
      typeof s.tenant_id === "string" && typeof s.student_id === "string" &&
      typeof s.token === "string" && /^[a-f0-9]{64}$/.test(s.token) &&
      typeof s.recipient_phone === "string" &&
      /^[1-9][0-9]{11,14}$/.test(s.recipient_phone) &&
      typeof s.recipient_name === "string" &&
      typeof s.student_name === "string" && s.term_months === 6 &&
      Number.isSafeInteger(s.monthly_fee_cents) &&
      Number(s.monthly_fee_cents) > 0 && Number.isInteger(s.classes_per_week) &&
      Number(s.classes_per_week) >= 1 && Number(s.classes_per_week) <= 7 &&
      date(s.contract_start) && date(s.service_end_date)
    ? s
    : null;
}
const brl = (c: number) =>
  (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const brDate = (v: string) => v.split("-").reverse().join("/");

serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }
  const auth = await authorizeScopedAutomation(request, headers);
  if (!auth.ok) return auth.response;
  const body = await request.json().catch(() => null);
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    (body as Row).sweep !== true || Object.keys(body).some((k) => k !== "sweep")
  ) {
    return new Response(JSON.stringify({ error: "invalid_sweep_request" }), {
      status: 400,
      headers,
    });
  }
  const admin = auth.context.admin;
  const result = {
    considered: 0,
    accepted: 0,
    delivered: 0,
    unknown: 0,
    rejected: 0,
    skipped: 0,
    errors: [] as string[],
  };
  const pending = await admin.rpc(
    "student_course_renewal_notifications_pending",
    { p_limit: 25 },
  );
  if (pending.error || !Array.isArray(pending.data)) {
    return new Response(
      JSON.stringify({ error: "renewal_queue_unavailable" }),
      { status: 503, headers },
    );
  }
  for (const raw of pending.data) {
    const candidate = object(raw);
    if (
      typeof candidate.id !== "string" ||
      typeof candidate.tenant_id !== "string"
    ) {
      result.skipped++;
      continue;
    }
    result.considered++;
    let claimToken = "";
    try {
      const claimed = await admin.rpc(
        "claim_student_course_renewal_notification",
        { p_id: candidate.id },
      );
      const claim = object(claimed.data);
      if (
        claimed.error || claim.ok !== true ||
        typeof claim.claim_token !== "string"
      ) {
        result.skipped++;
        continue;
      }
      claimToken = claim.claim_token;
      const sourceResult = await admin.rpc(
        "student_course_renewal_notification_source",
        { p_id: candidate.id, p_claim: claimToken },
      );
      const source = validSource(sourceResult.data);
      if (sourceResult.error || !source) {
        result.skipped++;
        continue;
      }
      // The public RPC is the exact endpoint the recipient opens. Validate it
      // immediately before dispatch and compare every frozen commercial field.
      const publicResult = await admin.rpc(
        "get_student_course_renewal_public",
        { p_token: source.token },
      );
      const publicData = object(object(publicResult.data).data);
      if (
        publicResult.error || object(publicResult.data).ok !== true ||
        publicData.status !== "PENDING_SIGNATURE" ||
        publicData.expired !== false ||
        publicData.term_months !== source.term_months ||
        publicData.monthly_fee_cents !== source.monthly_fee_cents ||
        publicData.classes_per_week !== source.classes_per_week ||
        publicData.contract_start !== source.contract_start ||
        publicData.service_end_date !== source.service_end_date
      ) {
        result.skipped++;
        continue;
      }
      const route = await loadTenantCentralWhatsAppContext(
        admin,
        String(source.tenant_id),
        "student",
        { requireDeliveryReceipts: true },
      );
      const integration = await resolveEvolutionIntegration(
        admin,
        String(source.tenant_id),
        "message.send_text",
      );
      if (
        !route || route.identity.tenantId !== source.tenant_id ||
        integration.tenantId !== source.tenant_id
      ) {
        result.skipped++;
        continue;
      }
      const portal =
        (route.identity.portalUrl || "https://system.wisewolflanguage.com.br")
          .replace(/\/$/, "");
      const link = `${portal}/renovar-curso?token=${
        encodeURIComponent(String(source.token))
      }`;
      new URL(link);
      const prepared = await admin.rpc(
        "prepare_student_course_renewal_notification",
        {
          p_id: source.id,
          p_claim: claimToken,
          p_instance: route.instanceName,
          p_destination: source.recipient_phone,
        },
      );
      if (prepared.error || object(prepared.data).ok !== true) {
        result.skipped++;
        continue;
      }
      const message =
        `Olá, ${source.recipient_name}! A renovação do curso de ${source.student_name} está pronta.\n\nCondição: 6 meses, ${
          brl(Number(source.monthly_fee_cents))
        } por mês e ${source.classes_per_week} aulas por semana. Vigência: ${
          brDate(String(source.contract_start))
        } a ${
          brDate(String(source.service_end_date))
        }.\n\nConfira e assine pelo link individual:\n${link}\n\nSe precisar ajustar a data, fale conosco antes de assinar.`;
      const sent = await sendWhatsTextDetailed({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: route.instanceName,
        to: String(source.recipient_phone),
        text: message,
      });
      const finished = await admin.rpc(
        "finish_student_course_renewal_notification",
        {
          p_id: source.id,
          p_claim: claimToken,
          p_outcome: sent.outcome,
          p_message_id: sent.messageId,
          p_http: sent.httpStatus,
        },
      );
      const state = String(object(finished.data).status || "");
      if (state === "ACCEPTED") result.accepted++;
      else if (state === "UNKNOWN") result.unknown++;
      else if (state === "FAILED") result.rejected++;
      else result.skipped++;
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : "renewal_notification_error",
      );
      if (claimToken) result.unknown++;
    }
  }
  return new Response(JSON.stringify(result), {
    status: result.errors.length ? 503 : 200,
    headers,
  });
});
