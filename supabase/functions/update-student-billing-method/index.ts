/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  AsaasCapabilityFenceError,
  type AsaasMutationPurpose,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import { guardAsaasMutationTarget } from "../_shared/asaas-mutation-guard.ts";
import { authorizePaymentTarget } from "../_shared/payment-auth.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
  TenantIntegrationBrokerError,
  type TenantIntegrationRpcClient,
} from "../_shared/tenant-integration-broker.ts";
import {
  ambiguousProviderMutationStatus,
  deterministicProviderDeclineStatus,
} from "../_shared/student-provider-lifecycle.ts";
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
  providerSubscriptionCardMatchesLast4,
  safeProviderMessage,
  type SubscriptionPayment,
  text,
} from "./core.ts";

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

type AsaasRequest = (
  path: string,
  method?: string,
  payload?: Record<string, unknown>,
) => Promise<{ response: Response; data: Record<string, unknown> }>;

function createAsaasRequest(
  admin: TenantIntegrationRpcClient,
  tenantId: string,
  integration: ResolvedAsaasIntegration,
  mutationPurpose?: AsaasMutationPurpose,
): AsaasRequest {
  return async (path, method = "GET", payload) => {
    const normalizedMethod = method.toUpperCase();
    let requestIntegration = integration;
    if (normalizedMethod !== "GET") {
      if (!mutationPurpose) throw new AsaasCapabilityFenceError("CHANGED");
      requestIntegration = await revalidateAsaasMutationCapability(admin, {
        tenantId,
        purpose: mutationPurpose,
        expected: integration,
      });
    }
    const response = await fetch(`${requestIntegration.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        access_token: requestIntegration.apiKey,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(normalizedMethod === "GET" ? 12_000 : 25_000),
    });
    const data = await response.json().catch(() => ({}));
    return { response, data: data as Record<string, unknown> };
  };
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
  claimToken: string;
};

type BillingMethodOperation = {
  id: string;
  token: string;
  action: "SUBMIT_ONCE" | "RECONCILE_REQUIRED";
  targetBillingType: BillingType;
  cardLast4: string;
};

async function beginBillingMethodOperation(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  integration: ResolvedAsaasIntegration,
  input: {
    customerId: string;
    subscriptionId: string;
    sourceBillingType: BillingType;
    targetBillingType: BillingType;
    cardLast4: string | null;
  },
): Promise<
  | { kind: "CLAIMED"; operation: BillingMethodOperation }
  | { kind: "IN_PROGRESS" }
  | { kind: "REVIEW_REQUIRED" }
> {
  const token = crypto.randomUUID();
  const { data, error } = await authorization.admin.rpc(
    "begin_student_billing_method_operation",
    {
      p_tenant_id: authorization.tenantId,
      p_student_id: authorization.targetProfile.id,
      p_requested_by: authorization.callerId,
      p_customer_id: input.customerId,
      p_subscription_id: input.subscriptionId,
      p_source_billing_type: input.sourceBillingType,
      p_target_billing_type: input.targetBillingType,
      p_card_last4: input.cardLast4,
      p_integration_id: integration.integrationId,
      p_integration_version: integration.version,
      p_integration_environment: integration.environment,
      p_integration_mode: integration.mode,
      p_claim_token: token,
      p_lease_seconds: 300,
    },
  );
  if (error || !data || typeof data !== "object") {
    throw new Error(`billing_method_claim_failed:${error?.code || "invalid"}`);
  }
  const result = data as Record<string, unknown>;
  const action = text(result.action);
  if (action === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
  if (action === "REVIEW_REQUIRED" || result.ok !== true) {
    return { kind: "REVIEW_REQUIRED" };
  }
  const id = text(result.operation_id);
  const returnedToken = text(result.claim_token);
  const targetBillingType = parseBillingType(result.target_billing_type);
  const cardLast4 = text(result.card_last4);
  if (
    !["SUBMIT_ONCE", "RECONCILE_REQUIRED"].includes(action) || !id ||
    returnedToken !== token || !targetBillingType ||
    targetBillingType !== input.targetBillingType ||
    (targetBillingType === "CREDIT_CARD" && cardLast4 !== input.cardLast4) ||
    (targetBillingType !== "CREDIT_CARD" && cardLast4)
  ) {
    throw new Error("billing_method_claim_response_invalid");
  }
  return {
    kind: "CLAIMED",
    operation: {
      id,
      token,
      action: action as BillingMethodOperation["action"],
      targetBillingType,
      cardLast4,
    },
  };
}

async function markBillingMethodMutating(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  operation: BillingMethodOperation,
): Promise<boolean> {
  const { data, error } = await authorization.admin.rpc(
    "mark_student_billing_method_mutating",
    { p_operation_id: operation.id, p_claim_token: operation.token },
  );
  return !error && data?.ok === true;
}

async function finishBillingMethodOperation(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  operation: BillingMethodOperation,
  outcome: "COMPLETE" | "FAILED" | "UNKNOWN" | "BLOCKED",
  providerHttpStatus: number | null,
  lastError: string | null,
): Promise<boolean> {
  const { data, error } = await authorization.admin.rpc(
    "finish_student_billing_method_operation",
    {
      p_operation_id: operation.id,
      p_claim_token: operation.token,
      p_outcome: outcome,
      p_provider_http_status: providerHttpStatus,
      p_last_error: lastError,
    },
  );
  if (error || data?.ok !== true) {
    console.warn("[update-student-billing-method] operation_finish_failed", {
      code: error?.code || data?.reason || "claim_lost",
      outcome,
    });
    return false;
  }
  return true;
}

async function listOverduePayments(
  asaasRequest: AsaasRequest,
  subscriptionId: string,
) {
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
  const claimToken = crypto.randomUUID();
  const { data, error } = await authorization.admin.rpc(
    "claim_student_overdue_card_charge",
    {
      p_tenant_id: authorization.tenantId,
      p_student_id: authorization.targetProfile.id,
      p_subscription_id: subscriptionId,
      p_payment_id: payment.id,
      p_requested_by: authorization.callerId,
      p_claim_token: claimToken,
      p_lease_seconds: 300,
    },
  );
  if (error || !data || typeof data !== "object") {
    throw new Error(`charge_claim_failed:${error?.code || "invalid_response"}`);
  }
  const result = data as Record<string, unknown>;
  const action = text(result.action);
  if (action === "COMPLETED") return { kind: "COMPLETED" as const };
  if (action === "IN_PROGRESS") return { kind: "IN_PROGRESS" as const };
  if (action === "REVIEW_REQUIRED" || result.ok !== true) {
    return { kind: "REVIEW_REQUIRED" as const };
  }
  const claimId = text(result.claim_id);
  const returnedToken = text(result.claim_token);
  if (action !== "SUBMIT_ONCE" || !claimId || returnedToken !== claimToken) {
    throw new Error("charge_claim_response_invalid");
  }
  return {
    kind: "CLAIMED" as const,
    claim: { id: claimId, claimToken } satisfies ChargeClaim,
  };
}

async function finishChargeClaim(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  claim: ChargeClaim,
  status: "SUCCEEDED" | "DECLINED" | "UNKNOWN" | "BLOCKED",
  providerStatus: string,
  providerHttpStatus: number | null,
  lastError: string | null,
) {
  const { data, error } = await authorization.admin.rpc(
    "finish_student_overdue_card_charge",
    {
      p_claim_id: claim.id,
      p_claim_token: claim.claimToken,
      p_status: status,
      p_provider_status: providerStatus || null,
      p_provider_http_status: providerHttpStatus,
      p_last_error: lastError,
    },
  );
  if (error || data?.ok !== true) {
    console.warn("[update-student-billing-method] claim_finish_failed", {
      code: error?.code || data?.reason || "claim_lost",
    });
    return false;
  }
  return true;
}

async function markChargeSubmitting(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  claim: ChargeClaim,
) {
  const { data, error } = await authorization.admin.rpc(
    "mark_student_overdue_card_charge_submitting",
    { p_claim_id: claim.id, p_claim_token: claim.claimToken },
  );
  return !error && data?.ok === true;
}

async function chargeOverduePayment(
  authorization: NonNullable<
    Awaited<ReturnType<typeof authorizePaymentTarget>>["authorization"]
  >,
  payment: SubscriptionPayment,
  subscriptionId: string,
  cardPayload: Record<string, unknown>,
  paymentIntegration: ResolvedAsaasIntegration,
  asaasRequest: AsaasRequest,
) {
  const encodedPaymentId = encodeURIComponent(payment.id);
  const customerId = text(authorization.targetProfile.asaas_customer_id);
  const guardPayment = (operation: string) =>
    guardAsaasMutationTarget({
      admin: authorization.admin,
      baseUrl: paymentIntegration.baseUrl,
      apiKey: paymentIntegration.apiKey,
      operation,
      target: {
        tenantId: authorization.tenantId,
        studentId: authorization.targetProfile.id,
        resource: "payment",
        entityId: payment.id,
        customerId,
        subscriptionId,
        subscriptionMatch: "required",
      },
    });
  const current = await guardPayment("billing_method_overdue_payment_read");
  if (!current.ok) {
    return {
      success: false,
      error: "A fatura precisa de revisao antes da cobranca.",
    };
  }
  const currentStatus = text(current.entity.status).toUpperCase();
  if (
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
  if (acquisition.kind === "REVIEW_REQUIRED") {
    return {
      success: false,
      error:
        "Esta fatura tem uma tentativa anterior sem resultado confirmado. Consulte o Asaas antes de tentar novamente.",
    };
  }

  // O claim evita duas tentativas concorrentes; esta segunda leitura, feita
  // imediatamente antes do POST financeiro, elimina uma troca de vínculo entre
  // a primeira consulta e a aquisição do claim.
  const finalGuard = await guardPayment(
    "billing_method_overdue_payment_charge",
  );
  if (!finalGuard.ok) {
    await finishChargeClaim(
      authorization,
      acquisition.claim,
      "BLOCKED",
      "",
      finalGuard.providerStatus,
      "provider_identity_unverified",
    );
    return {
      success: false,
      error: "A fatura precisa de revisao antes da cobranca.",
    };
  }
  const finalStatus = text(finalGuard.entity.status).toUpperCase();
  if (paymentNoLongerNeedsCharge(finalStatus)) {
    await finishChargeClaim(
      authorization,
      acquisition.claim,
      "SUCCEEDED",
      finalStatus,
      finalGuard.providerStatus,
      null,
    );
    return { success: true, charged: false, value: 0, status: finalStatus };
  }
  if (finalStatus !== "OVERDUE") {
    await finishChargeClaim(
      authorization,
      acquisition.claim,
      "BLOCKED",
      finalStatus,
      finalGuard.providerStatus,
      "payment_no_longer_overdue",
    );
    return {
      success: false,
      error: "A situacao da fatura mudou. Consulte novamente antes de cobrar.",
    };
  }

  // Crossing this fence is irreversible: SUBMITTING and UNKNOWN are never
  // reclaimed for another POST, even after a lease expires.
  if (!await markChargeSubmitting(authorization, acquisition.claim)) {
    return {
      success: false,
      error: "A tentativa perdeu a trava de seguranca antes da cobranca.",
    };
  }

  let chargeResult: Awaited<ReturnType<AsaasRequest>>;
  try {
    chargeResult = await asaasRequest(
      `/payments/${encodedPaymentId}/payWithCreditCard`,
      "POST",
      cardPayload,
    );
  } catch (error) {
    if (error instanceof AsaasCapabilityFenceError) {
      await finishChargeClaim(
        authorization,
        acquisition.claim,
        "BLOCKED",
        "",
        null,
        error.failure === "UNAVAILABLE"
          ? "payment_capability_unavailable_before_submit"
          : "payment_capability_changed_before_submit",
      );
      return {
        success: false,
        error: error.failure === "UNAVAILABLE"
          ? "A capacidade de cobrança no Asaas está indisponível."
          : "A credencial de cobrança mudou; a tentativa foi bloqueada.",
      };
    }
    const reconciled = await guardPayment(
      "billing_method_overdue_payment_reconcile",
    ).catch(() => null);
    const reconciledStatus = reconciled?.ok
      ? text(reconciled.entity.status).toUpperCase()
      : "";
    if (reconciled?.ok && paymentNoLongerNeedsCharge(reconciledStatus)) {
      await finishChargeClaim(
        authorization,
        acquisition.claim,
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
      acquisition.claim,
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
      acquisition.claim,
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

  const reconciled = await guardPayment(
    "billing_method_overdue_payment_reconcile",
  ).catch(() => null);
  const reconciledStatus = reconciled?.ok
    ? text(reconciled.entity.status).toUpperCase()
    : "";
  if (reconciled?.ok && paymentNoLongerNeedsCharge(reconciledStatus)) {
    await finishChargeClaim(
      authorization,
      acquisition.claim,
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
  const ambiguousOutcome = ambiguousProviderMutationStatus(
    chargeResult.response.status,
  );
  const terminalDecline = deterministicProviderDeclineStatus(
    chargeResult.response.status,
  ) && !ambiguousOutcome;
  await finishChargeClaim(
    authorization,
    acquisition.claim,
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

  const preAuth = await authorizeRequest(req, {
    allowService: true,
    allowedRoles: [
      "STUDENT",
      "SCHOOL_ADMIN",
      "SUPER_ADMIN",
      "COORDINATOR",
    ],
    corsHeaders,
  });
  if (preAuth.ok === false) {
    return preAuth.response;
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
    const normalizedAction = action.toUpperCase();
    if (!["GET", "UPDATE"].includes(normalizedAction)) {
      return json({ success: false, error: "action_invalid" }, 400);
    }
    const integration = await resolveAsaasIntegration(
      authorization.admin,
      authorization.tenantId,
      normalizedAction === "GET" ? "subscription.read" : "subscription.update",
    );
    const asaasRequest = createAsaasRequest(
      authorization.admin,
      authorization.tenantId,
      integration,
      normalizedAction === "UPDATE" ? "subscription.update" : undefined,
    );
    const paymentIntegration = normalizedAction === "UPDATE"
      ? await resolveAsaasIntegration(
        authorization.admin,
        authorization.tenantId,
        "payment.update",
      )
      : null;
    const paymentRequest = paymentIntegration
      ? createAsaasRequest(
        authorization.admin,
        authorization.tenantId,
        paymentIntegration,
        "payment.update",
      )
      : null;

    const encodedId = encodeURIComponent(subscriptionId);
    const customerId = text(profile.asaas_customer_id);
    const guardSubscription = (operation: string) =>
      guardAsaasMutationTarget({
        admin: authorization.admin,
        baseUrl: integration.baseUrl,
        apiKey: integration.apiKey,
        operation,
        target: {
          tenantId: authorization.tenantId,
          studentId: profile.id,
          resource: "subscription",
          entityId: subscriptionId,
          customerId,
          subscriptionId,
          subscriptionMatch: "entity_id",
        },
      });
    const currentResult = await guardSubscription(
      "billing_method_subscription_read",
    );
    if (currentResult.ok === false) {
      const identityFailure = currentResult.code === "IDENTITY_MISMATCH" ||
        currentResult.code === "CANONICAL_BINDING_INVALID" ||
        currentResult.code === "REFERENCE_UNAVAILABLE";
      return json(
        {
          success: false,
          error: identityFailure
            ? "A assinatura precisa de revisao antes da alteracao."
            : "Nao foi possivel consultar a assinatura no Asaas.",
        },
        identityFailure ? 409 : currentResult.code === "NOT_FOUND" ? 404 : 502,
      );
    }
    const currentType = parseBillingType(currentResult.entity.billingType);
    if (!currentType) {
      return json({
        success: false,
        error: "Forma de pagamento atual nao suportada.",
      }, 409);
    }

    if (normalizedAction === "GET") {
      let overdue: SubscriptionPayment[] = [];
      try {
        overdue = await listOverduePayments(asaasRequest, subscriptionId);
      } catch {
        return json({
          success: false,
          error: "Nao foi possivel consultar as faturas da assinatura.",
        }, 502);
      }
      return json({
        success: true,
        billingType: currentType,
        subscriptionStatus: text(currentResult.entity.status),
        overdue: overdueSummary(overdue),
      });
    }
    if (!paymentRequest || !paymentIntegration) {
      throw new Error("payment_integration_unavailable");
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

    let card: ReturnType<typeof parseCreditCard> = null;
    let holder: CardHolder | null = null;
    let remoteIp: string | null = null;
    let overduePayments: SubscriptionPayment[] = [];
    let immediateChargePayload: Record<string, unknown> | null = null;
    const cardLast4 = nextType === "CREDIT_CARD"
      ? digits((body.creditCard as Record<string, unknown> | null)?.number)
        .slice(-4)
      : null;

    if (nextType === "CREDIT_CARD") {
      card = parseCreditCard(body.creditCard);
      if (!card) {
        return json({
          success: false,
          error: "Dados do cartao incompletos ou invalidos.",
        }, 400);
      }
      remoteIp = clientIp(req.headers);
      if (!remoteIp) {
        return json({
          success: false,
          error: "Nao foi possivel validar o dispositivo do pagador.",
        }, 400);
      }
      const isDependent = Boolean(profile.guardian_id || profile.guardian_cpf);
      holder = {
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
      try {
        overduePayments = await listOverduePayments(
          asaasRequest,
          subscriptionId,
        );
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
      immediateChargePayload = {
        creditCard: card,
        creditCardHolderInfo: holder,
      };
    }

    const acquisition = await beginBillingMethodOperation(
      authorization,
      integration,
      {
        customerId,
        subscriptionId,
        sourceBillingType: currentType,
        targetBillingType: nextType,
        cardLast4,
      },
    );
    if (acquisition.kind === "IN_PROGRESS") {
      return json({
        success: false,
        error: "A forma de pagamento ja esta sendo atualizada em outra tela.",
      }, 409);
    }
    if (acquisition.kind === "REVIEW_REQUIRED") {
      return json({
        success: false,
        error:
          "A alteracao anterior precisa ser conciliada no Asaas antes de continuar.",
      }, 409);
    }
    const operation = acquisition.operation;
    const verifyPostcondition = async (operationName: string) => {
      const verification = await guardSubscription(operationName);
      if (!verification.ok) {
        return {
          matches: false,
          providerStatus: verification.providerStatus,
        };
      }
      const billingMatches =
        parseBillingType(verification.entity.billingType) === nextType;
      const cardMatches = nextType !== "CREDIT_CARD" ||
        providerSubscriptionCardMatchesLast4(
          verification.entity,
          operation.cardLast4,
        );
      return {
        matches: billingMatches && cardMatches,
        providerStatus: verification.providerStatus,
      };
    };

    let verifiedProviderStatus: number | null = null;
    if (operation.action === "RECONCILE_REQUIRED") {
      const reconciled = await verifyPostcondition(
        "billing_method_subscription_reconcile",
      );
      verifiedProviderStatus = reconciled.providerStatus;
      if (!reconciled.matches) {
        await finishBillingMethodOperation(
          authorization,
          operation,
          "UNKNOWN",
          reconciled.providerStatus,
          "provider_postcondition_unverified",
        );
        return json({
          success: false,
          error:
            "O resultado anterior ainda nao pode ser comprovado no Asaas. Nenhuma nova alteracao foi enviada.",
        }, 409);
      }
      if (
        !await finishBillingMethodOperation(
          authorization,
          operation,
          "COMPLETE",
          reconciled.providerStatus,
          null,
        )
      ) {
        return json({
          success: false,
          error: "A conciliacao perdeu a trava de seguranca.",
        }, 409);
      }
    } else {
      const mutationTarget = await guardSubscription(
        nextType === "CREDIT_CARD"
          ? "billing_method_subscription_card_update"
          : "billing_method_subscription_update",
      );
      if (!mutationTarget.ok) {
        await finishBillingMethodOperation(
          authorization,
          operation,
          "BLOCKED",
          mutationTarget.providerStatus,
          "provider_identity_unverified",
        );
        await audit(auditValues(nextType, "BLOCKED_IDENTITY_MISMATCH"));
        return json({
          success: false,
          error: "A assinatura precisa de revisao antes da alteracao.",
        }, 409);
      }
      // This RPC rechecks tenant, role, active lifecycle, exclusive membership
      // and canonical provider bindings under the same advisory lock used by
      // offboarding. No provider PUT can cross the offboarding snapshot.
      if (!await markBillingMethodMutating(authorization, operation)) {
        return json({
          success: false,
          error: "A alteracao perdeu a trava de seguranca antes do envio.",
        }, 409);
      }

      let partialMutation = false;
      if (nextType === "CREDIT_CARD" && card && holder && remoteIp) {
        let cardResult: Awaited<ReturnType<AsaasRequest>>;
        try {
          cardResult = await asaasRequest(
            `/subscriptions/${encodedId}/creditCard`,
            "PUT",
            { creditCard: card, creditCardHolderInfo: holder, remoteIp },
          );
        } catch (error) {
          if (error instanceof AsaasCapabilityFenceError) {
            await finishBillingMethodOperation(
              authorization,
              operation,
              error.failure === "UNAVAILABLE" ? "FAILED" : "BLOCKED",
              null,
              error.failure === "UNAVAILABLE"
                ? "subscription_capability_unavailable_before_card_submit"
                : "subscription_capability_changed_before_card_submit",
            );
            return json({
              success: false,
              error: error.failure === "UNAVAILABLE"
                ? "A capacidade de atualização no Asaas está indisponível."
                : "A credencial do Asaas mudou; reinicie a alteração.",
            }, error.failure === "UNAVAILABLE" ? 503 : 409);
          }
          await finishBillingMethodOperation(
            authorization,
            operation,
            "UNKNOWN",
            null,
            "provider_card_put_outcome_unknown",
          );
          return json({
            success: false,
            error:
              "O envio do cartao ficou sem resultado confirmado. Consulte o Asaas antes de tentar novamente.",
          }, 502);
        }
        if (!cardResult.response.ok) {
          const ambiguous = ambiguousProviderMutationStatus(
            cardResult.response.status,
          );
          const deterministic = deterministicProviderDeclineStatus(
            cardResult.response.status,
          ) && !ambiguous;
          await finishBillingMethodOperation(
            authorization,
            operation,
            deterministic ? "FAILED" : "UNKNOWN",
            cardResult.response.status,
            deterministic
              ? "provider_card_validation_rejected"
              : "provider_card_put_outcome_unknown",
          );
          await audit(auditValues(
            nextType,
            deterministic
              ? "FAILED_CARD_VALIDATION"
              : "UNKNOWN_CARD_VALIDATION",
            cardResult.response.status,
          ));
          return json(
            {
              success: false,
              error: deterministic
                ? providerError(cardResult.data)
                : "O resultado do envio do cartao precisa ser conciliado no Asaas.",
            },
            deterministic ? 422 : 502,
          );
        }
        partialMutation = true;
        const nestedCard = cardResult.data.creditCard &&
            typeof cardResult.data.creditCard === "object" &&
            !Array.isArray(cardResult.data.creditCard)
          ? cardResult.data.creditCard as Record<string, unknown>
          : {};
        const cardToken = text(cardResult.data.creditCardToken) ||
          text(nestedCard.creditCardToken);
        if (cardToken) immediateChargePayload = { creditCardToken: cardToken };
      }

      if (nextType !== currentType) {
        const updateTarget = await guardSubscription(
          "billing_method_subscription_update_after_fence",
        );
        if (!updateTarget.ok) {
          await finishBillingMethodOperation(
            authorization,
            operation,
            partialMutation ? "UNKNOWN" : "BLOCKED",
            updateTarget.providerStatus,
            "provider_identity_changed_during_mutation",
          );
          return json({
            success: false,
            error:
              "A assinatura mudou durante a alteracao e precisa de revisao.",
            ...(partialMutation ? { cardSaved: true } : {}),
          }, 409);
        }
        let updateResult: Awaited<ReturnType<AsaasRequest>>;
        try {
          updateResult = await asaasRequest(
            `/subscriptions/${encodedId}`,
            "PUT",
            { billingType: nextType, updatePendingPayments: true },
          );
        } catch (error) {
          if (error instanceof AsaasCapabilityFenceError) {
            await finishBillingMethodOperation(
              authorization,
              operation,
              partialMutation
                ? "UNKNOWN"
                : error.failure === "UNAVAILABLE"
                ? "FAILED"
                : "BLOCKED",
              null,
              error.failure === "UNAVAILABLE"
                ? "subscription_capability_unavailable_before_type_submit"
                : "subscription_capability_changed_before_type_submit",
            );
            return json({
              success: false,
              error: partialMutation
                ? "O cartão foi salvo, mas a segunda alteração foi bloqueada e precisa de conciliação."
                : error.failure === "UNAVAILABLE"
                ? "A capacidade de atualização no Asaas está indisponível."
                : "A credencial do Asaas mudou; reinicie a alteração.",
              ...(partialMutation ? { cardSaved: true } : {}),
            }, partialMutation || error.failure === "UNAVAILABLE" ? 503 : 409);
          }
          await finishBillingMethodOperation(
            authorization,
            operation,
            "UNKNOWN",
            null,
            "provider_subscription_put_outcome_unknown",
          );
          return json({
            success: false,
            error:
              "O resultado da alteracao precisa ser conciliado no Asaas antes de tentar novamente.",
            ...(partialMutation ? { cardSaved: true } : {}),
          }, 502);
        }
        if (!updateResult.response.ok) {
          const ambiguous = ambiguousProviderMutationStatus(
            updateResult.response.status,
          );
          const deterministic = !partialMutation &&
            deterministicProviderDeclineStatus(updateResult.response.status) &&
            !ambiguous;
          await finishBillingMethodOperation(
            authorization,
            operation,
            deterministic ? "FAILED" : "UNKNOWN",
            updateResult.response.status,
            deterministic
              ? "provider_subscription_update_rejected"
              : "provider_subscription_put_outcome_unknown",
          );
          await audit(auditValues(
            nextType,
            deterministic
              ? "FAILED_SUBSCRIPTION_UPDATE"
              : "UNKNOWN_SUBSCRIPTION_UPDATE",
            updateResult.response.status,
          ));
          return json({
            success: false,
            error: deterministic
              ? providerError(updateResult.data)
              : "O resultado da alteracao precisa ser conciliado no Asaas.",
            ...(partialMutation ? { cardSaved: true } : {}),
          }, deterministic ? 422 : 502);
        }
      }

      const verified = await verifyPostcondition(
        "billing_method_subscription_postcondition",
      );
      verifiedProviderStatus = verified.providerStatus;
      if (!verified.matches) {
        await finishBillingMethodOperation(
          authorization,
          operation,
          "UNKNOWN",
          verified.providerStatus,
          "provider_postcondition_unverified",
        );
        await audit(auditValues(
          nextType,
          "UNKNOWN_POSTCONDITION",
          verified.providerStatus || undefined,
        ));
        return json({
          success: false,
          error:
            "A alteracao nao foi comprovada pelo Asaas e exige conciliacao antes de qualquer novo envio.",
          ...(nextType === "CREDIT_CARD" ? { cardSaved: true } : {}),
        }, 502);
      }
      if (
        !await finishBillingMethodOperation(
          authorization,
          operation,
          "COMPLETE",
          verified.providerStatus,
          null,
        )
      ) {
        return json({
          success: false,
          error: "A confirmacao perdeu a trava de seguranca.",
        }, 409);
      }
    }

    if (nextType === "CREDIT_CARD" && immediateChargePayload) {
      // The billing-method fence is released only after its exact GET. Every
      // overdue charge then acquires its own lifecycle claim before POST.
      let chargedNowCount = 0;
      let chargedNowTotal = 0;
      for (const payment of overduePayments) {
        const result = await chargeOverduePayment(
          authorization,
          payment,
          subscriptionId,
          immediateChargePayload,
          paymentIntegration,
          paymentRequest,
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
        ...auditValues(
          nextType,
          "SUCCESS",
          verifiedProviderStatus || undefined,
        ),
        overdue_found: overduePayments.length,
        charged_now: chargedNowCount,
        charged_now_total: Math.round(chargedNowTotal * 100) / 100,
      });
      return json({
        success: true,
        billingType: nextType,
        pendingPaymentsUpdated: true,
        cardChargedNow: chargedNowCount > 0,
        chargedNowCount,
        chargedNowTotal: Math.round(chargedNowTotal * 100) / 100,
        reconciled: operation.action === "RECONCILE_REQUIRED",
      });
    }

    await audit(auditValues(
      nextType,
      "SUCCESS",
      verifiedProviderStatus || undefined,
    ));
    return json({
      success: true,
      billingType: nextType,
      pendingPaymentsUpdated: true,
      cardChargedNow: false,
      reconciled: operation.action === "RECONCILE_REQUIRED",
    });
  } catch (cause) {
    const integrationUnavailable = cause instanceof
      TenantIntegrationBrokerError;
    console.error("[update-student-billing-method] unexpected", {
      type: cause instanceof Error ? cause.name : "UnknownError",
    });
    return json({
      success: false,
      error: integrationUnavailable
        ? "payment_provider_unavailable"
        : "Nao foi possivel atualizar a forma de pagamento.",
    }, integrationUnavailable ? 503 : 500);
  }
});
