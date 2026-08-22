import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
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
const digits = (value: unknown) => String(value || "").replace(/\D/g, "");
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function asaasPathPrefix() {
  return ASAAS_URL.includes("api-sandbox") || ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "/api/v3";
}

function nextDueDate(dueDay: number, startMonth?: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const currentYear = Number(parts.find((part) => part.type === "year")?.value);
  const currentMonth = Number(parts.find((part) => part.type === "month")?.value);
  const currentDay = Number(parts.find((part) => part.type === "day")?.value);
  let year = currentYear;
  let month = currentMonth - 1;

  if (startMonth && /^\d{4}-\d{2}$/.test(startMonth)) {
    [year, month] = startMonth.split("-").map(Number);
    month -= 1;
  } else if (currentDay >= dueDay) {
    month += 1;
  }

  const todayUtc = Date.UTC(currentYear, currentMonth - 1, currentDay);
  let normalizedYear = year + Math.floor(month / 12);
  let normalizedMonth = ((month % 12) + 12) % 12;
  let lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
  let candidate = Date.UTC(normalizedYear, normalizedMonth, Math.min(dueDay, lastDay));

  while (candidate < todayUtc) {
    month += 1;
    normalizedYear = year + Math.floor(month / 12);
    normalizedMonth = ((month % 12) + 12) % 12;
    lastDay = new Date(Date.UTC(normalizedYear, normalizedMonth + 1, 0)).getUTCDate();
    candidate = Date.UTC(normalizedYear, normalizedMonth, Math.min(dueDay, lastDay));
  }

  return new Date(candidate).toISOString().slice(0, 10);
}

const paidStatus = (status: string) =>
  ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(status);

