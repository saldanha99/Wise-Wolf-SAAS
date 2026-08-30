/// <reference lib="deno.ns" />

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test({
  name: "manual Pix and recurring subscription share a pre-submit period fence",
  permissions: { read: true },
  async fn() {
    const manual = await Deno.readTextFile(
      new URL("../generate-student-manual-pix/index.ts", import.meta.url),
    );
    const subscription = await Deno.readTextFile(
      new URL("../create-asaas-subscription/index.ts", import.meta.url),
    );

    const manualCreationStart = manual.indexOf(
      "const paymentPayload: Record<string, unknown>",
    );
    const manualPeriodClaim = manual.indexOf(
      "await claimStudentBillingPeriod(authorization.admin",
      manualCreationStart,
    );
    const manualProviderClaim = manual.indexOf(
      "const paymentClaim = await claimAsaasCreation",
      manualPeriodClaim,
    );
    const manualRevalidation = manual.indexOf(
      "const latestPayments = await providerListAll",
      manualProviderClaim,
    );
    const manualPeriodFence = manual.indexOf(
      "await markStudentBillingPeriodSubmitting",
      manualRevalidation,
    );
    const manualProviderFence = manual.indexOf(
      "await markStudentAsaasCreationSubmitting",
      manualPeriodFence,
    );
    const manualPost = manual.indexOf(
      '"/payments",\n              "POST"',
      manualProviderFence,
    );
    assert(
      manualPeriodClaim >= 0 && manualProviderClaim > manualPeriodClaim &&
        manualRevalidation > manualProviderClaim &&
        manualPeriodFence > manualRevalidation &&
        manualProviderFence > manualPeriodFence &&
        manualPost > manualProviderFence,
      "manual Pix must reserve, revalidate and fence its competence before POST",
    );
    assert(
      manual.includes('["INACTIVE", "EXPIRED"].includes(subscriptionStatus)'),
      "manual Pix must fail closed for active or unknown recurring subscriptions",
    );
    const manualRecoveryLookup = manual.slice(
      manual.indexOf(
        "const lookup = await findUniqueAsaasEntity<ProviderPayment>",
      ),
      manual.indexOf(
        "if (lookup.kind",
        manual.indexOf(
          "const lookup = await findUniqueAsaasEntity<ProviderPayment>",
        ),
      ),
    );
    assert(
      manualRecoveryLookup.includes("externalReference") &&
        !manualRecoveryLookup.includes("customer: asaasCustomerId"),
      "provider recovery must not hide a divergent customer behind a query filter",
    );

    const subscriptionPeriodClaim = subscription.indexOf(
      "billingPeriodClaim = await claimStudentBillingPeriod",
    );
    const subscriptionProviderClaim = subscription.indexOf(
      "const creationClaim: AsaasCreationClaim = await claimAsaasCreation",
    );
    const subscriptionPeriodFence = subscription.indexOf(
      "await markStudentBillingPeriodSubmitting",
      subscriptionProviderClaim,
    );
    const subscriptionProviderFence = subscription.indexOf(
      "await markStudentAsaasCreationSubmitting",
      subscriptionPeriodFence,
    );
    const subscriptionPost = subscription.indexOf(
      "`${submitIntegration.baseUrl}/subscriptions`",
      subscriptionProviderFence,
    );
    assert(
      subscriptionPeriodClaim >= 0 &&
        subscriptionProviderClaim > subscriptionPeriodClaim &&
        subscriptionPeriodFence > subscriptionProviderClaim &&
        subscriptionProviderFence > subscriptionPeriodFence &&
        subscriptionPost > subscriptionProviderFence,
      "subscription must reserve and fence the same competence before POST",
    );
  },
});

