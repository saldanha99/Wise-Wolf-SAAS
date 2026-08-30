import {
  actualCreditAt,
  asaasDateToIso,
  completedRefundAmount,
  enrollmentPaymentKind,
  financialReviewReason,
  isProvenHistoricalReversalEvent,
  isSettledPaymentEvent,
  localStatusAfterProviderEvent,
  paymentCustomerMatchesCanonicalBinding,
  providerEventRank,
  providerGeneratedSubscriptionPaymentMatches,
  shouldApplyProviderEvent,
  studentIdFromKnownPaymentReference,
} from "./event-contract.ts";
import {
  applyEnrollmentPaymentObservation,
  EnrollmentPaymentObservationError,
  enrollmentPaymentObservationFailureDisposition,
} from "../_shared/enrollment-progress.ts";

Deno.test(
  "enrollment observation failures suppress stale lifecycle effects and retry only transient errors",
  async () => {
    for (
      const reason of [
        "student_lifecycle_inactive",
        "provider_observation_stale",
      ]
    ) {
      const disposition = enrollmentPaymentObservationFailureDisposition(
        new EnrollmentPaymentObservationError(reason, false),
      );
      if (disposition !== "SUPPRESS") {
        throw new Error(`${reason} was not safely suppressed`);
      }
    }

    const deterministic = enrollmentPaymentObservationFailureDisposition(
      new EnrollmentPaymentObservationError(
        "enrollment_observation_database_rejected",
        false,
        "22023",
      ),
    );
    if (deterministic !== "TRIAGE") {
      throw new Error("deterministic RPC rejection was scheduled for retry");
    }

    const transient = enrollmentPaymentObservationFailureDisposition(
      new EnrollmentPaymentObservationError(
        "enrollment_observation_temporarily_unavailable",
        true,
        "40001",
      ),
    );
    if (transient !== "RETRY") {
      throw new Error("transient serialization failure was not retried");
    }

    const captureRpcFailure = async (
      result: {
        data: Record<string, unknown> | null;
        error: { code?: string; message: string } | null;
      },
    ): Promise<unknown> => {
      try {
        await applyEnrollmentPaymentObservation(
          {
            rpc: () => Promise.resolve(result),
          } as unknown as Parameters<
            typeof applyEnrollmentPaymentObservation
          >[0],
          {
            tenantId: "tenant",
            studentId: "00000000-0000-4000-8000-000000000001",
            offerId: "00000000-0000-4000-8000-000000000002",
            providerPaymentId: "pay_1",
            providerCustomerId: "cus_1",
            providerSubscriptionId: null,
            paymentKind: "ONE_TIME",
            outcome: "SETTLED",
            providerValue: 10,
            externalReference:
              "enrollment:00000000-0000-4000-8000-000000000002:one-time",
            providerStatus: "RECEIVED",
            dueDate: "2026-08-25",
            billingType: "PIX",
            description: "Pagamento avulso",
          },
        );
      } catch (error) {
        return error;
      }
      throw new Error("mocked observation unexpectedly succeeded");
    };

    const databaseRejection = await captureRpcFailure({
      data: null,
      error: { code: "22023", message: "invalid observation" },
    });
    if (
      enrollmentPaymentObservationFailureDisposition(databaseRejection) !==
        "TRIAGE"
    ) {
      throw new Error("SQL contract error was not triaged by the real helper");
    }
    const staleResult = await captureRpcFailure({
      data: { ok: false, reason: "provider_observation_stale" },
      error: null,
    });
    if (
      enrollmentPaymentObservationFailureDisposition(staleResult) !==
        "SUPPRESS"
    ) {
      throw new Error("stale RPC result was not suppressed by the real helper");
    }
  },
);