async function loadOneTimePaymentDetails(paymentId: string) {
  const pathPrefix = asaasPathPrefix();
  const paymentRes = await fetch(
    `${ASAAS_URL}${pathPrefix}/payments/${encodeURIComponent(paymentId)}`,
    { headers: { access_token: ASAAS_API_KEY } },
  );
  const payment = await paymentRes.json().catch(() => ({}));
  if (!paymentRes.ok) throw new Error("one_time_payment_lookup_failed");

  const billingType = text(payment.billingType);
  const status = text(payment.status) || "PENDING";
  let pixCode = "";
  let qrCode = "";

  if (billingType === "PIX") {
    const pixRes = await fetch(
      `${ASAAS_URL}${pathPrefix}/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
      { headers: { access_token: ASAAS_API_KEY } },
    );
    const pix = await pixRes.json().catch(() => ({}));
    if (pixRes.ok) {
      pixCode = text(pix.payload);
      qrCode = text(pix.encodedImage);
    }
  }

  return {
    billing_type: billingType,
    status,
    paid: paidStatus(status),
    invoice_url: text(payment.bankSlipUrl) || text(payment.invoiceUrl) || null,
    pixCode: pixCode || null,
    qrCode: qrCode || null,
  };
}

async function findPaymentByReference(
  externalReference: string,
  customerId: string,
): Promise<string | null> {
  const pathPrefix = asaasPathPrefix();
  const response = await fetch(
    `${ASAAS_URL}${pathPrefix}/payments?externalReference=${
      encodeURIComponent(externalReference)
    }&customer=${encodeURIComponent(customerId)}&limit=1`,
    { headers: { access_token: ASAAS_API_KEY } },
  );
  if (!response.ok) return null;
  const data = await response.json().catch(() => ({}));
  const payments = Array.isArray(data.data) ? data.data : [];
  return text(
    payments.find((payment: Record<string, unknown>) => payment.deleted !== true)?.id,
  ) || null;
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
      ? await loadClaimedEnrollmentOffer(authorization.admin, userId, authorization.tenantId)
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
          userId,
          "asaas_not_configured",
          "Integração financeira temporariamente indisponível.",
        );
      }
      return json({ success: false, error: "asaas_not_configured" }, 503);
    }

    const offerPayload = offer?.payload || {};
    const correlationId = offer?.processing_correlation_id || null;
    const subscriptionReference = offer
      ? `enrollment:${offer.id}:subscription`
      : userId;
    const oneTimeReference = offer
      ? `enrollment:${offer.id}:one-time`
      : userId;
    const proRataReference = offer
      ? `enrollment:${offer.id}:pro-rata`
      : userId;
    const action = text(body.action);
    if (action === "check_one_time") {
      const paymentId = text(offer?.metadata?.one_time_payment_id);
      if (!offer || numberValue(offerPayload.planDuration) !== 0 || !paymentId) {
        return json({ success: false, error: "one_time_payment_not_found" }, 404);
      }
      try {
        const details = await loadOneTimePaymentDetails(paymentId);
        let completion: Record<string, unknown> | null = null;
        if (details.paid) {
          await markEnrollmentStage(
            authorization.admin,
            offer.id,
            userId,
            "BILLING_READY",
            {
              metadata: {
                one_time_payment_id: paymentId,
                one_time_paid_at: new Date().toISOString(),
              },
            },
          );
          completion = await completeEnrollment(authorization.admin, offer.id, userId);
        } else {
          await markEnrollmentStage(
            authorization.admin,
            offer.id,
            userId,
            "AWAITING_PAYMENT",
            { metadata: { one_time_payment_id: paymentId } },
          );
        }
        return json({
          success: true,
          id: paymentId,
          payment_id: paymentId,
          ...details,
          enrollment_complete: Boolean(completion),
          processing_state: completion ? "COMPLETED" : "AWAITING_PAYMENT",
          correlation_id: correlationId,
        });
      } catch (error) {
        await markEnrollmentFailure(
          authorization.admin,
          offer.id,
          userId,
          "payment_check_failed",
          error,
        );
        return json({ success: false, error: "payment_check_failed" }, 502);
      }
    }
    if (action) return json({ success: false, error: "action_not_allowed" }, 400);

    const value = offer
      ? numberValue(offerPayload.value)
      : numberValue(body.value ?? profile.monthly_fee);
    const dueDay = offer
      ? numberValue(offerPayload.dueDay)
      : numberValue(body.dueDay ?? profile.due_day);
    const durationMonths = offer ? numberValue(offerPayload.planDuration) : null;
    const requestedPlan = text(body.planDuration);
    const planDuration = offer
      ? durationMonths === 0
        ? "ONE_TIME"
        : durationMonths === 12
        ? "ANNUAL"
        : durationMonths === 6
        ? "SEMESTER"
        : "RECURRENT"
      : ["ONE_TIME", "ANNUAL", "SEMESTER", "RECURRENT"].includes(requestedPlan)
      ? requestedPlan
      : "RECURRENT";
    const billingType = text(body.billingType);
    const startMonth = offer ? text(offerPayload.billingStartMonth) : text(body.startDate);
    const proRata = offer ? Boolean(offerPayload.enableProRata) : Boolean(body.proRata);
    const proRataValue = offer
      ? numberValue(offerPayload.proRataValue)
      : numberValue(body.proRataValue);

    if (!value || value <= 0 || !dueDay || dueDay < 1 || dueDay > 31) {
      return json({ success: false, error: "Valor ou vencimento invalido." });
    }
    if (!["PIX", "BOLETO", "CREDIT_CARD"].includes(billingType)) {
      return json({ success: false, error: "Forma de pagamento invalida." });
    }

    const asaasCustomerId = text(profile.asaas_customer_id);
    if (!asaasCustomerId) {
      return json({ success: false, error: "Aluno ainda nao foi sincronizado com o Asaas." });
    }
    const requiresEnrollmentPayment = Boolean(
      offer &&
        offer.requires_enrollment !== false &&
        (numberValue(offer.enrollment_fee) || 0) > 0,
    );

    const registerRecurringBilling = async (
      subscriptionId: string,
    ): Promise<Record<string, unknown> | null> => {
      if (!offer) return null;
      if (requiresEnrollmentPayment) {
        await markEnrollmentStage(
          authorization.admin,
          offer.id,
          userId,
          "AWAITING_PAYMENT",
          { metadata: { subscription_id: subscriptionId } },
        );
        return null;
      }
      await markEnrollmentStage(
        authorization.admin,
        offer.id,
        userId,
        "BILLING_READY",
        { metadata: { subscription_id: subscriptionId } },
      );
      return await completeEnrollment(authorization.admin, offer.id, userId);
    };

    // Assinaturas e pagamento avulso sao idempotentes no estado local.
    if (planDuration !== "ONE_TIME" && text(profile.subscription_id)) {
      const completion = await registerRecurringBilling(text(profile.subscription_id));
      return json({
        success: true,
        subscription_id: profile.subscription_id,
        id: profile.subscription_id,
        idempotent: true,
        enrollment_complete: Boolean(completion),
        processing_state: completion ? "COMPLETED" : "AWAITING_PAYMENT",
        correlation_id: correlationId,
      });
    }
    const previousOneTimeId = text(offer?.metadata?.one_time_payment_id);
    if (planDuration === "ONE_TIME" && previousOneTimeId) {
      const details = await loadOneTimePaymentDetails(previousOneTimeId);
      let completion: Record<string, unknown> | null = null;
      if (offer) {
        await markEnrollmentStage(
          authorization.admin,
          offer.id,
          userId,
          details.paid ? "BILLING_READY" : "AWAITING_PAYMENT",
          {
            metadata: {
              one_time_payment_id: previousOneTimeId,
              ...(details.paid ? { one_time_paid_at: new Date().toISOString() } : {}),
            },
          },
        );
        if (details.paid) {
          completion = await completeEnrollment(authorization.admin, offer.id, userId);
        }
      }
      return json({
        success: true,
        payment_id: previousOneTimeId,
        id: previousOneTimeId,
        payment_type: "ONE_TIME",
        idempotent: true,
        ...details,
        enrollment_complete: Boolean(completion),
        processing_state: completion ? "COMPLETED" : "AWAITING_PAYMENT",
        correlation_id: correlationId,
      });
    }

    const pathPrefix = asaasPathPrefix();

    // Fecha a janela "Asaas criou e a função caiu antes de salvar o ID local".
    if (planDuration === "ONE_TIME" && offer) {
      const recoveredPaymentId = await findPaymentByReference(
        oneTimeReference,
        asaasCustomerId,
      );
      if (recoveredPaymentId) {
        const details = await loadOneTimePaymentDetails(recoveredPaymentId);
        await markEnrollmentStage(
          authorization.admin,
          offer.id,
          userId,
          details.paid ? "BILLING_READY" : "AWAITING_PAYMENT",
          {
            metadata: {
              one_time_payment_id: recoveredPaymentId,
              ...(details.paid ? { one_time_paid_at: new Date().toISOString() } : {}),
            },
          },
        );
        const completion = details.paid
          ? await completeEnrollment(authorization.admin, offer.id, userId)
          : null;
        return json({
          success: true,
          id: recoveredPaymentId,
          payment_id: recoveredPaymentId,
          payment_type: "ONE_TIME",
          recovered: true,
          ...details,
          enrollment_complete: Boolean(completion),
          processing_state: completion ? "COMPLETED" : "AWAITING_PAYMENT",
          correlation_id: correlationId,
        });
      }
    }

    // Recupera assinatura ativa criada numa tentativa anterior antes de criar outra.
    if (planDuration !== "ONE_TIME") {
      try {
        const existingRes = await fetch(
          `${ASAAS_URL}${pathPrefix}/subscriptions?customer=${
            encodeURIComponent(asaasCustomerId)
          }&externalReference=${encodeURIComponent(subscriptionReference)}&status=ACTIVE&limit=1`,
          { headers: { access_token: ASAAS_API_KEY } },
        );
        if (existingRes.ok) {
          const existingData = await existingRes.json();
          const recoveredId = text(existingData.data?.[0]?.id);
          if (recoveredId) {
            await authorization.admin.from("profiles").update({
              subscription_id: recoveredId,
              status_financial: "ACTIVE",
              monthly_fee: value,
              due_day: dueDay,
            }).eq("id", userId);
            const completion = await registerRecurringBilling(recoveredId);
            return json({
              success: true,
              subscription_id: recoveredId,
              id: recoveredId,
              recovered: true,
              enrollment_complete: Boolean(completion),
              processing_state: completion ? "COMPLETED" : "AWAITING_PAYMENT",
              correlation_id: correlationId,
            });
          }
        }
      } catch (error) {
        console.warn("[create-asaas-subscription] precheck", {
          type: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    const isDependent = offer
      ? Boolean(offerPayload.isDependent)
      : Boolean(profile.guardian_id || profile.guardian_cpf);
    const holderFromRequest = body.creditCardHolderInfo && typeof body.creditCardHolderInfo === "object"
      ? body.creditCardHolderInfo as Record<string, unknown>
      : {};
    const holder = {
      name: isDependent
        ? text(profile.guardian_name)
        : text(profile.full_name),
      email: isDependent
        ? text(profile.guardian_email)
        : text(profile.email),
      cpfCnpj: isDependent
        ? digits(profile.guardian_cpf)
        : digits(profile.cpf),
      postalCode: text(profile.postal_code),
      addressNumber: text(profile.address_number),
      phone: isDependent
        ? digits(profile.guardian_phone)
        : digits(profile.phone),
    };

    // Funcionarios podem informar titular diferente; no autoatendimento os
    // dados do titular vem sempre do perfil/offer vinculados.
    if (!isSelfStudent && authorization.isStaff) {
      holder.name = text(holderFromRequest.name) || holder.name;
      holder.email = text(holderFromRequest.email) || holder.email;
      holder.cpfCnpj = digits(holderFromRequest.cpfCnpj) || holder.cpfCnpj;
      holder.postalCode = text(holderFromRequest.postalCode) || holder.postalCode;
      holder.addressNumber = text(holderFromRequest.addressNumber) || holder.addressNumber;
      holder.phone = digits(holderFromRequest.phone) || holder.phone;
    }

    const creditCard = body.creditCard && typeof body.creditCard === "object"
      ? body.creditCard as Record<string, unknown>
      : null;
    const paymentPayload: Record<string, unknown> = {
      customer: asaasCustomerId,
      billingType,
      value,
      externalReference: planDuration === "ONE_TIME"
        ? oneTimeReference
        : subscriptionReference,
    };

    if (billingType === "CREDIT_CARD") {
      if (!creditCard) return json({ success: false, error: "Dados do cartao obrigatorios." });
      if (!holder.cpfCnpj || !holder.phone || !holder.postalCode || !holder.addressNumber) {
        return json({ success: false, error: "Dados do titular do cartao incompletos." });
      }
      paymentPayload.creditCard = {
        holderName: text(creditCard.holderName),
        number: digits(creditCard.number),
        expiryMonth: text(creditCard.expiryMonth),
        expiryYear: text(creditCard.expiryYear),
        ccv: digits(creditCard.ccv),
      };
      paymentPayload.creditCardHolderInfo = {
        ...holder,
        mobilePhone: holder.phone,
      };
    }

    const tenantId = authorization.tenantId;
    let split: Array<Record<string, unknown>> | undefined;
    const { data: tenant } = await authorization.admin
      .from("tenants")
      .select("name,asaas_wallet_id,asaas_split_percentage")
      .eq("id", tenantId)
      .maybeSingle();
    const schoolName = text(tenant?.name).slice(0, 120) || "Escola de idiomas";
    if (tenant?.asaas_wallet_id) {
      split = [{
        walletId: tenant.asaas_wallet_id,
        percentualValue: tenant.asaas_split_percentage ?? 90,
      }];
    }

    if (planDuration === "ONE_TIME") {
      Object.assign(paymentPayload, {
        dueDate: new Date().toISOString().slice(0, 10),
        description: `Aula avulsa - ${schoolName}`,
        ...(split ? { split } : {}),
      });
      const paymentRes = await fetch(`${ASAAS_URL}${pathPrefix}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
        body: JSON.stringify(paymentPayload),
      });
      const paymentData = await paymentRes.json();
      const paymentId = text(paymentData.id);
      if (!paymentRes.ok || !paymentId) {
        return json({
          success: false,
          error: paymentData.errors?.[0]?.description || "Erro ao criar pagamento avulso.",
        });
      }

      const details = await loadOneTimePaymentDetails(paymentId);
      let completion: Record<string, unknown> | null = null;
      if (offer) {
        await markEnrollmentStage(
          authorization.admin,
          offer.id,
          userId,
          details.paid ? "BILLING_READY" : "AWAITING_PAYMENT",
          {
            metadata: {
              one_time_payment_id: paymentId,
              ...(details.paid ? { one_time_paid_at: new Date().toISOString() } : {}),
            },
          },
        );
        if (details.paid) {
          completion = await completeEnrollment(authorization.admin, offer.id, userId);
        }
      }
      return json({
        success: true,
        id: paymentId,
        payment_id: paymentId,
        payment_type: "ONE_TIME",
        ...details,
        enrollment_complete: Boolean(completion),
        processing_state: completion ? "COMPLETED" : "AWAITING_PAYMENT",
        correlation_id: correlationId,
      });
    }

    const maxPayments = planDuration === "ANNUAL" ? 12 : planDuration === "SEMESTER" ? 6 : null;
    const planLabel = planDuration === "ANNUAL"
      ? "Anual (12 Meses)"
      : planDuration === "SEMESTER"
      ? "Semestral (6 Meses)"
      : "Recorrente";
    Object.assign(paymentPayload, {
      nextDueDate: nextDueDate(dueDay, startMonth),
      cycle: "MONTHLY",
      maxPayments,
      description: `Mensalidade ${schoolName} - Plano ${planLabel}`,
      remoteIp: (req.headers.get("x-forwarded-for") || "127.0.0.1").split(",")[0].trim(),
      ...(split ? { split } : {}),
    });

    const subscriptionRes = await fetch(`${ASAAS_URL}${pathPrefix}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
      body: JSON.stringify(paymentPayload),
    });
    const subscriptionData = await subscriptionRes.json();
    const subscriptionId = text(subscriptionData.id);
    if (!subscriptionRes.ok || !subscriptionId) {
      return json({
        success: false,
        error: subscriptionData.errors?.[0]?.description || "Erro ao processar assinatura.",
      });
    }

    const { error: profileUpdateError } = await authorization.admin.from("profiles").update({
      subscription_id: subscriptionId,
      monthly_fee: value,
      due_day: dueDay,
      status_financial: "ACTIVE",
    }).eq("id", userId);
    if (profileUpdateError) {
      throw new Error(`subscription_saved_remotely_but_profile_failed: ${profileUpdateError.message}`);
    }

    // Pro-rata ocorre depois da assinatura e uma unica vez. Se falhar, a
    // assinatura principal permanece valida e o erro fica registrado.
    let proRataChargeId: string | null = null;
    if (proRata && proRataValue && proRataValue > 0) {
      try {
        const recoveredProRataId = offer
          ? await findPaymentByReference(proRataReference, asaasCustomerId)
          : null;
        const proRataPayload: Record<string, unknown> = {
          customer: asaasCustomerId,
          billingType: billingType === "CREDIT_CARD" ? "CREDIT_CARD" : "PIX",
          value: proRataValue,
          dueDate: new Date().toISOString().slice(0, 10),
          description: `Pro-rata - ${schoolName}`,
          externalReference: proRataReference,
          ...(split ? { split } : {}),
        };
        if (billingType === "CREDIT_CARD") {
          proRataPayload.creditCard = paymentPayload.creditCard;
          proRataPayload.creditCardHolderInfo = paymentPayload.creditCardHolderInfo;
        }
        if (recoveredProRataId) {
          proRataChargeId = recoveredProRataId;
        } else {
          const proRataRes = await fetch(`${ASAAS_URL}${pathPrefix}/payments`, {
            method: "POST",
            headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
            body: JSON.stringify(proRataPayload),
          });
          if (proRataRes.ok) {
            proRataChargeId = text((await proRataRes.json()).id) || null;
          } else {
            console.error("[create-asaas-subscription] pro-rata", {
              status: proRataRes.status,
            });
          }
        }
      } catch (error) {
        console.error("[create-asaas-subscription] pro-rata", {
          type: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    // Habilitacao de notificacoes e melhor-esforco; fixtures E2E permanecem
    // silenciosas em todas as etapas.
    if (offerPayload.testMode !== true) {
      try {
        const notificationsRes = await fetch(
          `${ASAAS_URL}${pathPrefix}/customers/${encodeURIComponent(asaasCustomerId)}/notifications`,
          { headers: { access_token: ASAAS_API_KEY } },
        );
        if (notificationsRes.ok) {
          const notificationsData = await notificationsRes.json();
          for (const notification of notificationsData.data || notificationsData || []) {
            if (notification.id && !notification.whatsappEnabledForCustomer) {
              await fetch(`${ASAAS_URL}${pathPrefix}/notifications/${notification.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", access_token: ASAAS_API_KEY },
                body: JSON.stringify({
                  enabled: true,
                  emailEnabledForCustomer: true,
                  smsEnabledForCustomer: true,
                  whatsappEnabledForCustomer: true,
                }),
              });
            }
          }
        }
      } catch (error) {
        console.warn("[create-asaas-subscription] notifications", {
          type: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    const completion = await registerRecurringBilling(subscriptionId);
    return json({
      success: true,
      subscription_id: subscriptionId,
      id: subscriptionId,
      pro_rata_charge_id: proRataChargeId,
      enrollment_complete: Boolean(completion),
      processing_state: completion ? "COMPLETED" : offer ? "AWAITING_PAYMENT" : null,
      correlation_id: correlationId,
    });
  } catch (error) {
    console.error("[create-asaas-subscription]", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    if (progressAdmin && progressOfferId && progressUserId) {
      await markEnrollmentFailure(
        progressAdmin,
        progressOfferId,
        progressUserId,
        "billing_creation_failed",
        error,
      );
    }
    return json({
      success: false,
      error: error instanceof Error ? error.message : "Erro interno ao criar cobranca.",
    });
  }
});
