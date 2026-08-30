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
    assertEquals(
      schoolAdmin.match(/await requireAsaasMutationIdentity\(/g)?.length,
      2,
      "subscription and payment DELETE must each preflight",
    );
    assertStringIncludes(schoolAdmin, 'guard.code === "NOT_FOUND"');
    assertStringIncludes(
      schoolAdmin,
      'kind: "ASAAS_MUTATION_TARGET_ALREADY_ABSENT"',
    );
    const lifecycleBlock = schoolAdmin.slice(
      schoolAdmin.indexOf('if (isStudent && action.status !== "active")'),
      schoolAdmin.indexOf("// Revalida imediatamente antes da escrita global"),
    );
    const lastPreflight = lifecycleBlock.lastIndexOf(
      "await requireAsaasMutationIdentity",
    );
    const firstDelete = lifecycleBlock.indexOf("await callAsaas(");
    assert(
      lastPreflight >= 0 && firstDelete > lastPreflight,
      "all provider identities must be preflighted before the first DELETE",
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
      2,
      "lifecycle must validate scope before side effects and before profile update",
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