Deno.test("only balance-settled events can grant paid access", () => {
  if (isSettledPaymentEvent("PAYMENT_CONFIRMED")) {
    throw new Error("CONFIRMED was treated as settled cash");
  }
  for (const event of ["PAYMENT_RECEIVED", "PAYMENT_RECEIVED_IN_CASH"]) {
    if (!isSettledPaymentEvent(event)) {
      throw new Error(`${event} was not recognized as settlement`);
    }
  }
});

Deno.test("only proven reversals qualify for historical processing", () => {
  for (
    const event of [
      "PAYMENT_REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      "PAYMENT_RECEIVED_IN_CASH_UNDONE",
    ]
  ) {
    if (!isProvenHistoricalReversalEvent(event)) {
      throw new Error(`${event} was not recognized as a proven reversal`);
    }
  }
  for (
    const event of [
      "PAYMENT_RECEIVED",
      "PAYMENT_CONFIRMED",
      "PAYMENT_DELETED",
      "PAYMENT_CHARGEBACK_REQUESTED",
      "PAYMENT_REFUND_IN_PROGRESS",
    ]
  ) {
    if (isProvenHistoricalReversalEvent(event)) {
      throw new Error(`${event} incorrectly bypassed the operational gate`);
    }
  }
});

Deno.test(
  "recurring enrollment binds only its first settled subscription payment",
  () => {
    const binding = {
      subscriptionId: "sub_enrollment",
      requiresEnrollmentPayment: false,
    };
    const first = enrollmentPaymentKind(
      binding,
      { id: "pay_first", subscription: "sub_enrollment" },
      true,
    );
    if (first !== "SUBSCRIPTION_ACTIVATION") {
      throw new Error("first subscription settlement was not bound");
    }

    const persistedBinding = {
      ...binding,
      subscriptionActivationPaymentId: "pay_first",
    };
    if (
      enrollmentPaymentKind(
        persistedBinding,
        { id: "pay_later", subscription: "sub_enrollment" },
        true,
      ) !== null
    ) {
      throw new Error("later subscription installment became activation");
    }
    if (
      enrollmentPaymentKind(
        persistedBinding,
        { id: "pay_first", subscription: "sub_enrollment" },
        false,
      ) !== "SUBSCRIPTION_ACTIVATION"
    ) {
      throw new Error("stored activation payment cannot be reopened on refund");
    }
  },
);

Deno.test(
  "subscription settlement cannot bypass a required enrollment fee",
  () => {
    const kind = enrollmentPaymentKind(
      {
        subscriptionId: "sub_fee_required",
        requiresEnrollmentPayment: true,
      },
      { id: "pay_subscription", subscription: "sub_fee_required" },
      true,
    );
    if (kind !== null) throw new Error("subscription bypassed enrollment fee");
  },
);

Deno.test("creditDate uses noon UTC and CONFIRMED never invents cash", () => {
  const payment = {
    status: "CONFIRMED",
    paymentDate: "2026-01-31",
    creditDate: "2026-02-02",
    estimatedCreditDate: "2026-02-01",
  };
  if (actualCreditAt("PAYMENT_CONFIRMED", payment) !== null) {
    throw new Error("CONFIRMED must not populate credited_at");
  }
  const received = actualCreditAt("PAYMENT_RECEIVED", payment);
  if (received !== "2026-02-02T12:00:00.000Z") {
    throw new Error(`unexpected credit date: ${received}`);
  }
  if (asaasDateToIso(payment.paymentDate) === received) {
    throw new Error("payment date and balance credit date were conflated");
  }
});

Deno.test(
  "partial refund includes only completed refunds and caps at value",
  () => {
    const refunded = completedRefundAmount(
      {
        value: 100,
        refundedValue: 35,
        refunds: [
          { value: 20, status: "DONE" },
          { value: 70 },
          { value: 80, status: "PENDING" },
        ],
      },
      "PAYMENT_PARTIALLY_REFUNDED",
    );
    if (refunded !== 35) throw new Error(`expected 35, got ${refunded}`);

    const capped = completedRefundAmount(
      {
        value: 100,
        refundedValue: 150,
      },
      "PAYMENT_REFUNDED",
    );
    if (capped !== 100) throw new Error(`expected cap 100, got ${capped}`);
  },
);

