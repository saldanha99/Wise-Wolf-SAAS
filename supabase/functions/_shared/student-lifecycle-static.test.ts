/// <reference lib="deno.ns" />

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function source(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

Deno.test({
  name: "overdue card charge crosses a one-way submit fence",
  permissions: { read: true },
  async fn() {
    const billing = await source("../update-student-billing-method/index.ts");
    const migration = await source(
      "../../migrations/20260825194716_fence_student_lifecycle_mutations.sql",
    );
    assertStringIncludes(billing, '"claim_student_overdue_card_charge"');
    assertStringIncludes(
      billing,
      '"mark_student_overdue_card_charge_submitting"',
    );
    assertStringIncludes(billing, '"finish_student_overdue_card_charge"');
    assertStringIncludes(billing, "ambiguousProviderMutationStatus(");
    assertStringIncludes(billing, "deterministicProviderDeclineStatus(");
    const fence = billing.indexOf("await markChargeSubmitting(");
    const post = billing.indexOf("/payWithCreditCard`", fence);
    assert(
      fence >= 0 && post > fence,
      "provider POST happened before submit fence",
    );
    assert(!billing.includes('.from("student_overdue_card_charge_claims")'));
    const markStart = migration.indexOf(
      "create or replace function public.mark_student_overdue_card_charge_submitting(",
    );
    const markEnd = migration.indexOf("$function$;", markStart);
    const mark = migration.slice(markStart, markEnd);
    assertStringIncludes(mark, "student-billing-lifecycle:");
    assertStringIncludes(mark, "profile.lifecycle_status");
    assertStringIncludes(mark, "membership.status = 'ACTIVE'");
    assertStringIncludes(mark, "student_offboarding_operations");
    assertStringIncludes(mark, "student_account_deletion_claims");
  },
});

Deno.test({
  name: "billing method PUT is durable and UNKNOWN retries are GET-only",
  permissions: { read: true },
  async fn() {
    const billing = await source("../update-student-billing-method/index.ts");
    assertStringIncludes(
      billing,
      '"begin_student_billing_method_operation"',
    );
    assertStringIncludes(billing, '"mark_student_billing_method_mutating"');
    assertStringIncludes(
      billing,
      '"finish_student_billing_method_operation"',
    );
    assertStringIncludes(billing, "providerSubscriptionCardMatchesLast4(");
    const reconcile = billing.indexOf(
      'operation.action === "RECONCILE_REQUIRED"',
    );
    const reconcileGet = billing.indexOf(
      '"billing_method_subscription_reconcile"',
      reconcile,
    );
    const submitFence = billing.indexOf(
      "await markBillingMethodMutating(",
      reconcile,
    );
    const firstPut = billing.indexOf('"PUT"', submitFence);
    assert(
      reconcile >= 0 && reconcileGet > reconcile &&
        submitFence > reconcileGet &&
        firstPut > submitFence,
      "UNKNOWN recovery or provider PUT bypassed the durable mutation fence",
    );
  },
});

Deno.test({
  name: "permanent student deletion is claim-bound and identity-checked",
  permissions: { read: true },
  async fn() {
    const deletion = await source("../delete-student-account/index.ts");
    assertStringIncludes(deletion, '"begin_student_account_deletion"');
    assertStringIncludes(
      deletion,
      '"record_student_account_deletion_provider_state"',
    );
    assertStringIncludes(
      deletion,
      '"bind_student_account_deletion_integrations"',
    );
    assertStringIncludes(deletion, '"finalize_student_account_deletion"');
    assertStringIncludes(deletion, "providerCustomerMatchesStudent(");
    assertStringIncludes(deletion, "guardAsaasMutationTarget({");
    assertStringIncludes(deletion, '.eq("asaas_customer_id", customerId)');
    assertStringIncludes(deletion, '.eq("subscription_id", subscriptionId)');
    const claim = deletion.indexOf("await beginDeletionClaim(");
    const providerDelete = deletion.indexOf('method: "DELETE"', claim);
    assert(claim >= 0 && providerDelete > claim);
    const profileDelete = deletion.lastIndexOf(
      'supabase.from("profiles").delete()',
    );
    const authDelete = deletion.lastIndexOf(
      "supabase.auth.admin.deleteUser(",
    );
    assert(
      profileDelete > providerDelete && authDelete > profileDelete,
      "Auth was deleted before local FK-safe profile cleanup",
    );
  },
});

Deno.test({
  name: "school offboarding finalizes locally only after provider completion",
  permissions: { read: true },
  async fn() {
    const [school, migration] = await Promise.all([
      source("../school-admin/index.ts"),
      source(
        "../../migrations/20260825194716_fence_student_lifecycle_mutations.sql",
      ),
    ]);
    assertStringIncludes(school, '"begin_student_offboarding"');
    assertStringIncludes(school, '"record_student_offboarding_provider_state"');
    assertStringIncludes(school, '"bind_student_offboarding_integrations"');
    assertStringIncludes(school, '"finalize_student_offboarding"');
    const providerComplete = school.indexOf(
      'recordOffboardingProviderState(admin, claim, "COMPLETE")',
    );
    const finalize = school.indexOf(
      '"finalize_student_offboarding"',
      providerComplete,
    );
    assert(providerComplete >= 0 && finalize > providerComplete);
    assertStringIncludes(
      migration,
      "and upper(coalesce(payment.status, '')) = 'PENDING'",
    );
    assertStringIncludes(
      migration,
      "profile.subscription_id, '')), '') is not distinct from operation_row.subscription_id",
    );
    assertStringIncludes(migration, "integration_snapshot <> '{}'::jsonb");
  },
});

Deno.test({
  name: "enrollment PIX validates exact unique identity before binding and QR",
  permissions: { read: true },
  async fn() {
    const enrollment = await source("../create-enrollment-pix/index.ts");
    assertEquals(
      enrollment.match(/await verifyEnrollmentPayment\(/g)?.length,
      6,
      "check, stored binding, provider recovery, local binding, event advancement and QR paths must verify the provider payment",
    );
    assertStringIncludes(enrollment, 'includeDeleted: "true"');
    assertStringIncludes(enrollment, "providerEnrollmentPaymentMatches(");
    assertStringIncludes(enrollment, "freezeEnrollmentPaymentRequest(");
    assertStringIncludes(enrollment, "dueDate: paymentDueDate");
    assertStringIncludes(enrollment, "description: paymentDescription");
    assertStringIncludes(enrollment, "subscription: null");
    assertStringIncludes(enrollment, "splitPolicy,");
    assertStringIncludes(enrollment, "tenant_split_changed_before_submit");
    const lastSplitRead = enrollment.lastIndexOf(
      "await loadEnrollmentSplitPolicy(",
    );
    const submitFence = enrollment.indexOf(
      "await markStudentAsaasCreationSubmitting(",
      lastSplitRead,
    );
    const paymentPost = enrollment.indexOf(
      "fetch(`${submitIntegration.baseUrl}/payments`",
      submitFence,
    );
    assert(
      lastSplitRead >= 0 && submitFence > lastSplitRead &&
        paymentPost > submitFence,
      "split policy was not revalidated immediately before the one-way POST fence",
    );
    const scopeRecheck = enrollment.lastIndexOf(
      "await revalidateActiveStudentCreationScope(",
      submitFence,
    );
    assert(scopeRecheck > lastSplitRead && submitFence > scopeRecheck);
    assertStringIncludes(enrollment, "bindStudentAsaasCreationLifecycle(");
    assertStringIncludes(enrollment, "releaseStudentAsaasCreationLifecycle(");
    const verifyQr = enrollment.indexOf("const qrVerification = await");
    const enrollmentEvent = enrollment.indexOf(
      "await markEnrollmentStage(",
      verifyQr,
    );
    const finalQrVerify = enrollment.indexOf(
      "const finalQrVerification = await",
      enrollmentEvent,
    );
    const qr = enrollment.indexOf("/pixQrCode`", finalQrVerify);
    assert(
      verifyQr >= 0 && enrollmentEvent > verifyQr &&
        finalQrVerify > enrollmentEvent && qr > finalQrVerify,
    );
  },
});

Deno.test({
  name: "student customer and subscription syncs finish with canonical CAS",
  permissions: { read: true },
  async fn() {
    const [customerSync, subscriptionSync] = await Promise.all([
      source("../sync-student-asaas/index.ts"),
      source("../sync-subscription-status/index.ts"),
    ]);
    assertStringIncludes(customerSync, '"customer.read"');
    assertStringIncludes(customerSync, "providerCustomerMatchesStudent(");
    assertStringIncludes(customerSync, "markStudentAsaasCreationSubmitting(");
    assertStringIncludes(customerSync, "releaseStudentAsaasCreationLifecycle(");
    assertStringIncludes(customerSync, '.eq("tenant_id", tenantId)');
    assertStringIncludes(
      subscriptionSync,
      '.eq("subscription_id", result.subscriptionId)',
    );
    assertStringIncludes(
      subscriptionSync,
      '.eq("asaas_customer_id", result.customerId)',
    );
  },
});

Deno.test({
  name: "late settlement for an offboarded student is update-only",
  permissions: { read: true },
  async fn() {
    const webhook = await source("../asaas-webhook/index.ts");
    assertStringIncludes(
      webhook,
      'rpc("apply_inactive_student_payment_settlement"',
    );
    assertStringIncludes(webhook, "inactiveSettlementUpdateOnly");
    const updateOnly = webhook.indexOf(
      "if (inactiveSettlementUpdateOnly) {",
      webhook.indexOf("const settledPayment = isSettledPaymentEvent(event)"),
    );
    const enrollmentLookup = webhook.indexOf(
      "resolveWebhookEnrollmentObservationBinding",
      updateOnly,
    );
    assert(
      updateOnly >= 0 && enrollmentLookup > updateOnly,
      "inactive settlement did not stop before enrollment/notification effects",
    );
  },
});

Deno.test({
  name: "webhook enrollment effects use the exact atomic observation contract",
  permissions: { read: true },
  async fn() {
    const [webhook, progress, observationMigration] = await Promise.all([
      source("../asaas-webhook/index.ts"),
      source("./enrollment-progress.ts"),
      source(
        "../../migrations/20260825202500_serialize_enrollment_payment_observations.sql",
      ),
    ]);
    for (
      const argument of [
        "p_tenant_id: input.tenantId",
        "p_student_id: input.studentId",
        "p_offer_id: input.offerId",
        "p_provider_payment_id: input.providerPaymentId",
        "p_provider_customer_id: input.providerCustomerId",
        "p_provider_subscription_id: input.providerSubscriptionId",
        "p_payment_kind: input.paymentKind",
        "p_outcome: input.outcome",
        "p_provider_value: input.providerValue",
        "p_external_reference: input.externalReference",
        "p_provider_status: input.providerStatus",
        "p_due_date: input.dueDate",
        "p_billing_type: input.billingType",
        "p_description: input.description",
      ]
    ) {
      assertStringIncludes(progress, argument);
    }
    assertStringIncludes(progress, "student_lifecycle_inactive");
    assertStringIncludes(progress, "provider_observation_stale");
    assertStringIncludes(webhook, "applyWebhookEnrollmentObservation(");
    assert(
      !webhook.includes(".update({ enrollment_fee_paid: true })"),
      "webhook still writes the enrollment fee outside the observation RPC",
    );
    const durablePayment = webhook.indexOf(
      'rpc("apply_active_student_payment_event"',
    );
    const enrollmentEffects = webhook.indexOf(
      "await applyWebhookEnrollmentObservation(",
      durablePayment,
    );
    const communication = webhook.indexOf(
      '.from("notification_queue")',
      enrollmentEffects,
    );
    assert(
      durablePayment >= 0 && enrollmentEffects > durablePayment &&
        communication > enrollmentEffects,
      "enrollment observation/communication ran before the financial event was durable",
    );
    const recomputeStart = observationMigration.indexOf(
      "create or replace function public.recompute_student_financial_status(",
    );
    const recomputeEnd = observationMigration.indexOf(
      "$function$;",
      recomputeStart,
    );
    const recompute = observationMigration.slice(recomputeStart, recomputeEnd);
    assert(
      recomputeStart >= 0 &&
        recompute.includes("'student-billing-lifecycle:'") &&
        recompute.includes("student_offboarding_operations") &&
        recompute.includes("student_account_deletion_claims") &&
        recompute.includes("student_lifecycle_operation_active"),
      "aggregate profile status still mutates outside the lifecycle advisory",
    );
  },
});

Deno.test({
  name: "manual Pix message submission shares the student lifecycle fence",
  permissions: { read: true },
  async fn() {
    const [manualPix, migration] = await Promise.all([
      source("../generate-student-manual-pix/index.ts"),
      source(
        "../../migrations/20260825194716_fence_student_lifecycle_mutations.sql",
      ),
    ]);
    const mark = manualPix.indexOf("await markOutboundMessageSubmitting(");
    const send = manualPix.indexOf("await sendWhatsapp(", mark);
    assert(
      mark >= 0 && send > mark,
      "WhatsApp POST happened before the final lifecycle revalidation",
    );

    const claimStart = migration.indexOf(
      "create or replace function public.claim_asaas_outbound_message(",
    );
    const markStart = migration.indexOf(
      "create or replace function public.mark_asaas_outbound_message_submitting(",
      claimStart,
    );
    const nextFunction = migration.indexOf(
      "create or replace function public.bind_student_asaas_creation_lifecycle(",
      markStart,
    );
    const claimFence = migration.slice(claimStart, markStart);
    const markFence = migration.slice(markStart, nextFunction);
    assertStringIncludes(claimFence, "student-billing-lifecycle:");
    assertStringIncludes(claimFence, "profile.lifecycle_status");
    assertStringIncludes(claimFence, "membership.status = 'ACTIVE'");
    assertStringIncludes(claimFence, "student_offboarding_operations");
    assertStringIncludes(claimFence, "student_account_deletion_claims");
    assertStringIncludes(markFence, "student-billing-lifecycle:");
    assertStringIncludes(markFence, "student_lifecycle_inactive_before_send");
    assertStringIncludes(markFence, "status = 'SUPPRESSED'");
    assert(
      migration.match(/'reason', 'outbound_message_in_flight'/g)?.length === 2,
      "offboarding and deletion must both reject an in-flight message",
    );
  },
});

Deno.test({
  name:
    "protected student payment handlers authenticate before reading the body",
  permissions: { read: true },
  async fn() {
    const handlers = await Promise.all([
      source("../generate-student-manual-pix/index.ts"),
      source("../sync-student-asaas/index.ts"),
      source("../update-student-billing-method/index.ts"),
      source("../create-enrollment-pix/index.ts"),
      source("../create-asaas-subscription/index.ts"),
    ]);

    for (const handler of handlers) {
      const authentication = handler.indexOf("await authorizeRequest(req,");
      const bodyRead = handler.indexOf("await req.json(");
      assert(
        authentication >= 0 && bodyRead > authentication,
        "a protected payment handler can parse or validate input before authentication",
      );
    }
  },
});
