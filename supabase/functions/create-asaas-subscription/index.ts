import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizePaymentTarget,
  loadClaimedEnrollmentOffer,
} from "../_shared/payment-auth.ts";
import type { PaymentAdminClient } from "../_shared/payment-auth.ts";
import {
  applyEnrollmentPaymentObservation,
  markEnrollmentFailure,
  markEnrollmentStage,
} from "../_shared/enrollment-progress.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
  TenantIntegrationBrokerError,
} from "../_shared/tenant-integration-broker.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  type AsaasCreationClaim,
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  bindStudentAsaasCreationLifecycle,
  claimAsaasCreation,
  findUniqueAsaasEntity,
  isAsaasRefundedPaymentStatus,
  isAsaasSettledPaymentStatus,
  markStudentAsaasCreationSubmitting,
  recordAsaasCreationState,
  releaseStudentAsaasCreationLifecycle,
} from "../_shared/asaas-creation-guard.ts";
import {
  claimStudentBillingPeriod,
  markStudentBillingPeriodSubmitting,
  recordStudentBillingPeriodState,
  type StudentBillingPeriodClaim,
} from "../_shared/student-billing-period-guard.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
import {
  canonicalEnrollmentSplitPolicy,
  providerSplitPayload,
  providerSplitPoliciesEqual,
  type ProviderSplitPolicy,
} from "../_shared/student-provider-lifecycle.ts";
import {
  billingDateFromAnchor,
  canonicalFutureBillingDate,
  classifyProRataFailure,
  containsSensitiveCardMaterial,
  creationAnchorCandidates,
  type ExpectedProviderCustomer,
  type ExpectedProviderPayment,
  type ExpectedProviderSubscription,
  nextDueDateFromAnchor,
  normalizeProviderEntityId,
  occupiesProviderCustomerIdentity,
  occupiesProviderReference,
  type ProRataFailure,
  type ProviderBillingType,
  providerPaymentCanStartPendingLedger,
  providerPaymentLedgerStatusMatches,
  resolveProviderCustomerCandidate,
  resolveProviderPaymentCandidate,
  resolveProviderSubscriptionCandidate,
  selectFrozenCreationCandidate,
} from "./provider-identity.ts";

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
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const digits = (value: unknown) => String(value || "").replace(/\D/g, "");
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const BILLING_REVIEW_ERRORS = new Set([
  "billing_creation_reference_mismatch",
  "billing_creation_legacy_reference_requires_review",
  "billing_creation_fingerprint_invalid",
  "billing_creation_anchor_invalid",
]);
const billingReviewRequired = (error: unknown): boolean =>
  error instanceof Error && BILLING_REVIEW_ERRORS.has(error.message);

type CreationSeed = {
  anchors: Date[];
  externalReference: string;
  storedFingerprint: string | null;
};

async function loadCreationSeed(
  admin: PaymentAdminClient,
  tenantId: string,
  operation: "PAYMENT_CREATE" | "SUBSCRIPTION_CREATE",
  logicalKey: string,
  intendedExternalReference: string,
  allowedLegacyReferences: string[] = [],
): Promise<CreationSeed> {
  const { data, error } = await admin
    .from("asaas_provider_creation_attempts")
    .select("created_at,external_reference,request_fingerprint,status")
    .eq("tenant_id", tenantId)
    .eq("operation", operation)
    .eq("logical_key", logicalKey)
    .maybeSingle();
  if (error) throw new Error("billing_creation_anchor_lookup_failed");
  const storedReference = text(data?.external_reference);
  if (storedReference && storedReference !== intendedExternalReference) {
    if (!allowedLegacyReferences.includes(storedReference)) {
      throw new Error("billing_creation_reference_mismatch");
    }
    // Old non-offer flows reused the student UUID across distinct resources.
    // Only an already completed legacy attempt is safe to adopt by direct GET;
    // pending/ambiguous legacy attempts must never be allowed to POST again.
    if (text(data?.status) !== "SUCCEEDED") {
      throw new Error("billing_creation_legacy_reference_requires_review");
    }
  }
  const storedFingerprint = text(data?.request_fingerprint) || null;
  if (storedFingerprint && !/^[a-f0-9]{64}$/.test(storedFingerprint)) {
    throw new Error("billing_creation_fingerprint_invalid");
  }
  const storedCreatedAt = data?.created_at ? new Date(data.created_at) : null;
  if (storedCreatedAt && !Number.isFinite(storedCreatedAt.getTime())) {
    throw new Error("billing_creation_anchor_invalid");
  }
  const anchors = creationAnchorCandidates(storedCreatedAt, new Date());
  if (anchors.length === 0) throw new Error("billing_creation_anchor_invalid");
  return {
    anchors,
    externalReference: storedReference || intendedExternalReference,
    storedFingerprint,
  };
}