Deno.test(
  "older or lower-precedence event cannot regress received payment",
  () => {
    const current = {
      last_provider_event_at: "2026-02-02T12:00:00.000Z",
      last_provider_event_rank: providerEventRank("PAYMENT_RECEIVED"),
    };
    if (
      shouldApplyProviderEvent(
        current,
        "2026-02-01T12:00:00.000Z",
        providerEventRank("PAYMENT_CONFIRMED"),
      )
    ) {
      throw new Error("older CONFIRMED event was accepted");
    }
    if (
      shouldApplyProviderEvent(
        current,
        "2026-02-02T12:00:00.000Z",
        providerEventRank("PAYMENT_CREATED"),
      )
    ) {
      throw new Error("same-time lower-rank CREATED event was accepted");
    }
  },
);

Deno.test("provider retry preserves manual NAO_RECEITA classification", () => {
  const status = localStatusAfterProviderEvent(
    "NAO_RECEITA",
    "RECEIVED",
    "PAYMENT_RECEIVED",
  );
  if (status !== "NAO_RECEITA") {
    throw new Error("PAYMENT_RECEIVED retry erased manual classification");
  }
});

Deno.test("externalReference never overrides a divergent customer binding", () => {
  if (paymentCustomerMatchesCanonicalBinding("cus_expected", "cus_other")) {
    throw new Error("divergent provider customer was accepted");
  }
  if (!paymentCustomerMatchesCanonicalBinding("cus_expected", "cus_expected")) {
    throw new Error("exact canonical customer binding was rejected");
  }
});

Deno.test("only canonical UUID and manual Pix references identify a student", () => {
  const studentId = "00000000-0000-4000-8000-00000000a102";
  const issuanceId = "00000000-0000-4000-8000-00000000a101";
  if (studentIdFromKnownPaymentReference(studentId) !== studentId) {
    throw new Error("canonical UUID reference was not resolved");
  }
  if (
    studentIdFromKnownPaymentReference(
      `manual-pix:${issuanceId}:student:${studentId}`,
    ) !== studentId
  ) {
    throw new Error("manual Pix student binding was not resolved");
  }
  for (
    const unsafe of [
      `other:${issuanceId}:student:${studentId}`,
      `manual-pix:not-a-uuid:student:${studentId}`,
      `manual-pix:${issuanceId}:student:${studentId}:suffix`,
    ]
  ) {
    if (studentIdFromKnownPaymentReference(unsafe) !== null) {
      throw new Error(`unsafe payment reference was accepted: ${unsafe}`);
    }
  }
});

Deno.test("a new recurring payment requires the exact local and parent subscription", () => {
  const studentId = "00000000-0000-4000-8000-00000000a102";
  const expected = {
    studentId,
    customerId: "cus_expected",
    subscriptionId: "sub_expected",
  };
  const payment = {
    customer: expected.customerId,
    subscription: expected.subscriptionId,
    externalReference: studentId,
  };
  const parent = {
    id: expected.subscriptionId,
    customer: expected.customerId,
    externalReference: studentId,
  };
  if (!providerGeneratedSubscriptionPaymentMatches(payment, parent, expected)) {
    throw new Error("exact recurring origin was rejected");
  }
  for (
    const unsafePayment of [
      { customer: expected.customerId, externalReference: "out-of-band" },
      { ...payment, subscription: "sub_other" },
      { ...payment, customer: "cus_other" },
      { ...payment, externalReference: "out-of-band" },
    ]
  ) {
    if (
      providerGeneratedSubscriptionPaymentMatches(
        unsafePayment,
        parent,
        expected,
      )
    ) {
      throw new Error(
        `unsafe recurring origin was accepted: ${
          JSON.stringify(unsafePayment)
        }`,
      );
    }
  }
});

