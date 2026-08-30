/// <reference lib="deno.ns" />

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
  occupiesProviderCustomerIdentity,
  occupiesProviderReference,
  providerPaymentCanStartPendingLedger,
  providerPaymentLedgerStatusMatches,
  resolveProviderCustomerCandidate,
  resolveProviderPaymentCandidate,
  resolveProviderSubscriptionCandidate,
  selectFrozenCreationCandidate,
} from "./provider-identity.ts";
import { asaasCreationFingerprint } from "../_shared/asaas-creation-guard.ts";

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

const paymentExpected: ExpectedProviderPayment = {
  externalReference: "enrollment:offer-1:one-time",
  customerId: "cus_expected",
  billingType: "PIX",
  value: 250,
  dueDate: "2026-08-25",
  subscriptionId: null,
  splitPolicy: { kind: "NONE" },
};

const customerExpected: ExpectedProviderCustomer = {
  providerId: "cus_expected",
  externalReference: "student-1",
  cpfCnpj: "28718884857",
};

const customer = {
  id: customerExpected.providerId,
  externalReference: customerExpected.externalReference,
  cpfCnpj: "287.188.848-57",
};

const payment = {
  id: "pay_expected",
  externalReference: paymentExpected.externalReference,
  customer: paymentExpected.customerId,
  billingType: paymentExpected.billingType,
  value: paymentExpected.value,
  dueDate: paymentExpected.dueDate,
  status: "PENDING",
};

const subscriptionExpected: ExpectedProviderSubscription = {
  externalReference: "enrollment:offer-1:subscription",
  customerId: "cus_expected",
  billingType: "BOLETO",
  value: 397,
  nextDueDate: "2026-09-10",
  cycle: "MONTHLY",
  status: "ACTIVE",
  maxPayments: 12,
  splitPolicy: { kind: "NONE" },
};

const subscription = {
  id: "sub_expected",
  externalReference: subscriptionExpected.externalReference,
  customer: subscriptionExpected.customerId,
  billingType: subscriptionExpected.billingType,
  value: subscriptionExpected.value,
  nextDueDate: subscriptionExpected.nextDueDate,
  cycle: subscriptionExpected.cycle,
  status: subscriptionExpected.status,
  maxPayments: subscriptionExpected.maxPayments,
};

Deno.test("a local customer link requires one exact provider identity", () => {
  assertEquals(
    resolveProviderCustomerCandidate(customer, customerExpected),
    { status: "MATCH", id: "cus_expected" },
    "the direct provider customer must match id, reference and CPF",
  );
  for (
    const divergent of [
      { ...customer, id: "cus_other" },
      { ...customer, externalReference: "student-2" },
      { ...customer, cpfCnpj: "11144477735" },
      { ...customer, deleted: true },
    ]
  ) {
    assertEquals(
      resolveProviderCustomerCandidate(divergent, customerExpected),
      { status: "CONFLICT" },
      `divergent customer must be rejected: ${JSON.stringify(divergent)}`,
    );
  }
  assert(
    occupiesProviderCustomerIdentity(
      { ...customer, id: "cus_other", cpfCnpj: "11144477735" },
      customerExpected,
    ),
    "another customer with the same reference must block creation",
  );
  assert(
    occupiesProviderCustomerIdentity(
      { ...customer, id: "cus_other", externalReference: "student-2" },
      customerExpected,
    ),
    "another customer with the same CPF must block creation",
  );
});

