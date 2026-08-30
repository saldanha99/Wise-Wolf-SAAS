import {
  applyEnrollmentPaymentObservation,
  EnrollmentPaymentObservationError,
  enrollmentPaymentObservationFailureDisposition,
  resolveEnrollmentPaymentObservationBinding,
} from "./enrollment-progress.ts";

Deno.test("enrollment observation calls the authoritative RPC with exact evidence", async () => {
  let calledFunction = "";
  let calledArgs: Record<string, unknown> = {};
  const admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calledFunction = name;
      calledArgs = args;
      return Promise.resolve({
        data: { ok: true, action: "COMPLETED", processing_state: "COMPLETED" },
        error: null,
      });
    },
  };
  await applyEnrollmentPaymentObservation(admin, {
    tenantId: "tenant-a",
    studentId: "00000000-0000-4000-8000-000000000001",
    offerId: "00000000-0000-4000-8000-000000000002",
    providerPaymentId: "pay_activation",
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    paymentKind: "SUBSCRIPTION_ACTIVATION",
    outcome: "SETTLED",
    providerValue: 160,
    externalReference:
      "enrollment:00000000-0000-4000-8000-000000000002:subscription",
    providerStatus: "RECEIVED",
    dueDate: "2026-08-29",
    billingType: "PIX",
    description: "Mensalidade",
  });
  if (calledFunction !== "apply_enrollment_payment_observation") {
    throw new Error("authoritative observation RPC was not called");
  }
  if (
    calledArgs.p_payment_kind !== "SUBSCRIPTION_ACTIVATION" ||
    calledArgs.p_provider_subscription_id !== "sub_1" ||
    calledArgs.p_outcome !== "SETTLED"
  ) {
    throw new Error("activation evidence was not forwarded exactly");
  }
});

Deno.test("binding resolver accepts only a valid authoritative binding", async () => {
  const binding = await resolveEnrollmentPaymentObservationBinding({
    rpc: () =>
      Promise.resolve({
        data: {
          ok: true,
          action: "BOUND",
          offer_id: "00000000-0000-4000-8000-000000000002",
          payment_kind: "SUBSCRIPTION_ACTIVATION",
          external_reference:
            "enrollment:00000000-0000-4000-8000-000000000002:subscription",
        },
        error: null,
      }),
  }, {
    tenantId: "tenant-a",
    studentId: "00000000-0000-4000-8000-000000000001",
    providerPaymentId: "pay_activation",
    externalReference:
      "enrollment:00000000-0000-4000-8000-000000000002:subscription",
    outcome: "SETTLED",
  });
  if (binding?.paymentKind !== "SUBSCRIPTION_ACTIVATION") {
    throw new Error("valid activation binding was rejected");
  }
});

Deno.test("pro-rata remains an explicit authoritative payment kind", async () => {
  const binding = await resolveEnrollmentPaymentObservationBinding({
    rpc: () =>
      Promise.resolve({
        data: {
          ok: true,
          action: "BOUND",
          offer_id: "00000000-0000-4000-8000-000000000002",
          payment_kind: "PRO_RATA",
          external_reference:
            "enrollment:00000000-0000-4000-8000-000000000002:pro-rata",
        },
        error: null,
      }),
  }, {
    tenantId: "tenant-a",
    studentId: "00000000-0000-4000-8000-000000000001",
    providerPaymentId: "pay_prorata",
    externalReference:
      "enrollment:00000000-0000-4000-8000-000000000002:pro-rata",
    outcome: "SETTLED",
  });
  if (
    binding?.paymentKind !== "PRO_RATA" ||
    !binding.externalReference.endsWith(":pro-rata")
  ) {
    throw new Error("authoritative pro-rata kind was not preserved");
  }
});

Deno.test("observation failure disposition fails closed", () => {
  const deterministic = enrollmentPaymentObservationFailureDisposition(
    new EnrollmentPaymentObservationError(
      "enrollment_observation_database_rejected",
      false,
      "22023",
    ),
  );
  const transient = enrollmentPaymentObservationFailureDisposition(
    new EnrollmentPaymentObservationError(
      "enrollment_observation_temporarily_unavailable",
      true,
      "40001",
    ),
  );
  const stale = enrollmentPaymentObservationFailureDisposition(
    new EnrollmentPaymentObservationError("provider_observation_stale", false),
  );
  if (
    deterministic !== "TRIAGE" || transient !== "RETRY" || stale !== "SUPPRESS"
  ) {
    throw new Error("observation failures were classified unsafely");
  }
});
