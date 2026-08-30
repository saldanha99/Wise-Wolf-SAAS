/// <reference lib="deno.ns" />

import { asaasCreationFingerprint } from "../_shared/asaas-creation-guard.ts";
import {
  wolfieTopupCreationSnapshot,
  wolfieTopupDescription,
  wolfieTopupDueDate,
  wolfieTopupMaySubmitProviderPayment,
  wolfieTopupPaymentCoreIdentityMatches,
  wolfieTopupPaymentMatches,
  wolfieTopupProviderReference,
  wolfieTopupReferenceConflicts,
} from "./provider-safety.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const orderId = "00000000-0000-4000-8000-000000000321";
const expected = {
  reference: wolfieTopupProviderReference(orderId),
  customerId: "cus_expected",
  value: 29.9,
  dueDate: "2026-08-25",
  description: "Wolfie — 60 minutos",
  splitPolicy: { kind: "NONE" as const },
};
const exactPayment = {
  id: "pay_expected",
  customer: expected.customerId,
  billingType: "PIX",
  value: 29.9,
  dueDate: expected.dueDate,
  description: expected.description,
  externalReference: expected.reference,
};

Deno.test("topup provider schedule is derived only from the order snapshot", () => {
  assertEquals(
    wolfieTopupDueDate("2026-08-25T23:59:59.000Z"),
    "2026-08-25",
    "the due date must not move when a retry runs on another day",
  );
  assertEquals(
    wolfieTopupDueDate("invalid"),
    null,
    "invalid order timestamps must fail closed",
  );
  assertEquals(
    wolfieTopupDescription("  60 minutos  "),
    expected.description,
    "the provider description must be normalized once from the snapshot",
  );
});

Deno.test("topup recovery validates every immutable provider field", () => {
  assert(
    wolfieTopupPaymentMatches(exactPayment, expected),
    "the exact payment must be recoverable",
  );
  for (
    const divergent of [
      { ...exactPayment, id: "" },
      { ...exactPayment, externalReference: "wolfie-topup-order:other" },
      { ...exactPayment, customer: "cus_other" },
      { ...exactPayment, billingType: "BOLETO" },
      { ...exactPayment, value: 29.91 },
      { ...exactPayment, dueDate: "2026-08-26" },
      { ...exactPayment, description: "another package" },
      { ...exactPayment, subscription: "sub_unexpected" },
      {
        ...exactPayment,
        split: [{ walletId: "wallet_unexpected", percentualValue: 90 }],
      },
      { ...exactPayment, deleted: true },
    ]
  ) {
    assert(
      !wolfieTopupPaymentMatches(divergent, expected),
      `divergent payment was accepted: ${JSON.stringify(divergent)}`,
    );
  }
});

Deno.test("topup webhook core identity cannot cross customer or payment scope", () => {
  assert(
    wolfieTopupPaymentCoreIdentityMatches(
      exactPayment,
      "pay_expected",
      expected,
    ),
    "the exact provider identity must match",
  );
  for (
    const divergent of [
      { ...exactPayment, id: "pay_other" },
      { ...exactPayment, externalReference: "wolfie-topup-order:other" },
      { ...exactPayment, customer: "cus_other" },
      { ...exactPayment, billingType: "BOLETO" },
      { ...exactPayment, value: 29.91 },
      { ...exactPayment, subscription: "sub_unexpected" },
      {
        ...exactPayment,
        split: [{ walletId: "wallet_unexpected", percentualValue: 90 }],
      },
    ]
  ) {
    assert(
      !wolfieTopupPaymentCoreIdentityMatches(
        divergent,
        "pay_expected",
        expected,
      ),
      `divergent webhook identity was accepted: ${JSON.stringify(divergent)}`,
    );
  }
});

Deno.test("same-reference divergence is always a conflict", () => {
  assert(
    wolfieTopupReferenceConflicts(
      { ...exactPayment, customer: "cus_other", deleted: true },
      expected.reference,
    ),
    "even a deleted divergent object must reserve the provider reference",
  );
  assert(
    !wolfieTopupReferenceConflicts(
      { ...exactPayment, externalReference: "other" },
      expected.reference,
    ),
    "an unrelated reference is not a conflict",
  );
});

