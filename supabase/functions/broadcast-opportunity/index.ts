import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
import {
  loadTenantWhatsAppRoute,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import { loadOpportunityDispatchGuard } from "../_shared/opportunity-dispatch.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// CONFIGURATION
const API_URL = Deno.env.get("EVOLUTION_API_URL") || "https://api.2b.app.br";
const API_KEYS = [(Deno.env.get("EVOLUTION_API_KEY") || "").trim()].filter(
  Boolean,
);
const FALLBACK_PORTAL_URL = (
  Deno.env.get("APP_BASE_URL") ||
  Deno.env.get("SYSTEM_URL") ||
  "https://system.wisewolflanguage.com.br"
)
  .trim()
  .replace(/\/+$/, "");

const DAY_MAP: { [key: number]: string } = {
  1: "Segunda",
  2: "Terça",
  3: "Quarta",
  4: "Quinta",
  5: "Sexta",
  6: "Sábado",
  0: "Domingo",
};

// Map weekday name to short label for display
const WEEKDAY_LABELS: { [key: string]: string } = {
  monday: "Segunda",
  tuesday: "Terça",
  wednesday: "Quarta",
  thursday: "Quinta",
  friday: "Sexta",
  saturday: "Sábado",
  sunday: "Domingo",
};

// Professor inativo (suspenso/desligado) NUNCA recebe convite — mesma regra do
// helper is_teacher_notifiable. lifecycle_status é a fonte de verdade; status
// (decorativo) também barra valores explicitamente inativos por segurança.
const INACTIVE_STATUS = [
  "Inativo",
  "INACTIVE",
  "Inactive",
  "Arquivado",
  "Cancelado",
  "Trancado",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32_768;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type EvolutionDeliveryResult = {
  success: boolean;
  messageId: string | null;
  providerStatus: number | null;
  providerFailure: string | null;
  providerPayload: string | null;
};

function normalizeStringInput(value: unknown): string | null {
  if (typeof value === "string") {
    const cleaned = value.trim();
    return cleaned ? cleaned.slice(0, 320) : null;
  }
  return null;
}

function getDirectErrorFromField(payload: unknown, key: string): string | null {
  if (!isRecord(payload)) return null;
  const raw = normalizeStringInput(payload[key]);
  if (raw) return raw;
  if (isRecord(payload[key])) {
    const rec = payload[key] as Record<string, unknown>;
    const candidate = normalizeStringInput(rec.message) ||
      normalizeStringInput(rec.description) ||
      normalizeStringInput(rec.code) ||
      normalizeStringInput(rec.error) ||
      normalizeStringInput(rec.reason);
    if (candidate) return candidate;
  }
  return null;
}

function getEvolutionError(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  if (payload.error === true) return "provider rejected the message";
  const directError = getDirectErrorFromField(payload, "error");
  if (directError) return directError;

  const directErrors = payload.errors;
  if (Array.isArray(directErrors)) {
    if (directErrors.length > 0) {
      const first = directErrors[0];
      const firstMsg = normalizeStringInput(first);
      if (firstMsg) return firstMsg;
      if (isRecord(first)) {
        const candidate = getDirectErrorFromField(first, "message") ||
          getDirectErrorFromField(first, "reason") ||
          getDirectErrorFromField(first, "error");
        if (candidate) return candidate;
      }
      return JSON.stringify(first).slice(0, 320);
    }
  }

  const nestedResponse = payload.response;
  if (isRecord(nestedResponse)) {
    const nested = nestedResponse as Record<string, unknown>;
    const responseFailure = getDirectErrorFromField(nested, "error") ||
      getDirectErrorFromField(nested, "message") ||
      getDirectErrorFromField(nested, "reason");
    if (responseFailure) return responseFailure;
  }

  const directMessage = normalizeStringInput(payload.message);
  if (directMessage) {
    const msg = directMessage.toLowerCase();
    if (
      msg.includes("error") ||
      msg.includes("erro") ||
      msg.includes("failed") ||
      msg.includes("rejeit") ||
      msg.includes("invalid") ||
      msg.includes("disconnected")
    ) {
      return directMessage;
    }
  }

  const statusValue = payload.status;
  if (typeof statusValue === "number" && statusValue >= 400) {
    return `status ${statusValue}`;
  }
  if (typeof statusValue === "string") {
    const normalized = statusValue.trim().toUpperCase();
    if (
      [
        "ERROR",
        "FAILED",
        "FAILURE",
        "KO",
        "UNDELIVERED",
        "UNAUTHORIZED",
        "FORBIDDEN",
        "DISCONNECTED",
        "NOT_FOUND",
        "INVALID",
        "BLOCKED",
      ].includes(normalized)
    ) {
      return normalized.toLowerCase();
    }
    const normalizedErrorHint = normalized.toLowerCase();
    if (
      normalizedErrorHint.includes("error") ||
      normalizedErrorHint.includes("erro") ||
      normalizedErrorHint.includes("fail") ||
      normalizedErrorHint.includes("invalid") ||
      normalizedErrorHint.includes("rejeit")
    ) {
      return normalizedErrorHint;
    }
    return null;
  }
  return null;
}

function getEvolutionMessageId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const rootKey = isRecord(payload.key) ? payload.key : null;
  const potential = rootKey?.id || payload.id;
  return typeof potential === "string" && potential.trim()
    ? potential.trim().slice(0, 320)
    : null;
}

function isLikelySuccessPayload(payload: unknown, rawText: string): boolean {
  const raw = (rawText || "").trim().toLowerCase();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return (
      ["ok", "success", "sent", "queued", "pending", "message_id", "id"].some(
        (marker) => raw.includes(marker),
      ) &&
      !["error", "erro", "failed", "invalid", "forbidden", "disconnected"].some(
        (token) => raw.includes(token),
      )
    );
  }

  const record = payload as Record<string, unknown>;
  if (record.success === true || record.sent === true) return true;
  const directStatus = record.status;
  if (typeof directStatus === "string") {
    const status = directStatus.toUpperCase();
    if (["OK", "SUCCESS", "SENT", "PENDING", "QUEUED"].includes(status)) {
      return true;
    }
  }
  if (typeof getEvolutionMessageId(record) === "string") return true;
  return (
    [
      "ok",
      "success",
      "sent",
      "queued",
      "pending",
      "messageid",
      "message_id",
    ].some((marker) => raw.includes(marker)) &&
    !["error", "erro", "failed", "invalid", "forbidden", "disconnected"].some(
      (token) => raw.includes(token),
    )
  );
}

