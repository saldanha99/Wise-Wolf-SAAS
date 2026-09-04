/// <reference lib="deno.ns" />

import {
  authorizeStudentSubscriptionLifecycleEvent,
  classifyStudentSubscriptionProfileBinding,
  isStudentSubscriptionLifecycleEvent,
  studentEnrollmentOfferMatchesBinding,
  type StudentSubscriptionProfileBinding,
} from "./student-subscription-routing.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const studentId = "10000000-0000-4000-8000-000000000001";
const tenantId = "school-one";
const subscription = {
  id: "sub_student",
  customer: "cus_student",
  externalReference: studentId,
  status: "ACTIVE",
  value: 169,
  billingType: "CREDIT_CARD",
  maxPayments: 12,
  deleted: false,
};
const profile = {
  id: studentId,
  tenant_id: tenantId,
  role: "STUDENT",
  asaas_customer_id: "cus_student",
  subscription_id: "sub_student",
};

Deno.test("only known student subscription lifecycle events can seek authorization", () => {
  for (
    const event of [
      "SUBSCRIPTION_CREATED",
      "SUBSCRIPTION_UPDATED",
      "SUBSCRIPTION_INACTIVATED",
      "SUBSCRIPTION_DELETED",
    ]
  ) {
    assert(
      isStudentSubscriptionLifecycleEvent(event),
      `${event} was not recognized`,
    );
  }
  for (
    const event of [
      "SUBSCRIPTION_SPLIT_DISABLED",
      "SUBSCRIPTION_SPLIT_DIVERGENCE_BLOCK",
      "PAYMENT_UPDATED",
      "subscription_updated",
      "",
    ]
  ) {
    assert(
      !isStudentSubscriptionLifecycleEvent(event),
      `${event || "empty event"} was incorrectly accepted`,
    );
  }
});

function fixtureBinding(): StudentSubscriptionProfileBinding {
  const binding = classifyStudentSubscriptionProfileBinding(subscription, [
    profile,
  ]);
  if (!binding.ok) throw new Error("test fixture binding is invalid");
  return binding;
}

const exactBinding = fixtureBinding();
const eventAt = "2026-09-01T01:30:00.000Z";
const operationWindow = {
  startedAt: "2026-09-01T01:29:30.000Z",
  endedAt: "2026-09-01T01:30:30.000Z",
};

function authorize(
  eventName: string,
  operations: Parameters<
    typeof authorizeStudentSubscriptionLifecycleEvent
  >[0]["operations"],
  snapshot = subscription,
  timestamp = eventAt,
) {
  return authorizeStudentSubscriptionLifecycleEvent({
    eventName,
    eventAt: timestamp,
    binding: exactBinding,
    subscription: snapshot,
    operations,
  });
}

Deno.test("student subscription binding requires one exact profile and tenant", () => {
  const exact = classifyStudentSubscriptionProfileBinding(subscription, [
    profile,
  ]);
  assert(exact.ok, "the exact student binding was rejected");
  assert(
    exact.studentId === studentId && exact.tenantId === tenantId,
    "the exact student or tenant was not preserved",
  );

  const ambiguous = classifyStudentSubscriptionProfileBinding(subscription, [
    profile,
    { ...profile, id: "20000000-0000-4000-8000-000000000002" },
  ]);
  assert(
    !ambiguous.ok &&
      ambiguous.reason === "student_subscription_binding_ambiguous",
    "duplicate local bindings must remain ambiguous",
  );
  const malformedDuplicate = classifyStudentSubscriptionProfileBinding(
    subscription,
    [profile, { ...profile, tenant_id: null }],
  );
  assert(
    !malformedDuplicate.ok &&
      malformedDuplicate.reason === "student_subscription_binding_ambiguous",
    "a malformed duplicate must not hide an ambiguous local binding",
  );

  for (
    const candidate of [
      { ...profile, subscription_id: "sub_other" },
      { ...profile, asaas_customer_id: "cus_other" },
      { ...profile, role: "TEACHER" },
      { ...profile, tenant_id: null },
    ]
  ) {
    const rejected = classifyStudentSubscriptionProfileBinding(subscription, [
      candidate,
    ]);
    assert(
      !rejected.ok &&
        rejected.reason === "student_subscription_binding_unresolved",
      "an inexact local profile binding was accepted",
    );
  }
});