Deno.test("pro-rata failures expose a safe durable recovery state", () => {
  assertEquals(
    classifyProRataFailure(
      new Error("provider_pro_rata_creation_rejected"),
    ),
    {
      error: "provider_pro_rata_creation_rejected",
      state: "FAILED",
      httpStatus: 502,
    },
    "a deterministic provider rejection must be explicit",
  );
  assertEquals(
    classifyProRataFailure(new Error("pro_rata_creation_outcome_unknown")),
    {
      error: "pro_rata_creation_outcome_unknown",
      state: "UNKNOWN",
      httpStatus: 503,
    },
    "an ambiguous POST must require GET-only reconciliation",
  );
  assertEquals(
    classifyProRataFailure(new Error("provider_pro_rata_in_progress")),
    {
      error: "provider_pro_rata_in_progress",
      state: "IN_PROGRESS",
      httpStatus: 409,
    },
    "a live claim must not be presented as complete",
  );
  assertEquals(
    classifyProRataFailure(
      new Error("provider_pro_rata_claim_not_found_or_invalid"),
    ),
    {
      error: "provider_pro_rata_claim_not_found_or_invalid",
      state: "BLOCKED",
      httpStatus: 409,
    },
    "a missing entity behind a succeeded claim must be blocked, not retried",
  );
  assertEquals(
    classifyProRataFailure(new Error("unexpected secret provider detail")),
    {
      error: "pro_rata_processing_failed",
      state: "BLOCKED",
      httpStatus: 500,
    },
    "unexpected error text must not be reflected to callers",
  );
});

Deno.test("one-time and pro-rata recovery require the exact payment snapshot", () => {
  assertEquals(
    resolveProviderPaymentCandidate(payment, paymentExpected),
    { status: "MATCH", id: "pay_expected", providerStatus: "PENDING" },
    "the exact provider payment should match",
  );
  for (
    const divergent of [
      { ...payment, id: "bad id" },
      { ...payment, externalReference: "enrollment:other:one-time" },
      { ...payment, customer: "cus_other" },
      { ...payment, billingType: "BOLETO" },
      { ...payment, value: 250.01 },
      { ...payment, dueDate: "2026-08-26" },
      { ...payment, subscription: "sub_other" },
      {
        ...payment,
        split: [{ walletId: "wallet_unexpected", percentualValue: 90 }],
      },
      { ...payment, status: "UNKNOWN_PROVIDER_STATE" },
      { ...payment, deleted: true },
    ]
  ) {
    assertEquals(
      resolveProviderPaymentCandidate(divergent, paymentExpected),
      { status: "CONFLICT" },
      `divergent payment must be rejected: ${JSON.stringify(divergent)}`,
    );
  }
});

Deno.test("payment lifecycle changes do not erase an otherwise exact identity", () => {
  for (
    const status of [
      "CONFIRMED",
      "RECEIVED",
      "OVERDUE",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
      "REPROVED_BY_RISK_ANALYSIS",
      "RECEIVED_IN_CASH_UNDONE",
    ]
  ) {
    const resolution = resolveProviderPaymentCandidate(
      { ...payment, status },
      paymentExpected,
    );
    assert(
      resolution.status === "MATCH" && resolution.providerStatus === status,
      `${status} should retain the exact immutable payment identity`,
    );
  }
});

Deno.test("decisive provider states cannot be invented as a pending local ledger", () => {
  for (const status of ["PENDING", "OVERDUE", "CONFIRMED", "AUTHORIZED"]) {
    assert(
      providerPaymentCanStartPendingLedger(status),
      `${status} may start a pending local snapshot`,
    );
  }
  for (
    const status of [
      "RECEIVED",
      "RECEIVED_IN_CASH",
      "REFUNDED",
      "PARTIALLY_REFUNDED",
      "CANCELED",
      "DELETED",
    ]
  ) {
    assert(
      !providerPaymentCanStartPendingLedger(status),
      `${status} must wait for the signed webhook/reconciliation`,
    );
  }
  assert(
    providerPaymentLedgerStatusMatches("RECEIVED", "RECEIVED"),
    "an already persisted webhook settlement may release the lifecycle",
  );
  assert(
    !providerPaymentLedgerStatusMatches("RECEIVED", "PENDING"),
    "a stale pending row cannot authorize a recovered settlement",
  );
  assert(
    !providerPaymentLedgerStatusMatches("REFUNDED", "PENDING"),
    "a refund can never be represented as pending",
  );
});

