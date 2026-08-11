/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizePaymentTarget } from "../_shared/payment-auth.ts";
import {
  type BillingType,
  clientIp,
  digits,
  parseBillingType,
  parseCreditCard,
  safeProviderMessage,
  text,
} from "./core.ts";

let ASAAS_URL = Deno.env.get("ASAAS_API_URL") ||
  "https://api-sandbox.asaas.com";
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
  .replace(/\/v3$/, "")
  .replace(/\/api\/v3$/, "")
  .replace(/\/api$/, "");

const ASAAS_API_KEY = (
  Deno.env.get("ASAAS_API_KEY") || Deno.env.get("ASAAS_ACCESS_TOKEN") || ""
).trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(
    JSON.stringify(body),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );

function asaasPathPrefix() {
  return ASAAS_URL.includes("api-sandbox") ||
      ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "/api/v3";
}

async function asaasRequest(
  path: string,
  method = "GET",
  payload?: Record<string, unknown>,
) {
  const response = await fetch(`${ASAAS_URL}${asaasPathPrefix()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      access_token: ASAAS_API_KEY,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { response, data: data as Record<string, unknown> };
}

function providerError(data: Record<string, unknown>): string {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const first = errors[0] && typeof errors[0] === "object"
    ? errors[0] as Record<string, unknown>
    : null;
  return safeProviderMessage(first?.description || data.error);
}

function auditValues(
  type: BillingType | null,
  status: string,
  providerStatus?: number,
) {
  return {
    billing_type: type,
    status,
    update_pending_payments: true,
    ...(providerStatus ? { provider_status: providerStatus } : {}),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ success: false, error: "method_not_allowed" }, 405);
  }
  if (!ASAAS_API_KEY) {
    return json({ success: false, error: "payment_provider_unavailable" }, 503);
  }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const userId = text(body.user_id);
    const action = text(body.action) || "GET";
    const { authorization, error } = await authorizePaymentTarget(
      req,
      userId,
      corsHeaders,
    );
    if (error || !authorization) return error!;

    const profile = authorization.targetProfile;
    const subscriptionId = text(profile.subscription_id);
    if (!subscriptionId) {
      return json({
        success: false,
        error: "Aluno sem assinatura automatica no Asaas.",
      }, 409);
    }

    const encodedId = encodeURIComponent(subscriptionId);
    const currentResult = await asaasRequest(`/subscriptions/${encodedId}`);
    if (!currentResult.response.ok) {
      return json({
        success: false,
        error: "Nao foi possivel consultar a assinatura no Asaas.",
      }, currentResult.response.status === 404 ? 404 : 502);
    }
    const currentType = parseBillingType(currentResult.data.billingType);
    if (!currentType) {
      return json({
        success: false,
        error: "Forma de pagamento atual nao suportada.",
      }, 409);
    }

    if (action.toUpperCase() === "GET") {
      return json({
        success: true,
        billingType: currentType,
        subscriptionStatus: text(currentResult.data.status),
      });
    }
    if (action.toUpperCase() !== "UPDATE") {
      return json({ success: false, error: "action_invalid" }, 400);
    }

    const nextType = parseBillingType(body.billingType);
    if (!nextType) {
      return json(
        { success: false, error: "Forma de pagamento invalida." },
        400,
      );
    }

    const actorId = authorization.callerId;
    const tenantId = text(profile.tenant_id);
    const audit = async (newValues: Record<string, unknown>) => {
      const { error: auditError } = await authorization.admin.from("audit_logs")
        .insert({
          tenant_id: tenantId,
          user_id: actorId,
          user_role: text(authorization.callerProfile?.role) ||
            (authorization.isService ? "SERVICE" : "STUDENT"),
          action: "updateStudentBillingMethod",
          resource_type: "student_subscription",
          resource_id: userId,
          old_values: auditValues(currentType, "ACTIVE"),
          new_values: newValues,
          ip_address: clientIp(req.headers),
        });
      if (auditError) {
        console.warn("[update-student-billing-method] audit_failed", {
          code: auditError.code,
        });
      }
    };

    if (nextType === currentType && nextType !== "CREDIT_CARD") {
      return json({ success: true, billingType: currentType, unchanged: true });
    }

    if (nextType === "CREDIT_CARD") {
      const card = parseCreditCard(body.creditCard);
      if (!card) {
        return json({
          success: false,
          error: "Dados do cartao incompletos ou invalidos.",
        }, 400);
      }

      const remoteIp = clientIp(req.headers);
      if (!remoteIp) {
        return json({
          success: false,
          error: "Nao foi possivel validar o dispositivo do pagador.",
        }, 400);
      }

      const isDependent = Boolean(profile.guardian_id || profile.guardian_cpf);
      const holder = {
        name: isDependent
          ? text(profile.guardian_name)
          : text(profile.full_name),
        email: isDependent ? text(profile.guardian_email) : text(profile.email),
        cpfCnpj: isDependent
          ? digits(profile.guardian_cpf)
          : digits(profile.cpf),
        postalCode: text(profile.postal_code),
        addressNumber: text(profile.address_number),
        phone: isDependent
          ? digits(profile.guardian_phone)
          : digits(profile.phone),
      };
      if (
        !holder.name || !holder.email || !holder.cpfCnpj ||
        !holder.postalCode || !holder.addressNumber || !holder.phone
      ) {
        return json({
          success: false,
          error: "Complete o cadastro do titular antes de trocar para cartao.",
        }, 409);
      }

      // Primeiro valida e associa o cartão. Se a mudança da forma de pagamento
      // falhar depois, a assinatura continua no método anterior e pode ser
      // tentada novamente sem criar assinatura ou cobrança duplicada.
      const cardResult = await asaasRequest(
        `/subscriptions/${encodedId}/creditCard`,
        "PUT",
        {
          creditCard: card,
          creditCardHolderInfo: { ...holder, mobilePhone: holder.phone },
          remoteIp,
        },
      );
      if (!cardResult.response.ok) {
        await audit(
          auditValues(
            nextType,
            "FAILED_CARD_VALIDATION",
            cardResult.response.status,
          ),
        );
        return json(
          { success: false, error: providerError(cardResult.data) },
          422,
        );
      }
    }

    if (nextType !== currentType) {
      const updateResult = await asaasRequest(
        `/subscriptions/${encodedId}`,
        "PUT",
        { billingType: nextType, updatePendingPayments: true },
      );
      if (!updateResult.response.ok) {
        await audit(
          auditValues(
            nextType,
            "FAILED_SUBSCRIPTION_UPDATE",
            updateResult.response.status,
          ),
        );
        return json(
          { success: false, error: providerError(updateResult.data) },
          422,
        );
      }
    }

    const verified = await asaasRequest(`/subscriptions/${encodedId}`);
    const verifiedType = verified.response.ok
      ? parseBillingType(verified.data.billingType)
      : null;
    if (verifiedType !== nextType) {
      await audit(
        auditValues(nextType, "FAILED_VERIFICATION", verified.response.status),
      );
      return json({
        success: false,
        error: "A alteracao nao foi confirmada pelo Asaas.",
      }, 502);
    }

    await audit(auditValues(nextType, "SUCCESS", verified.response.status));
    console.log("[update-student-billing-method] completed", {
      studentId: userId,
      from: currentType,
      to: nextType,
    });
    return json({
      success: true,
      billingType: nextType,
      pendingPaymentsUpdated: true,
      cardChargedNow: false,
    });
  } catch (cause) {
    console.error("[update-student-billing-method] unexpected", {
      type: cause instanceof Error ? cause.name : "UnknownError",
    });
    return json({
      success: false,
      error: "Nao foi possivel atualizar a forma de pagamento.",
    }, 500);
  }
});
