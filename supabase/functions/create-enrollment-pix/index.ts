import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authenticatedPaymentUserId,
  authorizePaymentTarget,
  loadClaimedEnrollmentOffer,
} from "../_shared/payment-auth.ts";
import type { PaymentAdminClient } from "../_shared/payment-auth.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
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
  canonicalEnrollmentSplitPolicy,
  providerEnrollmentPaymentMatches,
  providerSplitPayload,
  providerSplitPoliciesEqual,
  type ProviderSplitPolicy,
} from "../_shared/student-provider-lifecycle.ts";
import {
  type AsaasCreationClaim,
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  bindStudentAsaasCreationLifecycle,
  claimAsaasCreation,
  findUniqueAsaasEntity,
  freezeEnrollmentPaymentRequest,
  isAsaasRefundedPaymentStatus,
  isAsaasSettledPaymentStatus,
  markStudentAsaasCreationSubmitting,
  recordAsaasCreationState,
  releaseStudentAsaasCreationLifecycle,
  revalidateActiveStudentCreationScope,
} from "../_shared/asaas-creation-guard.ts";

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
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

async function verifyEnrollmentPayment(
  integration: ResolvedAsaasIntegration,
  expected: {
    id: string;
    customerId: string;
    externalReference: string;
    value: number;
    dueDate: string;
    description: string;
    splitPolicy: ProviderSplitPolicy;
  },
): Promise<
  | { ok: true; payment: Record<string, unknown> }
  | { ok: false; error: string; status: number }