Deno.test("student subscription reference must be canonical and offer-bound", () => {
  const offerId = "30000000-0000-4000-8000-000000000003";
  const enrollment = classifyStudentSubscriptionProfileBinding(
    {
      ...subscription,
      externalReference: `enrollment:${offerId}:subscription`,
    },
    [profile],
  );
  assert(
    enrollment.ok && enrollment.reference.kind === "ENROLLMENT",
    "canonical enrollment reference was rejected",
  );
  assert(
    studentEnrollmentOfferMatchesBinding(enrollment, {
      id: offerId,
      tenant_id: tenantId,
      kind: "ENROLLMENT",
      processing_by: studentId,
      consumed_by: null,
    }),
    "the exact enrollment offer binding was rejected",
  );
  for (
    const offer of [
      null,
      {
        id: offerId,
        tenant_id: "school-other",
        kind: "ENROLLMENT",
        processing_by: studentId,
        consumed_by: null,
      },
      {
        id: offerId,
        tenant_id: tenantId,
        kind: "ENROLLMENT",
        processing_by: null,
        consumed_by: null,
      },
    ]
  ) {
    assert(
      !studentEnrollmentOfferMatchesBinding(enrollment, offer),
      "an unbound enrollment offer was accepted",
    );
  }

  const forgedReference = classifyStudentSubscriptionProfileBinding(
    { ...subscription, externalReference: "student-someone-else" },
    [profile],
  );
  assert(
    !forgedReference.ok &&
      forgedReference.reason === "student_subscription_reference_mismatch",
    "a non-canonical subscription reference was accepted",
  );
});

Deno.test("creation and update events require one exact operation", () => {
  const creation = {
    id: "operation-create",
    kind: "CREATION" as const,
    tenantId,
    studentId,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status: "SUCCEEDED",
    externalReference: subscription.externalReference,
    ...operationWindow,
  };
  assert(
    authorize("SUBSCRIPTION_CREATED", [creation]).ok,
    "the exact durable creation operation was rejected",
  );
  assert(
    !authorize("SUBSCRIPTION_CREATED", []).ok,
    "an uncorrelated creation event was accepted",
  );
  assert(
    !authorize("SUBSCRIPTION_CREATED", [
      { ...creation, externalReference: "student-other" },
    ]).ok,
    "a creation operation with another reference was accepted",
  );
  const oldCreation = authorize(
    "SUBSCRIPTION_CREATED",
    [
      {
        ...creation,
        startedAt: "2026-08-31T23:00:00.000Z",
        endedAt: "2026-08-31T23:01:00.000Z",
      },
    ],
  );
  assert(!oldCreation.ok, "an expired creation operation was accepted");
  const staleUnknown = authorize("SUBSCRIPTION_CREATED", [
    {
      ...creation,
      status: "UNKNOWN",
      startedAt: "2026-08-31T23:00:00.000Z",
      endedAt: "2026-09-01T01:30:30.000Z",
    },
  ]);
  assert(
    !staleUnknown.ok,
    "a recently reconciled but old UNKNOWN operation widened authorization",
  );

  const valueUpdate = {
    id: "operation-value",
    kind: "SUBSCRIPTION_MUTATION" as const,
    tenantId,
    studentId,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status: "SUCCEEDED",
    mutationKind: "PLAN_VALUE",
    desiredState: { valueCents: 16900 },
    ...operationWindow,
  };
  assert(
    authorize("SUBSCRIPTION_UPDATED", [valueUpdate]).ok,
    "the exact value update was rejected",
  );
  assert(
    !authorize(
      "SUBSCRIPTION_UPDATED",
      [valueUpdate],
      { ...subscription, value: 168 },
    ).ok,
    "a provider value that diverges from the durable intent was accepted",
  );
  assert(
    !authorize("SUBSCRIPTION_UPDATED", [
      {
        ...valueUpdate,
        startedAt: "2026-09-01T01:10:00.000Z",
        endedAt: "2026-09-01T01:30:30.000Z",
      },
    ]).ok,
    "an update event reused a mutation started outside its short window",
  );

  const billingMethod = {
    id: "operation-method",
    kind: "BILLING_METHOD" as const,
    tenantId,
    studentId,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status: "COMPLETED",
    targetBillingType: "CREDIT_CARD",
    ...operationWindow,
  };
  assert(
    authorize("SUBSCRIPTION_UPDATED", [billingMethod]).ok,
    "the exact billing-method update was rejected",
  );
  const ambiguous = authorize("SUBSCRIPTION_UPDATED", [
    valueUpdate,
    billingMethod,
  ]);
  assert(
    !ambiguous.ok &&
      ambiguous.reason === "student_subscription_operation_ambiguous",
    "two matching operations must remain triage",
  );
});

