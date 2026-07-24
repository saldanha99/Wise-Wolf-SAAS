import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizePaymentTarget,
  loadClaimedEnrollmentOffer,
} from "../_shared/payment-auth.ts";
import type { PaymentAdminClient } from "../_shared/payment-auth.ts";
import {
  markEnrollmentFailure,
  markEnrollmentStage,
} from "../_shared/enrollment-progress.ts";

let ASAAS_URL = Deno.env.get("ASAAS_API_URL") || "https://api-sandbox.asaas.com";
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
  .replace(/\/v3$/, "")
  .replace(/\/api\/v3$/, "")
  .replace(/\/api$/, "");

const API_KEY = (
  Deno.env.get("ASAAS_API_KEY") || Deno.env.get("ASAAS_ACCESS_TOKEN") || ""
).trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) => new Response(
  JSON.stringify(body),
  { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
);

const digits = (value: unknown) => String(value || "").replace(/\D/g, "");
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function asaasPathPrefix() {
  return ASAAS_URL.includes("api-sandbox") || ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "/api/v3";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let progressAdmin: PaymentAdminClient | null = null;
  let progressOfferId = "";
  let progressUserId = "";

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const userId = text(body?.user_id);
    progressUserId = userId;
    if (!body || !userId) return json({ success: false, error: "user_id_required" }, 400);

    const authResult = await authorizePaymentTarget(req, userId, corsHeaders);
    if (authResult.error) return authResult.error;
    const authorization = authResult.authorization!;
    progressAdmin = authorization.admin;

    const profile = authorization.targetProfile;
    const isSelfStudent = !authorization.isService &&
      authorization.callerId === userId &&
      authorization.callerProfile?.role === "STUDENT";
    const offer = isSelfStudent
      ? await loadClaimedEnrollmentOffer(authorization.admin, userId)
      : null;
    progressOfferId = offer?.id || "";

    if (isSelfStudent && !offer) {
      return json({ success: false, error: "enrollment_offer_required" }, 403);
    }
    if (!API_KEY) {
      if (offer) {
        await markEnrollmentFailure(
          authorization.admin,
          offer.id,
          userId,
          "asaas_not_configured",
          "Integração financeira temporariamente indisponível.",
        );
      }
      return json({ success: false, error: "asaas_not_configured" }, 503);
    }

    const offerPayload = offer?.payload || {};
    const isDependent = offer
      ? Boolean(offerPayload.isDependent)
      : Boolean(body.is_dependent || profile.guardian_id || profile.guardian_cpf);

    const tenantId = offer?.tenant_id || text(profile.tenant_id) || text(body.tenant_id);
    const studentName = text(profile.full_name) || text(body.name);
    const studentEmail = text(profile.email) || text(body.email);
    const studentPhone = digits(profile.phone || body.phone || body.mobilePhone);

    const guardianName = offer
      ? text(offerPayload.guardianName)
      : text(profile.guardian_name || body.guardian_name);
    const guardianEmail = offer
      ? text(offerPayload.guardianEmail)
      : text(profile.guardian_email || body.guardian_email);
    const guardianPhone = offer
      ? digits(offerPayload.guardianPhone)
      : digits(profile.guardian_phone || body.guardian_phone);
    const guardianCpf = offer
      ? digits(offerPayload.guardianCpf)
      : digits(profile.guardian_cpf || body.guardian_cpf);

    const billingName = isDependent ? guardianName : studentName;
    const billingEmail = isDependent ? guardianEmail : studentEmail;
    const billingPhone = isDependent ? guardianPhone : studentPhone;
    const billingCpf = isDependent ? guardianCpf : digits(profile.cpf || body.cpf);

    if (!billingName || !billingEmail || billingPhone.length < 10 || billingCpf.length !== 11) {
      throw new Error("Nome, e-mail, telefone e CPF validos sao obrigatorios para a cobranca.");
    }

    const pathPrefix = asaasPathPrefix();
    let asaasCustomerId = text(profile.asaas_customer_id) || null;

    // Um retry recupera somente o customer desta identidade. Buscar apenas pelo
    // primeiro CPF poderia ligar outro dependente/tenant ao perfil atual.
    if (!asaasCustomerId) {
      const searchRes = await fetch(
        `${ASAAS_URL}${pathPrefix}/customers?cpfCnpj=${encodeURIComponent(billingCpf)}`,
        { headers: { access_token: API_KEY } },
      );
      if (searchRes.ok) {
        const searchData = await searchRes.json();
        const exactCustomer = (searchData.data || []).find(
          (candidate: Record<string, unknown>) =>
            candidate.deleted !== true && text(candidate.externalReference) === userId,
        );
        asaasCustomerId = text(exactCustomer?.id) || null;
      }
    }

    if (!asaasCustomerId) {
      const createRes = await fetch(`${ASAAS_URL}${pathPrefix}/customers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", access_token: API_KEY },
        body: JSON.stringify({
          name: billingName,
          cpfCnpj: billingCpf,
          email: billingEmail,
          mobilePhone: billingPhone,
          externalReference: userId,
          // Fixtures E2E autorizadas nunca disparam comunicações do Asaas.
          notificationDisabled: offerPayload.testMode === true,
          postalCode: text(profile.postal_code || body.postalCode),
          address: text(profile.address || body.address),
          addressNumber: text(profile.address_number || body.addressNumber),
        }),
      });

      const responseText = await createRes.text();
      let createData: Record<string, unknown> = {};
      try {
        createData = JSON.parse(responseText);
      } catch {
        throw new Error(`Asaas retornou ${createRes.status}`);
      }

      asaasCustomerId = text(createData.id) || null;
      if (!createRes.ok || !asaasCustomerId) {
        const errors = Array.isArray(createData.errors) ? createData.errors : [];
        const firstError = errors[0] as { description?: string } | undefined;
        throw new Error(
          firstError?.description || "Nao foi possivel cadastrar o cliente no Asaas.",
        );
      }
    }

    const profileUpdate: Record<string, unknown> = { asaas_customer_id: asaasCustomerId };
    if (offer) {
      profileUpdate.role = "STUDENT";
      profileUpdate.tenant_id = offer.tenant_id;
      profileUpdate.monthly_fee = numberValue(offerPayload.value);
      profileUpdate.due_day = numberValue(offerPayload.dueDay);
      profileUpdate.class_frequency = `${numberValue(offerPayload.classesPerWeek) || 1}x`;
      profileUpdate.professor_id = text(offerPayload.professorId) || null;
      profileUpdate.professor_id2 = text(offerPayload.professorId2) || null;
      profileUpdate.enrollment_fee = Number(offer.enrollment_fee || 0);
      profileUpdate.guardian_id = isDependent ? text(offerPayload.guardianId) || null : null;
      profileUpdate.guardian_name = isDependent ? guardianName || null : null;
      profileUpdate.guardian_cpf = isDependent ? guardianCpf || null : null;
      profileUpdate.guardian_email = isDependent ? guardianEmail || null : null;
      profileUpdate.guardian_phone = isDependent ? guardianPhone || null : null;
      profileUpdate.attendance_phone = isDependent ? digits(offerPayload.studentPhone) || null : null;
      profileUpdate.start_date = text(offerPayload.startDate) || null;
    }

    const { error: updateError } = await authorization.admin
      .from("profiles")
      .update(profileUpdate)
      .eq("id", userId);
    if (updateError) throw new Error(`profile_update_failed: ${updateError.message}`);

    // Agenda da oferta e idempotente: retries inserem apenas slots ausentes.
    const schedule = offer
      ? (Array.isArray(offerPayload.schedule) ? offerPayload.schedule : [])
      : (Array.isArray(body.classSchedule) ? body.classSchedule : []);
    const professorId = offer
      ? text(offerPayload.professorId)
      : text(profile.professor_id || body.professor_id);

    if (schedule.length > 0 && professorId) {
      const dayMap: Record<string, string> = {
        monday: "Segunda",
        tuesday: "Terca",
        wednesday: "Quarta",
        thursday: "Quinta",
        friday: "Sexta",
        saturday: "Sabado",
        sunday: "Domingo",
      };
      const { data: existingBookings, error: bookingsError } = await authorization.admin
        .from("bookings")
        .select("teacher_id, day_of_week, time_slot")
        .eq("student_id", userId);
      if (bookingsError) throw new Error(`booking_lookup_failed: ${bookingsError.message}`);

      const existing = new Set(
        (existingBookings || []).map((booking: Record<string, unknown>) =>
          `${booking.teacher_id}|${booking.day_of_week}|${booking.time_slot}`
        ),
      );
      const rows = schedule.flatMap((rawSlot) => {
        const slot = rawSlot as Record<string, unknown>;
        const rawDay = text(slot.weekday || slot.day);
        const day = dayMap[rawDay.toLowerCase()] || rawDay;
        const time = text(slot.time);
        const key = `${professorId}|${day}|${time}`;
        if (!day || !time || existing.has(key)) return [];
        existing.add(key);
        return [{
          tenant_id: tenantId,
          teacher_id: professorId,
          student_id: userId,
          day_of_week: day,
          time_slot: time,
          start_date: offer ? text(offerPayload.startDate) || new Date().toISOString().slice(0, 10) : text(body.startDate) || new Date().toISOString().slice(0, 10),
        }];
      });

      if (rows.length > 0) {
        const { error: insertError } = await authorization.admin.from("bookings").insert(rows);
        if (insertError) throw new Error(`booking_insert_failed: ${insertError.message}`);
      }
    }

    if (offer) {
      await markEnrollmentStage(
        authorization.admin,
        offer.id,
        userId,
        "CUSTOMER_READY",
        { metadata: { asaas_customer_id: asaasCustomerId } },
      );
    }

    return json({
      success: true,
      asaas_customer_id: asaasCustomerId,
      processing_state: offer ? "CUSTOMER_READY" : null,
      correlation_id: offer?.processing_correlation_id || null,
    });
  } catch (error) {
    console.error("[sync-student-asaas]", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    if (progressAdmin && progressOfferId && progressUserId) {
      await markEnrollmentFailure(
        progressAdmin,
        progressOfferId,
        progressUserId,
        error instanceof Error && error.message.startsWith("booking_")
          ? "booking_update_failed"
          : error instanceof Error && error.message.startsWith("profile_")
          ? "profile_update_failed"
          : "customer_sync_failed",
        error,
      );
    }
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Erro interno ao sincronizar aluno.",
    });
  }
});
