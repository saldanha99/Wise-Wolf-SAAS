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
  name:
    "official Asaas subscription updates use PUT without overriding notification consent",
  permissions: { read: true },
  async fn() {
    const [planChange, adminUpdate, subscriptionCreation] = await Promise.all([
      source("../sync-plan-change-billing/index.ts"),
      source("../admin-update-subscription/index.ts"),
      source("../create-asaas-subscription/index.ts"),
    ]);

    assertStringIncludes(planChange, 'method: "PUT"');
    assert(!planChange.includes('method: "POST"'));
    assertStringIncludes(adminUpdate, 'method: "PUT"');
    assert(!adminUpdate.includes('? "POST" : "GET"'));

    assert(!subscriptionCreation.includes("/notifications"));
    assert(!subscriptionCreation.includes("whatsappEnabledForCustomer"));
  },
});

Deno.test({
  name: "debt collection remains fail-closed without a provider mutation",
  permissions: { read: true },
  async fn() {
    const schoolAdmin = await source("./index.ts");
    assertStringIncludes(
      schoolAdmin,
      'code: "DUNNING_DISABLED_PENDING_SAFE_OUTBOX"',
    );
    assert(!schoolAdmin.includes("/paymentDunnings"));
    assert(!schoolAdmin.includes('"dunning.create"'));
  },
});