> {
  let response: Response;
  try {
    response = await fetch(
      `${integration.baseUrl}/payments/${encodeURIComponent(expected.id)}`,
      {
        method: "GET",
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    return {
      ok: false,
      error: "payment_identity_lookup_unavailable",
      status: 0,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: response.status === 404
        ? "payment_identity_not_found"
        : "payment_identity_lookup_unavailable",
      status: response.status,
    };
  }
  const payment = await response.json().catch(() => null);
  if (!providerEnrollmentPaymentMatches(payment, expected)) {
    return { ok: false, error: "payment_identity_mismatch", status: 409 };
  }

  const unique = await findUniqueAsaasEntity<Record<string, unknown>>({
    baseUrl: integration.baseUrl,
    apiKey: integration.apiKey,
    path: "payments",
    query: {
      externalReference: expected.externalReference,
      includeDeleted: "true",
    },
    matches: (candidate) =>
      providerEnrollmentPaymentMatches(candidate, expected),
    conflicts: (candidate) =>
      text(candidate.externalReference) === expected.externalReference,
  });
  if (unique.kind === "UNAVAILABLE") {
    return {
      ok: false,
      error: "payment_uniqueness_lookup_unavailable",
      status: unique.httpStatus || 0,
    };
  }
  if (unique.kind !== "FOUND" || text(unique.entity.id) !== expected.id) {
    return {
      ok: false,
      error: unique.kind === "DUPLICATE"
        ? "duplicate_provider_payments"
        : "provider_payment_identity_conflict",
      status: 409,
    };
  }
  return { ok: true, payment: unique.entity };
}

async function loadEnrollmentPaymentDueDate(
  integration: ResolvedAsaasIntegration,
  expected: {
    id: string;
    customerId: string;
    externalReference: string;
    value: number;
    description: string;
    splitPolicy: ProviderSplitPolicy;
  },
): Promise<
  | { ok: true; dueDate: string }
  | { ok: false; error: string; status: number }
> {
  let response: Response;
  try {
    response = await fetch(
      `${integration.baseUrl}/payments/${encodeURIComponent(expected.id)}`,
      {
        method: "GET",
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(12_000),
      },
    );
  } catch {
    return {
      ok: false,
      error: "payment_identity_lookup_unavailable",
      status: 0,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: response.status === 404
        ? "payment_identity_not_found"
        : "payment_identity_lookup_unavailable",
      status: response.status,
    };
  }
  const payment = await response.json().catch(() => null);
  const dueDate = payment && typeof payment === "object"
    ? text((payment as Record<string, unknown>).dueDate)
    : "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) ||
    !providerEnrollmentPaymentMatches(payment, { ...expected, dueDate })
  ) {
    return { ok: false, error: "payment_identity_mismatch", status: 409 };
  }
  return { ok: true, dueDate };
}

async function loadEnrollmentSplitPolicy(
  admin: PaymentAdminClient,
  tenantId: string,
  integration: ResolvedAsaasIntegration,
): Promise<
  | { ok: true; policy: ProviderSplitPolicy }
  | { ok: false; error: "UNAVAILABLE" | "INVALID" }
> {
  const { data: tenant, error } = await admin.from("tenants")
    .select("asaas_wallet_id,asaas_split_percentage")
    .eq("id", tenantId)
    .maybeSingle();
  if (error || !tenant) return { ok: false, error: "UNAVAILABLE" };
  const policy = canonicalEnrollmentSplitPolicy(
    integration.mode,
    tenant.asaas_wallet_id,
    tenant.asaas_split_percentage,
  );
  return policy ? { ok: true, policy } : { ok: false, error: "INVALID" };
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

  let progressAdmin: PaymentAdminClient | null = null;
  let progressOfferId = "";
  let progressUserId = "";

  try {
    const body = await req.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (!body) return json({ success: false, error: "invalid_request" }, 400);

    let targetUserId = text(body.user_id);
    if (!targetUserId) {
      const caller = await authenticatedPaymentUserId(req, corsHeaders);
      if (caller.error) return caller.error;
      targetUserId = caller.userId || "";
    }
    progressUserId = targetUserId;

    const authResult = await authorizePaymentTarget(
      req,
      targetUserId,
      corsHeaders,
    );
    if (authResult.error) return authResult.error;
    const authorization = authResult.authorization!;
    progressAdmin = authorization.admin;
    const profile = authorization.targetProfile;

    const isSelfStudent = !authorization.isService &&
      authorization.callerId === targetUserId &&
      authorization.callerProfile?.role === "STUDENT";
    const offer = isSelfStudent
      ? await loadClaimedEnrollmentOffer(
        authorization.admin,
        targetUserId,
        authorization.tenantId,
      )
      : null;
    progressOfferId = offer?.id || "";

    if (isSelfStudent && !offer) {
      return json({ success: false, error: "enrollment_offer_required" }, 403);
    }
    const enrollmentRequired = offer
      ? offer.requires_enrollment !== false
      : numberValue(profile.enrollment_fee) !== null &&
        Number(profile.enrollment_fee) > 0;
    const amount = offer
      ? numberValue(offer.enrollment_fee)
      : numberValue(profile.enrollment_fee);
    if (!enrollmentRequired || !amount || amount <= 0) {
      return json(
        { success: false, error: "enrollment_fee_not_required" },
        400,
      );
    }

    const customerId = text(profile.asaas_customer_id);
    if (!customerId) {
      return json(
        { success: false, error: "student_not_synced_with_asaas" },
        409,
      );
    }

    const metadata = offer?.metadata || {};
    const profilePaymentId = text(profile.enrollment_payment_id);
    const offerPaymentId = text(metadata.enrollment_payment_id);
    if (
      profilePaymentId && offerPaymentId && profilePaymentId !== offerPaymentId
    ) {
      return json({ success: false, error: "payment_binding_conflict" }, 409);
    }
    const storedPaymentId = profilePaymentId || offerPaymentId;
    const requestedPaymentId = text(body.paymentId);
    const action = text(body.action);
    const paymentId = storedPaymentId || requestedPaymentId;

    if (
      requestedPaymentId && storedPaymentId &&
      requestedPaymentId !== storedPaymentId
    ) {
      return json({ success: false, error: "payment_forbidden" }, 403);
    }

    const paymentReference = offer
      ? `enrollment:${offer.id}:fee`
      : targetUserId;
    const paymentDescription = "Taxa de Matricula Wise Wolf School";
    const integration = await resolveAsaasIntegration(
      authorization.admin,
      authorization.tenantId,
      action === "check" ? "payment.read" : "payment.create",
    );
    const initialSplitPolicy = await loadEnrollmentSplitPolicy(
      authorization.admin,
      authorization.tenantId,
      integration,
    );
    if (initialSplitPolicy.ok === false) {
      return json({
        success: false,
        error: initialSplitPolicy.error === "INVALID"
          ? "tenant_billing_configuration_invalid"
          : "tenant_billing_configuration_unavailable",
      }, initialSplitPolicy.error === "INVALID" ? 409 : 503);
    }
    const splitPolicy = initialSplitPolicy.policy;
    const logicalKey = offer
      ? `enrollment-fee:${offer.id}`
      : `enrollment-fee:${targetUserId}`;
    const lifecycleInput = {
      tenantId: authorization.tenantId,
      studentId: targetUserId,
      bindingKind: "ENROLLMENT_PAYMENT" as const,
      expectedCustomerId: customerId,
    };
    const claimEnrollmentPayment = async () =>
      await claimAsaasCreation(authorization.admin, {
        tenantId: authorization.tenantId,
        operation: "PAYMENT_CREATE",
        logicalKey,
        externalReference: paymentReference,
        requestFingerprint: await asaasCreationFingerprint({
          tenantId: authorization.tenantId,
          operation: "PAYMENT_CREATE",
          logicalKey,
          externalReference: paymentReference,
          customerId,
          billingType: "PIX",
          amount,
          currency: "BRL",
          description: paymentDescription,
          subscription: null,
          splitPolicy,
          requestSnapshotKind: "ENROLLMENT_PAYMENT_V1",
        }),
      });

    if (action === "check") {
      if (!paymentId || paymentId !== storedPaymentId) {
        return json({ success: false, error: "payment_not_found" }, 404);
      }

      const checkClaim = await claimEnrollmentPayment();
      if (checkClaim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "payment_creation_in_progress",
          retry_after_seconds: checkClaim.retry_after_seconds || 15,
        }, 409);
      }
      if (checkClaim.action === "REVIEW_REQUIRED" || !checkClaim.ok) {
        return json({
          success: false,
          error: "payment_creation_requires_review",
        }, 409);
      }
      if (
        checkClaim.action === "ALREADY_SUCCEEDED" &&
        text(checkClaim.provider_entity_id) !== paymentId
      ) {
        return json({
          success: false,
          error: "payment_creation_local_binding_conflict",
        }, 409);
      }
      const observedIdentity = await loadEnrollmentPaymentDueDate(
        integration,
        {
          id: paymentId,
          customerId,
          externalReference: paymentReference,
          value: amount,
          description: paymentDescription,
          splitPolicy,
        },
      );
      if (observedIdentity.ok === false) {
        return json(
          { success: false, error: observedIdentity.error },
          observedIdentity.status === 404 || observedIdentity.status === 409
            ? 409
            : 503,
        );
      }
      const checkedDueDate = await freezeEnrollmentPaymentRequest(
        authorization.admin,
        checkClaim,
        {
          dueDate: observedIdentity.dueDate,
          description: paymentDescription,
        },
      );
      const checked = await verifyEnrollmentPayment(integration, {
        id: paymentId,
        customerId,
        externalReference: paymentReference,
        value: amount,
        dueDate: checkedDueDate,
        description: paymentDescription,
        splitPolicy,
      });
      if (checked.ok === false) {
        return json({
          success: false,
          status: "PENDING",
          error: checked.error,
        }, checked.status === 409 || checked.status === 404 ? 409 : 502);
      }
      if (checkClaim.action !== "ALREADY_SUCCEEDED") {
        await recordAsaasCreationState(authorization.admin, checkClaim, {
          status: "SUCCEEDED",
          providerEntityId: paymentId,
          providerStatus: text(checked.payment.status),
        });
      }
      if (!profilePaymentId) {
        const { data: recoveredProfile, error: recoveredError } =
          await authorization.admin.from("profiles")
            .update({
              enrollment_payment_id: paymentId,
              enrollment_fee: amount,
            })
            .eq("id", targetUserId)
            .eq("tenant_id", authorization.tenantId)
            .eq("asaas_customer_id", customerId)
            .is("enrollment_payment_id", null)
            .select("id")
            .maybeSingle();
        if (recoveredError || !recoveredProfile) {
          const current = await authorization.admin.from("profiles")
            .select("asaas_customer_id,enrollment_payment_id")
            .eq("id", targetUserId)
            .eq("tenant_id", authorization.tenantId)
            .maybeSingle();
          if (
            current.error ||
            text(current.data?.asaas_customer_id) !== customerId ||
            text(current.data?.enrollment_payment_id) !== paymentId
          ) {
            return json(
              { success: false, error: "payment_binding_changed" },
              409,
            );
          }
        }
      }
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          checkClaim,
          lifecycleInput,
        )
      ) {
        return json({
          success: false,
          error: "payment_creation_lifecycle_requires_review",
        }, 409);
      }

      const payment = checked.payment;
      const status = text(payment.status) || "PENDING";
      const paid = isAsaasSettledPaymentStatus(status);
      const refunded = isAsaasRefundedPaymentStatus(status);
      const observation = await applyEnrollmentPaymentObservation(
        authorization.admin,
        {
          tenantId: authorization.tenantId,
          studentId: targetUserId,
          offerId: offer?.id || null,
          providerPaymentId: paymentId,
          providerCustomerId: customerId,
          providerSubscriptionId: null,
          paymentKind: "ENROLLMENT_FEE",
          outcome: paid ? "SETTLED" : refunded ? "UNSETTLED" : "PENDING",
          providerValue: amount,
          externalReference: paymentReference,
          providerStatus: status,
          dueDate: checkedDueDate,
          billingType: "PIX",
          description: paymentDescription,
        },
      );
      if (
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          checkClaim,
          {
            tenantId: authorization.tenantId,
            studentId: targetUserId,
            providerEntityId: paymentId,
          },
        )
      ) {
        return json({
          success: false,
          error: "payment_creation_lifecycle_release_failed",
        }, 409);
      }
      const enrollmentComplete = observation.processing_state === "COMPLETED";

      return json({
        success: true,
        status,
        paid,
        enrollment_complete: enrollmentComplete,
        processing_state: observation.processing_state || "AWAITING_PAYMENT",
        correlation_id: offer?.processing_correlation_id || null,
      });
    }

    if (action && action !== "create") {
      return json({ success: false, error: "action_not_allowed" }, 400);
    }

    let finalPaymentId = storedPaymentId;
    let recoveredCreation = false;
    let creationLifecycleClaim: AsaasCreationClaim | null = null;
    let paymentDueDate = "";
    if (finalPaymentId) {
      const claim = await claimEnrollmentPayment();
      if (claim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "payment_creation_in_progress",
          retry_after_seconds: claim.retry_after_seconds || 15,
        }, 409);
      }
      if (claim.action === "REVIEW_REQUIRED" || !claim.ok) {
        return json({
          success: false,
          error: "payment_creation_requires_review",
        }, 409);
      }
      if (
        claim.action === "ALREADY_SUCCEEDED" &&
        text(claim.provider_entity_id) !== finalPaymentId
      ) {
        return json({
          success: false,
          error: "payment_creation_local_binding_conflict",
        }, 409);
      }
      const observedIdentity = await loadEnrollmentPaymentDueDate(
        integration,
        {
          id: finalPaymentId,
          customerId,
          externalReference: paymentReference,
          value: amount,
          description: paymentDescription,
          splitPolicy,
        },
      );
      if (observedIdentity.ok === false) {
        return json(
          { success: false, error: observedIdentity.error },
          observedIdentity.status === 404 || observedIdentity.status === 409
            ? 409
            : 503,
        );
      }
      paymentDueDate = await freezeEnrollmentPaymentRequest(
        authorization.admin,
        claim,
        {
          dueDate: observedIdentity.dueDate,
          description: paymentDescription,
        },
      );
      const storedVerification = await verifyEnrollmentPayment(integration, {
        id: finalPaymentId,
        customerId,
        externalReference: paymentReference,
        value: amount,
        dueDate: paymentDueDate,
        description: paymentDescription,
        splitPolicy,
      });
      if (storedVerification.ok === false) {
        return json(
          { success: false, error: storedVerification.error },
          storedVerification.status === 404 || storedVerification.status === 409
            ? 409
            : 503,
        );
      }
      if (claim.action !== "ALREADY_SUCCEEDED") {
        await recordAsaasCreationState(authorization.admin, claim, {
          status: "SUCCEEDED",
          providerEntityId: finalPaymentId,
          providerStatus: text(storedVerification.payment.status),
        });
      }
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          claim,
          lifecycleInput,
        ) ||
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          claim,
          {
            tenantId: authorization.tenantId,
            studentId: targetUserId,
            providerEntityId: finalPaymentId,
          },
        )
      ) {
        return json({
          success: false,
          error: "payment_creation_lifecycle_release_failed",
        }, 409);
      }
    }
    if (!finalPaymentId) {
      const claim = await claimEnrollmentPayment();
      creationLifecycleClaim = claim;

      if (claim.action === "ALREADY_SUCCEEDED") {
        if (
          !await bindStudentAsaasCreationLifecycle(
            authorization.admin,
            claim,
            lifecycleInput,
          )
        ) {
          return json({
            success: false,
            error: "payment_creation_lifecycle_requires_review",
          }, 409);
        }
        finalPaymentId = text(claim.provider_entity_id);
        recoveredCreation = true;
      } else if (claim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "payment_creation_in_progress",
          retry_after_seconds: claim.retry_after_seconds || 15,
        }, 409);
      } else if (claim.action === "REVIEW_REQUIRED" || !claim.ok) {
        return json({
          success: false,
          error: "payment_creation_requires_review",
        }, 409);
      }

      const proposedDueDate = new Date().toISOString().slice(0, 10);
      if (claim.action === "ALREADY_SUCCEEDED") {
        const recoveredId = text(claim.provider_entity_id);
        if (!recoveredId) {
          return json({
            success: false,
            error: "provider_payment_id_missing",
          }, 409);
        }
        const observedIdentity = await loadEnrollmentPaymentDueDate(
          integration,
          {
            id: recoveredId,
            customerId,
            externalReference: paymentReference,
            value: amount,
            description: paymentDescription,
            splitPolicy,
          },
        );
        if (observedIdentity.ok === false) {
          return json(
            { success: false, error: observedIdentity.error },
            observedIdentity.status === 404 || observedIdentity.status === 409
              ? 409
              : 503,
          );
        }
        paymentDueDate = await freezeEnrollmentPaymentRequest(
          authorization.admin,
          claim,
          {
            dueDate: observedIdentity.dueDate,
            description: paymentDescription,
          },
        );
      } else {
        paymentDueDate = await freezeEnrollmentPaymentRequest(
          authorization.admin,
          claim,
          { dueDate: proposedDueDate, description: paymentDescription },
        );
      }

      if (claim.action !== "ALREADY_SUCCEEDED") {
        const lookup = await findUniqueAsaasEntity<Record<string, unknown>>({
          baseUrl: integration.baseUrl,
          apiKey: integration.apiKey,
          path: "payments",
          query: {
            externalReference: paymentReference,
          },
          matches: (candidate) =>
            providerEnrollmentPaymentMatches(candidate, {
              id: text(candidate.id),
              customerId,
              externalReference: paymentReference,
              value: amount,
              dueDate: paymentDueDate,
              description: paymentDescription,
              splitPolicy,
            }),
          conflicts: (candidate) =>
            candidate.deleted !== true &&
            text(candidate.externalReference) === paymentReference,
        });
        if (lookup.kind === "DUPLICATE" || lookup.kind === "CONFLICT") {
          await recordAsaasCreationState(authorization.admin, claim, {
            status: "BLOCKED",
            error: lookup.kind === "DUPLICATE"
              ? "duplicate_provider_payments"
              : "provider_payment_identity_conflict",
          });
          return json({
            success: false,
            error: lookup.kind === "DUPLICATE"
              ? "duplicate_provider_payments"
              : "provider_payment_identity_conflict",
          }, 409);
        }
        if (lookup.kind === "UNAVAILABLE") {
          await recordAsaasCreationState(authorization.admin, claim, {
            status: claim.action === "RECONCILE_REQUIRED" ? "UNKNOWN" : "RETRY",
            httpStatus: lookup.httpStatus,
            error: "payment_recovery_lookup_unavailable",
          });
          return json({
            success: false,
            error: "payment_recovery_lookup_unavailable",
          }, 503);
        }
        if (lookup.kind === "FOUND") {
          if (
            !await bindStudentAsaasCreationLifecycle(
              authorization.admin,
              claim,
              lifecycleInput,
            )
          ) {
            return json({
              success: false,
              error: "payment_creation_lifecycle_requires_review",
            }, 409);
          }
          finalPaymentId = text(lookup.entity.id);
          if (!finalPaymentId) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "BLOCKED",
              error: "provider_payment_id_missing",
            });
            return json({
              success: false,
              error: "provider_payment_id_missing",
            }, 502);
          }
          const recoveredVerification = await verifyEnrollmentPayment(
            integration,
            {
              id: finalPaymentId,
              customerId,
              externalReference: paymentReference,
              value: amount,
              dueDate: paymentDueDate,
              description: paymentDescription,
              splitPolicy,
            },
          );
          if (recoveredVerification.ok === false) {
            const identityConflict = recoveredVerification.status === 404 ||
              recoveredVerification.status === 409;
            await recordAsaasCreationState(authorization.admin, claim, {
              status: identityConflict ? "BLOCKED" : "UNKNOWN",
              httpStatus: recoveredVerification.status || null,
              error: recoveredVerification.error,
            });
            return json({
              success: false,
              error: recoveredVerification.error,
            }, identityConflict ? 409 : 503);
          }
          await recordAsaasCreationState(authorization.admin, claim, {
            status: "SUCCEEDED",
            providerEntityId: finalPaymentId,
            providerStatus: text(recoveredVerification.payment.status),
          });
          recoveredCreation = true;
        } else if (claim.action === "RECONCILE_REQUIRED") {
          await recordAsaasCreationState(authorization.admin, claim, {
            status: "UNKNOWN",
            error: "provider_payment_not_yet_observed",
          });
          return json({
            success: false,
            error: "payment_creation_reconciliation_pending",
          }, 409);
        } else {
          const { data: latestProfile, error: latestProfileError } =
            await authorization.admin
              .from("profiles")
              .select("asaas_customer_id,enrollment_payment_id")
              .eq("id", targetUserId)
              .maybeSingle();
          if (latestProfileError || !latestProfile) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "RETRY",
              error: "student_binding_revalidation_unavailable",
            });
            return json({
              success: false,
              error: "student_billing_state_unavailable",
            }, 503);
          }
          if (
            text(latestProfile.asaas_customer_id) !== customerId ||
            text(latestProfile.enrollment_payment_id)
          ) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "BLOCKED",
              error: "student_binding_changed_before_submit",
            });
            return json({
              success: false,
              error: "student_billing_state_changed",
            }, 409);
          }

          // Re-read the split configuration at the last safe point before the
          // one-way submission fence. A changed or missing policy can never
          // reuse the fingerprint and payload captured above.
          const latestSplitPolicy = await loadEnrollmentSplitPolicy(
            authorization.admin,
            authorization.tenantId,
            integration,
          );
          if (latestSplitPolicy.ok === false) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "RETRY",
              error: latestSplitPolicy.error === "INVALID"
                ? "tenant_split_invalid_before_submit"
                : "tenant_split_lookup_failed_before_submit",
            });
            return json({
              success: false,
              error: latestSplitPolicy.error === "INVALID"
                ? "tenant_billing_configuration_invalid"
                : "tenant_billing_configuration_unavailable",
            }, latestSplitPolicy.error === "INVALID" ? 409 : 503);
          }
          if (
            !providerSplitPoliciesEqual(
              splitPolicy,
              latestSplitPolicy.policy,
            )
          ) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "BLOCKED",
              error: "tenant_split_changed_before_submit",
            });
            return json({
              success: false,
              error: "tenant_billing_configuration_changed",
            }, 409);
          }
          const split = providerSplitPayload(splitPolicy);

          if (
            !await revalidateActiveStudentCreationScope(
              authorization.admin,
              lifecycleInput,
            )
          ) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "BLOCKED",
              error: "student_lifecycle_changed_before_submit",
            });
            return json({
              success: false,
              error: "student_billing_state_changed",
            }, 409);
          }
          await markStudentAsaasCreationSubmitting(
            authorization.admin,
            claim,
            lifecycleInput,
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
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "BLOCKED",
              error: unavailable
                ? "payment_capability_unavailable_before_submit"
                : "payment_capability_changed_before_submit",
            });
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
              body: JSON.stringify({
                customer: customerId,
                billingType: "PIX",
                value: amount,
                dueDate: paymentDueDate,
                description: paymentDescription,
                externalReference: paymentReference,
                ...(split ? { split } : {}),
              }),
              signal: AbortSignal.timeout(25_000),
            });
          } catch {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "UNKNOWN",
              error: "provider_payment_post_outcome_unknown",
            });
            return json({
              success: false,
              error: "payment_creation_outcome_unknown",
            }, 502);
          }

          const rawPayment = await paymentRes.text();
          let payment: Record<string, unknown> = {};
          try {
            payment = JSON.parse(rawPayment);
          } catch {
            // Outcome classification below remains fail-closed.
          }
          const submittedPaymentMatches = providerEnrollmentPaymentMatches(
            payment,
            {
              id: text(payment.id),
              customerId,
              externalReference: paymentReference,
              value: amount,
              dueDate: paymentDueDate,
              description: paymentDescription,
              splitPolicy,
            },
          );
          const providerPaymentId = submittedPaymentMatches
            ? text(payment.id)
            : "";
          const outcome = asaasCreationHttpOutcome(
            paymentRes.ok,
            paymentRes.status,
            providerPaymentId,
          );
          await recordAsaasCreationState(authorization.admin, claim, {
            status: outcome,
            providerEntityId: providerPaymentId,
            providerStatus: text(payment.status),
            httpStatus: paymentRes.status,
            error: outcome === "SUCCEEDED"
              ? null
              : outcome === "FAILED"
              ? "provider_payment_creation_rejected"
              : "provider_payment_post_outcome_unknown",
          });
          if (outcome === "UNKNOWN") {
            return json({
              success: false,
              error: "payment_creation_outcome_unknown",
            }, 502);
          }
          if (outcome === "FAILED") {
            const errors = Array.isArray(payment.errors) ? payment.errors : [];
            const firstError = errors[0] as
              | { description?: string }
              | undefined;
            return json({
              success: false,
              error: firstError?.description ||
                "enrollment_payment_creation_failed",
            }, 502);
          }
          finalPaymentId = providerPaymentId;
        }
      }

      if (!finalPaymentId) {
        throw new Error("payment_creation_state_invalid");
      }

      // A claim/POST response is not a local binding authorization. Prove the
      // exact object by id and prove uniqueness by externalReference first.
      const bindingVerification = await verifyEnrollmentPayment(integration, {
        id: finalPaymentId,
        customerId,
        externalReference: paymentReference,
        value: amount,
        dueDate: paymentDueDate,
        description: paymentDescription,
        splitPolicy,
      });
      if (bindingVerification.ok === false) {
        return json(
          { success: false, error: bindingVerification.error },
          bindingVerification.status === 404 ||
            bindingVerification.status === 409
            ? 409
            : 503,
        );
      }

      const { data: linkedProfile, error: profileUpdateError } =
        await authorization.admin
          .from("profiles")
          .update({
            enrollment_payment_id: finalPaymentId,
            enrollment_fee: amount,
          })
          .eq("id", targetUserId)
          .eq("tenant_id", authorization.tenantId)
          .eq("asaas_customer_id", customerId)
          .is("enrollment_payment_id", null)
          .select("id")
          .maybeSingle();
      if (profileUpdateError || !linkedProfile) {
        const currentProfile = await authorization.admin.from("profiles")
          .select("asaas_customer_id,enrollment_payment_id")
          .eq("id", targetUserId)
          .maybeSingle();
        const sameBinding = !currentProfile.error &&
          text(currentProfile.data?.asaas_customer_id) === customerId &&
          text(currentProfile.data?.enrollment_payment_id) === finalPaymentId;
        if (sameBinding) {
          // Another invocation linked the exact same provider payment.
        } else {
          console.error(
            "[create-enrollment-pix] payment persisted remotely but profile update failed",
            {
              code: profileUpdateError?.code ||
                currentProfile.error?.code || "binding_conflict",
            },
          );
          return json(
            { success: false, error: "payment_persistence_failed" },
            500,
          );
        }
      }
      if (
        creationLifecycleClaim &&
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          creationLifecycleClaim,
          {
            tenantId: authorization.tenantId,
            studentId: targetUserId,
            providerEntityId: finalPaymentId,
          },
        )
      ) {
        return json({
          success: false,
          error: "payment_creation_lifecycle_release_failed",
        }, 409);
      }
    }

    if (!finalPaymentId) {
      throw new Error("payment_binding_state_invalid");
    }
    const qrVerification = await verifyEnrollmentPayment(integration, {
      id: finalPaymentId,
      customerId,
      externalReference: paymentReference,
      value: amount,
      dueDate: paymentDueDate,
      description: paymentDescription,
      splitPolicy,
    });
    if (qrVerification.ok === false) {
      return json(
        { success: false, error: qrVerification.error },
        qrVerification.status === 404 || qrVerification.status === 409
          ? 409
          : 503,
      );
    }
    if (!profilePaymentId) {
      const { error: recoveredBindingError } = await authorization.admin
        .from("profiles")
        .update({
          enrollment_payment_id: finalPaymentId,
          enrollment_fee: amount,
        })
        .eq("id", targetUserId)
        .eq("tenant_id", authorization.tenantId)
        .eq("asaas_customer_id", customerId)
        .is("enrollment_payment_id", null);
      if (recoveredBindingError) {
        return json(
          { success: false, error: "payment_persistence_failed" },
          500,
        );
      }
    }
    const { data: qrBoundProfile, error: qrBindingError } = await authorization
      .admin.from("profiles")
      .select("id")
      .eq("id", targetUserId)
      .eq("tenant_id", authorization.tenantId)
      .eq("asaas_customer_id", customerId)
      .eq("enrollment_payment_id", finalPaymentId)
      .maybeSingle();
    if (qrBindingError || !qrBoundProfile) {
      return json({ success: false, error: "payment_binding_changed" }, 409);
    }

    // Provider identity and canonical local binding are established before
    // advancing the enrollment event/state machine.
    if (offer) {
      await markEnrollmentStage(
        authorization.admin,
        offer.id,
        targetUserId,
        "AWAITING_PAYMENT",
        { metadata: { enrollment_payment_id: finalPaymentId } },
      );
    }

    const finalQrVerification = await verifyEnrollmentPayment(integration, {
      id: finalPaymentId,
      customerId,
      externalReference: paymentReference,
      value: amount,
      dueDate: paymentDueDate,
      description: paymentDescription,
      splitPolicy,
    });
    if (finalQrVerification.ok === false) {
      return json(
        { success: false, error: finalQrVerification.error },
        finalQrVerification.status === 404 ||
          finalQrVerification.status === 409
          ? 409
          : 503,
      );
    }

    const qrCodeRes = await fetch(
      `${integration.baseUrl}/payments/${
        encodeURIComponent(finalPaymentId)
      }/pixQrCode`,
      { headers: { access_token: integration.apiKey } },
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
      idempotent: Boolean(storedPaymentId || recoveredCreation),
      processing_state: offer ? "AWAITING_PAYMENT" : null,
      correlation_id: offer?.processing_correlation_id || null,
    });
  } catch (error) {
    const integrationUnavailable = error instanceof
      TenantIntegrationBrokerError;
    console.error("[create-enrollment-pix]", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    if (progressAdmin && progressOfferId && progressUserId) {
      await markEnrollmentFailure(
        progressAdmin,
        progressOfferId,
        progressUserId,
        integrationUnavailable
          ? "asaas_not_configured"
          : "payment_creation_failed",
        error,
      );
    }
    return json({
      success: false,
      error: integrationUnavailable ? "asaas_not_configured" : "internal_error",
    }, integrationUnavailable ? 503 : 500);
  }
});