Deno.test("subscription recovery validates identity, schedule and duration", () => {
  assertEquals(
    resolveProviderSubscriptionCandidate(subscription, subscriptionExpected),
    { status: "MATCH", id: "sub_expected", providerStatus: "ACTIVE" },
    "the exact active provider subscription should match",
  );
  assertEquals(
    resolveProviderSubscriptionCandidate(
      { ...subscription, nextDueDate: "2026-10-10" },
      subscriptionExpected,
    ),
    { status: "MATCH", id: "sub_expected", providerStatus: "ACTIVE" },
    "Asaas advances nextDueDate after generating the requested first charge",
  );
  for (
    const divergent of [
      { ...subscription, id: "bad id" },
      { ...subscription, externalReference: "enrollment:other:subscription" },
      { ...subscription, customer: "cus_other" },
      { ...subscription, billingType: "PIX" },
      { ...subscription, value: 396.99 },
      { ...subscription, nextDueDate: "2026-09-11" },
      { ...subscription, cycle: "YEARLY" },
      { ...subscription, status: "INACTIVE" },
      { ...subscription, maxPayments: 6 },
      {
        ...subscription,
        split: [{ walletId: "wallet_unexpected", percentualValue: 90 }],
      },
      { ...subscription, deleted: true },
    ]
  ) {
    assertEquals(
      resolveProviderSubscriptionCandidate(divergent, subscriptionExpected),
      { status: "CONFLICT" },
      `divergent subscription must be rejected: ${JSON.stringify(divergent)}`,
    );
  }
});

Deno.test("subscription date advance is exactly one clamped monthly cycle", () => {
  const monthEndExpected = {
    ...subscriptionExpected,
    nextDueDate: "2027-01-31",
  };
  assert(
    resolveProviderSubscriptionCandidate(
      { ...subscription, nextDueDate: "2027-02-28" },
      monthEndExpected,
    ).status === "MATCH",
    "month-end advancement must use the next real calendar date",
  );
  for (const nextDueDate of ["2027-02-27", "2027-03-31", "2027-02-31"]) {
    assert(
      resolveProviderSubscriptionCandidate(
        { ...subscription, nextDueDate },
        monthEndExpected,
      ).status === "CONFLICT",
      `unsafe subscription due-date drift was accepted: ${nextDueDate}`,
    );
  }
});

Deno.test("payment and subscription recovery require the exact frozen split", () => {
  const splitPolicy = {
    kind: "PERCENTAGE" as const,
    walletId: "wallet_expected",
    percentualValue: 87.5,
  };
  const exactSplit = [{ walletId: "wallet_expected", percentualValue: 87.5 }];
  assertEquals(
    resolveProviderPaymentCandidate(
      { ...payment, split: exactSplit },
      { ...paymentExpected, splitPolicy },
    ).status,
    "MATCH",
    "an exact payment split should match",
  );
  assertEquals(
    resolveProviderSubscriptionCandidate(
      { ...subscription, split: exactSplit },
      { ...subscriptionExpected, splitPolicy },
    ).status,
    "MATCH",
    "an exact subscription split should match",
  );
  for (
    const divergentSplit of [
      undefined,
      [{ walletId: "wallet_other", percentualValue: 87.5 }],
      [{ walletId: "wallet_expected", percentualValue: 87.49 }],
      [
        { walletId: "wallet_expected", percentualValue: 87.5 },
        { walletId: "wallet_other", percentualValue: 12.5 },
      ],
    ]
  ) {
    assertEquals(
      resolveProviderPaymentCandidate(
        { ...payment, split: divergentSplit },
        { ...paymentExpected, splitPolicy },
      ).status,
      "CONFLICT",
      "a divergent payment split must be rejected",
    );
    assertEquals(
      resolveProviderSubscriptionCandidate(
        { ...subscription, split: divergentSplit },
        { ...subscriptionExpected, splitPolicy },
      ).status,
      "CONFLICT",
      "a divergent subscription split must be rejected",
    );
  }
});