Deno.test(
  "non-final refund and chargeback events preserve settled cash",
  () => {
    for (
      const eventName of [
        "PAYMENT_REFUND_IN_PROGRESS",
        "PAYMENT_CHARGEBACK_REQUESTED",
        "PAYMENT_CHARGEBACK_DISPUTE",
        "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
        "PAYMENT_DELETED",
      ]
    ) {
      const status = localStatusAfterProviderEvent(
        "RECEIVED",
        eventName.replace("PAYMENT_", ""),
        eventName,
      );
      if (status !== "RECEIVED") {
        throw new Error(`${eventName} removed settled cash prematurely`);
      }
      if (!financialReviewReason(eventName, "RECEIVED", 0)) {
        throw new Error(`${eventName} should require financial review`);
      }
    }
  },
);

Deno.test(
  "partial completed refund preserves paid status and full refund reverses",
  () => {
    const partial = localStatusAfterProviderEvent(
      "RECEIVED",
      "REFUNDED",
      "PAYMENT_PARTIALLY_REFUNDED",
      25,
      100,
    );
    if (partial !== "RECEIVED") {
      throw new Error("partial refund removed all cash");
    }

    const partialFromSnapshot = localStatusAfterProviderEvent(
      "RECEIVED",
      "PARTIALLY_REFUNDED",
      "PAYMENT_UPDATED",
      25,
      100,
    );
    if (partialFromSnapshot !== "RECEIVED") {
      throw new Error("DONE partial refund snapshot removed all cash");
    }

    const full = localStatusAfterProviderEvent(
      "RECEIVED",
      "RECEIVED",
      "PAYMENT_REFUNDED",
      100,
      100,
    );
    if (full !== "REFUNDED") {
      throw new Error(
        "contradictory provider status kept cash after full refund",
      );
    }

    const fullFromSnapshot = localStatusAfterProviderEvent(
      "RECEIVED",
      "RECEIVED",
      "PAYMENT_UPDATED",
      100,
      100,
    );
    if (fullFromSnapshot !== "REFUNDED") {
      throw new Error("full completed refund snapshot kept cash status");
    }
  },
);

Deno.test(
  "undoing a cash receipt preserves gross cash and produces a full reversal",
  () => {
    const payment = { value: 75, status: "PENDING" };
    const reversed = completedRefundAmount(
      payment,
      "PAYMENT_RECEIVED_IN_CASH_UNDONE",
    );
    if (reversed !== 75) {
      throw new Error(`cash undo must reverse the full 75, got ${reversed}`);
    }
    const localStatus = localStatusAfterProviderEvent(
      "RECEIVED_IN_CASH",
      "PENDING",
      "PAYMENT_RECEIVED_IN_CASH_UNDONE",
      reversed,
      payment.value,
    );
    if (localStatus !== "REFUNDED") {
      throw new Error(
        `cash undo must use the auditable reversal path, got ${localStatus}`,
      );
    }
  },
);

