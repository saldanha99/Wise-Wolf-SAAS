import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authenticatedPaymentUserId,
  authorizePaymentTarget,
  loadClaimedEnrollmentOffer,
} from "../_shared/payment-auth.ts";
import type { PaymentAdminClient } from "../_shared/payment-auth.ts";
import {
  completeEnrollment,
  markEnrollmentFailure,
  markEnrollmentStage,
} from "../_shared/enrollment-progress.ts";

let ASAAS_URL = Deno.env.get("ASAAS_API_URL") || "https://api-sandbox.asaas.com";
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
  .replace(/\/v3$/, "")
  .replace(/\/api\/v3$/, "")
  .replace(/\/api$/, "");

const ASAAS_API_KEY = (
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

function paidStatus(status: string): boolean {
  return ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(status);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  let progressAdmin: PaymentAdminClient | null = null;
  let progressOfferId = "";
  let progressUserId = "";

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return json({ success: false, error: "invalid_request" }, 400);

    let targetUserId = text(body.user_id);
    if (!targetUserId) {
      const caller = await authenticatedPaymentUserId(req, corsHeaders);
      if (caller.error) return caller.error;
      targetUserId = caller.userId || "";
    }
    progressUserId = targetUserId;

    const authResult = await authorizePaymentTarget(req, targetUserId, corsHeaders);
    if (authResult.error) return authResult.error;
    const authorization = authResult.authorization!;
    progressAdmin = authorization.admin;
    const profile = authorization.targetProfile;

    const isSelfStudent = !authorization.isService &&
      authorization.callerId === targetUserId &&
      authorization.callerProfile?.role === "STUDENT";
    const offer = isSelfStudent
      ? await loadClaimedEnrollmentOffer(authorization.admin, targetUserId)
      : null;
    progressOfferId = offer?.id || "";

    if (isSelfStudent && !offer) {
      return json({ success: false, error: "enrollment_offer_required" }, 403);
    }
    if (!ASAAS_API_KEY) {
      if (offer) {
        await markEnrollmentFailure(
          authorization.admin,
          offer.id,
          targetUserId,
          "asaas_not_configured",
          "Integração financeira temporariamente indisponível.",
        );
      }
      return json({ success: false, error: "asaas_not_configured" }, 503);
    }

    const enrollmentRequired = offer
      ? offer.requires_enrollment !== false
      : numberValue(profile.enrollment_fee) !== null && Number(profile.enrollment_fee) > 0;
    const amount = offer
      ? numberValue(offer.enrollment_fee)
      : numberValue(profile.enrollment_fee);
    if (!enrollmentRequired || !amount || amount <= 0) {
      return json({ success: false, error: "enrollment_fee_not_required" }, 400);
    }

    const customerId = text(profile.asaas_customer_id);
    if (!customerId) {
      return json({ success: false, error: "student_not_synced_with_asaas" }, 409);
    }

    const metadata = offer?.metadata || {};
    const storedPaymentId = text(profile.enrollment_payment_id) ||
      text(metadata.enrollment_payment_id);
    const requestedPaymentId = text(body.paymentId);
    const action = text(body.action);
    const paymentId = storedPaymentId || requestedPaymentId;

    if (requestedPaymentId && storedPaymentId && requestedPaymentId !== storedPaymentId) {
      return json({ success: false, error: "payment_forbidden" }, 403);
    }

    const pathPrefix = asaasPathPrefix();
    const paymentReference = offer
      ? `enrollment:${offer.id}:fee`
      : targetUserId;

    if (action === "check") {
      if (!paymentId || paymentId !== storedPaymentId) {
        return json({ success: false, error: "payment_not_found" }, 404);
      }

      const checkRes = await fetch(
        `${ASAAS_URL}${pathPrefix}/payments/${encodeURIComponent(paymentId)}`,
        { headers: { access_token: ASAAS_API_KEY } },
      );
      if (!checkRes.ok) {
        return json({ success: false, status: "PENDING", error: "payment_check_failed" }, 502);
      }

      const payment = await checkRes.json();
      const status = text(payment.status) || "PENDING";
      const paid = paidStatus(status);
      if (paid && profile.enrollment_fee_paid !== true) {
        await authorization.admin.from("profiles").update({
          enrollment_fee_paid: true,
        }).eq("id", targetUserId).eq("enrollment_payment_id", paymentId);
      }

      let completion: Record<string, unknown> | null = null;
      if (offer) {
        await markEnrollmentStage(
          authorization.admin,
          offer.id,
          targetUserId,
          paid ? "BILLING_READY" : "AWAITING_PAYMENT",
          {
            metadata: {
              enrollment_payment_id: paymentId,
              ...(paid ? { enrollment_fee_paid_at: new Date().toISOString() } : {}),
            },
          },
        );
        if (paid) {
          completion = await completeEnrollment(
            authorization.admin,
            offer.id,
            targetUserId,
          );
        }
      }

      return json({
        success: true,
        status,
        paid,
        enrollment_complete: Boolean(completion),
        processing_state: completion ? "COMPLETED" : "AWAITING_PAYMENT",
        correlation_id: offer?.processing_correlation_id || null,
      });
    }

    if (action && action !== "create") {
      return json({ success: false, error: "action_not_allowed" }, 400);
    }

    let finalPaymentId = storedPaymentId;
    if (!finalPaymentId) {
      // Recupera uma cobrança criada antes de uma eventual queda entre o POST
      // remoto e a persistência local.
      const recoveryRes = await fetch(
        `${ASAAS_URL}${pathPrefix}/payments?externalReference=${
          encodeURIComponent(paymentReference)
        }&customer=${encodeURIComponent(customerId)}&limit=1`,
        { headers: { access_token: ASAAS_API_KEY } },
      );
      if (recoveryRes.ok) {
        const recoveryData = await recoveryRes.json().catch(() => ({}));
        const candidates = Array.isArray(recoveryData.data) ? recoveryData.data : [];
        finalPaymentId = text(
          candidates.find((candidate: Record<string, unknown>) =>
            candidate.deleted !== true
          )?.id,
        );
      }

      let split: Array<Record<string, unknown>> | undefined;
      const { data: tenant } = await authorization.admin
        .from("tenants")
        .select("asaas_wallet_id, asaas_split_percentage")
        .eq("id", text(profile.tenant_id))
        .maybeSingle();
      if (tenant?.asaas_wallet_id) {
        split = [{
          walletId: tenant.asaas_wallet_id,
          percentualValue: tenant.asaas_split_percentage ?? 90,
        }];
      }

      if (!finalPaymentId) {
        const paymentRes = await fetch(`${ASAAS_URL}${pathPrefix}/payments`, {
          method: "POST",
          headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
          body: JSON.stringify({
            customer: customerId,
            billingType: "PIX",
            value: amount,
            dueDate: new Date().toISOString().slice(0, 10),
            description: "Taxa de Matricula Wise Wolf School",
            externalReference: paymentReference,
            ...(split ? { split } : {}),
          }),
        });
        const payment = await paymentRes.json();
        finalPaymentId = text(payment.id);
        if (!paymentRes.ok || !finalPaymentId) {
          const errors = Array.isArray(payment.errors) ? payment.errors : [];
          const firstError = errors[0] as { description?: string } | undefined;
          return json({
            success: false,
            error: firstError?.description || "enrollment_payment_creation_failed",
          }, 502);
        }
      }

      const { error: profileUpdateError } = await authorization.admin
        .from("profiles")
        .update({
          enrollment_payment_id: finalPaymentId,
          enrollment_fee: amount,
          enrollment_fee_paid: false,
        })
        .eq("id", targetUserId);
      if (profileUpdateError) {
        console.error("[create-enrollment-pix] payment persisted remotely but profile update failed", {
          code: profileUpdateError.code,
        });
        return json({ success: false, error: "payment_persistence_failed" }, 500);
      }

    }

    if (offer) {
      await markEnrollmentStage(
        authorization.admin,
        offer.id,
        targetUserId,
        "AWAITING_PAYMENT",
        { metadata: { enrollment_payment_id: finalPaymentId } },
      );
    }

    const qrCodeRes = await fetch(
      `${ASAAS_URL}${pathPrefix}/payments/${encodeURIComponent(finalPaymentId)}/pixQrCode`,
      { headers: { access_token: ASAAS_API_KEY } },
    );
    const qrCode = await qrCodeRes.json();
    if (!qrCodeRes.ok || !text(qrCode.payload) || !text(qrCode.encodedImage)) {
      return json({ success: false, error: "pix_qr_code_failed" }, 502);
    }

    return json({
      success: true,
      paymentId: finalPaymentId,
      pixCode: text(qrCode.payload),
      qrCode: text(qrCode.encodedImage),
      idempotent: Boolean(storedPaymentId),
      processing_state: offer ? "AWAITING_PAYMENT" : null,
      correlation_id: offer?.processing_correlation_id || null,
    });
  } catch (error) {
    console.error("[create-enrollment-pix]", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    if (progressAdmin && progressOfferId && progressUserId) {
      await markEnrollmentFailure(
        progressAdmin,
        progressOfferId,
        progressUserId,
        "payment_creation_failed",
        error,
      );
    }
    return json({ success: false, error: "internal_error" }, 500);
  }
});
