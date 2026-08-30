import {
  enrollmentPaymentKind,
  isSettledPaymentEvent,
  providerGeneratedSubscriptionPaymentMatches,
} from "./event-contract.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("recurring enrollment waits for its exact first settled charge", () => {
  assert(
    !isSettledPaymentEvent("PAYMENT_CONFIRMED"),
    "authorization/confirmation cannot complete enrollment",
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
  },
});