Deno.test({
  name:
    "manual Pix adopts observed charges under lifecycle fences and marks READY last",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("../generate-student-manual-pix/index.ts", import.meta.url),
    );
    const observedBranch = source.indexOf("if (payment) {");
    const observedPeriodClaim = source.indexOf(
      "paymentPeriodClaim = await claimStudentBillingPeriod",
      observedBranch,
    );
    const recurringAdoptionKey = source.indexOf(
      "`subscription-payment:${subscriptionId}:${targetDueDate}`",
      observedPeriodClaim,
    );
    const observedCreationClaim = source.indexOf(
      "const paymentClaim = await claimAsaasCreation",
      recurringAdoptionKey,
    );
    const observedLifecycle = source.indexOf(
      "await bindStudentAsaasCreationLifecycle",
      observedCreationClaim,
    );
    const observedGet = source.indexOf(
      "const exactObservedPayment = await providerRequest",
      observedLifecycle,
    );
    assert(
      observedBranch >= 0 && observedPeriodClaim > observedBranch &&
        recurringAdoptionKey > observedPeriodClaim &&
        observedCreationClaim > recurringAdoptionKey &&
        observedLifecycle > observedCreationClaim &&
        observedGet > observedLifecycle,
      "an already-observed charge must be adopted durably without another POST",
    );
    const localBinding = source.indexOf(
      'authorization.admin.from("student_payments")',
      observedGet,
    );
    const lifecycleRelease = source.indexOf(
      "await releaseStudentAsaasCreationLifecycle",
      localBinding,
    );
    const boundPeriod = source.indexOf(
      'await recordPaymentPeriod("BOUND", paymentId)',
      lifecycleRelease,
    );
    const ready = source.indexOf('status: "READY"', boundPeriod);
    assert(
      localBinding > observedGet && lifecycleRelease > localBinding &&
        boundPeriod > lifecycleRelease && ready > boundPeriod,
      "READY must follow exact GET, local ledger binding and lifecycle release",
    );
    assert(
      source.includes(
        "billingSourceKey = `manual-pix:${referencedIssuanceId}`",
      ) &&
        source.includes("recurringPaymentSourceKey("),
      "manual recovery must retain its original key and recurring adoption must prove its source",
    );
  },
});

Deno.test({
  name: "linked customer crash recovery proves and releases the exact attempt",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("../generate-student-manual-pix/index.ts", import.meta.url),
    );
    const linked = source.indexOf("if (asaasCustomerId) {");
    const exactReference = source.indexOf(
      "!providerCustomerMatches(linkedCustomer.data",
      linked,
    );
    const succeeded = source.indexOf(
      'status: "SUCCEEDED"',
      exactReference,
    );
    const bind = source.indexOf(
      "await bindStudentAsaasCreationLifecycle",
      succeeded,
    );
    const release = source.indexOf(
      "await releaseStudentAsaasCreationLifecycle",
      bind,
    );
    assert(
      linked >= 0 && exactReference > linked && succeeded > exactReference &&
        bind > succeeded && release > bind,
      "a locally linked customer must repair the exact durable lifecycle after CAS",
    );
    assert(
      source.includes("externalReference === input.studentId") &&
        !source.includes("!externalReference ||"),
      "a customer without the exact student reference must fail closed",
    );
  },
});

Deno.test({
  name: "manual Pix communication has one irreversible send attempt",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("../generate-student-manual-pix/index.ts", import.meta.url),
    );
    const claim = source.indexOf(
      "const messageClaim = await claimOutboundMessage",
    );
    const fence = source.indexOf("await markOutboundMessageSubmitting", claim);
    const send = source.indexOf("const delivery = await sendWhatsapp", fence);
    const finish = source.indexOf("await finishOutboundMessage", send);
    assert(
      claim >= 0 && fence > claim && send > fence && finish > send,
      "WhatsApp delivery must persist SUBMITTING before its only send",
    );
    assert(
      source.includes('delivery.ambiguous\n              ? "UNKNOWN"') &&
        source.includes('messageClaim.action === "ALREADY_FINAL"'),
      "ambiguous or final delivery must never be retried",
    );
  },
});