Deno.test("open-ended subscription accepts only a nullish provider limit", () => {
  const expected = { ...subscriptionExpected, maxPayments: null };
  const withoutLimit = { ...subscription };
  delete (withoutLimit as Record<string, unknown>).maxPayments;
  assert(
    resolveProviderSubscriptionCandidate(withoutLimit, expected).status ===
      "MATCH",
    "an omitted provider limit should represent an open-ended subscription",
  );
  assert(
    resolveProviderSubscriptionCandidate(
      { ...withoutLimit, maxPayments: 12 },
      expected,
    ).status === "CONFLICT",
    "a finite provider limit must not be adopted as open-ended",
  );
});

Deno.test("provider reference conflicts include deleted or divergent objects", () => {
  assert(
    occupiesProviderReference(
      { externalReference: paymentExpected.externalReference, deleted: true },
      paymentExpected.externalReference,
    ),
    "an occupied externalReference must never be downgraded to not found",
  );
});

Deno.test("billing dates remain stable from the durable claim anchor", () => {
  const anchor = new Date("2026-08-25T02:30:00.000Z");
  assertEquals(
    billingDateFromAnchor(anchor),
    "2026-08-24",
    "the provider due date must use the Sao Paulo business date",
  );
  assertEquals(
    nextDueDateFromAnchor(10, undefined, anchor),
    "2026-09-10",
    "retries must derive the same schedule from the stored creation anchor",
  );
  assertEquals(
    nextDueDateFromAnchor(31, "2026-09", anchor),
    "2026-09-30",
    "month-end schedules must clamp deterministically",
  );
  assertEquals(
    nextDueDateFromAnchor(10, "2026-13", anchor),
    null,
    "an invalid requested start month must fail closed",
  );
});

Deno.test("offer billing date is exact, real and cannot be in the past", () => {
  assertEquals(
    canonicalFutureBillingDate("2026-09-07", "2026-08-29"),
    "2026-09-07",
    "the reserved first billing date must be preserved exactly",
  );
  for (const invalid of ["2026-08-28", "2026-02-31", "2026-9-07", ""]) {
    assertEquals(
      canonicalFutureBillingDate(invalid, "2026-08-29"),
      null,
      `invalid or past billing date was accepted: ${invalid}`,
    );
  }
});

Deno.test("a midnight-crossing claim recovers the fingerprinted business date", async () => {
  const beforeClaim = new Date("2026-08-25T02:59:59.900Z");
  const storedCreatedAt = new Date("2026-08-25T03:00:00.100Z");
  const frozenSnapshot = {
    payload: { dueDate: billingDateFromAnchor(beforeClaim), value: 250 },
  };
  const storedFingerprint = await asaasCreationFingerprint(frozenSnapshot);
  const candidates = creationAnchorCandidates(
    storedCreatedAt,
    new Date("2099-01-01T00:00:00.000Z"),
  ).map((anchor) => ({
    payload: { dueDate: billingDateFromAnchor(anchor), value: 250 },
  }));
  const recovered = await selectFrozenCreationCandidate({
    candidates,
    storedFingerprint,
    fingerprintFor: (candidate) => asaasCreationFingerprint(candidate),
  });
  assert(
    recovered.matchedStoredFingerprint &&
      recovered.candidate.payload.dueDate === "2026-08-24",
    "retry must recover the pre-midnight date stored in the first fingerprint",
  );
});

Deno.test("creation fingerprints reject raw card material", () => {
  assert(
    !containsSensitiveCardMaterial({
      billingType: "CREDIT_CARD",
      customer: "cus_expected",
      value: 397,
    }),
    "the billing method name alone is not secret card material",
  );
  assert(
    containsSensitiveCardMaterial({
      payload: { creditCard: { number: "4111111111111111" } },
    }),
    "card details must never enter a durable snapshot",
  );
});