async function loadOneTimePaymentDetails(
  integration: ResolvedAsaasIntegration,
  paymentId: string,
) {
  const paymentRes = await fetch(
    `${integration.baseUrl}/payments/${encodeURIComponent(paymentId)}`,
    { headers: { access_token: integration.apiKey } },
  );
  const payment = await paymentRes.json().catch(() => ({}));
  if (!paymentRes.ok) throw new Error("one_time_payment_lookup_failed");

  const billingType = text(payment.billingType);
  const status = text(payment.status) || "PENDING";
  let pixCode = "";
  let qrCode = "";

  if (billingType === "PIX") {
    const pixRes = await fetch(
      `${integration.baseUrl}/payments/${
        encodeURIComponent(paymentId)
      }/pixQrCode`,
      { headers: { access_token: integration.apiKey } },
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
    paid: isAsaasSettledPaymentStatus(status),
    refunded: isAsaasRefundedPaymentStatus(status),
    invoice_url: text(payment.bankSlipUrl) || text(payment.invoiceUrl) || null,
    pixCode: pixCode || null,
    qrCode: qrCode || null,
  };
}

async function readProviderEntity(
  integration: ResolvedAsaasIntegration,
  resource: "customers" | "payments" | "subscriptions",
  providerEntityId: string,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number }
> {
  let response: Response;
  try {
    response = await fetch(
      `${integration.baseUrl}/${resource}/${
        encodeURIComponent(providerEntityId)
      }`,
      {
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return { ok: false, status: 0 };
  }
  if (!response.ok) return { ok: false, status: response.status };
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, status: response.status };
  }
  return { ok: true, data: data as Record<string, unknown> };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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

  let progressAdmin: PaymentAdminClient | null = null;
  let progressOfferId = "";
  let progressUserId = "";

  try {
    const body = await req.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const userId = text(body?.user_id);
    progressUserId = userId;
    if (!body || !userId) {
      return json({ success: false, error: "user_id_required" }, 400);
    }

    const authResult = await authorizePaymentTarget(req, userId, corsHeaders);
    if (authResult.error) return authResult.error;
    const authorization = authResult.authorization!;
    progressAdmin = authorization.admin;
    const profile = authorization.targetProfile;

    const isSelfStudent = !authorization.isService &&
      authorization.callerId === userId &&
      authorization.callerProfile?.role === "STUDENT";
    const offer = isSelfStudent
      ? await loadClaimedEnrollmentOffer(
        authorization.admin,
        userId,
        authorization.tenantId,
      )
      : null;
    progressOfferId = offer?.id || "";
    if (isSelfStudent && !offer) {
      return json({ success: false, error: "enrollment_offer_required" }, 403);
    }
    const offerPayload = offer?.payload || {};
    const correlationId = offer?.processing_correlation_id || null;
    const subscriptionReference = offer
      ? `enrollment:${offer.id}:subscription`
      : userId;
    const oneTimeReference = offer
      ? `enrollment:${offer.id}:one-time`
      : `student:${userId}:one-time`;
    const proRataReference = offer
      ? `enrollment:${offer.id}:pro-rata`
      : `student:${userId}:pro-rata`;
    const action = text(body.action);
    if (action === "check_one_time") {
      const paymentId = normalizeProviderEntityId(
        offer?.metadata?.one_time_payment_id,
      );
      if (
        !offer || numberValue(offerPayload.planDuration) !== 0 || !paymentId
      ) {
        return json(
          { success: false, error: "one_time_payment_not_found" },
          404,
        );
      }
      try {
        const integration = await resolveAsaasIntegration(
          authorization.admin,
          authorization.tenantId,
          "payment.read",
        );
        const expectedValue = numberValue(offerPayload.value);
        const expectedCustomerId = text(profile.asaas_customer_id);
        const expectedBillingType = text(offer.metadata?.billing_type);
        const { data: checkTenant, error: checkTenantError } =
          await authorization.admin.from("tenants")
            .select("asaas_wallet_id,asaas_split_percentage")
            .eq("id", authorization.tenantId)
            .maybeSingle();
        if (checkTenantError || !checkTenant) {
          return json({
            success: false,
            error: "tenant_billing_configuration_unavailable",
          }, 503);
        }
        const checkSplitPolicy = canonicalEnrollmentSplitPolicy(
          integration.mode,
          checkTenant.asaas_wallet_id,
          checkTenant.asaas_split_percentage,
        );
        if (
          !expectedValue || expectedValue <= 0 || !expectedCustomerId ||
          !["PIX", "BOLETO", "CREDIT_CARD"].includes(expectedBillingType) ||
          !checkSplitPolicy
        ) {
          return json({
            success: false,
            error: "one_time_payment_requires_review",
          }, 409);
        }
        const checkLogicalKey = `one-time:${offer.id}`;
        const checkSeed = await loadCreationSeed(
          authorization.admin,
          authorization.tenantId,
          "PAYMENT_CREATE",
          checkLogicalKey,
          oneTimeReference,
        );
        const checkDueDates = Array.from(
          new Set(
            checkSeed.anchors.map(billingDateFromAnchor).filter(
              (dueDate): dueDate is string => Boolean(dueDate),
            ),
          ),
        );
        if (checkDueDates.length === 0) {
          return json({
            success: false,
            error: "one_time_payment_requires_review",
          }, 409);
        }
        const checkedPayment = await readProviderEntity(
          integration,
          "payments",
          paymentId,
        );
        if (checkedPayment.ok === false) {
          return json(
            {
              success: false,
              error: "payment_check_failed",
            },
            checkedPayment.status >= 500 || checkedPayment.status === 0
              ? 503
              : 409,
          );
        }
        const checkedResolution = checkDueDates.map((dueDate) =>
          resolveProviderPaymentCandidate(checkedPayment.data, {
            externalReference: checkSeed.externalReference,
            customerId: expectedCustomerId,
            billingType: expectedBillingType as ProviderBillingType,
            value: expectedValue,
            dueDate,
            subscriptionId: null,
            splitPolicy: checkSplitPolicy,
          })
        ).find((resolution) => resolution.status === "MATCH");
        if (
          !checkedResolution || checkedResolution.status !== "MATCH" ||
          checkedResolution.id !== paymentId
        ) {
          return json({
            success: false,
            error: "one_time_payment_requires_review",
          }, 409);
        }
        const details = await loadOneTimePaymentDetails(integration, paymentId);
        const observation = await applyEnrollmentPaymentObservation(
          authorization.admin,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            offerId: offer.id,
            providerPaymentId: paymentId,
            providerCustomerId: expectedCustomerId,
            providerSubscriptionId: null,
            paymentKind: "ONE_TIME",
            outcome: details.paid
              ? "SETTLED"
              : details.refunded
              ? "UNSETTLED"
              : "PENDING",
            providerValue: expectedValue,
            externalReference: checkSeed.externalReference,
            providerStatus: details.status,
            dueDate: text(checkedPayment.data.dueDate),
            billingType: expectedBillingType as
              | "PIX"
              | "BOLETO"
              | "CREDIT_CARD",
            description: text(checkedPayment.data.description) ||
              "Pagamento avulso",
          },
        );
        const enrollmentComplete = observation.processing_state === "COMPLETED";
        return json({
          success: true,
          id: paymentId,
          payment_id: paymentId,
          ...details,
          enrollment_complete: enrollmentComplete,
          processing_state: observation.processing_state || "AWAITING_PAYMENT",
          correlation_id: correlationId,
        });
      } catch (error) {
        const integrationUnavailable = error instanceof
          TenantIntegrationBrokerError;
        const reviewRequired = billingReviewRequired(error);
        await markEnrollmentFailure(
          authorization.admin,
          offer.id,
          userId,
          integrationUnavailable
            ? "asaas_not_configured"
            : reviewRequired
            ? "one_time_payment_requires_review"
            : "payment_check_failed",
          error,
        );
        return json({
          success: false,
          error: integrationUnavailable
            ? "asaas_not_configured"
            : reviewRequired
            ? "one_time_payment_requires_review"
            : "payment_check_failed",
        }, integrationUnavailable ? 503 : reviewRequired ? 409 : 502);
      }
    }
    if (action) {
      return json({ success: false, error: "action_not_allowed" }, 400);
    }

    const value = offer
      ? numberValue(offerPayload.value)
      : numberValue(body.value ?? profile.monthly_fee);
    const dueDay = offer
      ? numberValue(offerPayload.dueDay)
      : numberValue(body.dueDay ?? profile.due_day);
    const durationMonths = offer
      ? numberValue(offerPayload.planDuration)
      : null;
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
    const startMonth = offer
      ? text(offerPayload.billingStartMonth)
      : text(body.startDate);
    const offerFirstBillingDate = offer && planDuration !== "ONE_TIME"
      ? canonicalFutureBillingDate(
        offerPayload.firstBillingDate,
        billingDateFromAnchor(new Date()) || "",
      )
      : null;
    const proRata = offer
      ? offerPayload.enableProRata === true
      : body.proRata === true;
    const proRataValue = proRata
      ? offer
        ? numberValue(offerPayload.proRataValue)
        : numberValue(body.proRataValue)
      : null;

    if (!value || value <= 0 || !dueDay || dueDay < 1 || dueDay > 31) {
      return json({ success: false, error: "Valor ou vencimento invalido." });
    }
    if (!["PIX", "BOLETO", "CREDIT_CARD"].includes(billingType)) {
      return json({ success: false, error: "Forma de pagamento invalida." });
    }
    if (offer && planDuration !== "ONE_TIME" && !offerFirstBillingDate) {
      return json({
        success: false,
        error: "enrollment_first_billing_date_passed",
      }, 409);
    }
    const providerBillingType = billingType as ProviderBillingType;

    const profileCustomerId = normalizeProviderEntityId(
      text(profile.asaas_customer_id),
    );
    const offerCustomerId = offer
      ? normalizeProviderEntityId(text(offer.metadata?.asaas_customer_id))
      : profileCustomerId;
    const rawAsaasCustomerId = offer
      ? text(offer.metadata?.asaas_customer_id)
      : text(profile.asaas_customer_id);
    const asaasCustomerId = normalizeProviderEntityId(rawAsaasCustomerId);
    if (!asaasCustomerId) {
      return json({
        success: false,
        error: rawAsaasCustomerId
          ? "provider_customer_local_link_invalid"
          : "Aluno ainda nao foi sincronizado com o Asaas.",
      }, rawAsaasCustomerId ? 409 : 200);
    }
    if (
      offer && (!profileCustomerId || profileCustomerId !== offerCustomerId)
    ) {
      return json({
        success: false,
        error: "provider_customer_local_link_conflict",
      }, 409);
    }
    const integration = await resolveAsaasIntegration(
      authorization.admin,
      authorization.tenantId,
      planDuration === "ONE_TIME" ? "payment.create" : "subscription.create",
    );
    const customerIsDependent = offer
      ? Boolean(offerPayload.isDependent)
      : Boolean(profile.guardian_id || profile.guardian_cpf);
    const expectedCustomerCpf = customerIsDependent
      ? digits(profile.guardian_cpf)
      : digits(profile.cpf);
    const offerGuardianCpf = offer && customerIsDependent
      ? digits(offerPayload.guardianCpf)
      : "";
    if (expectedCustomerCpf.length !== 11) {
      return json({
        success: false,
        error: "provider_customer_cpf_requires_review",
      }, 409);
    }
    if (offerGuardianCpf && offerGuardianCpf !== expectedCustomerCpf) {
      return json({
        success: false,
        error: "provider_customer_authoritative_cpf_conflict",
      }, 409);
    }
    const expectedCustomerReference = offer
      ? `tenant:${authorization.tenantId}:enrollment:${offer.id}:payer`
      : userId;
    const expectedCustomer: ExpectedProviderCustomer = {
      providerId: asaasCustomerId,
      externalReference: expectedCustomerReference,
      cpfCnpj: expectedCustomerCpf,
    };
    const providerCustomer = await readProviderEntity(
      integration,
      "customers",
      asaasCustomerId,
    );
    if (providerCustomer.ok === false) {
      const unavailable = providerCustomer.status === 0 ||
        providerCustomer.status === 408 || providerCustomer.status === 429 ||
        providerCustomer.status >= 500;
      return json({
        success: false,
        error: unavailable
          ? "provider_customer_lookup_unavailable"
          : "provider_customer_local_link_conflict",
      }, unavailable ? 503 : 409);
    }
    const providerCustomerResolution = resolveProviderCustomerCandidate(
      providerCustomer.data,
      expectedCustomer,
    );
    if (
      providerCustomerResolution.status !== "MATCH" ||
      providerCustomerResolution.id !== asaasCustomerId
    ) {
      return json({
        success: false,
        error: "provider_customer_local_link_conflict",
      }, 409);
    }
    const customerQueries: Array<Record<string, string>> = [
      { externalReference: expectedCustomerReference, includeDeleted: "true" },
      { cpfCnpj: expectedCustomerCpf, includeDeleted: "true" },
    ];
    for (const customerQuery of customerQueries) {
      const customerLookup = await findUniqueAsaasEntity<
        Record<string, unknown>
      >({
        baseUrl: integration.baseUrl,
        apiKey: integration.apiKey,
        path: "customers",
        query: customerQuery,
        matches: (candidate) =>
          resolveProviderCustomerCandidate(candidate, expectedCustomer)
            .status === "MATCH",
        conflicts: (candidate) =>
          occupiesProviderCustomerIdentity(candidate, expectedCustomer),
      });
      if (customerLookup.kind === "UNAVAILABLE") {
        return json({
          success: false,
          error: "provider_customer_lookup_unavailable",
        }, 503);
      }
      if (
        customerLookup.kind !== "FOUND" ||
        resolveProviderCustomerCandidate(
            customerLookup.entity,
            expectedCustomer,
          ).status !== "MATCH" ||
        normalizeProviderEntityId(customerLookup.entity.id) !== asaasCustomerId
      ) {
        return json({
          success: false,
          error: customerLookup.kind === "DUPLICATE"
            ? "duplicate_provider_customers"
            : "provider_customer_identity_conflict",
        }, 409);
      }
    }
    const proRataIntegration = planDuration !== "ONE_TIME" && proRata &&
        proRataValue && proRataValue > 0
      ? await resolveAsaasIntegration(
        authorization.admin,
        authorization.tenantId,
        "payment.create",
      )
      : null;
    const requiresEnrollmentPayment = Boolean(
      offer &&
        offer.requires_enrollment !== false &&
        (numberValue(offer.enrollment_fee) || 0) > 0,
    );
    const enrollmentAlreadyComplete = offer?.processing_state === "COMPLETED";
    let proRataChargeId: string | null = null;
    let proRataFailure: ProRataFailure | null = null;

    const registerRecurringBilling = async (
      subscriptionId: string,
    ): Promise<Record<string, unknown> | null> => {
      if (!offer) return null;
      // A subscription object is not proof that its first charge reached the
      // balance. PAYMENT_RECEIVED will complete the enrollment in the webhook.
      await markEnrollmentStage(
        authorization.admin,
        offer.id,
        userId,
        "AWAITING_PAYMENT",
        {
          metadata: {
            subscription_id: subscriptionId,
            requires_enrollment_payment: requiresEnrollmentPayment,
          },
        },
      );
      return null;
    };

    const bindSubscriptionToProfile = async (
      subscriptionId: string,
    ): Promise<"BOUND" | "CONFLICT"> => {
      const { data: boundProfile, error: bindError } = await authorization.admin
        .from("profiles")
        .update({
          subscription_id: subscriptionId,
          monthly_fee: value,
          due_day: dueDay,
          status_financial: "PENDING",
        })
        .eq("id", userId)
        .eq("tenant_id", authorization.tenantId)
        .eq("asaas_customer_id", asaasCustomerId)
        .is("subscription_id", null)
        .select("tenant_id,asaas_customer_id,subscription_id")
        .maybeSingle();
      if (bindError) {
        throw new Error(
          `subscription_profile_bind_failed: ${bindError.message}`,
        );
      }
      if (
        text(boundProfile?.tenant_id) === authorization.tenantId &&
        text(boundProfile?.asaas_customer_id) === asaasCustomerId &&
        text(boundProfile?.subscription_id) === subscriptionId
      ) {
        return "BOUND";
      }
      const { data: currentProfile, error: currentError } = await authorization
        .admin.from("profiles")
        .select("tenant_id,asaas_customer_id,subscription_id")
        .eq("id", userId)
        .eq("tenant_id", authorization.tenantId)
        .maybeSingle();
      if (currentError) {
        throw new Error(
          `subscription_profile_recheck_failed: ${currentError.message}`,
        );
      }
      return text(currentProfile?.tenant_id) === authorization.tenantId &&
          text(currentProfile?.asaas_customer_id) === asaasCustomerId &&
          text(currentProfile?.subscription_id) === subscriptionId
        ? "BOUND"
        : "CONFLICT";
    };

    const bindProviderPaymentToLedger = async (
      payment: Record<string, unknown>,
      expected: ExpectedProviderPayment,
      paymentType: "SUBSCRIPTION" | "PRO_RATA",
    ): Promise<boolean> => {
      const paymentId = normalizeProviderEntityId(payment.id);
      const providerStatus = text(payment.status) || "PENDING";
      if (!paymentId) return false;
      const normalizedProviderStatus = providerStatus.toUpperCase();
      const expectedCents = Math.round(expected.value * 100);
      const pendingStatus = providerStatus.toUpperCase() === "OVERDUE"
        ? "OVERDUE"
        : "PENDING";
      const snapshot = {
        asaas_payment_id: paymentId,
        provider_customer_id: asaasCustomerId,
        student_id: userId,
        tenant_id: authorization.tenantId,
        value: expected.value,
        amount_cents: expectedCents,
        status: pendingStatus,
        provider_status: providerStatus,
        due_date: expected.dueDate,
        billing_type: expected.billingType,
        payment_method: expected.billingType,
        invoice_url: text(payment.bankSlipUrl || payment.invoiceUrl) || null,
        description: text(payment.description) || null,
        payment_type: paymentType,
        updated_at: new Date().toISOString(),
      };
      const loadBinding = () =>
        authorization.admin.from("student_payments")
          .select(
            "id,student_id,tenant_id,provider_customer_id,value,status,due_date",
          )
          .eq("asaas_payment_id", paymentId)
          .maybeSingle();
      let { data: localPayment, error: localError } = await loadBinding();
      if (localError) {
        throw new Error(`payment_binding_lookup:${localError.code}`);
      }
      if (!localPayment) {
        // A provider GET/POST snapshot is identity evidence, but settlement and
        // refund transitions remain exclusive to the signed webhook. Never
        // manufacture a PENDING ledger row from a decisive provider status.
        if (!providerPaymentCanStartPendingLedger(normalizedProviderStatus)) {
          return false;
        }
        const inserted = await authorization.admin.from("student_payments")
          .insert(snapshot)
          .select(
            "id,student_id,tenant_id,provider_customer_id,value,status,due_date",
          )
          .maybeSingle();
        localPayment = inserted.data;
        localError = inserted.error;
        if (localError?.code === "23505") {
          const raced = await loadBinding();
          localPayment = raced.data;
          localError = raced.error;
        }
      }
      if (localError || !localPayment) return false;
      const bindingMatches = text(localPayment.student_id) === userId &&
        text(localPayment.tenant_id) === authorization.tenantId &&
        text(localPayment.provider_customer_id) === asaasCustomerId &&
        Math.round(Number(localPayment.value) * 100) === expectedCents &&
        text(localPayment.due_date) === expected.dueDate &&
        providerPaymentLedgerStatusMatches(
          normalizedProviderStatus,
          localPayment.status,
        );
      if (!bindingMatches) return false;
      const { data: confirmed, error: updateError } = await authorization.admin
        .from("student_payments")
        .update({
          provider_status: providerStatus,
          billing_type: expected.billingType,
          payment_method: expected.billingType,
          invoice_url: snapshot.invoice_url,
          description: snapshot.description,
          payment_type: paymentType,
          updated_at: snapshot.updated_at,
        })
        .eq("id", localPayment.id)
        .eq("student_id", userId)
        .eq("tenant_id", authorization.tenantId)
        .eq("provider_customer_id", asaasCustomerId)
        .eq("asaas_payment_id", paymentId)
        .select("id")
        .maybeSingle();
      return !updateError && Boolean(confirmed?.id);
    };

    // A local provider id is only a hint. Every return below is preceded by a
    // direct provider GET or a fully paginated exact recovery.
    const existingLocalSubscriptionId = normalizeProviderEntityId(
      profile.subscription_id,
    );
    if (profile.subscription_id && !existingLocalSubscriptionId) {
      return json({
        success: false,
        error: "provider_subscription_local_link_invalid",
      }, 409);
    }
    if (
      planDuration !== "ONE_TIME" && enrollmentAlreadyComplete &&
      !existingLocalSubscriptionId
    ) {
      return json({
        success: false,
        error: "completed_enrollment_subscription_requires_review",
      }, 409);
    }
    const isOneTime = planDuration === "ONE_TIME";
    const creationOperation = isOneTime
      ? "PAYMENT_CREATE" as const
      : "SUBSCRIPTION_CREATE" as const;
    const intendedCreationReference = isOneTime
      ? oneTimeReference
      : subscriptionReference;
    const creationLogicalKey = `${isOneTime ? "one-time" : "subscription"}:${
      offer?.id || userId
    }`;
    const creationSeed = await loadCreationSeed(
      authorization.admin,
      authorization.tenantId,
      creationOperation,
      creationLogicalKey,
      intendedCreationReference,
      !offer && isOneTime ? [userId] : [],
    );
    const creationReference = creationSeed.externalReference;
    const maxPayments = planDuration === "ANNUAL"
      ? 12
      : planDuration === "SEMESTER"
      ? 6
      : null;
    const planLabel = planDuration === "ANNUAL"
      ? "Anual (12 Meses)"
      : planDuration === "SEMESTER"
      ? "Semestral (6 Meses)"
      : "Recorrente";

    const { data: tenant, error: tenantError } = await authorization.admin
      .from("tenants")
      .select("name,asaas_wallet_id,asaas_split_percentage")
      .eq("id", authorization.tenantId)
      .maybeSingle();
    if (tenantError || !tenant) {
      return json({
        success: false,
        error: "tenant_billing_configuration_unavailable",
      }, 503);
    }
    const schoolName = text(tenant?.name).slice(0, 120) || "Escola de idiomas";
    const creationSplitPolicy = canonicalEnrollmentSplitPolicy(
      integration.mode,
      tenant.asaas_wallet_id,
      tenant.asaas_split_percentage,
    );
    if (!creationSplitPolicy) {
      return json({
        success: false,
        error: "tenant_billing_split_configuration_invalid",
      }, 409);
    }
    const split = providerSplitPayload(creationSplitPolicy);
    const proRataSplitPolicy = proRataIntegration
      ? canonicalEnrollmentSplitPolicy(
        proRataIntegration.mode,
        tenant.asaas_wallet_id,
        tenant.asaas_split_percentage,
      )
      : null;
    if (proRataIntegration && !proRataSplitPolicy) {
      return json({
        success: false,
        error: "tenant_billing_split_configuration_invalid",
      }, 409);
    }
    const proRataSplit = proRataSplitPolicy
      ? providerSplitPayload(proRataSplitPolicy)
      : undefined;

    const revalidateFrozenSplitPolicy = async (
      resolvedIntegration: ResolvedAsaasIntegration,
      frozenPolicy: ProviderSplitPolicy,
    ): Promise<"MATCH" | "UNAVAILABLE" | "INVALID" | "CHANGED"> => {
      const { data: currentTenant, error: currentTenantError } =
        await authorization.admin.from("tenants")
          .select("asaas_wallet_id,asaas_split_percentage")
          .eq("id", authorization.tenantId)
          .maybeSingle();
      if (currentTenantError || !currentTenant) return "UNAVAILABLE";
      const currentPolicy = canonicalEnrollmentSplitPolicy(
        resolvedIntegration.mode,
        currentTenant.asaas_wallet_id,
        currentTenant.asaas_split_percentage,
      );
      if (!currentPolicy) return "INVALID";
      return providerSplitPoliciesEqual(currentPolicy, frozenPolicy)
        ? "MATCH"
        : "CHANGED";
    };

    const buildCreationCandidate = (anchor: Date) => {
      const oneTimeDueDate = billingDateFromAnchor(anchor);
      const recurringNextDueDate = isOneTime ? "" : offerFirstBillingDate ||
        nextDueDateFromAnchor(dueDay, startMonth, anchor);
      if (!oneTimeDueDate || (!isOneTime && !recurringNextDueDate)) return null;
      const paymentPayload: Record<string, unknown> = {
        customer: asaasCustomerId,
        billingType: providerBillingType,
        value,
        externalReference: creationReference,
        ...(isOneTime
          ? {
            dueDate: oneTimeDueDate,
            description: `Aula avulsa - ${schoolName}`,
          }
          : {
            nextDueDate: recurringNextDueDate,
            cycle: "MONTHLY",
            maxPayments,
            description: `Mensalidade ${schoolName} - Plano ${planLabel}`,
          }),
        ...(split ? { split } : {}),
      };
      const safeCreationSnapshot = {
        operation: creationOperation,
        tenantId: authorization.tenantId,
        logicalKey: creationLogicalKey,
        payload: { ...paymentPayload },
      };
      const expectedCreation:
        | ExpectedProviderPayment
        | ExpectedProviderSubscription = isOneTime
          ? {
            externalReference: creationReference,
            customerId: asaasCustomerId,
            billingType: providerBillingType,
            value,
            dueDate: oneTimeDueDate,
            subscriptionId: null,
            splitPolicy: creationSplitPolicy,
          }
          : {
            externalReference: creationReference,
            customerId: asaasCustomerId,
            billingType: providerBillingType,
            value,
            nextDueDate: recurringNextDueDate!,
            cycle: "MONTHLY",
            status: "ACTIVE",
            maxPayments,
            splitPolicy: creationSplitPolicy,
          };
      return {
        expectedCreation,
        paymentPayload,
        recurringNextDueDate,
        safeCreationSnapshot,
      };
    };
    const creationCandidates = creationSeed.anchors.map(
      buildCreationCandidate,
    ).filter(
      (candidate): candidate is NonNullable<
        ReturnType<typeof buildCreationCandidate>
      > => Boolean(candidate),
    );
    if (creationCandidates.length === 0) {
      return json({ success: false, error: "billing_due_date_invalid" }, 409);
    }
    const frozenCreation = await selectFrozenCreationCandidate({
      candidates: creationCandidates,
      storedFingerprint: creationSeed.storedFingerprint,
      fingerprintFor: (candidate) =>
        asaasCreationFingerprint(candidate.safeCreationSnapshot),
    });
    const {
      expectedCreation,
      paymentPayload,
      recurringNextDueDate,
      safeCreationSnapshot,
    } = frozenCreation.candidate;
    if (containsSensitiveCardMaterial(safeCreationSnapshot)) {
      throw new Error("sensitive_card_material_in_creation_claim");
    }
    if (
      creationSeed.storedFingerprint &&
      !frozenCreation.matchedStoredFingerprint
    ) {
      await claimAsaasCreation(authorization.admin, {
        tenantId: authorization.tenantId,
        operation: creationOperation,
        logicalKey: creationLogicalKey,
        externalReference: creationReference,
        requestFingerprint: frozenCreation.fingerprint,
      });
      return json({
        success: false,
        error: "billing_creation_requires_review",
      }, 409);
    }
    const resolveCreationCandidate = (candidate: unknown) =>
      isOneTime
        ? resolveProviderPaymentCandidate(
          candidate,
          expectedCreation as ExpectedProviderPayment,
        )
        : resolveProviderSubscriptionCandidate(
          candidate,
          expectedCreation as ExpectedProviderSubscription,
        );
    const findExactCreation = () =>
      findUniqueAsaasEntity<Record<string, unknown>>({
        baseUrl: integration.baseUrl,
        apiKey: integration.apiKey,
        path: isOneTime ? "payments" : "subscriptions",
        // Filtering by customer here would hide a same-reference conflict.
        query: {
          externalReference: creationReference,
          includeDeleted: "true",
        },
        matches: (candidate) =>
          resolveCreationCandidate(candidate).status === "MATCH",
        conflicts: (candidate) =>
          occupiesProviderReference(candidate, creationReference),
      });

    let billingPeriodClaim: StudentBillingPeriodClaim | null = null;
    let billingPeriodReconcileOnly = false;
    let boundBillingPeriodProviderId = "";
    if (!isOneTime) {
      billingPeriodClaim = await claimStudentBillingPeriod(
        authorization.admin,
        {
          tenantId: authorization.tenantId,
          studentId: userId,
          dueDate: recurringNextDueDate!,
          source: "SUBSCRIPTION",
          sourceKey: creationLogicalKey,
          requestFingerprint: await asaasCreationFingerprint({
            tenantId: authorization.tenantId,
            studentId: userId,
            dueDate: recurringNextDueDate!,
            source: "SUBSCRIPTION",
            sourceKey: creationLogicalKey,
            payload: safeCreationSnapshot.payload,
          }),
        },
      );
      if (
        billingPeriodClaim.action === "CONFLICT" ||
        billingPeriodClaim.action === "REVIEW_REQUIRED" ||
        !billingPeriodClaim.ok
      ) {
        return json({
          success: false,
          error: "billing_period_requires_review",
        }, 409);
      }
      if (billingPeriodClaim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "billing_period_in_progress",
          retry_after_seconds: billingPeriodClaim.retry_after_seconds || 15,
        }, 409);
      }
      billingPeriodReconcileOnly =
        billingPeriodClaim.action === "RECONCILE_REQUIRED";
      const rawBoundProviderId = billingPeriodClaim.action === "ALREADY_BOUND"
        ? text(billingPeriodClaim.provider_entity_id)
        : "";
      boundBillingPeriodProviderId = rawBoundProviderId
        ? normalizeProviderEntityId(rawBoundProviderId) || ""
        : "";
      if (
        billingPeriodClaim.action === "ALREADY_BOUND" &&
        (!rawBoundProviderId || !boundBillingPeriodProviderId)
      ) {
        return json({
          success: false,
          error: "billing_period_provider_id_invalid",
        }, 409);
      }
    }
    const recordBillingPeriod = async (
      status: "RETRY" | "UNKNOWN" | "BOUND" | "FAILED" | "BLOCKED",
      providerEntityId?: string | null,
      error?: string | null,
    ) => {
      if (!billingPeriodClaim?.claim_token) return;
      await recordStudentBillingPeriodState(
        authorization.admin,
        billingPeriodClaim,
        { status, providerEntityId, error },
      );
    };
    if (
      existingLocalSubscriptionId && boundBillingPeriodProviderId &&
      existingLocalSubscriptionId !== boundBillingPeriodProviderId
    ) {
      return json({
        success: false,
        error: "provider_subscription_local_link_conflict",
      }, 409);
    }
    const providerSubscriptionHintId = !isOneTime
      ? existingLocalSubscriptionId || boundBillingPeriodProviderId
      : "";
    const creationClaim: AsaasCreationClaim = await claimAsaasCreation(
      authorization.admin,
      {
        tenantId: authorization.tenantId,
        operation: creationOperation,
        logicalKey: creationLogicalKey,
        externalReference: creationReference,
        requestFingerprint: frozenCreation.fingerprint,
      },
    );
    if (
      !["IN_PROGRESS", "REVIEW_REQUIRED"].includes(creationClaim.action) &&
      creationClaim.ok && !providerSubscriptionHintId &&
      !await bindStudentAsaasCreationLifecycle(
        authorization.admin,
        creationClaim,
        {
          tenantId: authorization.tenantId,
          studentId: userId,
          bindingKind: isOneTime ? "STUDENT_PAYMENT" : "SUBSCRIPTION",
          expectedCustomerId: asaasCustomerId,
        },
      )
    ) {
      await recordBillingPeriod(
        "BLOCKED",
        null,
        "student_creation_lifecycle_binding_failed",
      );
      return json({
        success: false,
        error: "student_creation_lifecycle_requires_review",
      }, 409);
    }

    let recoveredCreationId = "";
    let recoveredCreationEntity: Record<string, unknown> | null = null;
    if (creationClaim.action === "ALREADY_SUCCEEDED") {
      recoveredCreationId = normalizeProviderEntityId(
        creationClaim.provider_entity_id,
      ) || "";
      if (!recoveredCreationId) {
        await recordBillingPeriod(
          "BLOCKED",
          null,
          "billing_creation_claim_provider_id_invalid",
        );
        return json({
          success: false,
          error: "billing_creation_requires_review",
        }, 409);
      }
      const claimedEntity = await readProviderEntity(
        integration,
        isOneTime ? "payments" : "subscriptions",
        recoveredCreationId,
      );
      if (claimedEntity.ok === false) {
        const unavailable = claimedEntity.status === 0 ||
          claimedEntity.status === 408 || claimedEntity.status === 429 ||
          claimedEntity.status >= 500;
        if (billingPeriodClaim?.action === "SUBMIT_ONCE") {
          await recordBillingPeriod(
            unavailable ? "RETRY" : "BLOCKED",
            null,
            unavailable
              ? "billing_recovery_lookup_unavailable"
              : "billing_creation_claim_provider_not_found",
          );
        } else if (!unavailable) {
          await recordBillingPeriod(
            "BLOCKED",
            null,
            "billing_creation_claim_provider_not_found",
          );
        }
        return json({
          success: false,
          error: unavailable
            ? "billing_recovery_lookup_unavailable"
            : "billing_creation_requires_review",
        }, unavailable ? 503 : 409);
      }
      const claimedResolution = resolveCreationCandidate(claimedEntity.data);
      if (
        claimedResolution.status !== "MATCH" ||
        claimedResolution.id !== recoveredCreationId
      ) {
        await recordBillingPeriod(
          "BLOCKED",
          null,
          "provider_billing_payload_conflict",
        );
        return json({
          success: false,
          error: "provider_billing_payload_conflict",
        }, 409);
      }
      recoveredCreationEntity = claimedEntity.data;
      const claimedUniqueness = await findExactCreation();
      if (claimedUniqueness.kind === "UNAVAILABLE") {
        if (billingPeriodClaim?.action === "SUBMIT_ONCE") {
          await recordBillingPeriod(
            "RETRY",
            null,
            "billing_recovery_lookup_unavailable",
          );
        }
        return json({
          success: false,
          error: "billing_recovery_lookup_unavailable",
        }, 503);
      }
      if (
        claimedUniqueness.kind !== "FOUND" ||
        resolveCreationCandidate(claimedUniqueness.entity).status !== "MATCH" ||
        normalizeProviderEntityId(claimedUniqueness.entity.id) !==
          recoveredCreationId
      ) {
        await recordBillingPeriod(
          "BLOCKED",
          null,
          "provider_billing_identity_conflict",
        );
        return json({
          success: false,
          error: "provider_billing_identity_conflict",
        }, 409);
      }
      if (
        boundBillingPeriodProviderId &&
        boundBillingPeriodProviderId !== recoveredCreationId
      ) {
        await recordBillingPeriod(
          "BLOCKED",
          null,
          "billing_period_provider_id_mismatch",
        );
        return json({
          success: false,
          error: "billing_period_provider_id_mismatch",
        }, 409);
      }
      if (
        !isOneTime && existingLocalSubscriptionId &&
        existingLocalSubscriptionId !== recoveredCreationId
      ) {
        await recordBillingPeriod(
          "BLOCKED",
          null,
          "provider_subscription_local_link_conflict",
        );
        return json({
          success: false,
          error: "provider_subscription_local_link_conflict",
        }, 409);
      }
    } else if (creationClaim.action === "IN_PROGRESS") {
      return json({
        success: false,
        error: "billing_creation_in_progress",
        retry_after_seconds: creationClaim.retry_after_seconds || 15,
      }, 409);
    } else if (
      creationClaim.action === "REVIEW_REQUIRED" || !creationClaim.ok
    ) {
      return json({
        success: false,
        error: "billing_creation_requires_review",
      }, 409);
    } else {
      if (providerSubscriptionHintId) {
        const hintedEntity = await readProviderEntity(
          integration,
          "subscriptions",
          providerSubscriptionHintId,
        );
        if (hintedEntity.ok === false) {
          const unavailable = hintedEntity.status === 0 ||
            hintedEntity.status === 408 || hintedEntity.status === 429 ||
            hintedEntity.status >= 500;
          await recordAsaasCreationState(
            authorization.admin,
            creationClaim,
            {
              status: unavailable &&
                  creationClaim.action === "RECONCILE_REQUIRED"
                ? "UNKNOWN"
                : unavailable
                ? "RETRY"
                : "BLOCKED",
              httpStatus: hintedEntity.status || null,
              error: unavailable
                ? "provider_subscription_hint_lookup_unavailable"
                : "provider_subscription_hint_not_found",
            },
          );
          if (billingPeriodClaim?.action === "SUBMIT_ONCE") {
            await recordBillingPeriod(
              unavailable ? "RETRY" : "BLOCKED",
              null,
              unavailable
                ? "provider_subscription_hint_lookup_unavailable"
                : "provider_subscription_hint_not_found",
            );
          }
          return json({
            success: false,
            error: unavailable
              ? "billing_recovery_lookup_unavailable"
              : "provider_subscription_local_link_conflict",
          }, unavailable ? 503 : 409);
        }
        const hintedResolution = resolveProviderSubscriptionCandidate(
          hintedEntity.data,
          expectedCreation as ExpectedProviderSubscription,
        );
        if (
          hintedResolution.status !== "MATCH" ||
          hintedResolution.id !== providerSubscriptionHintId
        ) {
          await recordAsaasCreationState(
            authorization.admin,
            creationClaim,
            {
              status: "BLOCKED",
              providerEntityId: providerSubscriptionHintId,
              providerStatus: text(hintedEntity.data.status),
              error: "provider_subscription_hint_payload_conflict",
            },
          );
          await recordBillingPeriod(
            "BLOCKED",
            null,
            "provider_subscription_hint_payload_conflict",
          );
          return json({
            success: false,
            error: "provider_subscription_local_link_conflict",
          }, 409);
        }
      }
      const lookup = await findExactCreation();
      if (lookup.kind === "DUPLICATE" || lookup.kind === "CONFLICT") {
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: "BLOCKED",
            error: lookup.kind === "CONFLICT"
              ? "provider_billing_identity_conflict"
              : isOneTime
              ? "duplicate_provider_payments"
              : "duplicate_provider_subscriptions",
          },
        );
        await recordBillingPeriod(
          "BLOCKED",
          null,
          lookup.kind === "CONFLICT"
            ? "provider_billing_identity_conflict"
            : "duplicate_provider_subscriptions",
        );
        return json({
          success: false,
          error: lookup.kind === "CONFLICT"
            ? "provider_billing_identity_conflict"
            : isOneTime
            ? "duplicate_provider_payments"
            : "duplicate_provider_subscriptions",
        }, 409);
      }
      if (lookup.kind === "UNAVAILABLE") {
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: creationClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            httpStatus: lookup.httpStatus,
            error: "billing_recovery_lookup_unavailable",
          },
        );
        if (billingPeriodClaim?.action === "SUBMIT_ONCE") {
          await recordBillingPeriod(
            "RETRY",
            null,
            "billing_recovery_lookup_unavailable",
          );
        }
        return json({
          success: false,
          error: "billing_recovery_lookup_unavailable",
        }, 503);
      }
      if (lookup.kind === "FOUND") {
        const recoveredResolution = resolveCreationCandidate(lookup.entity);
        recoveredCreationId = recoveredResolution.status === "MATCH"
          ? recoveredResolution.id
          : "";
        if (!recoveredCreationId) {
          await recordAsaasCreationState(
            authorization.admin,
            creationClaim,
            { status: "BLOCKED", error: "provider_billing_id_missing" },
          );
          return json({
            success: false,
            error: "provider_billing_id_missing",
          }, 502);
        }
        recoveredCreationEntity = lookup.entity;
        if (
          boundBillingPeriodProviderId &&
          boundBillingPeriodProviderId !== recoveredCreationId
        ) {
          await recordAsaasCreationState(
            authorization.admin,
            creationClaim,
            {
              status: "BLOCKED",
              providerEntityId: recoveredCreationId,
              error: "billing_period_provider_id_mismatch",
            },
          );
          return json({
            success: false,
            error: "billing_period_provider_id_mismatch",
          }, 409);
        }
        if (
          !isOneTime && existingLocalSubscriptionId &&
          existingLocalSubscriptionId !== recoveredCreationId
        ) {
          await recordAsaasCreationState(
            authorization.admin,
            creationClaim,
            {
              status: "BLOCKED",
              providerEntityId: recoveredCreationId,
              error: "provider_subscription_local_link_conflict",
            },
          );
          await recordBillingPeriod(
            "BLOCKED",
            null,
            "provider_subscription_local_link_conflict",
          );
          return json({
            success: false,
            error: "provider_subscription_local_link_conflict",
          }, 409);
        }
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: "SUCCEEDED",
            providerEntityId: recoveredCreationId,
            providerStatus: text(lookup.entity.status),
          },
        );
        await recordBillingPeriod("BOUND", recoveredCreationId);
      } else if (
        creationClaim.action === "RECONCILE_REQUIRED" ||
        billingPeriodReconcileOnly || boundBillingPeriodProviderId ||
        existingLocalSubscriptionId
      ) {
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: creationClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            error: "provider_billing_not_yet_observed",
          },
        );
        return json({
          success: false,
          error: "billing_creation_reconciliation_pending",
        }, 409);
      }
    }

    if (!recoveredCreationId && creationClaim.action === "ALREADY_SUCCEEDED") {
      return json({
        success: false,
        error: "billing_creation_requires_review",
      }, 409);
    }

    if (recoveredCreationId && isOneTime) {
      if (
        !recoveredCreationEntity ||
        !await bindProviderPaymentToLedger(
          recoveredCreationEntity,
          expectedCreation as ExpectedProviderPayment,
          "SUBSCRIPTION",
        )
      ) {
        return json({
          success: false,
          error: "payment_local_binding_requires_review",
        }, 409);
      }
      const details = await loadOneTimePaymentDetails(
        integration,
        recoveredCreationId,
      );
      let observation: Record<string, unknown> | null = null;
      if (offer) {
        observation = await applyEnrollmentPaymentObservation(
          authorization.admin,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            offerId: offer.id,
            providerPaymentId: recoveredCreationId,
            providerCustomerId: asaasCustomerId,
            providerSubscriptionId: null,
            paymentKind: "ONE_TIME",
            outcome: details.paid
              ? "SETTLED"
              : details.refunded
              ? "UNSETTLED"
              : "PENDING",
            providerValue: (expectedCreation as ExpectedProviderPayment).value,
            externalReference: creationReference,
            providerStatus: details.status,
            dueDate: (expectedCreation as ExpectedProviderPayment).dueDate,
            billingType: (expectedCreation as ExpectedProviderPayment)
              .billingType,
            description: text(recoveredCreationEntity.description) ||
              "Pagamento avulso",
          },
        );
      }
      if (
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          creationClaim,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            providerEntityId: recoveredCreationId,
          },
        )
      ) {
        return json({
          success: false,
          error: "payment_local_binding_requires_review",
        }, 409);
      }
      const enrollmentComplete = observation?.processing_state === "COMPLETED";
      return json({
        success: true,
        id: recoveredCreationId,
        payment_id: recoveredCreationId,
        payment_type: "ONE_TIME",
        recovered: true,
        ...details,
        enrollment_complete: enrollmentComplete,
        processing_state: observation?.processing_state ||
          (offer ? "AWAITING_PAYMENT" : null),
        correlation_id: correlationId,
      });
    }

    const subscriptionWasRecovered = !isOneTime && Boolean(
      recoveredCreationId,
    );
    let subscriptionId = subscriptionWasRecovered ? recoveredCreationId : "";
    if (subscriptionWasRecovered) {
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          creationClaim,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            bindingKind: "SUBSCRIPTION",
            expectedCustomerId: asaasCustomerId,
          },
        )
      ) {
        return json({
          success: false,
          error: "student_creation_lifecycle_requires_review",
        }, 409);
      }
      if (
        boundBillingPeriodProviderId &&
        boundBillingPeriodProviderId !== subscriptionId
      ) {
        return json({
          success: false,
          error: "billing_period_provider_id_mismatch",
        }, 409);
      }
      await recordBillingPeriod("BOUND", subscriptionId);
      if (
        await bindSubscriptionToProfile(subscriptionId) === "CONFLICT"
      ) {
        return json({
          success: false,
          error: "provider_subscription_local_link_conflict",
        }, 409);
      }
      if (
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          creationClaim,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            providerEntityId: subscriptionId,
          },
        )
      ) {
        return json({
          success: false,
          error: "subscription_local_binding_requires_review",
        }, 409);
      }
    }

    const isDependent = offer
      ? Boolean(offerPayload.isDependent)
      : Boolean(profile.guardian_id || profile.guardian_cpf);
    const holderFromRequest =
      body.creditCardHolderInfo && typeof body.creditCardHolderInfo === "object"
        ? body.creditCardHolderInfo as Record<string, unknown>
        : {};
    const holder = {
      name: isDependent ? text(profile.guardian_name) : text(profile.full_name),
      email: isDependent ? text(profile.guardian_email) : text(profile.email),
      cpfCnpj: isDependent ? digits(profile.guardian_cpf) : digits(profile.cpf),
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
      holder.postalCode = text(holderFromRequest.postalCode) ||
        holder.postalCode;
      holder.addressNumber = text(holderFromRequest.addressNumber) ||
        holder.addressNumber;
      holder.phone = digits(holderFromRequest.phone) || holder.phone;
    }

    const creditCard = body.creditCard && typeof body.creditCard === "object"
      ? body.creditCard as Record<string, unknown>
      : null;
    const buildCreditCardPayload = ():
      | {
        ok: true;
        data: Record<string, unknown>;
      }
      | {
        ok: false;
        responseError: string;
        stateError: string;
      } => {
      if (!creditCard) {
        return {
          ok: false,
          responseError: "Dados do cartao obrigatorios.",
          stateError: "credit_card_required_before_submit",
        };
      }
      if (
        !holder.cpfCnpj || !holder.phone || !holder.postalCode ||
        !holder.addressNumber
      ) {
        return {
          ok: false,
          responseError: "Dados do titular do cartao incompletos.",
          stateError: "card_holder_incomplete_before_submit",
        };
      }
      return {
        ok: true,
        data: {
          creditCard: {
            holderName: text(creditCard.holderName),
            number: digits(creditCard.number),
            expiryMonth: text(creditCard.expiryMonth),
            expiryYear: text(creditCard.expiryYear),
            ccv: digits(creditCard.ccv),
          },
          creditCardHolderInfo: {
            ...holder,
            mobilePhone: holder.phone,
          },
        },
      };
    };
    if (billingType === "CREDIT_CARD" && !subscriptionWasRecovered) {
      const cardPayload = buildCreditCardPayload();
      if (cardPayload.ok === false) {
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          { status: "RETRY", error: cardPayload.stateError },
        );
        if (billingPeriodClaim?.action === "SUBMIT_ONCE") {
          await recordBillingPeriod("RETRY", null, cardPayload.stateError);
        }
        return json({ success: false, error: cardPayload.responseError });
      }
      Object.assign(paymentPayload, cardPayload.data);
    }

    if (planDuration === "ONE_TIME") {
      const splitState = await revalidateFrozenSplitPolicy(
        integration,
        creationSplitPolicy,
      );
      if (splitState !== "MATCH") {
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: splitState === "UNAVAILABLE" ? "RETRY" : "BLOCKED",
            error: splitState === "UNAVAILABLE"
              ? "tenant_billing_split_revalidation_unavailable"
              : splitState === "INVALID"
              ? "tenant_billing_split_configuration_invalid"
              : "tenant_billing_split_configuration_changed",
          },
        );
        return json({
          success: false,
          error: splitState === "UNAVAILABLE"
            ? "tenant_billing_configuration_unavailable"
            : "tenant_billing_split_requires_review",
        }, splitState === "UNAVAILABLE" ? 503 : 409);
      }
      await markStudentAsaasCreationSubmitting(
        authorization.admin,
        creationClaim,
        {
          tenantId: authorization.tenantId,
          studentId: userId,
          bindingKind: "STUDENT_PAYMENT",
          expectedCustomerId: asaasCustomerId,
        },
      );
      let submitIntegration: ResolvedAsaasIntegration;
      try {
        submitIntegration = await revalidateAsaasMutationCapability(
          authorization.admin,
          {
            tenantId: authorization.tenantId,
            purpose: "payment.create",
            expected: integration,
          },
        );
      } catch (error) {
        const unavailable = error instanceof AsaasCapabilityFenceError &&
          error.failure === "UNAVAILABLE";
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: "BLOCKED",
            error: unavailable
              ? "payment_capability_unavailable_before_submit"
              : "payment_capability_changed_before_submit",
          },
        );
        return json({
          success: false,
          error: unavailable
            ? "provider_payment_capability_unavailable"
            : "provider_payment_capability_changed",
        }, unavailable ? 503 : 409);
      }
      let paymentRes: Response;
      try {
        paymentRes = await fetch(`${submitIntegration.baseUrl}/payments`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            access_token: submitIntegration.apiKey,
          },
          body: JSON.stringify(paymentPayload),
          signal: AbortSignal.timeout(25_000),
        });
      } catch {
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: "UNKNOWN",
            error: "provider_one_time_post_outcome_unknown",
          },
        );
        return json({
          success: false,
          error: "payment_creation_outcome_unknown",
        }, 502);
      }
      const rawPayment = await paymentRes.text();
      let paymentData: Record<string, unknown> = {};
      try {
        paymentData = JSON.parse(rawPayment);
      } catch {
        // A malformed success/5xx remains ambiguous and is reconciled by GET.
      }
      const paymentId = text(paymentData.id);
      const outcome = asaasCreationHttpOutcome(
        paymentRes.ok,
        paymentRes.status,
        paymentId,
      );
      if (outcome === "SUCCEEDED") {
        const paymentResolution = resolveProviderPaymentCandidate(
          paymentData,
          expectedCreation as ExpectedProviderPayment,
        );
        if (
          paymentResolution.status !== "MATCH" ||
          paymentResolution.id !== paymentId
        ) {
          await recordAsaasCreationState(
            authorization.admin,
            creationClaim,
            {
              status: "BLOCKED",
              providerEntityId: paymentId,
              providerStatus: text(paymentData.status),
              httpStatus: paymentRes.status,
              error: "provider_one_time_response_payload_conflict",
            },
          );
          return json({
            success: false,
            error: "provider_billing_payload_conflict",
          }, 409);
        }
      }
      await recordAsaasCreationState(
        authorization.admin,
        creationClaim,
        {
          status: outcome,
          providerEntityId: paymentId,
          providerStatus: text(paymentData.status),
          httpStatus: paymentRes.status,
          error: outcome === "SUCCEEDED"
            ? null
            : outcome === "FAILED"
            ? "provider_one_time_creation_rejected"
            : "provider_one_time_post_outcome_unknown",
        },
      );
      if (outcome === "UNKNOWN") {
        return json({
          success: false,
          error: "payment_creation_outcome_unknown",
        }, 502);
      }
      if (outcome === "FAILED") {
        const errors = Array.isArray(paymentData.errors)
          ? paymentData.errors
          : [];
        const firstError = errors[0] as
          | { description?: string }
          | undefined;
        return json({
          success: false,
          error: firstError?.description ||
            "Erro ao criar pagamento avulso.",
        }, 502);
      }

      if (
        !await bindProviderPaymentToLedger(
          paymentData,
          expectedCreation as ExpectedProviderPayment,
          "SUBSCRIPTION",
        )
      ) {
        return json({
          success: false,
          error: "payment_local_binding_requires_review",
        }, 409);
      }

      const details = await loadOneTimePaymentDetails(integration, paymentId);
      let observation: Record<string, unknown> | null = null;
      if (offer) {
        observation = await applyEnrollmentPaymentObservation(
          authorization.admin,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            offerId: offer.id,
            providerPaymentId: paymentId,
            providerCustomerId: asaasCustomerId,
            providerSubscriptionId: null,
            paymentKind: "ONE_TIME",
            outcome: details.paid
              ? "SETTLED"
              : details.refunded
              ? "UNSETTLED"
              : "PENDING",
            providerValue: (expectedCreation as ExpectedProviderPayment).value,
            externalReference: creationReference,
            providerStatus: details.status,
            dueDate: (expectedCreation as ExpectedProviderPayment).dueDate,
            billingType: (expectedCreation as ExpectedProviderPayment)
              .billingType,
            description: text(paymentData.description) || "Pagamento avulso",
          },
        );
      }
      if (
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          creationClaim,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            providerEntityId: paymentId,
          },
        )
      ) {
        return json({
          success: false,
          error: "payment_local_binding_requires_review",
        }, 409);
      }
      const enrollmentComplete = observation?.processing_state === "COMPLETED";
      return json({
        success: true,
        id: paymentId,
        payment_id: paymentId,
        payment_type: "ONE_TIME",
        ...details,
        enrollment_complete: enrollmentComplete,
        processing_state: observation?.processing_state ||
          (offer ? "AWAITING_PAYMENT" : null),
        correlation_id: correlationId,
      });
    }

    if (!subscriptionWasRecovered) {
      Object.assign(paymentPayload, {
        remoteIp: (req.headers.get("x-forwarded-for") || "127.0.0.1").split(
          ",",
        )[0].trim(),
      });

      const splitState = await revalidateFrozenSplitPolicy(
        integration,
        creationSplitPolicy,
      );
      if (splitState !== "MATCH") {
        const stateError = splitState === "UNAVAILABLE"
          ? "tenant_billing_split_revalidation_unavailable"
          : splitState === "INVALID"
          ? "tenant_billing_split_configuration_invalid"
          : "tenant_billing_split_configuration_changed";
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: splitState === "UNAVAILABLE" ? "RETRY" : "BLOCKED",
            error: stateError,
          },
        );
        if (billingPeriodClaim?.action === "SUBMIT_ONCE") {
          await recordBillingPeriod(
            splitState === "UNAVAILABLE" ? "RETRY" : "BLOCKED",
            null,
            stateError,
          );
        }
        return json({
          success: false,
          error: splitState === "UNAVAILABLE"
            ? "tenant_billing_configuration_unavailable"
            : "tenant_billing_split_requires_review",
        }, splitState === "UNAVAILABLE" ? 503 : 409);
      }

      if (billingPeriodClaim) {
        await markStudentBillingPeriodSubmitting(
          authorization.admin,
          billingPeriodClaim,
        );
      }
      await markStudentAsaasCreationSubmitting(
        authorization.admin,
        creationClaim,
        {
          tenantId: authorization.tenantId,
          studentId: userId,
          bindingKind: "SUBSCRIPTION",
          expectedCustomerId: asaasCustomerId,
        },
      );
      let submitIntegration: ResolvedAsaasIntegration;
      try {
        submitIntegration = await revalidateAsaasMutationCapability(
          authorization.admin,
          {
            tenantId: authorization.tenantId,
            purpose: "subscription.create",
            expected: integration,
          },
        );
      } catch (error) {
        const unavailable = error instanceof AsaasCapabilityFenceError &&
          error.failure === "UNAVAILABLE";
        const state = "BLOCKED" as const;
        const stateError = unavailable
          ? "subscription_capability_unavailable_before_submit"
          : "subscription_capability_changed_before_submit";
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          { status: state, error: stateError },
        );
        await recordBillingPeriod(state, null, stateError);
        return json({
          success: false,
          error: unavailable
            ? "provider_subscription_capability_unavailable"
            : "provider_subscription_capability_changed",
        }, unavailable ? 503 : 409);
      }
      let subscriptionRes: Response;
      try {
        subscriptionRes = await fetch(
          `${submitIntegration.baseUrl}/subscriptions`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              access_token: submitIntegration.apiKey,
            },
            body: JSON.stringify(paymentPayload),
            signal: AbortSignal.timeout(25_000),
          },
        );
      } catch {
        await recordAsaasCreationState(
          authorization.admin,
          creationClaim,
          {
            status: "UNKNOWN",
            error: "provider_subscription_post_outcome_unknown",
          },
        );
        await recordBillingPeriod(
          "UNKNOWN",
          null,
          "provider_subscription_post_outcome_unknown",
        );
        return json({
          success: false,
          error: "subscription_creation_outcome_unknown",
        }, 502);
      }
      const rawSubscription = await subscriptionRes.text();
      let subscriptionData: Record<string, unknown> = {};
      try {
        subscriptionData = JSON.parse(rawSubscription);
      } catch {
        // A malformed success/5xx remains ambiguous and is reconciled by GET.
      }
      subscriptionId = text(subscriptionData.id);
      const subscriptionOutcome = asaasCreationHttpOutcome(
        subscriptionRes.ok,
        subscriptionRes.status,
        subscriptionId,
      );
      if (subscriptionOutcome === "SUCCEEDED") {
        const subscriptionResolution = resolveProviderSubscriptionCandidate(
          subscriptionData,
          expectedCreation as ExpectedProviderSubscription,
        );
        if (
          subscriptionResolution.status !== "MATCH" ||
          subscriptionResolution.id !== subscriptionId
        ) {
          await recordAsaasCreationState(
            authorization.admin,
            creationClaim,
            {
              status: "BLOCKED",
              providerEntityId: subscriptionId,
              providerStatus: text(subscriptionData.status),
              httpStatus: subscriptionRes.status,
              error: "provider_subscription_response_payload_conflict",
            },
          );
          await recordBillingPeriod(
            "BLOCKED",
            null,
            "provider_subscription_response_payload_conflict",
          );
          return json({
            success: false,
            error: "provider_billing_payload_conflict",
          }, 409);
        }
      }
      await recordAsaasCreationState(
        authorization.admin,
        creationClaim,
        {
          status: subscriptionOutcome,
          providerEntityId: subscriptionId,
          providerStatus: text(subscriptionData.status),
          httpStatus: subscriptionRes.status,
          error: subscriptionOutcome === "SUCCEEDED"
            ? null
            : subscriptionOutcome === "FAILED"
            ? "provider_subscription_creation_rejected"
            : "provider_subscription_post_outcome_unknown",
        },
      );
      await recordBillingPeriod(
        subscriptionOutcome === "SUCCEEDED"
          ? "BOUND"
          : subscriptionOutcome === "FAILED"
          ? "FAILED"
          : "UNKNOWN",
        subscriptionId,
        subscriptionOutcome === "SUCCEEDED"
          ? null
          : subscriptionOutcome === "FAILED"
          ? "provider_subscription_creation_rejected"
          : "provider_subscription_post_outcome_unknown",
      );
      if (subscriptionOutcome === "UNKNOWN") {
        return json({
          success: false,
          error: "subscription_creation_outcome_unknown",
        }, 502);
      }
      if (subscriptionOutcome === "FAILED") {
        const errors = Array.isArray(subscriptionData.errors)
          ? subscriptionData.errors
          : [];
        const firstError = errors[0] as
          | { description?: string }
          | undefined;
        return json({
          success: false,
          error: firstError?.description ||
            "Erro ao processar assinatura.",
        }, 502);
      }

      if (await bindSubscriptionToProfile(subscriptionId) === "CONFLICT") {
        return json({
          success: false,
          error: "provider_subscription_local_link_conflict",
        }, 409);
      }
      if (
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          creationClaim,
          {
            tenantId: authorization.tenantId,
            studentId: userId,
            providerEntityId: subscriptionId,
          },
        )
      ) {
        return json({
          success: false,
          error: "subscription_local_binding_requires_review",
        }, 409);
      }
    }

    // Pro-rata ocorre depois da assinatura e uma unica vez. Qualquer falha e
    // devolvida explicitamente; tentativas ambiguas so podem retomar por GET.
    if (proRataIntegration && proRata && proRataValue && proRataValue > 0) {
      try {
        const proRataLogicalKey = `pro-rata:${offer?.id || userId}`;
        const proRataSeed = await loadCreationSeed(
          authorization.admin,
          authorization.tenantId,
          "PAYMENT_CREATE",
          proRataLogicalKey,
          proRataReference,
          !offer ? [userId] : [],
        );
        const proRataCreationReference = proRataSeed.externalReference;
        const proRataBillingType: ProviderBillingType =
          providerBillingType === "CREDIT_CARD" ? "CREDIT_CARD" : "PIX";
        const buildProRataCandidate = (anchor: Date) => {
          const proRataDueDate = billingDateFromAnchor(anchor);
          if (!proRataDueDate) return null;
          const proRataFinancialPayload: Record<string, unknown> = {
            customer: asaasCustomerId,
            billingType: proRataBillingType,
            value: proRataValue,
            dueDate: proRataDueDate,
            description: `Pro-rata - ${schoolName}`,
            externalReference: proRataCreationReference,
            ...(proRataSplit ? { split: proRataSplit } : {}),
          };
          const proRataSafeSnapshot = {
            tenantId: authorization.tenantId,
            operation: "PAYMENT_CREATE",
            logicalKey: proRataLogicalKey,
            payload: { ...proRataFinancialPayload },
          };
          const expectedProRata: ExpectedProviderPayment = {
            externalReference: proRataCreationReference,
            customerId: asaasCustomerId,
            billingType: proRataBillingType,
            value: proRataValue,
            dueDate: proRataDueDate,
            subscriptionId: null,
            splitPolicy: proRataSplitPolicy!,
          };
          return {
            expectedProRata,
            proRataFinancialPayload,
            proRataSafeSnapshot,
          };
        };
        const proRataCandidates = proRataSeed.anchors.map(
          buildProRataCandidate,
        ).filter(
          (candidate): candidate is NonNullable<
            ReturnType<typeof buildProRataCandidate>
          > => Boolean(candidate),
        );
        if (proRataCandidates.length === 0) {
          throw new Error("pro_rata_due_date_invalid");
        }
        const frozenProRata = await selectFrozenCreationCandidate({
          candidates: proRataCandidates,
          storedFingerprint: proRataSeed.storedFingerprint,
          fingerprintFor: (candidate) =>
            asaasCreationFingerprint(candidate.proRataSafeSnapshot),
        });
        if (
          proRataSeed.storedFingerprint &&
          !frozenProRata.matchedStoredFingerprint
        ) {
          await claimAsaasCreation(authorization.admin, {
            tenantId: authorization.tenantId,
            operation: "PAYMENT_CREATE",
            logicalKey: proRataLogicalKey,
            externalReference: proRataCreationReference,
            requestFingerprint: frozenProRata.fingerprint,
          });
          throw new Error("provider_pro_rata_creation_requires_review");
        }
        const {
          expectedProRata,
          proRataFinancialPayload,
          proRataSafeSnapshot,
        } = frozenProRata.candidate;
        if (containsSensitiveCardMaterial(proRataSafeSnapshot)) {
          throw new Error("sensitive_card_material_in_pro_rata_claim");
        }
        const findExactProRata = () =>
          findUniqueAsaasEntity<Record<string, unknown>>({
            baseUrl: proRataIntegration.baseUrl,
            apiKey: proRataIntegration.apiKey,
            path: "payments",
            // Customer is validated below; filtering it would hide conflicts.
            query: {
              externalReference: proRataCreationReference,
              includeDeleted: "true",
            },
            matches: (candidate) =>
              resolveProviderPaymentCandidate(candidate, expectedProRata)
                .status === "MATCH",
            conflicts: (candidate) =>
              occupiesProviderReference(candidate, proRataCreationReference),
          });
        const proRataClaim = await claimAsaasCreation(
          authorization.admin,
          {
            tenantId: authorization.tenantId,
            operation: "PAYMENT_CREATE",
            logicalKey: proRataLogicalKey,
            externalReference: proRataCreationReference,
            requestFingerprint: frozenProRata.fingerprint,
          },
        );
        if (
          !["IN_PROGRESS", "REVIEW_REQUIRED"].includes(proRataClaim.action) &&
          proRataClaim.ok &&
          !await bindStudentAsaasCreationLifecycle(
            authorization.admin,
            proRataClaim,
            {
              tenantId: authorization.tenantId,
              studentId: userId,
              bindingKind: "STUDENT_PAYMENT",
              expectedCustomerId: asaasCustomerId,
            },
          )
        ) {
          throw new Error("pro_rata_lifecycle_binding_failed");
        }
        let proRataEntity: Record<string, unknown> | null = null;
        if (proRataClaim.action === "ALREADY_SUCCEEDED") {
          const claimedProRataId = normalizeProviderEntityId(
            proRataClaim.provider_entity_id,
          );
          if (!claimedProRataId) {
            throw new Error("provider_pro_rata_claim_id_invalid");
          }
          const claimedProRata = await readProviderEntity(
            proRataIntegration,
            "payments",
            claimedProRataId,
          );
          if (claimedProRata.ok === false) {
            const unavailable = claimedProRata.status === 0 ||
              claimedProRata.status === 408 ||
              claimedProRata.status === 429 || claimedProRata.status >= 500;
            throw new Error(
              unavailable
                ? "provider_pro_rata_claim_lookup_unavailable"
                : "provider_pro_rata_claim_not_found_or_invalid",
            );
          }
          const claimedResolution = resolveProviderPaymentCandidate(
            claimedProRata.data,
            expectedProRata,
          );
          if (
            claimedResolution.status !== "MATCH" ||
            claimedResolution.id !== claimedProRataId
          ) {
            throw new Error("provider_pro_rata_claim_payload_conflict");
          }
          const claimedUniqueness = await findExactProRata();
          if (claimedUniqueness.kind === "UNAVAILABLE") {
            throw new Error("provider_pro_rata_claim_lookup_unavailable");
          }
          if (
            claimedUniqueness.kind !== "FOUND" ||
            resolveProviderPaymentCandidate(
                claimedUniqueness.entity,
                expectedProRata,
              ).status !== "MATCH" ||
            normalizeProviderEntityId(claimedUniqueness.entity.id) !==
              claimedProRataId
          ) {
            throw new Error("provider_pro_rata_claim_identity_conflict");
          }
          proRataChargeId = claimedProRataId;
          proRataEntity = claimedProRata.data;
        } else if (
          proRataClaim.action !== "IN_PROGRESS" &&
          proRataClaim.action !== "REVIEW_REQUIRED" &&
          proRataClaim.ok
        ) {
          const lookup = await findExactProRata();
          if (lookup.kind === "DUPLICATE" || lookup.kind === "CONFLICT") {
            await recordAsaasCreationState(
              authorization.admin,
              proRataClaim,
              {
                status: "BLOCKED",
                error: lookup.kind === "CONFLICT"
                  ? "provider_pro_rata_payload_conflict"
                  : "duplicate_provider_pro_rata",
              },
            );
            throw new Error("provider_pro_rata_requires_review");
          } else if (lookup.kind === "UNAVAILABLE") {
            await recordAsaasCreationState(
              authorization.admin,
              proRataClaim,
              {
                status: proRataClaim.action === "RECONCILE_REQUIRED"
                  ? "UNKNOWN"
                  : "RETRY",
                httpStatus: lookup.httpStatus,
                error: "pro_rata_recovery_lookup_unavailable",
              },
            );
            throw new Error("pro_rata_recovery_lookup_unavailable");
          } else if (lookup.kind === "FOUND") {
            const recoveredResolution = resolveProviderPaymentCandidate(
              lookup.entity,
              expectedProRata,
            );
            proRataChargeId = recoveredResolution.status === "MATCH"
              ? recoveredResolution.id
              : null;
            if (proRataChargeId && recoveredResolution.status === "MATCH") {
              proRataEntity = lookup.entity;
              await recordAsaasCreationState(
                authorization.admin,
                proRataClaim,
                {
                  status: "SUCCEEDED",
                  providerEntityId: proRataChargeId,
                  providerStatus: recoveredResolution.providerStatus,
                },
              );
            } else {
              await recordAsaasCreationState(
                authorization.admin,
                proRataClaim,
                { status: "BLOCKED", error: "provider_pro_rata_id_missing" },
              );
              throw new Error("provider_pro_rata_id_missing");
            }
          } else if (proRataClaim.action === "RECONCILE_REQUIRED") {
            await recordAsaasCreationState(
              authorization.admin,
              proRataClaim,
              {
                status: "UNKNOWN",
                error: "provider_pro_rata_not_yet_observed",
              },
            );
            throw new Error("provider_pro_rata_reconciliation_pending");
          } else {
            const proRataSubmitPayload: Record<string, unknown> = {
              ...proRataFinancialPayload,
            };
            if (providerBillingType === "CREDIT_CARD") {
              const cardPayload = buildCreditCardPayload();
              if (cardPayload.ok === false) {
                await recordAsaasCreationState(
                  authorization.admin,
                  proRataClaim,
                  { status: "RETRY", error: cardPayload.stateError },
                );
                throw new Error(cardPayload.stateError);
              }
              Object.assign(proRataSubmitPayload, cardPayload.data);
            }
            const splitState = await revalidateFrozenSplitPolicy(
              proRataIntegration,
              proRataSplitPolicy!,
            );
            if (splitState !== "MATCH") {
              const stateError = splitState === "UNAVAILABLE"
                ? "pro_rata_split_configuration_unavailable"
                : splitState === "INVALID"
                ? "pro_rata_split_configuration_invalid"
                : "pro_rata_split_configuration_changed";
              await recordAsaasCreationState(
                authorization.admin,
                proRataClaim,
                {
                  status: splitState === "UNAVAILABLE" ? "RETRY" : "BLOCKED",
                  error: stateError,
                },
              );
              throw new Error(stateError);
            }
            await markStudentAsaasCreationSubmitting(
              authorization.admin,
              proRataClaim,
              {
                tenantId: authorization.tenantId,
                studentId: userId,
                bindingKind: "STUDENT_PAYMENT",
                expectedCustomerId: asaasCustomerId,
              },
            );
            let submitProRataIntegration: ResolvedAsaasIntegration;
            try {
              submitProRataIntegration =
                await revalidateAsaasMutationCapability(
                  authorization.admin,
                  {
                    tenantId: authorization.tenantId,
                    purpose: "payment.create",
                    expected: proRataIntegration,
                  },
                );
            } catch (error) {
              const unavailable = error instanceof AsaasCapabilityFenceError &&
                error.failure === "UNAVAILABLE";
              const stateError = unavailable
                ? "pro_rata_capability_unavailable_before_submit"
                : "pro_rata_capability_changed_before_submit";
              await recordAsaasCreationState(
                authorization.admin,
                proRataClaim,
                {
                  status: "BLOCKED",
                  error: stateError,
                },
              );
              throw new Error(stateError);
            }
            let proRataRes: Response;
            try {
              proRataRes = await fetch(
                `${submitProRataIntegration.baseUrl}/payments`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    access_token: submitProRataIntegration.apiKey,
                  },
                  body: JSON.stringify(proRataSubmitPayload),
                  signal: AbortSignal.timeout(25_000),
                },
              );
            } catch {
              await recordAsaasCreationState(
                authorization.admin,
                proRataClaim,
                {
                  status: "UNKNOWN",
                  error: "provider_pro_rata_post_outcome_unknown",
                },
              );
              throw new Error("pro_rata_creation_outcome_unknown");
            }
            const rawProRata = await proRataRes.text();
            let proRataData: Record<string, unknown> = {};
            try {
              proRataData = JSON.parse(rawProRata);
            } catch {
              // Classification below keeps malformed success/5xx ambiguous.
            }
            const providerProRataId = text(proRataData.id);
            const proRataOutcome = asaasCreationHttpOutcome(
              proRataRes.ok,
              proRataRes.status,
              providerProRataId,
            );
            if (proRataOutcome === "SUCCEEDED") {
              const proRataResolution = resolveProviderPaymentCandidate(
                proRataData,
                expectedProRata,
              );
              if (
                proRataResolution.status !== "MATCH" ||
                proRataResolution.id !== providerProRataId
              ) {
                await recordAsaasCreationState(
                  authorization.admin,
                  proRataClaim,
                  {
                    status: "BLOCKED",
                    providerEntityId: providerProRataId,
                    providerStatus: text(proRataData.status),
                    httpStatus: proRataRes.status,
                    error: "provider_pro_rata_response_payload_conflict",
                  },
                );
                throw new Error("provider_pro_rata_response_payload_conflict");
              }
            }
            await recordAsaasCreationState(
              authorization.admin,
              proRataClaim,
              {
                status: proRataOutcome,
                providerEntityId: providerProRataId,
                providerStatus: text(proRataData.status),
                httpStatus: proRataRes.status,
                error: proRataOutcome === "SUCCEEDED"
                  ? null
                  : proRataOutcome === "FAILED"
                  ? "provider_pro_rata_creation_rejected"
                  : "provider_pro_rata_post_outcome_unknown",
              },
            );
            if (proRataOutcome === "SUCCEEDED") {
              proRataChargeId = providerProRataId;
              proRataEntity = proRataData;
            } else {
              throw new Error(
                proRataOutcome === "FAILED"
                  ? "provider_pro_rata_creation_rejected"
                  : "pro_rata_creation_outcome_unknown",
              );
            }
          }
        } else {
          throw new Error(
            proRataClaim.action === "IN_PROGRESS"
              ? "provider_pro_rata_in_progress"
              : "provider_pro_rata_creation_requires_review",
          );
        }
        if (
          !proRataChargeId || !proRataEntity ||
          !await bindProviderPaymentToLedger(
            proRataEntity,
            expectedProRata,
            "PRO_RATA",
          ) ||
          !await releaseStudentAsaasCreationLifecycle(
            authorization.admin,
            proRataClaim,
            {
              tenantId: authorization.tenantId,
              studentId: userId,
              providerEntityId: proRataChargeId,
            },
          )
        ) {
          throw new Error("pro_rata_local_binding_requires_review");
        }
      } catch (error) {
        proRataFailure = classifyProRataFailure(error);
        console.error("[create-asaas-subscription] pro-rata", {
          type: error instanceof Error ? error.name : "UnknownError",
          state: proRataFailure.state,
        });
      }
    }

    const completion = await registerRecurringBilling(subscriptionId);
    if (proRataFailure) {
      return json({
        success: false,
        subscription_created: true,
        subscription_id: subscriptionId,
        id: subscriptionId,
        recovered: subscriptionWasRecovered,
        pro_rata_charge_id: proRataChargeId,
        pro_rata_status: proRataFailure.state,
        pro_rata_recovery: "GET_ONLY",
        error: proRataFailure.error,
        enrollment_complete: enrollmentAlreadyComplete || Boolean(completion),
        processing_state: enrollmentAlreadyComplete || completion
          ? "COMPLETED"
          : offer
          ? "AWAITING_PAYMENT"
          : null,
        correlation_id: correlationId,
      }, proRataFailure.httpStatus);
    }
    return json({
      success: true,
      subscription_id: subscriptionId,
      id: subscriptionId,
      recovered: subscriptionWasRecovered,
      pro_rata_charge_id: proRataChargeId,
      enrollment_complete: enrollmentAlreadyComplete || Boolean(completion),
      processing_state: enrollmentAlreadyComplete || completion
        ? "COMPLETED"
        : offer
        ? "AWAITING_PAYMENT"
        : null,
      correlation_id: correlationId,
    });
  } catch (error) {
    const integrationUnavailable = error instanceof
      TenantIntegrationBrokerError;
    const reviewRequired = billingReviewRequired(error);
    console.error("[create-asaas-subscription]", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    if (progressAdmin && progressOfferId && progressUserId) {
      await markEnrollmentFailure(
        progressAdmin,
        progressOfferId,
        progressUserId,
        integrationUnavailable
          ? "asaas_not_configured"
          : reviewRequired
          ? "billing_creation_requires_review"
          : "billing_creation_failed",
        error,
      );
    }
    return json({
      success: false,
      error: integrationUnavailable
        ? "asaas_not_configured"
        : reviewRequired
        ? "billing_creation_requires_review"
        : error instanceof Error
        ? error.message
        : "Erro interno ao criar cobranca.",
    }, integrationUnavailable ? 503 : reviewRequired ? 409 : 500);
  }
});
