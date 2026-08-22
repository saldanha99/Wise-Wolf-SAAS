/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizePaymentTarget } from "../_shared/payment-auth.ts";
import {
  type BillingType,
  clientIp,
  digits,
  overdueConfirmationKey,
  overdueSummary,
  parseBillingType,
  parseCreditCard,
  parseSubscriptionPayments,
  paymentNoLongerNeedsCharge,
  safeProviderMessage,
  type SubscriptionPayment,
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

type CardHolder = {
  name: string;
  email: string;
  cpfCnpj: string;
  postalCode: string;
  addressNumber: string;
  phone: string;
  mobilePhone: string;
};

type ChargeClaim = {
  id: string;
  status: string;
  attempt_count: number;
  updated_at: string;
};

async function listOverduePayments(subscriptionId: string) {
  const records: unknown[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const result = await asaasRequest(
      `/subscriptions/${
        encodeURIComponent(subscriptionId)
      }/payments?limit=100&offset=${offset}`,
    );
    if (!result.response.ok) {
      throw new Error("subscription_payments_unavailable");
    }
    const page = Array.isArray(result.data.data) ? result.data.data : [];
    records.push(...page);
    if (page.length < 100 || result.data.hasMore !== true) break;
  }
  return parseSubscriptionPayments(records, subscriptionId);
}

async function acquireChargeClaim(
  authorization: Awaited<
    ReturnType<typeof authorizePaymentTarget>
  >["authorization"],
  payment: SubscriptionPayment,
  subscriptionId: string,
) {
  if (!authorization) throw new Error("authorization_missing");
  const now = new Date().toISOString();
  const payload = {
    tenant_id: text(authorization.targetProfile.tenant_id),
    student_id: authorization.targetProfile.id,
    asaas_subscription_id: subscriptionId,
    asaas_payment_id: payment.id,
    status: "PROCESSING",
    requested_by: authorization.callerId,
    processing_started_at: now,
    updated_at: now,
  };
  const { data: inserted, error: insertError } = await authorization.admin
    .from("student_overdue_card_charge_claims")
    .insert(payload)
    .select("id,status,attempt_count,updated_at")
    .single();
  if (!insertError && inserted) {
    return { kind: "CLAIMED" as const, claim: inserted as ChargeClaim };
  }
  if (insertError?.code !== "23505") {
    throw new Error(`charge_claim_failed:${insertError?.code || "unknown"}`);
  }

  const { data: existing, error: lookupError } = await authorization.admin
    .from("student_overdue_card_charge_claims")
    .select("id,status,attempt_count,updated_at")
    .eq("asaas_payment_id", payment.id)
    .maybeSingle();
  if (lookupError || !existing) throw new Error("charge_claim_lookup_failed");
  const claim = existing as ChargeClaim;
  if (claim.status === "SUCCEEDED") return { kind: "COMPLETED" as const };

  const age = Date.now() - new Date(claim.updated_at).getTime();
  if (
    (claim.status === "PROCESSING" || claim.status === "UNKNOWN") &&
    Number.isFinite(age) && age < 5 * 60_000
  ) {
    return { kind: "IN_PROGRESS" as const };
  }

  // Retomada por compare-and-swap. Antes deste ponto o chamador consultou o
  // Asaas e confirmou que a cobrança ainda está OVERDUE. Assim um timeout não
  // é repetido às cegas, e duas abas não conseguem assumir a mesma tentativa.
  const { data: reclaimed, error: reclaimError } = await authorization.admin
    .from("student_overdue_card_charge_claims")
    .update({
      status: "PROCESSING",
      attempt_count: Number(claim.attempt_count || 0) + 1,
      requested_by: authorization.callerId,
      processing_started_at: now,
      provider_status: null,
      provider_http_status: null,
      last_error: null,
      updated_at: now,
    })
    .eq("id", claim.id)
    .eq("updated_at", claim.updated_at)
    .select("id,status,attempt_count,updated_at")
    .maybeSingle();
  if (reclaimError) throw new Error("charge_claim_reclaim_failed");
  if (!reclaimed) return { kind: "IN_PROGRESS" as const };
  return { kind: "CLAIMED" as const, claim: reclaimed as ChargeClaim };
}

async function finishChargeClaim(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  claimId: string,
  status: "SUCCEEDED" | "DECLINED" | "UNKNOWN",
  providerStatus: string,
  providerHttpStatus: number | null,
  lastError: string | null,
) {
  const { error } = await authorization.admin
    .from("student_overdue_card_charge_claims")
    .update({
      status,
      provider_status: providerStatus || null,
      provider_http_status: providerHttpStatus,
      last_error: lastError,
      updated_at: new Date().toISOString(),
    })
    .eq("id", claimId);
  if (error) {
    console.warn("[update-student-billing-method] claim_finish_failed", {
      code: error.code,
    });
  }
}

async function chargeOverduePayment(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  payment: SubscriptionPayment,
  subscriptionId: string,
  cardPayload: Record<string, unknown>,
) {
  const encodedPaymentId = encodeURIComponent(payment.id);
  const current = await asaasRequest(`/payments/${encodedPaymentId}`);
  if (!current.response.ok) {
    return {
      success: false,
      error: "Nao foi possivel confirmar a fatura vencida.",
    };
  }
  const currentStatus = text(current.data.status).toUpperCase();
  if (
    text(current.data.subscription) !== subscriptionId ||
    paymentNoLongerNeedsCharge(currentStatus) || currentStatus !== "OVERDUE"
  ) {
    return { success: true, charged: false, value: 0, status: currentStatus };
  }

  const acquisition = await acquireChargeClaim(
    authorization,
    payment,
    subscriptionId,
  );
  if (acquisition.kind === "COMPLETED") {
    return { success: true, charged: false, value: 0, status: "CONFIRMED" };
  }
  if (acquisition.kind === "IN_PROGRESS") {
    return {
      success: false,
      error: "Esta fatura ja esta sendo processada em outra tela.",
    };
  }

  let chargeResult: Awaited<ReturnType<typeof asaasRequest>>;
  try {
    chargeResult = await asaasRequest(
      `/payments/${encodedPaymentId}/payWithCreditCard`,
      "POST",
      cardPayload,
    );
  } catch {
    const reconciled = await asaasRequest(`/payments/${encodedPaymentId}`)
      .catch(() => null);
    const reconciledStatus = text(reconciled?.data.status).toUpperCase();
    if (
      reconciled?.response.ok && paymentNoLongerNeedsCharge(reconciledStatus)
    ) {
      await finishChargeClaim(
        authorization,
        acquisition.claim.id,
        "SUCCEEDED",
        reconciledStatus,
        null,
        null,
      );
      return {
        success: true,
        charged: true,
        value: payment.value,
        status: reconciledStatus,
      };
    }
    await finishChargeClaim(
      authorization,
      acquisition.claim.id,
      "UNKNOWN",
      reconciledStatus,
      null,
      "provider_result_unknown",
    );
    return {
      success: false,
      error:
        "O cartão foi salvo, mas o resultado da cobrança precisa ser confirmado no Asaas antes de tentar novamente.",
    };
  }

  const providerStatus = text(chargeResult.data.status).toUpperCase();
  if (chargeResult.response.ok && paymentNoLongerNeedsCharge(providerStatus)) {
    await finishChargeClaim(
      authorization,
      acquisition.claim.id,
      "SUCCEEDED",
      providerStatus,
      chargeResult.response.status,
      null,
    );
    return {
      success: true,
      charged: true,
      value: payment.value,
      status: providerStatus,
    };
  }

  const reconciled = await asaasRequest(`/payments/${encodedPaymentId}`).catch(
    () => null,
  );
  const reconciledStatus = text(reconciled?.data.status).toUpperCase();
  if (reconciled?.response.ok && paymentNoLongerNeedsCharge(reconciledStatus)) {
    await finishChargeClaim(
      authorization,
      acquisition.claim.id,
      "SUCCEEDED",
      reconciledStatus,
      chargeResult.response.status,
      null,
    );
    return {
      success: true,
      charged: true,
      value: payment.value,
      status: reconciledStatus,
    };
  }

  const message = providerError(chargeResult.data);
  const terminalDecline = chargeResult.response.status >= 400 &&
    chargeResult.response.status < 500;
  await finishChargeClaim(
    authorization,
    acquisition.claim.id,
    terminalDecline ? "DECLINED" : "UNKNOWN",
    reconciledStatus || providerStatus,
    chargeResult.response.status,
    message,
  );
  return {
    success: false,
    error: terminalDecline
      ? `Cartao salvo para a recorrencia, mas a fatura vencida foi recusada: ${message}`
      : "Cartao salvo, mas nao foi possivel confirmar a cobranca vencida no Asaas.",
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
      let overdue: SubscriptionPayment[] = [];
      try {
        overdue = await listOverduePayments(subscriptionId);
      } catch {
        return json({
          success: false,
          error: "Nao foi possivel consultar as faturas da assinatura.",
        }, 502);
      }
      return json({
        success: true,
        billingType: currentType,
        subscriptionStatus: text(currentResult.data.status),
        overdue: overdueSummary(overdue),
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
    const tenantId = authorization.tenantId;
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
      const holder: CardHolder = {
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
        mobilePhone: isDependent
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
      let overduePayments: SubscriptionPayment[];
      try {
        overduePayments = await listOverduePayments(subscriptionId);
      } catch {
        return json({
          success: false,
          error: "Nao foi possivel verificar se existem faturas vencidas.",
        }, 502);
      }
      if (
        text(body.overdueConfirmationKey) !==
          overdueConfirmationKey(overduePayments)
      ) {
        return json({
          success: false,
          error:
            "A situacao das faturas mudou. Confira novamente antes de cadastrar o cartao.",
        }, 409);
      }

      const cardResult = await asaasRequest(
        `/subscriptions/${encodedId}/creditCard`,
        "PUT",
        {
          creditCard: card,
          creditCardHolderInfo: holder,
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

      const nestedCard = cardResult.data.creditCard &&
          typeof cardResult.data.creditCard === "object" &&
          !Array.isArray(cardResult.data.creditCard)
        ? cardResult.data.creditCard as Record<string, unknown>
        : {};
      const cardToken = text(cardResult.data.creditCardToken) ||
        text(nestedCard.creditCardToken);
      const immediateChargePayload: Record<string, unknown> = cardToken
        ? { creditCardToken: cardToken }
        : { creditCard: card, creditCardHolderInfo: holder };

      // A assinatura e as cobranças futuras são atualizadas primeiro. Depois,
      // somente as cobranças realmente OVERDUE são pagas agora. Cobranças
      // PENDING (aluno em dia) nunca entram neste laço.
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
          return json({
            success: false,
            error: providerError(updateResult.data),
          }, 422);
        }
      }

      const verified = await asaasRequest(`/subscriptions/${encodedId}`);
      const verifiedType = verified.response.ok
        ? parseBillingType(verified.data.billingType)
        : null;
      if (verifiedType !== nextType) {
        await audit(
          auditValues(
            nextType,
            "FAILED_VERIFICATION",
            verified.response.status,
          ),
        );
        return json({
          success: false,
          error: "A alteracao nao foi confirmada pelo Asaas.",
        }, 502);
      }

      let chargedNowCount = 0;
      let chargedNowTotal = 0;
      for (const payment of overduePayments) {
        const result = await chargeOverduePayment(
          authorization,
          payment,
          subscriptionId,
          immediateChargePayload,
        );
        if (!result.success) {
          await audit({
            ...auditValues(nextType, "CARD_SAVED_OVERDUE_CHARGE_FAILED"),
            overdue_found: overduePayments.length,
            charged_now: chargedNowCount,
          });
          return json({
            success: false,
            error: result.error,
            billingType: nextType,
            cardSaved: true,
            chargedNowCount,
            chargedNowTotal: Math.round(chargedNowTotal * 100) / 100,
          }, 422);
        }
        if (result.charged) {
          chargedNowCount += 1;
          chargedNowTotal += result.value;
        }
      }

      await audit({
        ...auditValues(nextType, "SUCCESS", verified.response.status),
        overdue_found: overduePayments.length,
        charged_now: chargedNowCount,
        charged_now_total: Math.round(chargedNowTotal * 100) / 100,
      });
      console.log("[update-student-billing-method] completed", {
        studentId: userId,
        from: currentType,
        to: nextType,
        overdueFound: overduePayments.length,
        chargedNow: chargedNowCount,
      });
      return json({
        success: true,
        billingType: nextType,
        pendingPaymentsUpdated: true,
        cardChargedNow: chargedNowCount > 0,
        chargedNowCount,
        chargedNowTotal: Math.round(chargedNowTotal * 100) / 100,
      });
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
