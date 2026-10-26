import {
  enrollmentPaymentKind,
  isSettledPaymentEvent,
  providerGeneratedSubscriptionPaymentMatches,
} from "./event-contract.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("cash settlement remains distinct from enrollment confirmation", () => {
  assert(
    !isSettledPaymentEvent("PAYMENT_CONFIRMED"),
    "confirmation must not become cash settlement",
  );
  assert(
    isSettledPaymentEvent("PAYMENT_RECEIVED") &&
      isSettledPaymentEvent("PAYMENT_RECEIVED_IN_CASH"),
    "settled provider events were not recognized",
  );

  const pendingBinding = {
    subscriptionId: "sub_enrollment",
    requiresEnrollmentPayment: false,
  };
  assert(
    enrollmentPaymentKind(
      pendingBinding,
      { id: "pay_first", subscription: "sub_enrollment" },
      true,
    ) === "SUBSCRIPTION_ACTIVATION",
    "first charge was not eligible for an atomic activation binding",
  );
  assert(
    enrollmentPaymentKind(
      { ...pendingBinding, requiresEnrollmentPayment: true },
      { id: "pay_first", subscription: "sub_enrollment" },
      true,
    ) === null,
    "subscription charge bypassed the required enrollment fee",
  );
  const frozenBinding = {
    ...pendingBinding,
    subscriptionActivationPaymentId: "pay_first",
  };
  assert(
    enrollmentPaymentKind(
      frozenBinding,
      { id: "pay_later", subscription: "sub_enrollment" },
      true,
    ) === null,
    "later installment replaced the activation payment",
  );
});

Deno.test("provider-generated charge inherits only the exact offer subscription", () => {
  const studentId = "00000000-0000-4000-8000-000000000001";
  const expected = {
    studentId,
    customerId: "cus_student",
    subscriptionId: "sub_enrollment",
  };
  const payment = {
    customer: expected.customerId,
    subscription: expected.subscriptionId,
  };
  const parent = {
    id: expected.subscriptionId,
    customer: expected.customerId,
    externalReference: `enrollment:${studentId}:subscription`,
  };
  assert(
    providerGeneratedSubscriptionPaymentMatches(payment, parent, expected),
    "exact parent subscription was rejected",
  );
  assert(
    !providerGeneratedSubscriptionPaymentMatches(
      payment,
      { ...parent, customer: "cus_other" },
      expected,
    ),
    "foreign parent customer was accepted",
  );
});

Deno.test({
  name: "Edge flow never completes from subscription creation alone",
  permissions: { read: true },
  async fn() {
    const [creator, webhook] = await Promise.all([
      Deno.readTextFile(
        new URL("../create-asaas-subscription/index.ts", import.meta.url),
      ),
      Deno.readTextFile(new URL("./index.ts", import.meta.url)),
    ]);
    const enrollmentPix = await Deno.readTextFile(
      new URL("../create-enrollment-pix/index.ts", import.meta.url),
    );
    assert(
      creator.includes('"AWAITING_PAYMENT"') &&
        creator.includes("A subscription object is not proof") &&
        !creator.includes("completeEnrollment("),
      "subscription creation can still complete the offer directly",
    );
    assert(
      webhook.includes("resolveEnrollmentPaymentObservationBinding") &&
        webhook.includes("applyEnrollmentPaymentObservation") &&
        webhook.includes("financialPhone") &&
        webhook.includes("guardian_phone"),
      "webhook lost atomic offer binding or financial guardian routing",
    );
    assert(
      enrollmentPix.includes("isSelfStudent || authorization.isService") &&
        enrollmentPix.includes("enrollment:${offer.id}:fee"),
      "service operation can no longer create the exact offer-bound enrollment fee",
    );
  },
});

Deno.test("legacy installments use exact fresh identities for pending and paid states", async () => {
  const { verifiedLegacySubscriptionPayment } = await import(
    "./legacy-subscription-origin.ts"
  );
  const expected = {
    studentId: "00000000-0000-4000-8000-000000000001",
    customerId: "cus_bound",
    subscriptionId: "sub_bound",
  };
  const parent = {
    id: expected.subscriptionId,
    customer: expected.customerId,
    status: "ACTIVE",
  };
  const charge = {
    id: "pay_bound",
    customer: expected.customerId,
    subscription: expected.subscriptionId,
    status: "PENDING",
    value: 389,
    dueDate: "2026-10-30",
  };
  const verify = (
    eventName: string,
    eventPayment: unknown,
    authoritativePayment: unknown,
    authoritativeSubscription: unknown = parent,
  ) =>
    verifiedLegacySubscriptionPayment({
      eventName,
      eventPayment,
      authoritativePayment,
      authoritativeSubscription,
      expected,
    });
  assert(
    verify("PAYMENT_CREATED", charge, charge),
    "pending legacy invoice disappeared",
  );
  assert(
    !verify("PAYMENT_RECEIVED", charge, charge),
    "unpaid invoice became a receipt",
  );
  assert(
    !verify("PAYMENT_CREATED", charge, { ...charge, customer: "cus_other" }),
    "foreign customer accepted",
  );
  assert(
    !verify("PAYMENT_CREATED", charge, {
      ...charge,
      subscription: "sub_other",
    }),
    "foreign subscription accepted",
  );
  assert(
    !verify("PAYMENT_CREATED", charge, { ...charge, value: 390 }),
    "changed amount accepted",
  );
  assert(
    !verify("PAYMENT_CREATED", charge, { ...charge, status: "RECEIVED" }),
    "stale event accepted",
  );
  assert(
    !verify("PAYMENT_CREATED", charge, charge, {
      ...parent,
      externalReference: "unknown",
    }),
    "unknown reference accepted",
  );
  const confirmed = { ...charge, status: "CONFIRMED" };
  assert(
    verify("PAYMENT_CONFIRMED", confirmed, confirmed),
    "exact confirmation rejected",
  );
  const received = { ...charge, status: "RECEIVED", paymentDate: "2026-10-26" };
  assert(
    verify("PAYMENT_RECEIVED", received, received),
    "exact settlement rejected",
  );
  assert(
    !verify("PAYMENT_RECEIVED", { ...received, paymentDate: null }, {
      ...received,
      paymentDate: null,
    }),
    "undated cash accepted",
  );
});