Deno.test("only a fresh durable claim for a pending order may POST", () => {
  const claimActions = [
    "SUBMIT_ONCE",
    "RECONCILE_REQUIRED",
    "ALREADY_SUCCEEDED",
    "IN_PROGRESS",
    "REVIEW_REQUIRED",
  ] as const;
  const lookupKinds = [
    "FOUND",
    "NOT_FOUND",
    "CONFLICT",
    "DUPLICATE",
    "UNAVAILABLE",
  ] as const;
  for (const claimAction of claimActions) {
    for (const lookupKind of lookupKinds) {
      for (const localOrderStatus of ["PENDING", "CREATING"]) {
        const maySubmit = wolfieTopupMaySubmitProviderPayment({
          claimAction,
          lookupKind,
          localOrderStatus,
        });
        assertEquals(
          maySubmit,
          claimAction === "SUBMIT_ONCE" && lookupKind === "NOT_FOUND" &&
            localOrderStatus === "PENDING",
          `${claimAction}/${lookupKind}/${localOrderStatus} was misclassified`,
        );
      }
    }
  }
});

Deno.test("the creation fingerprint is stable and covers the order snapshot", async () => {
  const input = {
    tenantId: "school-test",
    studentId: "00000000-0000-4000-8000-000000000123",
    orderId,
    packageId: "00000000-0000-4000-8000-000000000456",
    packageName: "60 minutos",
    minutes: 60,
    amountBrl: 29.9,
    customerId: expected.customerId,
    dueDate: expected.dueDate,
    description: expected.description,
    externalReference: expected.reference,
  };
  const first = await asaasCreationFingerprint(
    wolfieTopupCreationSnapshot(input),
  );
  const second = await asaasCreationFingerprint(
    wolfieTopupCreationSnapshot({ ...input }),
  );
  const changed = await asaasCreationFingerprint(
    wolfieTopupCreationSnapshot({ ...input, minutes: 61 }),
  );
  assertEquals(
    first,
    second,
    "the same durable snapshot must hash identically",
  );
  assert(
    first !== changed,
    "changing an immutable snapshot must change its hash",
  );
});

Deno.test({
  name: "topup creation claims, reconciles and fences before its only POST",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const claim = source.indexOf(
      "const claimTopupCreation = async () =>",
    );
    const lookup = source.indexOf(
      "const providerLookup = await findUniqueAsaasEntity",
      claim,
    );
    const decision = source.indexOf(
      "wolfieTopupMaySubmitProviderPayment",
      lookup,
    );
    const submitCapability = source.indexOf('"payment.create"', decision);
    const fence = source.indexOf(
      "await markLifecycleSubmitting()",
      submitCapability,
    );
    const post = source.indexOf('method: "POST"', fence);

    assert(
      claim >= 0 && lookup > claim && decision > lookup &&
        submitCapability > decision && fence > submitCapability &&
        post > fence,
      "provider creation must claim, exhaust recovery, authorize the capability and persist submission before POST",
    );
    assertEquals(
      (source.match(/method: "POST"/g) ?? []).length,
      1,
      "the flow must contain exactly one provider creation POST",
    );
    assert(
      !source.includes("claim_wolfie_topup_order_creation"),
      "the expiring local lease must no longer authorize provider creation",
    );
    assert(
      source.includes('operation: "PAYMENT_CREATE"') &&
        source.includes("requestFingerprint: await asaasCreationFingerprint") &&
        source.includes("query: { externalReference: reference }") &&
        source.includes("conflicts: (candidate) =>"),
      "the durable claim and paginated same-reference conflict lookup are required",
    );
    assert(
      source.includes('creationClaim.action === "ALREADY_SUCCEEDED"') &&
        source.includes("await loadExactProviderPayment(claimedPaymentId)") &&
        source.includes(
          "wolfieTopupPaymentMatches(claimedPayment, expectedPayment)",
        ),
      "a succeeded claim must be recovered through an exact validated GET",
    );
    assert(
      source.includes("markStudentAsaasCreationSubmitting(") &&
        source.includes('"hub_mark_account_provider_creation_submitting"') &&
        source.includes('"hub_adopt_wolfie_topup_provider_binding"') &&
        source.includes("releaseStudentAsaasCreationLifecycle(") &&
        source.includes('bindingKind: "TOPUP_ORDER"'),
      "school and wolfie-direct lifecycle fences must cover submit, recovery, local binding and release",
    );
    assert(
      source.includes('creationClaim.action === "RECONCILE_REQUIRED"') &&
        source.includes('status: "UNKNOWN"') &&
        source.includes("wolfieTopupDueDate(activeOrder.created_at)"),
      "ambiguous attempts must remain GET-only with a stable due date",
    );
    assert(
      source.includes('allowedRoles: ["STUDENT"]') &&
        source.includes("await requireWolfieProductAccess") &&
        source.includes('.eq("tenant_id", tenantId)') &&
        source.includes('.eq("student_id", studentId)'),
      "the topup must preserve authenticated student and tenant ownership",
    );
    assert(
      !source.includes('.from("student_minute_credits")') &&
        !source.includes('rpc("apply_wolfie_topup_payment"'),
      "this creation function must never credit minutes before the webhook",
    );
    assert(
      source.includes("resolvePlatformAsaasIntegration") &&
        source.includes('"payment.read"') &&
        source.includes(
          "submitIntegration.integrationId !== readIntegration.integrationId",
        ) &&
        !source.includes('Deno.env.get("ASAAS_ACCESS_TOKEN")') &&
        !source.includes('Deno.env.get("ASAAS_API_KEY")'),
      "topup provider access must be purpose-scoped and version-fenced by the platform broker",
    );
  },
});