Deno.test({
  name: "student financial access is aggregate and never event-order driven",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    if (!source.includes('"recompute_student_financial_status"')) {
      throw new Error("webhook does not call the aggregate financial RPC");
    }
    if (!source.includes('"apply_active_student_payment_event"')) {
      throw new Error(
        "normal student payment events bypass lifecycle serialization",
      );
    }
    const durableFinancialWrite = source.indexOf(
      'rpc("apply_active_student_payment_event"',
    );
    const enrollmentReferenceResolution = source.indexOf(
      "const offerScopedEnrollmentReference =",
    );
    if (
      enrollmentReferenceResolution < 0 ||
      enrollmentReferenceResolution > durableFinancialWrite ||
      source.includes(
        "existingPayment && offerScopedEnrollmentReference?.kind",
      ) ||
      !source.includes('"enrollment_payment_customer_mismatch"')
    ) {
      throw new Error(
        "offer-scoped fee/one-time events are not resolved through offer ownership plus exact customer",
      );
    }
    if (
      !source.includes('["fee", "one-time", "pro-rata"]') ||
      !source.includes(
        'offerScopedEnrollmentReference.purpose === "pro-rata" &&',
      ) ||
      !source.includes("const studentScopedDirectMatch = String(") ||
      !source.includes('"student_direct_payment_binding_mismatch"')
    ) {
      throw new Error(
        "direct pro-rata/student charges do not require an exact persisted binding",
      );
    }
    const atomicLifecycleDecisionStart = source.indexOf(
      "if (!studentId || !studentTenantId || !canonicalPaymentReference)",
      enrollmentReferenceResolution,
    );
    if (
      atomicLifecycleDecisionStart < 0 ||
      source.slice(atomicLifecycleDecisionStart, durableFinancialWrite)
        .includes(
          '.from("tenant_memberships")',
        )
    ) {
      throw new Error(
        "webhook still makes a racy membership decision before the atomic payment RPC",
      );
    }
    const enrollmentObservation = source.indexOf(
      "await applyWebhookEnrollmentObservation(",
      durableFinancialWrite,
    );
    const enrollmentNotification = source.indexOf(
      '.from("notification_queue")',
      enrollmentObservation,
    );
    if (
      durableFinancialWrite < 0 || enrollmentObservation < 0 ||
      enrollmentNotification < enrollmentObservation
    ) {
      throw new Error(
        "enrollment effects/communication do not follow the durable financial event",
      );
    }
    if (
      (source.match(/await applyWebhookEnrollmentObservation\(/g) || [])
        .length !== 1
    ) {
      throw new Error(
        "all enrollment settlement/reversal paths must converge on one atomic observation call",
      );
    }
    if (source.includes(".update({ enrollment_fee_paid: true })")) {
      throw new Error(
        "webhook still marks the enrollment fee outside the atomic RPC",
      );
    }
    if (!source.includes("if (!observation.applied)")) {
      throw new Error(
        "stale/inactive enrollment observations do not suppress later effects",
      );
    }
    if (/from\("student_payments"\)[\s\S]{0,200}\.upsert\(/.test(source)) {
      throw new Error(
        "normal webhook still upserts the student ledger outside the RPC",
      );
    }
    if (source.includes('.update({ status_financial: "ACTIVE" })')) {
      throw new Error("settlement still grants access from one event alone");
    }
    if (source.includes('.update({ status_financial: "OVERDUE" })')) {
      throw new Error("overdue event still blocks access from one event alone");
    }
  },
});

Deno.test({
  name: "payment confirmation delivery is tenant-scoped and submit-once fenced",
  permissions: { read: true },
  async fn() {
    const [webhook, worker, lifecycleSql, deliverySql, occurrenceSql] =
      await Promise.all([
        Deno.readTextFile(new URL("./index.ts", import.meta.url)),
        Deno.readTextFile(
          new URL("../process-notification-queue/index.ts", import.meta.url),
        ),
        Deno.readTextFile(
          new URL(
            "../../migrations/20260825194716_fence_student_lifecycle_mutations.sql",
            import.meta.url,
          ),
        ),
        Deno.readTextFile(
          new URL(
            "../../migrations/20260830152214_harden_whatsapp_delivery_pipeline.sql",
            import.meta.url,
          ),
        ),
        Deno.readTextFile(
          new URL(
            "../../migrations/20260830170000_fence_whatsapp_occurrence_receipts.sql",
            import.meta.url,
          ),
        ),
      ]);

    const capiStart = webhook.indexOf("async function deliverMetaPurchaseOnce");
    const capiClaim = webhook.indexOf(
      "claimOutboundMessage(input.admin",
      capiStart,
    );
    const capiMark = webhook.indexOf(
      "markOutboundMessageSubmittingDecision",
      capiClaim,
    );
    const capiPost = webhook.indexOf("sendMetaCapiEvent({", capiMark);
    const capiTerminal = webhook.indexOf(
      "finishOutboundMessage(input.admin, claim, delivery)",
      capiPost,
    );
    if (
      capiStart < 0 || capiClaim < capiStart || capiMark < capiClaim ||
      capiPost < capiMark || capiTerminal < capiPost ||
      !webhook.includes("FB_CAPI_TENANT_ID !== input.tenantId") ||
      webhook.includes("void sendMetaCapiEvent")
    ) {
      throw new Error("CAPI confirmation bypasses tenant or submit-once fence");
    }

    const workerClaim = worker.indexOf("claimOutboundMessage(supabaseClient");
    const workerIntegration = worker.indexOf(
      "integration = await resolveDeliveryIntegration(",
    );
    const workerJidLookup = worker.indexOf(
      "await resolveWhatsAppDestination({",
      workerIntegration,
    );
    const workerBegin = worker.lastIndexOf(
      "await beginPaymentConfirmationSubmission(",
    );
    const workerRecover = worker.indexOf(
      "await recoverNotificationSubmission(",
      workerBegin,
    );
    const workerPost = worker.indexOf(
      "const providerResult = await sendWhatsTextToResolvedDestinationDetailed(",
      workerRecover,
    );
    const workerTerminal = worker.lastIndexOf(
      "await finalizePaymentConfirmationSubmission(",
    );
    if (
      workerIntegration < 0 || workerIntegration > workerClaim ||
      workerJidLookup < workerIntegration || workerJidLookup > workerClaim ||
      workerClaim < 0 || workerBegin < workerClaim ||
      workerRecover < workerBegin || workerPost < workerRecover ||
      workerTerminal < workerPost ||
      !worker.includes("pending = resolveEvolutionIntegration(") ||
      !worker.includes("payment_confirmation_destination_changed") ||
      !worker.includes("PAYMENT_CONFIRMED_WHATSAPP") ||
      !worker.includes("currentProfile?.guardian_id") ||
      !worker.includes("currentProfile?.guardian_phone") ||
      !worker.includes('"begin_payment_confirmation_delivery_submission"') ||
      !worker.includes('"recover_notification_delivery_submission"') ||
      !worker.includes('"finalize_payment_confirmation_delivery"') ||
      !worker.includes("p_provider_destination: providerDestination") ||
      !worker.includes('decision.status === "sent"') ||
      !worker.includes("messageId: providerResult.messageId") ||
      !lifecycleSql.includes("'action', 'REPLAY'") ||
      !lifecycleSql.includes(
        "payment_row.last_provider_event_id",
      )
    ) {
      throw new Error(
        "WhatsApp confirmation bypasses tenant routing or terminal delivery persistence",
      );
    }

    for (
      const contract of [
        "foreign key (student_id) references public.profiles(id) on delete cascade",
        "PAYMENT_CONFIRMED_CAPI",
        "PAYMENT_CONFIRMED_WHATSAPP",
        "for update;",
        "payment_state_changed_before_notification_send",
      ]
    ) {
      if (!lifecycleSql.includes(contract)) {
        throw new Error(`payment confirmation SQL fence missing: ${contract}`);
      }
    }

    for (
      const contract of [
        "begin_payment_confirmation_delivery_submission",
        "finalize_payment_confirmation_delivery",
        "financial_outbound_queue_binding_mismatch",
        "provider_destination = v_provider_destination",
      ]
    ) {
      if (!deliverySql.includes(contract)) {
        throw new Error(
          `payment confirmation delivery bridge missing: ${contract}`,
        );
      }
    }

    for (
      const contract of [
        "recover_notification_delivery_submission",
        "receipt_state = 'SEALED'",
        "lesson_authorized_snapshot_changed",
        "notification_provider_binding_changed",
      ]
    ) {
      if (!occurrenceSql.includes(contract)) {
        throw new Error(`notification occurrence fence missing: ${contract}`);
      }
    }
  },
});