Deno.test({
  name: "every Asaas mutation and subscription sync proves provider identity",
  permissions: { read: true },
  async fn() {
    const [planChange, billingMethod, schoolAdmin, adminUpdate, statusSync] =
      await Promise.all([
        source("../sync-plan-change-billing/index.ts"),
        source("../update-student-billing-method/index.ts"),
        source("./index.ts"),
        source("../admin-update-subscription/index.ts"),
        source("../sync-subscription-status/index.ts"),
      ]);

    for (
      const caller of [
        planChange,
        billingMethod,
        schoolAdmin,
        adminUpdate,
        statusSync,
      ]
    ) {
      assertStringIncludes(caller, "guardAsaasMutationTarget");
    }

    assert(
      planChange.indexOf("await guardAsaasMutationTarget") <
        planChange.indexOf('method: "PUT"'),
    );
    assertStringIncludes(
      billingMethod,
      '"billing_method_subscription_card_update"',
    );
    assertStringIncludes(
      billingMethod,
      '"billing_method_overdue_payment_charge"',
    );
    assertEquals(
      billingMethod.match(/await guardSubscription\(/g)?.length,
      4,
      "read, card association and both subscription update branches must preflight",
    );
    assertStringIncludes(schoolAdmin, "requireAsaasOffboardingIdentity");
    assertStringIncludes(schoolAdmin, 'guard.code === "NOT_FOUND"');
    assertStringIncludes(
      schoolAdmin,
      'kind: "ASAAS_MUTATION_TARGET_ALREADY_ABSENT"',
    );
    const lifecycleStart = schoolAdmin.indexOf(
      "const paymentTargets = claim.payments.flatMap",
    );
    const lifecycleBlock = schoolAdmin.slice(
      lifecycleStart,
      schoolAdmin.indexOf(
        "const begun = await beginStudentReactivation",
        lifecycleStart,
      ),
    );
    assertEquals(
      lifecycleBlock.match(/await requireAsaasOffboardingIdentity\(/g)?.length,
      4,
      "subscription/payment mutations must preflight and both resources must satisfy postconditions",
    );
    assertStringIncludes(lifecycleBlock, "listAsaasSubscriptionPayments(");
    assertStringIncludes(
      lifecycleBlock,
      "requireCompleteOffboardingPaymentSnapshot(",
    );
    assertStringIncludes(
      lifecycleBlock,
      "requireOffboardingProviderCancellationComplete(",
    );
    const firstPreflight = lifecycleBlock.indexOf(
      "await requireAsaasOffboardingIdentity",
    );
    const secondPreflight = lifecycleBlock.indexOf(
      "await requireAsaasOffboardingIdentity",
      firstPreflight + 1,
    );
    const postcondition = lifecycleBlock.indexOf(
      "await requireAsaasOffboardingIdentity",
      secondPreflight + 1,
    );
    const firstDelete = lifecycleBlock.indexOf("await callAsaas(");
    assert(
      firstPreflight >= 0 && secondPreflight > firstPreflight &&
        firstDelete > secondPreflight && postcondition > firstDelete,
      "all provider identities must be preflighted before the first PUT/DELETE",
    );
    assert(
      adminUpdate.indexOf("const guard = await guardAsaasMutationTarget") <
        adminUpdate.indexOf('method: "PUT"'),
    );
    assertStringIncludes(adminUpdate, "revalidateCanonicalAsaasBinding");
    assertStringIncludes(
      adminUpdate,
      "admin_subscription_update_postcondition",
    );
    assert(
      statusSync.indexOf("await guardAsaasMutationTarget") <
        statusSync.indexOf("asaas_subscription_status: result.status"),
    );
  },
});

Deno.test({
  name: "destructive account operations enforce active unambiguous scope",
  permissions: { read: true },
  async fn() {
    const [deletion, schoolAdmin] = await Promise.all([
      source("../delete-student-account/index.ts"),
      source("./index.ts"),
    ]);

    assertStringIncludes(deletion, "await authorizeRequest(req");
    assertStringIncludes(deletion, '.from("tenant_memberships")');
    assertStringIncludes(deletion, 'membership.status !== "ACTIVE"');
    assertStringIncludes(deletion, "studentProfile.lifecycle_status");
    assertEquals(
      deletion.match(/loadExclusiveActiveStudentScope\(/g)?.length,
      4,
      "delete must define and perform authorization, pre-provider and pre-local scope checks",
    );
    assert(!deletion.includes(".auth.getUser("));

    assertStringIncludes(
      schoolAdmin,
      "hasExclusiveActiveTargetMembership(data || []",
    );
    assertEquals(
      schoolAdmin.match(/await requireExclusiveActiveTargetMembership\(/g)
        ?.length,
      4,
      "lifecycle must validate scope at request, immediately before provider mutations and before local fallback",
    );
  },
});

Deno.test({
  name:
    "offboarding accepts only exact deleted frozen charges and reactivation stays fail-closed",
  permissions: { read: true },
  async fn() {
    const schoolAdmin = await source("./index.ts");
    const proofStart = schoolAdmin.indexOf(
      "async function proveFrozenDeletedOffboardingPayments(",
    );
    const proofEnd = schoolAdmin.indexOf(
      "async function requireSynchronizedLiveSubscriptionPayments(",
      proofStart,
    );
    const proof = schoolAdmin.slice(proofStart, proofEnd);
    assert(proofStart >= 0 && proofEnd > proofStart);
    assertStringIncludes(
      proof,
      'operation: "school_admin_offboarding_deleted_payment_inventory"',
    );
    assertStringIncludes(proof, 'identity.evidence === "DELETED"');
    assertStringIncludes(
      proof,
      "classifyExactDeletedOffboardingPaymentProof({",
    );
    assertStringIncludes(proof, 'disposition === "OPEN_DELETABLE"');
    assertEquals(
      proof.match(/proven\.set\(frozen\.asaasPaymentId,/g)?.length,
      1,
      "only an exactly proven still-open deletable row may enter the exception map",
    );
    assertStringIncludes(proof, '"OFFBOARDING_DELETED_PAYMENT_NOT_PROVEN"');

    const classifierStart = schoolAdmin.indexOf(
      "export function classifyExactDeletedOffboardingPaymentProof(",
    );
    const classifierEnd = schoolAdmin.indexOf(
      "export function isExactDeletedOffboardingPaymentProof(",
      classifierStart,
    );
    const classifier = schoolAdmin.slice(classifierStart, classifierEnd);
    assertStringIncludes(classifier, 'localAccountingStatus === "CANCELLED"');
    assertStringIncludes(classifier, 'localProviderStatus === "DELETED"');
    assertStringIncludes(classifier, 'return "ALREADY_RECONCILED"');
    assertStringIncludes(
      classifier,
      "DELETABLE_PAYMENT_STATUSES.has(localAccountingStatus)",
    );
    assertStringIncludes(
      classifier,
      "localAccountingStatus === frozenAccountingStatus",
    );
    assertStringIncludes(classifier, "input.provider.deleted === true");
    assertStringIncludes(classifier, "input.local.paidAt == null");

    const syncStart = schoolAdmin.indexOf(
      "async function requireSynchronizedLiveSubscriptionPayments(",
    );
    const syncEnd = schoolAdmin.indexOf(
      "type OffboardingCustomerInventory =",
      syncStart,
    );
    const sync = schoolAdmin.slice(syncStart, syncEnd);
    assertStringIncludes(
      sync,
      "local.accountingStatus !== proof.accountingStatus",
    );
    assertStringIncludes(sync, "local.status !== proof.providerStatus");

    const inventoryStart = schoolAdmin.indexOf(
      "async function requireOffboardingCustomerInventory(",
    );
    const inventoryEnd = schoolAdmin.indexOf(
      "function requireOffboardingCustomerPostcondition(",
      inventoryStart,
    );
    const inventory = schoolAdmin.slice(inventoryStart, inventoryEnd);
    assert(inventoryStart >= 0 && inventoryEnd > inventoryStart);
    assertStringIncludes(inventory, "proveFrozenDeletedOffboardingPayments(");
    assertStringIncludes(inventory, "provenDeletedOpenPayments,");

    const claimParserStart = schoolAdmin.indexOf(
      "async function beginStudentOffboarding(",
    );
    const claimParserEnd = schoolAdmin.indexOf(
      "type ReactivationClaim =",
      claimParserStart,
    );
    const claimParser = schoolAdmin.slice(claimParserStart, claimParserEnd);
    assertStringIncludes(
      claimParser,
      "result.preserved_payment_snapshot",
    );
    assertStringIncludes(
      claimParser,
      "result.provider_subscription_final_status",
    );
    assertStringIncludes(
      claimParser,
      "preservedPayments.length !== 1",
    );

    const retainedInvoiceStart = schoolAdmin.indexOf(
      "async function requireSinglePreservedCurrentInvoice(",
    );
    const retainedInvoiceEnd = schoolAdmin.indexOf(
      "async function requireExclusiveActiveTargetMembership(",
      retainedInvoiceStart,
    );
    const retainedInvoice = schoolAdmin.slice(
      retainedInvoiceStart,
      retainedInvoiceEnd,
    );
    assertStringIncludes(retainedInvoice, "claim.preservedPayments");
    assertStringIncludes(
      retainedInvoice,
      "isExactPreservedOffboardingPaymentSnapshot(frozen",
    );

    const offboardingExecutionStart = schoolAdmin.indexOf(
      "const preserveCurrentInvoices =",
    );
    const offboardingExecutionEnd = schoolAdmin.indexOf(
      '"finalize_student_offboarding_with_billing_policy"',
      offboardingExecutionStart,
    );
    const offboardingExecution = schoolAdmin.slice(
      offboardingExecutionStart,
      offboardingExecutionEnd,
    );
    assertStringIncludes(
      offboardingExecution,
      "claim.providerSubscriptionFinalStatus",
    );
    assert(
      !offboardingExecution.includes(
        "definitivePreservedSubscriptionIsSafe",
      ),
      "offboarding must not accept ABSENT/EXPIRED when the frozen final state is INACTIVE",
    );

    const reactivationStart = schoolAdmin.indexOf(
      "const begun = await beginStudentReactivation",
    );
    const reactivationEnd = schoolAdmin.indexOf(
      "const { data: finalized, error: finalizeError } = await admin.rpc(",
      reactivationStart,
    );
    const reactivation = schoolAdmin.slice(
      reactivationStart,
      reactivationEnd,
    );
    assert(reactivationStart >= 0 && reactivationEnd > reactivationStart);
    assertEquals(
      reactivation.match(
        /await requireSynchronizedLiveSubscriptionPayments\(/g,
      )?.length,
      2,
      "reactivation must reconcile both preflight and postcondition inventories",
    );
    assert(
      !reactivation.includes("provenDeletedOpenPayments"),
      "reactivation must never inherit the offboarding-only deleted-payment exception",
    );
    assertStringIncludes(
      reactivation,
      '"pre_provider_validation_failed"',
    );
    assertStringIncludes(
      reactivation,
      "verifiedStatus !== claim.providerSubscriptionFinalStatus",
    );
    assertStringIncludes(reactivation, "throw operationError;");
    assert(
      reactivation.indexOf(
        'recordOffboardingProviderState(admin, claim, "MUTATING")',
      ) <
        reactivation.indexOf("catch (operationError)"),
      "the outer catch must preserve pre-provider aborts and fail closed after the mutation fence",
    );
  },
});

Deno.test({
  name:
    "payment authorization validates target profile before membership scope",
  permissions: { read: true },
  async fn() {
    const paymentAuth = await source("../_shared/payment-auth.ts");
    const guard = paymentAuth.indexOf(
      "if (!isActiveStudentPaymentTarget(targetProfile as Profile))",
    );
    const memberships = paymentAuth.indexOf(
      "const membershipResult = await loadActiveStudentMemberships",
    );
    assert(guard >= 0 && memberships > guard);
    assert(!paymentAuth.includes('role: "STUDENT",\n    tenant_id'));
  },
});

Deno.test({
  name: "payment authorization authenticates before exposing target validation",
  permissions: { read: true },
  async fn() {
    const paymentAuth = await source("../_shared/payment-auth.ts");
    const helperStart = paymentAuth.indexOf(
      "export async function authorizePaymentTarget(",
    );
    const helperEnd = paymentAuth.indexOf(
      "\nexport async function loadClaimedEnrollmentOffer(",
      helperStart,
    );
    const helper = paymentAuth.slice(helperStart, helperEnd);
    const authenticate = helper.indexOf(
      "const auth = await authorizeRequest(req,",
    );
    const rejectUnauthenticated = helper.indexOf(
      "if (auth.ok === false) return { error: auth.response };",
    );
    const validateTarget = helper.indexOf("if (!targetUserId)");

    assert(
      helperStart >= 0 &&
        helperEnd > helperStart &&
        authenticate >= 0 &&
        rejectUnauthenticated > authenticate &&
        validateTarget > rejectUnauthenticated,
      "an anonymous empty-body request must resolve to 401 before target_user_required",
    );
  },
});

Deno.test({
  name: "student and enrollment creations reject divergent provider identity",
  permissions: { read: true },
  async fn() {
    const [studentSync, enrollmentPix] = await Promise.all([
      source("../sync-student-asaas/index.ts"),
      source("../create-enrollment-pix/index.ts"),
    ]);

    for (const caller of [studentSync, enrollmentPix]) {
      assertStringIncludes(caller, "conflicts: (candidate) =>");
      assertStringIncludes(caller, 'lookup.kind === "CONFLICT"');
    }

    assertStringIncludes(studentSync, "providerCustomerMatches(");
    assertStringIncludes(
      studentSync,
      "provider_customer_claim_identity_conflict",
    );
    assertStringIncludes(
      studentSync,
      "query: { externalReference }",
    );
    assert(
      studentSync.indexOf("const submittedCustomerMatches") <
        studentSync.indexOf("const outcome = asaasCreationHttpOutcome"),
    );
    assertStringIncludes(
      studentSync,
      'updateQuery.is("asaas_customer_id", null)',
    );
    assertStringIncludes(
      studentSync,
      "provider_customer_local_binding_conflict",
    );

    assertStringIncludes(
      enrollmentPix,
      "query: {\n            externalReference: paymentReference,\n          }",
    );
    assert(
      enrollmentPix.indexOf("const submittedPaymentMatches") <
        enrollmentPix.indexOf("const outcome = asaasCreationHttpOutcome"),
    );
    assertStringIncludes(enrollmentPix, "provider_payment_identity_conflict");
    assert(
      enrollmentPix.indexOf("student_binding_revalidation_unavailable") <
        enrollmentPix.indexOf("await markStudentAsaasCreationSubmitting"),
    );
    assertStringIncludes(
      enrollmentPix,
      '.is("enrollment_payment_id", null)',
    );
    assertEquals(
      enrollmentPix.match(/enrollment_fee_paid: false/g)?.length ?? 0,
      0,
      "payment creation must never clear the paid enrollment flag",
    );
  },
});