Deno.test({
  name:
    "a school topup retry releases the exact lifecycle after payment-link persistence",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const recoveryStart = source.indexOf(
      'if (locallyLinkedPaymentId && tenantId !== "wolfie-direct")',
    );
    const recoveryEnd = source.indexOf(
      "if (locallyLinkedPaymentId) {",
      recoveryStart + 1,
    );
    const recovery = source.slice(recoveryStart, recoveryEnd);
    const reclaim = recovery.indexOf(
      "const recoveryClaim = await claimTopupCreation()",
    );
    const exactGet = recovery.indexOf(
      "await loadExactProviderPayment(",
      reclaim,
    );
    const exactIdentity = recovery.indexOf(
      "wolfieTopupPaymentMatches(existing, expectedPayment)",
      exactGet,
    );
    const durableSuccess = recovery.indexOf(
      "await recordAsaasCreationState(auth.context.admin, recoveryClaim",
      exactIdentity,
    );
    const lifecycleRelease = recovery.indexOf(
      "await releaseStudentAsaasCreationLifecycle(",
      durableSuccess,
    );
    const response = recovery.indexOf(
      "return await respondWithPayment(existing)",
      lifecycleRelease,
    );

    assert(
      recoveryStart >= 0 && recoveryEnd > recoveryStart && reclaim >= 0 &&
        exactGet > reclaim && exactIdentity > exactGet &&
        durableSuccess > exactIdentity && lifecycleRelease > durableSuccess &&
        response > lifecycleRelease,
      "persisted school payments must reclaim, GET-prove, complete and release the exact attempt before returning",
    );
    assert(
      recovery.includes(
        'recoveryClaim.action === "ALREADY_SUCCEEDED"',
      ) &&
        recovery.includes(
          "claimedPaymentId !== locallyLinkedPaymentId",
        ) &&
        recovery.includes('recoveryClaim.action === "IN_PROGRESS"'),
      "retry must reject a divergent succeeded claim and never steal a live claim",
    );

    const freshPersist = source.lastIndexOf(
      "await persistPaymentLink(providerPaymentId)",
    );
    const freshRelease = source.lastIndexOf(
      "await releaseSchoolLifecycle(providerPaymentId)",
    );
    assert(
      freshPersist >= 0 && freshRelease > freshPersist,
      "the regression fixture must model the crash window between local persistence and lifecycle release",
    );
  },
});