async function sendEvolutionText(
  baseEndpoint: string,
  key: string,
  number: string,
  text: string,
): Promise<EvolutionDeliveryResult> {
  try {
    const resp = await fetch(baseEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key },
      body: JSON.stringify({
        number,
        text,
        delay: 1200,
        linkPreview: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 401) {
      return {
        success: false,
        messageId: null,
        providerStatus: 401,
        providerFailure: "unauthorized",
        providerPayload: null,
      };
    }
    if (!resp.ok) {
      return {
        success: false,
        messageId: null,
        providerStatus: resp.status,
        providerFailure: `http ${resp.status}`,
        providerPayload: null,
      };
    }

    const providerRaw = await resp.text().catch(() => "");
    let payload: unknown = null;
    if (providerRaw) {
      try {
        payload = JSON.parse(providerRaw);
      } catch {
        payload = null;
      }
    }
    const providerFailure = getEvolutionError(payload) ||
      (providerRaw && !isLikelySuccessPayload(payload, providerRaw)
        ? "provider returned unexpected response format"
        : null);
    if (providerFailure) {
      return {
        success: false,
        messageId: getEvolutionMessageId(payload),
        providerStatus: resp.status,
        providerFailure,
        providerPayload: providerRaw.slice(0, 600),
      };
    }
    return {
      success: true,
      messageId: getEvolutionMessageId(payload),
      providerStatus: resp.status,
      providerFailure: null,
      providerPayload: providerRaw.slice(0, 600),
    };
  } catch (error) {
    return {
      success: false,
      messageId: null,
      providerStatus: null,
      providerFailure: error instanceof Error ? error.message : "network error",
      providerPayload: null,
    };
  }
}

function saoPauloDateTimeParts(value: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value || "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function calendarDayOfWeek(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function cleanTeacherPhone(raw: string): string | null {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p.length >= 12 ? p : null;
}

// Resolve o JID real cadastrado no WhatsApp antes de enviar. Necessário porque
// muitas contas brasileiras (DDDs mais antigos) ainda estão registradas SEM o
// 9º dígito extra do celular — mandar pro número "no chute" (com o 9, como
// fica salvo no cadastro) não bate com o JID real e a mensagem nunca chega,
// mesmo a Evolution respondendo 200/PENDING. Resolve e usa o JID canônico.
async function resolveJid(
  instance: string,
  phone: string,
): Promise<string | null> {
  for (const key of API_KEYS) {
    try {
      const resp = await fetch(
        `${API_URL}/chat/whatsappNumbers/${encodeURIComponent(instance)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: key },
          body: JSON.stringify({ numbers: [phone] }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (resp.status === 401) continue; // chave rotacionada → tenta a próxima
      if (!resp.ok) return null;
      const data = await resp.json();
      const entry = Array.isArray(data) ? data[0] : null;
      if (entry?.exists && entry.jid) return String(entry.jid).split("@")[0];
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    console.log("Broadcast Function Hit");
    const contentLength = Number(req.headers.get("content-length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json({ error: "Payload too large" }, 413);
    }
    const authorization = await authorizeRequest(req, {
      corsHeaders,
      allowedRoles: [
        "SCHOOL_ADMIN",
        "SUPER_ADMIN",
        "COORDINATOR",
        "COMMERCIAL",
        "SALESPERSON",
      ],
    });
    if (authorization.ok === false) return authorization.response;

    const supabaseAdmin = authorization.context.admin;
    const userId = authorization.context.userId;
    const tenantId = authorization.context.profile?.tenant_id;
    const callerRole = authorization.context.profile?.role;
    if (!userId || !tenantId) {
      return json({ error: "Tenant access is required" }, 403);
    }

    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Payload too large" }, 413);
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody || "{}");
      if (!isRecord(parsed)) throw new Error("invalid_body");
      body = parsed;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const allowedFields = new Set([
      "student_name",
      "student_phone",
      "date",
      "time",
      "interests",
      "preferred_slots",
      "opportunity_id",
      "kind",
      "dispatch_mode",
    ]);
    if (Object.keys(body).some((field) => !allowedFields.has(field))) {
      return json({ error: "Unexpected opportunity field" }, 400);
    }

    let student_name = safeCommunicationText(body.student_name, 120);
    let student_phone = typeof body.student_phone === "string"
      ? body.student_phone.replace(/\D/g, "").slice(0, 15)
      : "";
    const date = typeof body.date === "string" ? body.date.trim() : "";
    const time = typeof body.time === "string" ? body.time.trim() : "";
    const interests = safeCommunicationText(body.interests, 2000);
    const rawPreferredSlots = body.preferred_slots ?? null;
    const preferred_slots: Array<{ weekday: string; time: string }> | null =
      Array.isArray(rawPreferredSlots)
        ? rawPreferredSlots.flatMap((slot) => {
          if (!isRecord(slot)) return [];
          const weekday = typeof slot.weekday === "string"
            ? slot.weekday.trim().toLowerCase()
            : "";
          const preferredTime = typeof slot.time === "string"
            ? slot.time.trim()
            : "";
          return WEEKDAY_LABELS[weekday] &&
              /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(preferredTime)
            ? [{ weekday, time: preferredTime }]
            : [];
        })
        : null;
    const opportunity_id = typeof body.opportunity_id === "string"
      ? body.opportunity_id.trim()
      : "";
    let oppKind = body.kind === "TRAINING" ? "TRAINING" : "TRIAL";
    const mode = body.dispatch_mode === "group" ? "group" : "individual";
    if (
      !student_name ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ||
      (student_phone && student_phone.length < 10) ||
      (!opportunity_id && oppKind === "TRIAL" && student_phone.length < 10) ||
      (opportunity_id && !UUID_PATTERN.test(opportunity_id)) ||
      (body.kind !== undefined &&
        body.kind !== "TRIAL" &&
        body.kind !== "TRAINING") ||
      (body.dispatch_mode !== undefined &&
        body.dispatch_mode !== "group" &&
        body.dispatch_mode !== "individual") ||
      (opportunity_id && body.kind === "TRAINING") ||
      (rawPreferredSlots !== null && !Array.isArray(rawPreferredSlots)) ||
      (Array.isArray(rawPreferredSlots) && rawPreferredSlots.length > 12) ||
      (Array.isArray(rawPreferredSlots) &&
        preferred_slots?.length !== rawPreferredSlots.length)
    ) {
      return json({ error: "Invalid opportunity payload" }, 400);
    }
    if (
      opportunity_id &&
      !["SCHOOL_ADMIN", "SUPER_ADMIN", "COORDINATOR"].includes(callerRole || "")
    ) {
      return json({ error: "Only school managers can reopen a trial" }, 403);
    }
    if (oppKind === "TRIAL" && mode === "group") {
      return json(
        { error: "Trial opportunities must use active teacher recipients" },
        400,
      );
    }
    const requestedStart = new Date(`${date}T${time}:00-03:00`);
    if (!Number.isFinite(requestedStart.getTime())) {
      return json({ error: "Opportunity time must be valid" }, 400);
    }
    const normalizedStart = saoPauloDateTimeParts(requestedStart);
    if (
      normalizedStart.date !== date ||
      normalizedStart.time !== time ||
      requestedStart.getTime() <= Date.now() + 5 * 60_000 ||
      requestedStart.getTime() > Date.now() + 366 * 24 * 60 * 60_000
    ) {
      return json(
        { error: "Opportunity time must be a valid future slot" },
        400,
      );
    }
    if (!API_KEYS.length) {
      return json({ error: "WhatsApp provider is unavailable" }, 503);
    }

    let route = await loadTenantWhatsAppRoute(
      supabaseAdmin,
      tenantId,
      "teacher",
    );
    if (!route) {
      console.warn(
        "[Broadcast] Nenhuma rota teacher ativa encontrada; tentando audience general como fallback.",
      );
      route = await loadTenantWhatsAppRoute(supabaseAdmin, tenantId, "general");
    }
    const INSTANCE = route?.instanceName || null;
    const ROUTE_PORTAL_URL = safeCommunicationText(
      route?.identity?.portalUrl || FALLBACK_PORTAL_URL,
      2048,
    );

    if (!route || !INSTANCE) {
      return new Response(
        JSON.stringify({
          error:
            "⚠️ Nenhuma conexão institucional ativa encontrada para esta escola.",
          error_code: "missing_instance_connection",
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (!ROUTE_PORTAL_URL) {
      return json(
        {
          error: "⚠️ Nenhuma URL de portal configurada para esta escola.",
          error_code: "missing_portal_url",
        },
        503,
      );
    }
    if (!route?.identity?.portalUrl) {
      console.warn(
        "[Broadcast] tenant sem portalUrl configurado; usando fallback para claim-opportunity",
      );
    }
    if (mode === "group" && !route?.teachersGroupId) {
      return new Response(
        JSON.stringify({
          error:
            "⚠️ Configure o grupo de professores antes de divulgar em grupo.",
          error_code: "missing_group_route",
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    console.log(`[Broadcast] 🚀 Disparando oportunidade no modo ${mode}`);

    // Date Logic
    const dayOfWeek = calendarDayOfWeek(date);
    const dayString = DAY_MAP[dayOfWeek] || "Dia";
    const formattedDate = date.split("-").reverse().join("/");

    // 3. Create/Reuse Opportunity
    const createdSlot = {
      day: dayOfWeek,
      time: time,
      date: date,
      formatted: `${formattedDate} (${dayString})`,
    };

    let oppData: { id: string; claimGeneration: number };
    let allowTargetedReopen = false;

    if (opportunity_id) {
      const dispatchGuard = await loadOpportunityDispatchGuard(
        supabaseAdmin,
        tenantId,
        opportunity_id,
      );
      if (!dispatchGuard.ok) {
        return json(
          {
            error:
              "Falha de segurança ao validar a oportunidade antes do reenvio.",
            error_code: "dispatch_guard_failed",
          },
          409,
        );
      }

      const was_targeted_reopen = dispatchGuard.dispatchMode === "TARGETED";

      const { data: reopened, error: reopenError } = await supabaseAdmin.rpc(
        "reopen_trial_opportunity_for_broadcast",
        {
          p_tenant_id: tenantId,
          p_opportunity_id: opportunity_id,
          p_slots_proposed: [createdSlot],
          p_interests: interests || null,
          p_preferred_slots: preferred_slots || null,
        },
      );
      if (reopenError || !reopened?.ok) {
        console.error(
          "[Broadcast] Reabertura recusada:",
          reopenError || reopened?.error,
        );
        return new Response(
          JSON.stringify({
            error: "Não foi possível reabrir esta experimental com segurança.",
            error_code: "reopen_failed",
          }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      if (was_targeted_reopen) {
        console.info(
          "[Broadcast] Opção de reabertura solicitada para oportunidade direcionada; prosseguindo com redistribuição geral.",
        );
        allowTargetedReopen = true;
      }
      oppData = {
        id: opportunity_id,
        claimGeneration: Number(reopened.claim_generation),
      };
      student_name = safeCommunicationText(reopened.student_name, 120) ||
        "Aluno(a)";
      student_phone = typeof reopened.student_phone === "string"
        ? reopened.student_phone.replace(/\D/g, "").slice(0, 15)
        : "";
      oppKind = "TRIAL";
      console.log(
        `[Broadcast] ♻️ Oportunidade ${opportunity_id} reaberta para reagendamento`,
      );
    } else {
      const recentCutoff = new Date(Date.now() - 2 * 86400000).toISOString();
      const { data: recentOpen, error: recentError } = await supabaseAdmin
        .from("opportunities")
        .select("id,student_name,slots_proposed,claim_generation")
        .eq("tenant_id", tenantId)
        .eq("status", "OPEN")
        .eq("kind", oppKind)
        .eq("student_phone", student_phone || "")
        .gte("opened_at", recentCutoff)
        .order("opened_at", { ascending: false })
        .limit(10);
      if (recentError) throw new Error("DB Error: " + recentError.message);
      let reusable: any = null;
      for (const candidate of recentOpen || []) {
        const dispatchGuard = await loadOpportunityDispatchGuard(
          supabaseAdmin,
          tenantId,
          candidate.id,
        );
        if (!dispatchGuard.ok) {
          return json(
            {
              error: "Falha de segurança ao verificar solicitação anterior.",
              error_code: "dispatch_guard_failed",
            },
            409,
          );
        }
        if (dispatchGuard.dispatchMode === "TARGETED") {
          continue;
        }
        const candidateSlot = Array.isArray(candidate.slots_proposed)
          ? candidate.slots_proposed[0]
          : null;
        if (
          candidate.student_name !== student_name ||
          candidateSlot?.date !== date ||
          candidateSlot?.time !== time
        ) {
          continue;
        }
        reusable = candidate;
        break;
      }

      if (reusable) {
        oppData = {
          id: reusable.id,
          claimGeneration: Number(reusable.claim_generation),
        };
      } else {
        const { data: inserted, error: oppError } = await supabaseAdmin
          .from("opportunities")
          .insert({
            student_name: student_name,
            student_phone: student_phone || "",
            slots_proposed: [createdSlot],
            status: "OPEN",
            tenant_id: tenantId,
            interests: interests || null,
            user_id: userId,
            preferred_slots: preferred_slots || null,
            kind: oppKind,
          })
          .select("id,claim_generation")
          .single();
        if (oppError) throw new Error("DB Error: " + oppError.message);
        oppData = {
          id: inserted.id,
          claimGeneration: Number(inserted.claim_generation),
        };
      }
    }

    if (
      !Number.isInteger(oppData.claimGeneration) ||
      oppData.claimGeneration < 1
    ) {
      throw new Error("DB Error: invalid claim generation");
    }
    const dispatchGuard = await loadOpportunityDispatchGuard(
      supabaseAdmin,
      tenantId,
      oppData.id,
    );
    if (
      dispatchGuard.dispatchMode === "TARGETED" &&
      !allowTargetedReopen
    ) {
      return json(
        {
          error: "Esta solicitação é direcionada e não pode ser divulgada.",
          error_code: "targeted_opportunity",
        },
        409,
      );
    }
    if (!dispatchGuard.ok) {
      return json(
        {
          error: "Falha de segurança ao validar a oportunidade antes do envio.",
          error_code: "dispatch_guard_failed",
        },
        409,
      );
    }

    // 4. Construct URL with Params
    const claimLink = `${ROUTE_PORTAL_URL}/claim-opportunity?id=${
      encodeURIComponent(
        oppData.id,
      )
    }&g=${oppData.claimGeneration}`;

    // Build preferred slots text
    let preferredSlotsText = "";
    if (
      preferred_slots &&
      Array.isArray(preferred_slots) &&
      preferred_slots.length > 0
    ) {
      const slotLines = preferred_slots
        .map((s: { weekday: string; time: string }) => {
          const dayLabel = WEEKDAY_LABELS[s.weekday] || s.weekday;
          const timeShort = s.time.replace(":00", "h").replace(":", "h");
          return `  ${dayLabel} ${timeShort}`;
        })
        .join("\n");
      preferredSlotsText = `\n\n📅 *Preferências do aluno:*\n${slotLines}`;
    }

    const textMessage = oppKind === "TRAINING"
      ? `🎓⚡ *TREINAMENTO AO VIVO — ${formattedDate} (${dayString}) às ${time}*\n\n📚 *Tema:* ${student_name}\n🎯 *Foco:* ${
        interests || "Capacitação da equipe"
      }${preferredSlotsText}\n\n🏆 *Professor(a), quer participar deste treinamento?*\nO primeiro a clicar no link abaixo garante a vaga (remunerado como aula)!\n\n👇 *Aceitar agora:*\n${claimLink}`
      : `⚡ *EXPERIMENTAL — ${route.identity.brandName} — ${formattedDate} (${dayString}) às ${time}*\n\n📋 *Aluno:* ${student_name}\n🎯 *Objetivo:* ${
        interests || "Não informado"
      }${preferredSlotsText}\n\n🏆 *Professor(a), essa aula é sua?*\nO primeiro a clicar no link abaixo garante a aula experimental!\n\n👇 *Aceitar agora:*\n${claimLink}`;

    const endpoint = `${API_URL}/message/sendText/${
      encodeURIComponent(
        INSTANCE,
      )
    }`;

    // ============ MODO GRUPO: posta no grupo de professores configurado ============
    if (mode === "group") {
      const destinationGroup = route.teachersGroupId!;
      let ok = false;
      let failureReason: string | null = null;
      let failureStatus: number | null = null;

      try {
        for (const key of API_KEYS) {
          const result = await sendEvolutionText(
            endpoint,
            key,
            destinationGroup,
            textMessage,
          );
          if (result.providerStatus === 401) continue;
          failureReason = result.providerFailure;
          failureStatus = result.providerStatus;
          if (failureReason && result.providerPayload) {
            console.warn(
              "[Broadcast] Payload bruto provider (grupo):",
              result.providerPayload,
            );
          }
          ok = result.success;
          if (!ok) {
            console.warn(
              "[Broadcast] Falha no envio de grupo",
              destinationGroup.slice(-4),
              result.providerStatus,
              result.providerFailure,
            );
          }
          break;
        }
      } catch {
        ok = false;
      }

      if (!ok) {
        return json(
          {
            success: false,
            error: "WhatsApp delivery failed",
            provider_status: failureStatus,
            provider_error: failureReason,
            id: oppData.id,
            retryable: true,
          },
          502,
        );
      }

      return new Response(
        JSON.stringify({
          success: true,
          id: oppData.id,
          mode: "group",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ============ MODO INDIVIDUAL (default): DM só para professores ATIVOS ============
    //    Antes ia num broadcast de GRUPO: qualquer um no grupo (inclusive ex-professor
    //    desligado) recebia o convite. Agora o sistema escolhe a lista — desligado/
    //    suspenso NUNCA entra (mesma regra do is_teacher_notifiable). "O primeiro a
    //    clicar garante" continua valendo: o accept-opportunity tem trava atômica.
    const { data: memberships, error: membershipsError } = await supabaseAdmin
      .from("tenant_memberships")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("role", "TEACHER")
      .eq("status", "ACTIVE");

    if (membershipsError) {
      throw new Error("DB Error (memberships): " + membershipsError.message);
    }
    const activeTeacherIds = (memberships || []).map(
      (membership: { user_id: string }) => membership.user_id,
    );
    const { data: teachers, error: teachersErr } = activeTeacherIds.length
      ? await supabaseAdmin
        .from("profiles")
        .select("id, full_name, phone, status")
        .in("id", activeTeacherIds)
        .eq("lifecycle_status", "active")
      : { data: [], error: null };

    if (teachersErr) {
      throw new Error("DB Error (teachers): " + teachersErr.message);
    }

    const recipients = (teachers || [])
      .filter((t: any) => !INACTIVE_STATUS.includes(t.status || ""))
      .map((t: any) => ({
        id: t.id,
        name: t.full_name,
        phone: cleanTeacherPhone(t.phone || ""),
      }))
      .filter((t: any) => !!t.phone);

    let sent = 0;
    const failed: string[] = [];

    for (const r of recipients) {
      let ok = false;
      let failureReason: string | null = null;
      let failureStatus: number | null = null;
      let failurePayload: string | null = null;
      // Resolve o JID real (corrige o caso do 9º dígito) antes de enviar; se a
      // resolução falhar, cai pro número "no chute" como antes (não bloqueia envio).
      const targetNumber = (await resolveJid(INSTANCE, r.phone!)) || r.phone!;
      try {
        for (const key of API_KEYS) {
          const result = await sendEvolutionText(
            endpoint,
            key,
            targetNumber,
            textMessage,
          );
          if (result.providerStatus === 401) continue; // chave rotacionada → tenta a próxima
          failureReason = result.providerFailure;
          failureStatus = result.providerStatus;
          failurePayload = result.providerPayload;
          ok = result.success;
          if (!ok) {
            console.warn(
              "[Broadcast] Falha ao enviar p/ professor",
              r.id,
              result.providerStatus,
              result.providerFailure,
            );
            if (failurePayload) {
              console.warn(
                "[Broadcast] Payload bruto provider (professor):",
                failurePayload,
              );
            }
          }
          break;
        }
      } catch (err: any) {
        console.error(
          `[Broadcast] Falha ao enviar p/ ${r.name}:`,
          err?.message,
        );
        ok = false;
        failureReason = "network error";
      }
      if (ok) sent++;
      else {
        failed.push(
          `${r.name || r.id} (${failureReason || "failed"}${
            failureStatus ? `, status ${failureStatus}` : ""
          })`,
        );
      }
    }

    if (sent === 0) {
      return json(
        {
          success: false,
          error: recipients.length === 0
            ? "No active teacher recipient"
            : "WhatsApp delivery failed",
          error_code: recipients.length === 0
            ? "no_active_teacher_recipient"
            : "whatsapp_delivery_failed",
          id: oppData.id,
          failed: failed.slice(0, 20),
          retryable: true,
        },
        502,
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        id: oppData.id,
        mode: "individual",
        recipients: sent,
        total_active_teachers: recipients.length,
        failed: failed.length,
        warning: failed.length
          ? `${failed.length} professor(es) não recebeu(ram) o convite no envio.`
          : undefined,
        failed_details: failed.slice(0, 10),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: any) {
    console.error("Critical Error", error);
    return json({ error: "Broadcast failed" }, 500);
  }
});