Deno.test("destructive lifecycle events require their exact lifecycle ledger", () => {
  assert(
    !authorize("SUBSCRIPTION_INACTIVATED", [], {
      ...subscription,
      status: "INACTIVE",
    }).ok,
    "an unexpected inactivation was silently accepted",
  );
  assert(
    !authorize("SUBSCRIPTION_DELETED", [], {
      ...subscription,
      status: "INACTIVE",
      deleted: true,
    }).ok,
    "an unexpected deletion was silently accepted",
  );

  const offboarding = {
    id: "operation-offboarding",
    kind: "OFFBOARDING" as const,
    tenantId,
    studentId,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status: "PROVIDER_MUTATING",
    targetLifecycleStatus: "suspended",
    providerSubscriptionFinalStatus: "INACTIVE",
    ...operationWindow,
  };
  assert(
    authorize(
      "SUBSCRIPTION_INACTIVATED",
      [offboarding],
      { ...subscription, status: "INACTIVE" },
    ).ok,
    "the exact authorized inactivation was rejected",
  );
  assert(
    !authorize(
      "SUBSCRIPTION_INACTIVATED",
      [{ ...offboarding, providerSubscriptionFinalStatus: "ACTIVE" }],
      { ...subscription, status: "INACTIVE" },
    ).ok,
    "an operation that did not request inactivation was accepted",
  );

  const deletion = {
    id: "operation-deletion",
    kind: "ACCOUNT_DELETION" as const,
    tenantId,
    studentId,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    status: "PROVIDER_COMPLETE",
    ...operationWindow,
  };
  assert(
    authorize(
      "SUBSCRIPTION_DELETED",
      [deletion],
      { ...subscription, status: "INACTIVE", deleted: true },
    ).ok,
    "the exact authorized account deletion was rejected",
  );
  assert(
    !authorize(
      "SUBSCRIPTION_DELETED",
      [{ ...deletion, status: "BLOCKED" }],
      { ...subscription, status: "INACTIVE", deleted: true },
    ).ok,
    "a blocked lifecycle operation silently authorized deletion",
  );
});

Deno.test({
  name: "student lifecycle route preserves SaaS precedence and fails closed",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const dispatchStart = source.indexOf(
      "async function dispatchPersistedAsaasEvent(",
    );
    const dispatchEnd = source.indexOf(
      "\nasync function drainAsaasWebhookInbox(",
      dispatchStart,
    );
    const dispatch = source.slice(dispatchStart, dispatchEnd);
    const saas = dispatch.indexOf("await processSaasCheckoutEvent(");
    const student = dispatch.indexOf(
      "await processStudentSubscriptionLifecycleEvent(",
    );
    const unsupported = dispatch.indexOf(
      'throw new AsaasTriageError("unsupported_unrouted_asaas_event")',
    );
    assert(
      saas >= 0 && student > saas && unsupported > student,
      "student no-op can shadow SaaS or bypass unrouted triage",
    );

    const processorStart = source.indexOf(
      "async function processStudentSubscriptionLifecycleEvent(",
    );
    const processorEnd = source.indexOf(
      "\nasync function dispatchPersistedAsaasEvent(",
      processorStart,
    );
    const processor = source.slice(processorStart, processorEnd);
    const loaderStart = source.indexOf(
      "async function loadStudentSubscriptionLifecycleOperations(",
    );
    const loader = source.slice(loaderStart, processorStart);
    assert(
      processor.includes('.eq("subscription_id", subscriptionId)') &&
        processor.includes('.eq("asaas_customer_id", customerId)') &&
        processor.includes('.eq("role", "STUDENT")') &&
        processor.includes(".limit(2)"),
      "student subscription lookup is not exact and ambiguity-safe",
    );
    assert(
      processor.includes('.eq("tenant_id", binding.tenantId)') &&
        processor.includes('.eq("kind", "ENROLLMENT")') &&
        processor.includes("studentEnrollmentOfferMatchesBinding("),
      "enrollment subscription reference is not verified against its tenant offer",
    );
    assert(
      processor.includes("throw new AsaasTriageError(") &&
        processor.includes("student_subscription_enrollment_mismatch") &&
        processor.includes("authorizeStudentSubscriptionLifecycleEvent("),
      "unbound, forged or unauthorized student subscriptions do not remain triage",
    );
    for (
      const ledger of [
        "asaas_provider_creation_attempts",
        "asaas_subscription_mutation_operations",
        "student_billing_method_operations",
        "student_offboarding_operations",
        "student_account_deletion_claims",
      ]
    ) {
      assert(
        loader.includes(`.from("${ledger}")`),
        `${ledger} is missing from lifecycle authorization`,
      );
    }
    assert(
      loader.includes('.lte("provider_started_at", window.latestStartAt)') &&
        loader.includes(
          '.gte("provider_started_at", window.earliestStartAt)',
        ) &&
        !loader.includes('.from("audit_logs")'),
      "lifecycle authorization is not time-bounded or trusts generic audit rows",
    );
  },
});