Deno.test({
  name:
    "all three billing creations reconcile exact identities before one POST",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const mainClaim = source.indexOf("const creationClaim:");
    const mainLookup = source.indexOf(
      "const lookup = await findExactCreation()",
      mainClaim,
    );
    const mainFence = source.indexOf(
      "await markStudentAsaasCreationSubmitting(",
      mainLookup,
    );
    const oneTimePost = source.indexOf(
      "`${submitIntegration.baseUrl}/payments`",
      mainFence,
    );
    const subscriptionPost = source.indexOf(
      "`${submitIntegration.baseUrl}/subscriptions`",
      mainFence,
    );
    const proRataClaim = source.indexOf(
      "const proRataClaim =",
      subscriptionPost,
    );
    const proRataLookup = source.indexOf(
      "const lookup = await findExactProRata()",
      proRataClaim,
    );
    const proRataFence = source.indexOf(
      "await markStudentAsaasCreationSubmitting(",
      proRataLookup,
    );
    const proRataPost = source.indexOf(
      "`${submitProRataIntegration.baseUrl}/payments`",
      proRataFence,
    );

    assert(
      mainClaim >= 0 && mainLookup > mainClaim && mainFence > mainLookup &&
        oneTimePost > mainFence && subscriptionPost > mainFence,
      "primary payment/subscription must claim, reconcile and fence before POST",
    );
    assert(
      proRataClaim > subscriptionPost && proRataLookup > proRataClaim &&
        proRataFence > proRataLookup && proRataPost > proRataFence,
      "pro-rata must claim, reconcile and fence before its only POST",
    );
    assert(
      (source.match(/method: "POST"/g) ?? []).length === 3,
      "only the mutually exclusive primary POSTs and one pro-rata POST may exist",
    );
    assert(
      (source.match(/conflicts: \(candidate\) =>/g) ?? []).length >= 3 &&
        source.includes('lookup.kind === "CONFLICT"'),
      "provider customer and financial conflicts must block every POST",
    );
    assert(
      (source.match(/includeDeleted: "true"/g) ?? []).length === 4 &&
        !/query:\s*\{[^}]*customer:/s.test(source),
      "provider lookup must search the reference alone so another customer cannot hide a conflict",
    );
    const customerDirectGet = source.indexOf(
      '"customers",\n      asaasCustomerId',
    );
    assert(
      customerDirectGet >= 0 && customerDirectGet < mainClaim &&
        source.includes("resolveProviderCustomerCandidate(") &&
        source.includes("occupiesProviderCustomerIdentity(") &&
        source.includes("provider_customer_authoritative_cpf_conflict") &&
        source.includes("const expectedCustomerReference = offer") &&
        source.includes(
          "tenant:${authorization.tenantId}:enrollment:${offer.id}:payer",
        ) &&
        source.includes("externalReference: expectedCustomerReference") &&
        source.includes("{ cpfCnpj: expectedCustomerCpf"),
      "a pre-existing local customer must pass direct GET and both fully paginated uniqueness checks before a claim or POST",
    );
    assert(
      source.includes("readProviderEntity(") &&
        source.includes('creationClaim.action === "ALREADY_SUCCEEDED"') &&
        source.includes("resolveCreationCandidate(claimedEntity.data)") &&
        source.includes("resolveProviderPaymentCandidate(") &&
        source.includes("resolveProviderSubscriptionCandidate("),
      "claim recovery and POST responses must validate exact provider payloads",
    );
    assert(
      source.indexOf("safeCreationSnapshot") < mainClaim &&
        source.indexOf(
            "Object.assign(paymentPayload, cardPayload.data)",
            mainClaim,
          ) > mainClaim &&
        source.indexOf("proRataSafeSnapshot") < proRataClaim &&
        source.indexOf(
            "Object.assign(proRataSubmitPayload, cardPayload.data)",
            proRataClaim,
          ) > proRataClaim,
      "card data must be appended only after card-free durable fingerprints",
    );
    assert(
      source.includes("loadCreationSeed(") &&
        source.includes("creationAnchorCandidates(") &&
        source.includes("selectFrozenCreationCandidate({") &&
        source.includes("requestFingerprint: frozenCreation.fingerprint") &&
        source.includes("requestFingerprint: frozenProRata.fingerprint") &&
        source.includes("nextDueDateFromAnchor(") &&
        !source.includes("new Date().toISOString().slice(0, 10)"),
      "all provider due dates must be recovered from the durable fingerprint even across midnight",
    );
    assert(
      source.includes("`student:${userId}:one-time`") &&
        source.includes("`student:${userId}:pro-rata`") &&
        source.includes(
          'text(data?.status) !== "SUCCEEDED"',
        ) &&
        source.includes(
          "billing_creation_legacy_reference_requires_review",
        ) &&
        !source.includes(
          "const oneTimeReference = offer ? `enrollment:${offer.id}:one-time` : userId",
        ),
      "non-offer one-time and pro-rata references must be distinct and ambiguous legacy attempts must stay blocked",
    );
    assert(
      source.includes("claimStudentBillingPeriod(") &&
        source.includes("markStudentBillingPeriodSubmitting(") &&
        source.includes("recordStudentBillingPeriodState(") &&
        source.includes('.eq("tenant_id", authorization.tenantId)') &&
        source.includes('.eq("asaas_customer_id", asaasCustomerId)') &&
        source.includes('.is("subscription_id", null)') &&
        source.includes(
          '.select("tenant_id,asaas_customer_id,subscription_id")',
        ),
      "cross-flow period fencing and local compare-and-set must remain active",
    );
    assert(
      source.includes("const subscriptionWasRecovered") &&
        source.includes("if (!subscriptionWasRecovered)") &&
        source.includes("recovered: subscriptionWasRecovered") &&
        proRataClaim > source.indexOf("const subscriptionWasRecovered"),
      "a recovered subscription must continue into pro-rata GET reconciliation without another primary POST",
    );
    const surfacedProRataFailure = source.indexOf("if (proRataFailure)");
    assert(
      surfacedProRataFailure > proRataPost &&
        source.includes("subscription_created: true") &&
        source.includes("pro_rata_status: proRataFailure.state") &&
        source.includes('pro_rata_recovery: "GET_ONLY"') &&
        source.includes("classifyProRataFailure(error)") &&
        source.includes("provider_pro_rata_creation_rejected") &&
        !source.includes("pro-rata deferred"),
      "FAILED, UNKNOWN and deferred pro-rata work must fail closed with an explicit GET-only recovery state",
    );
    assert(
      !/console\.(?:log|warn|error)[^\n]*(?:creditCard|paymentPayload|proRataSubmitPayload)/
        .test(source),
      "card-bearing payloads must never be logged",
    );
    assert(
      (source.match(/bindStudentAsaasCreationLifecycle\(/g)?.length || 0) >=
          2 &&
        (source.match(/markStudentAsaasCreationSubmitting\(/g)?.length || 0) >=
          3 &&
        (source.match(/releaseStudentAsaasCreationLifecycle\(/g)?.length ||
            0) >= 5 &&
        source.includes("bindProviderPaymentToLedger(") &&
        source.includes("creationClaim.ok && !providerSubscriptionHintId") &&
        source.includes('bindingKind: "STUDENT_PAYMENT"') &&
        source.includes('bindingKind: "SUBSCRIPTION"'),
      "one-time, subscription and pro-rata creation must share the student lifecycle fence through exact local binding",
    );
  },
});
