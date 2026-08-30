import {
  buildReconciliationIssues,
  planTransferAudit,
  runTransferAudit,
} from "./diff.ts";

const empty = {
  windowStart: "2026-01-01",
  windowEnd: "2026-12-31",
  statement: [],
  grossLedgerByPaymentId: new Map(),
  refundLedgerByPaymentId: new Map(),
  customerByStudentId: new Map<string, string>(),
  studentByCustomerId: new Map<
    string,
    Array<{ id: string; tenantId: string | null }>
  >(),
  productPaymentByProviderId: new Map(),
  productReferenceByExternalReference: new Map(),
  providerTransfers: [],
  localTransfers: [],
};

Deno.test("transfer audit skips provider endpoint only when disabled and empty", () => {
  const plan = planTransferAudit(false, 0);
  if (plan !== "SKIP_DISABLED_WITHOUT_LOCAL_ATTEMPTS") {
    throw new Error(`unexpected transfer audit plan: ${plan}`);
  }
});

Deno.test("transfer audit fails closed when disabled with local history", () => {
  let message = "";
  try {
    planTransferAudit(false, 1);
  } catch (error) {
    message = error instanceof Error ? error.message : "unknown";
  }
  if (message !== "local_transfers_present_while_teacher_transfers_disabled") {
    throw new Error(`unexpected transfer audit failure: ${message}`);
  }
});

Deno.test("transfer audit lists provider data whenever transfers are enabled", () => {
  for (const localTransferCount of [0, 3]) {
    const plan = planTransferAudit(true, localTransferCount);
    if (plan !== "LIST_PROVIDER_TRANSFERS") {
      throw new Error(`unexpected enabled transfer audit plan: ${plan}`);
    }
  }
});

Deno.test("disabled transfer audit never calls the provider", async () => {
  let calls = 0;
  const result = await runTransferAudit(false, 0, () => {
    calls += 1;
    return Promise.resolve([{ id: "should-not-be-read" }]);
  });
  if (calls !== 0 || result.providerTransfers.length !== 0) {
    throw new Error("disabled transfer audit reached the provider");
  }
});

Deno.test("enabled transfer audit calls the provider exactly once", async () => {
  let calls = 0;
  const result = await runTransferAudit(true, 0, () => {
    calls += 1;
    return Promise.resolve([{ id: "transfer-1" }]);
  });
  if (calls !== 1 || result.providerTransfers[0]?.id !== "transfer-1") {
    throw new Error("enabled transfer audit did not preserve provider data");
  }
});

Deno.test(
  "reconciliation detects missing provider receipt without importing it",
  () => {
    const issues = buildReconciliationIssues({
      ...empty,
      referenceTenantId: "school-wise-wolf",
      providerPayments: [
        {
          id: "pay_missing",
          customer: "cus_1",
          status: "RECEIVED",
          value: 100,
        },
      ],
      localPayments: [],
    });
    if (
      !issues.some((issue) =>
        issue.kind === "PROVIDER_PAYMENT_MISSING_LOCAL" &&
        issue.tenant_id === "school-wise-wolf"
      ) ||
      !issues.some((issue) =>
        issue.kind === "PROVIDER_CUSTOMER_UNRESOLVED" &&
        issue.tenant_id === "school-wise-wolf"
      )
    ) {
      throw new Error(
        "missing root-account payment was hidden from its tenant",
      );
    }
  },
);

Deno.test(
  "reconciliation raises a high issue when a deleted provider charge remains locally open",
  () => {
    const localId = "00000000-0000-4000-8000-000000000090";
    const baseInput = {
      ...empty,
      providerPayments: [{
        id: "pay_deleted_open",
        customer: "cus_deleted_open",
        status: "PENDING",
        value: 279,
        dueDate: "2026-08-15",
        deleted: true,
      }],
      customerByStudentId: new Map([["student-deleted", "cus_deleted_open"]]),
      studentByCustomerId: new Map([
        [
          "cus_deleted_open",
          [{ id: "student-deleted", tenantId: "school" }],
        ],
      ]),
    };
    const issues = buildReconciliationIssues({
      ...baseInput,
      localPayments: [{
        id: localId,
        tenant_id: "school",
        student_id: "student-deleted",
        asaas_payment_id: "pay_deleted_open",
        status: "PENDING",
        provider_status: "PENDING",
        value: 279,
        due_date: "2026-08-15",
        refunded_amount: 0,
      }],
    });
    const issue = issues.find((candidate) =>
      candidate.kind === "PROVIDER_PAYMENT_DELETED_LOCAL_OPEN"
    );
    if (!issue || issue.severity !== "HIGH") {
      throw new Error("deleted provider charge remained invisible locally");
    }

    const converged = buildReconciliationIssues({
      ...baseInput,
      localPayments: [{
        id: localId,
        tenant_id: "school",
        student_id: "student-deleted",
        asaas_payment_id: "pay_deleted_open",
        status: "CANCELLED",
        provider_status: "DELETED",
        value: 279,
        due_date: "2026-08-15",
        refunded_amount: 0,
      }],
    });
    if (
      converged.some((candidate) =>
        candidate.kind === "PROVIDER_PAYMENT_DELETED_LOCAL_OPEN" ||
        candidate.kind === "PAYMENT_STATUS_MISMATCH"
      )
    ) {
      throw new Error("a converged provider deletion stayed falsely open");
    }
  },
);

Deno.test("identity collisions are critical instead of silently collapsed", () => {
  const providerId = "pay_collision";
  const customerId = "cus_collision";
  const productReference = "hub:10000000-0000-4000-8000-000000000001";
  const issues = buildReconciliationIssues({
    ...empty,
    providerPayments: [
      { id: providerId, customer: customerId, value: 100 },
      { id: providerId, customer: customerId, value: 101 },
    ],
    localPayments: [
      {
        id: "10000000-0000-4000-8000-000000000011",
        asaas_payment_id: providerId,
        tenant_id: "school-a",
      },
      {
        id: "10000000-0000-4000-8000-000000000012",
        asaas_payment_id: providerId,
        tenant_id: "school-b",
      },
    ],
    studentByCustomerId: new Map([
      [
        customerId,
        [
          { id: "student-a", tenantId: "school-a" },
          { id: "student-b", tenantId: "school-b" },
        ],
      ],
    ]),
    productPaymentByProviderId: new Map([
      [
        "pay_product_collision",
        [
          {
            family: "HUB",
            localEntityId: "checkout-a",
            externalReference: productReference,
          },
          {
            family: "SAAS",
            localEntityId: "checkout-b",
            externalReference: productReference,
          },
        ],
      ],
    ]),
    productReferenceByExternalReference: new Map([
      [
        productReference,
        [
          { family: "HUB", localEntityId: "checkout-a" },
          { family: "HUB", localEntityId: "checkout-b" },
        ],
      ],
    ]),
  });
  const criticalKinds = new Set(
    issues.filter((issue) => issue.severity === "CRITICAL").map((issue) =>
      issue.kind
    ),
  );
  for (
    const expected of [
      "PROVIDER_PAYMENT_ID_COLLISION",
      "LOCAL_PAYMENT_PROVIDER_ID_COLLISION",
      "LOCAL_CUSTOMER_IDENTITY_COLLISION",
      "PRODUCT_PAYMENT_PROVIDER_ID_COLLISION",
      "PRODUCT_PAYMENT_REFERENCE_COLLISION",
    ]
  ) {
    if (!criticalKinds.has(expected)) {
      throw new Error(`${expected} was silently collapsed`);
    }
  }
});

Deno.test(
  "a provider payment cannot satisfy a student debt and a product sale",
  () => {
    const providerId = "pay_shared_student_product";
    const localId = "10000000-0000-4000-8000-000000000021";
    const issues = buildReconciliationIssues({
      ...empty,
      referenceTenantId: "school-wise-wolf",
      providerPayments: [{
        id: providerId,
        externalReference: "hub:10000000-0000-4000-8000-000000000022",
        status: "RECEIVED",
        value: 169,
      }],
      localPayments: [{
        id: localId,
        tenant_id: "school-wise-wolf",
        student_id: "student-shared-provider",
        asaas_payment_id: providerId,
        status: "RECEIVED",
        provider_status: "RECEIVED",
        value: 169,
      }],
      productPaymentByProviderId: new Map([
        [providerId, [{
          family: "HUB",
          localEntityId: "10000000-0000-4000-8000-000000000022",
          externalReference: "hub:10000000-0000-4000-8000-000000000022",
        }]],
      ]),
    });
    const collision = issues.find((issue) =>
      issue.kind === "STUDENT_AND_PRODUCT_PAYMENT_PROVIDER_ID_COLLISION"
    );
    if (
      !collision || collision.severity !== "CRITICAL" ||
      collision.tenant_id !== "school-wise-wolf"
    ) {
      throw new Error("cross-ledger provider id collision was hidden");
    }
  },
);

Deno.test(
  "NAO_RECEITA compares provider_status and preserves its non-revenue ledger",
  () => {
    const localId = "00000000-0000-4000-8000-000000000001";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [
        {
          id: "pay_non_revenue",
          customer: "cus_1",
          status: "RECEIVED",
          value: 20,
          creditDate: "2026-08-20",
        },
      ],
      localPayments: [
        {
          id: localId,
          tenant_id: "school",
          student_id: "student",
          asaas_payment_id: "pay_non_revenue",
          value: 20,
          status: "NAO_RECEITA",
          provider_status: "RECEIVED",
          credited_at: "2026-08-20T12:00:00Z",
          refunded_amount: 0,
          ledger_entry_created: true,
        },
      ],
      grossLedgerByPaymentId: new Map([
        [
          localId,
          [{
            id: "00000000-0000-4000-8000-000000000011",
            student_payment_id: localId,
            amount: 20,
            occurred_at: "2026-08-20T12:00:00Z",
            type: "ENTRADA",
            category: "aporte_ou_movimentacao",
          }],
        ],
      ]),
      customerByStudentId: new Map([["student", "cus_1"]]),
    });
    if (issues.some((issue) => issue.kind === "LEDGER_GROSS_ENTRY_MISSING")) {
      throw new Error("NAO_RECEITA ledger entry was not recognized");
    }
    if (issues.some((issue) => issue.kind === "LEDGER_FLAG_MISMATCH")) {
      throw new Error("NAO_RECEITA ledger flag was not recognized");
    }
    if (issues.some((issue) => issue.kind === "PAYMENT_STATUS_MISMATCH")) {
      throw new Error("provider status was compared to local classification");
    }
  },
);

Deno.test(
  "reconciliation detects lying ledger flag and cross-month credit mismatch",
  () => {
    const localId = "00000000-0000-4000-8000-000000000002";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [
        {
          id: "pay_cross_month",
          customer: "cus_2",
          status: "RECEIVED",
          value: 100,
          paymentDate: "2026-01-31",
          creditDate: "2026-02-02",
        },
      ],
      localPayments: [
        {
          id: localId,
          tenant_id: "school",
          student_id: "student",
          asaas_payment_id: "pay_cross_month",
          value: 100,
          status: "RECEIVED",
          provider_status: "RECEIVED",
          credited_at: "2026-01-31T12:00:00Z",
          refunded_amount: 0,
          ledger_entry_created: true,
        },
      ],
      customerByStudentId: new Map([["student", "cus_2"]]),
    });
    const kinds = new Set(issues.map((issue) => issue.kind));
    if (!kinds.has("CREDIT_DATE_MISMATCH")) {
      throw new Error("credit mismatch missed");
    }
    if (!kinds.has("LEDGER_GROSS_ENTRY_MISSING")) {
      throw new Error("missing ledger missed");
    }
    if (!kinds.has("LEDGER_FLAG_MISMATCH")) {
      throw new Error("lying flag missed");
    }
  },
);

Deno.test(
  "CONFIRMED card with future credit date is not treated as received cash",
  () => {
    const localId = "00000000-0000-4000-8000-000000000082";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [{
        id: "pay_confirmed_future_credit",
        customer: "cus_confirmed",
        status: "CONFIRMED",
        value: 315,
        dueDate: "2026-08-28",
        paymentDate: "2026-08-28",
        creditDate: "2026-09-14",
        billingType: "CREDIT_CARD",
      }],
      localPayments: [{
        id: localId,
        tenant_id: "school",
        student_id: "student-confirmed",
        asaas_payment_id: "pay_confirmed_future_credit",
        value: 315,
        status: "CONFIRMED",
        provider_status: "CONFIRMED",
        due_date: "2026-08-28",
        payment_date: "2026-08-28",
        credited_at: null,
        paid_at: null,
        refunded_amount: 0,
        ledger_entry_created: false,
      }],
      customerByStudentId: new Map([
        ["student-confirmed", "cus_confirmed"],
      ]),
    });
    const creditIssues = issues.filter((issue) =>
      issue.kind.includes("CREDIT_DATE")
    );
    if (creditIssues.length > 0) {
      throw new Error(
        `future confirmed credit produced cash issue: ${
          creditIssues.map((issue) => issue.kind).join(",")
        }`,
      );
    }
  },
);

Deno.test(
  "pre-cash provider status rejects an invented local credit marker",
  () => {
    for (
      const [index, status] of [
        "CONFIRMED",
        "AWAITING_RISK_ANALYSIS",
        "AUTHORIZED",
        "REPROVED_BY_RISK_ANALYSIS",
        "CANCELLED",
        "RECEIVED_IN_CASH",
      ].entries()
    ) {
      const localId = `00000000-0000-4000-8000-00000000008${index + 4}`;
      const providerId = `pay_precash_local_credit_${index}`;
      const issues = buildReconciliationIssues({
        ...empty,
        providerPayments: [{
          id: providerId,
          customer: "cus_precash_credit",
          status,
          value: 315,
          dueDate: "2026-08-28",
          paymentDate: "2026-08-28",
          creditDate: "2026-09-14",
          billingType: "CREDIT_CARD",
        }],
        localPayments: [{
          id: localId,
          tenant_id: "school",
          student_id: "student-precash-credit",
          asaas_payment_id: providerId,
          value: 315,
          status,
          provider_status: status,
          due_date: "2026-08-28",
          payment_date: "2026-08-28",
          credited_at: "2026-09-14T12:00:00Z",
          paid_at: "2026-08-28T12:00:00Z",
          refunded_amount: 0,
          ledger_entry_created: false,
        }],
        customerByStudentId: new Map([
          ["student-precash-credit", "cus_precash_credit"],
        ]),
      });
      if (
        !issues.some((issue) =>
          issue.kind === "LOCAL_CREDIT_DATE_WITHOUT_PROVIDER_CREDIT" &&
          issue.severity === "HIGH"
        )
      ) {
        throw new Error(`invented local cash marker was hidden for ${status}`);
      }
    }
  },
);

Deno.test(
  "statement-only financial facts remain visible to the audited tenant",
  () => {
    const issues = buildReconciliationIssues({
      ...empty,
      referenceTenantId: "school-wise-wolf",
      providerPayments: [],
      localPayments: [],
      statement: [
        {
          id: "statement_missing_receipt",
          type: "PAYMENT_RECEIVED",
          paymentId: "pay_statement_missing_local",
          value: 169,
          date: "2026-08-29",
        },
        {
          id: "statement_unresolved_refund",
          type: "PAYMENT_REVERSAL",
          value: -50,
          date: "2026-08-29",
        },
      ],
    });
    const missingLocal = issues.find((issue) =>
      issue.kind === "STATEMENT_RECEIPT_MISSING_LOCAL_PAYMENT"
    );
    const unresolved = issues.find((issue) =>
      issue.kind === "STATEMENT_REFUND_PAYMENT_ID_UNRESOLVED"
    );
    if (
      missingLocal?.tenant_id !== "school-wise-wolf" ||
      unresolved?.tenant_id !== null
    ) {
      throw new Error("statement financial facts crossed tenant boundaries");
    }
  },
);

Deno.test(
  "matching statement corroborates one missing local credit without duplicate issue",
  () => {
    const localId = "00000000-0000-4000-8000-000000000083";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [{
        id: "pay_missing_local_credit",
        customer: "cus_received",
        status: "RECEIVED",
        value: 169,
        dueDate: "2026-08-10",
        paymentDate: "2026-08-10",
        creditDate: "2026-08-10",
        billingType: "PIX",
      }],
      localPayments: [{
        id: localId,
        tenant_id: "school",
        student_id: "student-received",
        asaas_payment_id: "pay_missing_local_credit",
        value: 169,
        status: "RECEIVED",
        provider_status: "RECEIVED",
        due_date: "2026-08-10",
        payment_date: "2026-08-10",
        credited_at: null,
        paid_at: "2026-08-10T12:00:00Z",
        refunded_amount: 0,
        ledger_entry_created: true,
      }],
      statement: [{
        id: "ftn_received",
        type: "PAYMENT_RECEIVED",
        paymentId: "pay_missing_local_credit",
        value: 169,
        date: "2026-08-10",
      }],
      customerByStudentId: new Map([
        ["student-received", "cus_received"],
      ]),
      grossLedgerByPaymentId: new Map([
        [
          localId,
          [{
            student_payment_id: localId,
            amount: 169,
            occurred_at: "2026-08-10T12:00:00Z",
            type: "ENTRADA",
            category: "MENSALIDADE",
          }],
        ],
      ]),
    });
    const creditKinds = issues
      .filter((issue) => issue.kind.includes("CREDIT_DATE"))
      .map((issue) => issue.kind);
    if (
      creditKinds.length !== 1 ||
      creditKinds[0] !== "LOCAL_CREDIT_DATE_MISSING"
    ) {
      throw new Error(`credit evidence was duplicated: ${creditKinds}`);
    }
  },
);

Deno.test(
  "unlinked settled cash is reviewable while open debt remains critical",
  () => {
    const baseProvider = {
      customer: "cus_unlinked",
      value: 169,
      dueDate: "2026-08-10",
    };
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [
        {
          ...baseProvider,
          id: "pay_unlinked_received",
          status: "RECEIVED",
          paymentDate: "2026-08-10",
          creditDate: "2026-08-10",
        },
        {
          ...baseProvider,
          id: "pay_unlinked_open",
          status: "PENDING",
        },
        {
          ...baseProvider,
          id: "pay_unlinked_deleted",
          status: "PENDING",
          deleted: true,
        },
      ],
      localPayments: [
        {
          id: "00000000-0000-4000-8000-000000000084",
          tenant_id: "school",
          student_id: null,
          asaas_payment_id: "pay_unlinked_received",
          value: 169,
          status: "RECEIVED",
          provider_status: "RECEIVED",
          due_date: "2026-08-10",
          payment_date: "2026-08-10",
          credited_at: "2026-08-10T12:00:00Z",
          paid_at: "2026-08-10T12:00:00Z",
          refunded_amount: 0,
          ledger_entry_created: true,
        },
        {
          id: "00000000-0000-4000-8000-000000000085",
          tenant_id: "school",
          student_id: null,
          asaas_payment_id: "pay_unlinked_open",
          value: 169,
          status: "PENDING",
          provider_status: "PENDING",
          due_date: "2026-08-10",
          refunded_amount: 0,
          ledger_entry_created: false,
        },
        {
          id: "00000000-0000-4000-8000-000000000086",
          tenant_id: "school",
          student_id: null,
          asaas_payment_id: "pay_unlinked_deleted",
          value: 169,
          status: "CANCELLED",
          provider_status: "DELETED",
          due_date: "2026-08-10",
          refunded_amount: 0,
          ledger_entry_created: false,
        },
      ],
      grossLedgerByPaymentId: new Map([
        [
          "00000000-0000-4000-8000-000000000084",
          [{
            student_payment_id: "00000000-0000-4000-8000-000000000084",
            amount: 169,
            occurred_at: "2026-08-10T12:00:00Z",
            type: "ENTRADA",
            category: "MENSALIDADE",
          }],
        ],
      ]),
    });
    const unresolved = issues.filter((issue) =>
      issue.kind === "PAYMENT_TENANT_OR_STUDENT_UNRESOLVED"
    );
    if (
      unresolved.length !== 2 ||
      unresolved.find((issue) =>
          issue.provider_entity_id === "pay_unlinked_received"
        )?.severity !== "HIGH" ||
      unresolved.find((issue) =>
          issue.provider_entity_id === "pay_unlinked_open"
        )?.severity !== "CRITICAL" ||
      unresolved.some((issue) =>
        issue.provider_entity_id === "pay_unlinked_deleted"
      )
    ) {
      throw new Error("unlinked payment severities are not operationally safe");
    }
  },
);

Deno.test(
  "UNKNOWN transfer is reconciled as critical without retrying POST",
  () => {
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [],
      localPayments: [],
      localTransfers: [
        {
          id: "attempt",
          closing_id: "closing",
          tenant_id: "school",
          external_reference: "wisewolf-teacher-closing:closing",
          status: "UNKNOWN",
          expected_amount: 250,
        },
      ],
      providerTransfers: [
        {
          id: "tr_1",
          externalReference: "wisewolf-teacher-closing:closing",
          status: "DONE",
          value: 250,
        },
      ],
    });
    if (!issues.some((issue) => issue.kind === "TRANSFER_LOCAL_STATE_STALE")) {
      throw new Error("ambiguous transfer resolution was missed");
    }
  },
);

Deno.test("partial refund accepts gross receipt plus matching refund output", () => {
  const localId = "00000000-0000-4000-8000-000000000003";
  const issues = buildReconciliationIssues({
    ...empty,
    providerPayments: [
      {
        id: "pay_partial",
        customer: "cus_3",
        status: "RECEIVED",
        value: 100,
        refundedValue: 25,
        creditDate: "2026-08-20",
      },
    ],
    localPayments: [
      {
        id: localId,
        tenant_id: "school",
        student_id: "student",
        asaas_payment_id: "pay_partial",
        value: 100,
        status: "RECEIVED",
        provider_status: "RECEIVED",
        credited_at: "2026-08-20T12:00:00Z",
        refunded_amount: 25,
        last_provider_event_id: "evt_refund_partial",
        last_provider_event_at: "2026-08-22T15:30:00Z",
        ledger_entry_created: true,
      },
    ],
    customerByStudentId: new Map([["student", "cus_3"]]),
    grossLedgerByPaymentId: new Map([
      [
        localId,
        [{
          id: "00000000-0000-4000-8000-000000000031",
          student_payment_id: localId,
          amount: 100,
          occurred_at: "2026-08-20T12:00:00Z",
          type: "ENTRADA",
          category: "MENSALIDADE",
        }],
      ],
    ]),
    refundLedgerByPaymentId: new Map([
      [
        localId,
        [{
          id: "00000000-0000-4000-8000-000000000032",
          refund_student_payment_id: localId,
          provider_event_id: "evt_refund_partial",
          amount: 25,
          occurred_at: "2026-08-22T15:30:00Z",
          type: "SAIDA",
          category: "ESTORNO_MENSALIDADE",
        }],
      ],
    ]),
  });
  if (issues.some((issue) => issue.source === "LEDGER")) {
    throw new Error(
      `valid gross/refund ledger was rejected: ${
        issues.filter((issue) => issue.source === "LEDGER").map((issue) =>
          issue.kind
        ).join(",")
      }`,
    );
  }
});

Deno.test("gross receipt without partial refund output is detected", () => {
  const localId = "00000000-0000-4000-8000-000000000004";
  const issues = buildReconciliationIssues({
    ...empty,
    providerPayments: [{
      id: "pay_partial_missing_output",
      customer: "cus_4",
      status: "RECEIVED",
      value: 100,
      refundedValue: 25,
      creditDate: "2026-08-20",
    }],
    localPayments: [{
      id: localId,
      tenant_id: "school",
      student_id: "student",
      asaas_payment_id: "pay_partial_missing_output",
      value: 100,
      status: "RECEIVED",
      provider_status: "RECEIVED",
      credited_at: "2026-08-20T12:00:00Z",
      refunded_amount: 25,
      ledger_entry_created: true,
    }],
    customerByStudentId: new Map([["student", "cus_4"]]),
    grossLedgerByPaymentId: new Map([
      [
        localId,
        [{
          id: "00000000-0000-4000-8000-000000000041",
          student_payment_id: localId,
          amount: 100,
          occurred_at: "2026-08-20T12:00:00Z",
          type: "ENTRADA",
          category: "MENSALIDADE",
        }],
      ],
    ]),
  });
  if (!issues.some((issue) => issue.kind === "LEDGER_REFUND_TOTAL_MISMATCH")) {
    throw new Error("missing refund output was hidden by the gross receipt");
  }
  if (issues.some((issue) => issue.kind === "LEDGER_GROSS_AMOUNT_MISMATCH")) {
    throw new Error("gross receipt was incorrectly compared with net cash");
  }
});

Deno.test("full refund preserves gross receipt and requires full output", () => {
  const localId = "00000000-0000-4000-8000-000000000005";
  const baseInput = {
    ...empty,
    providerPayments: [{
      id: "pay_full_refund",
      customer: "cus_5",
      status: "REFUNDED",
      value: 100,
      refundedValue: 100,
      creditDate: "2026-08-20",
    }],
    localPayments: [{
      id: localId,
      tenant_id: "school",
      student_id: "student",
      asaas_payment_id: "pay_full_refund",
      value: 100,
      status: "REFUNDED",
      provider_status: "REFUNDED",
      credited_at: "2026-08-20T12:00:00Z",
      refunded_amount: 100,
      last_provider_event_id: "evt_refund_full",
      last_provider_event_at: "2026-08-23T10:00:00Z",
      ledger_entry_created: true,
    }],
    customerByStudentId: new Map([["student", "cus_5"]]),
    grossLedgerByPaymentId: new Map([
      [
        localId,
        [{
          id: "00000000-0000-4000-8000-000000000051",
          student_payment_id: localId,
          amount: 100,
          occurred_at: "2026-08-20T12:00:00Z",
          type: "ENTRADA",
          category: "MENSALIDADE",
        }],
      ],
    ]),
  };

  const missingOutputIssues = buildReconciliationIssues(baseInput);
  if (
    !missingOutputIssues.some((issue) =>
      issue.kind === "LEDGER_REFUND_TOTAL_MISMATCH"
    )
  ) {
    throw new Error("full refund without output was not detected");
  }
  if (
    missingOutputIssues.some((issue) =>
      issue.kind === "UNEXPECTED_LEDGER_GROSS_ENTRY"
    )
  ) {
    throw new Error("full refund incorrectly removed the gross receipt");
  }

  const completeIssues = buildReconciliationIssues({
    ...baseInput,
    refundLedgerByPaymentId: new Map([
      [
        localId,
        [{
          id: "00000000-0000-4000-8000-000000000052",
          refund_student_payment_id: localId,
          provider_event_id: "evt_refund_full",
          amount: 100,
          occurred_at: "2026-08-23T10:00:00Z",
          type: "SAIDA",
          category: "ESTORNO_MENSALIDADE",
        }],
      ],
    ]),
  });
  if (completeIssues.some((issue) => issue.source === "LEDGER")) {
    throw new Error("complete full-refund ledger was rejected");
  }
});

Deno.test("refund before provider credit has no cash movement", () => {
  const localId = "00000000-0000-4000-8000-000000000006";
  const issues = buildReconciliationIssues({
    ...empty,
    providerPayments: [{
      id: "pay_refunded_before_credit",
      customer: "cus_6",
      status: "REFUNDED",
      value: 100,
      refundedValue: 100,
    }],
    localPayments: [{
      id: localId,
      tenant_id: "school",
      student_id: "student",
      asaas_payment_id: "pay_refunded_before_credit",
      value: 100,
      status: "REFUNDED",
      provider_status: "REFUNDED",
      credited_at: null,
      refunded_amount: 100,
      ledger_entry_created: false,
    }],
    customerByStudentId: new Map([["student", "cus_6"]]),
  });
  if (issues.some((issue) => issue.source === "LEDGER")) {
    throw new Error("pre-credit refund invented a cash movement");
  }
});

Deno.test(
  "statement partial refund events match distinct durable refund outputs",
  () => {
    const localId = "00000000-0000-4000-8000-000000000007";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [{
        id: "pay_statement_partial",
        customer: "cus_7",
        status: "RECEIVED",
        value: 100,
        refundedValue: 30,
        creditDate: "2026-08-20",
        installment: "ins_7",
      }],
      localPayments: [{
        id: localId,
        tenant_id: "school",
        student_id: "student",
        asaas_payment_id: "pay_statement_partial",
        value: 100,
        status: "RECEIVED",
        provider_status: "RECEIVED",
        credited_at: "2026-08-20T12:00:00Z",
        refunded_amount: 30,
        last_provider_event_id: "evt_refund_20",
        last_provider_event_at: "2026-08-24T15:00:00Z",
        ledger_entry_created: true,
      }],
      customerByStudentId: new Map([["student", "cus_7"]]),
      grossLedgerByPaymentId: new Map([
        [
          localId,
          [{
            id: "00000000-0000-4000-8000-000000000071",
            student_payment_id: localId,
            amount: 100,
            occurred_at: "2026-08-20T12:00:00Z",
            type: "ENTRADA",
            category: "MENSALIDADE",
          }],
        ],
      ]),
      refundLedgerByPaymentId: new Map([
        [
          localId,
          [
            {
              id: "00000000-0000-4000-8000-000000000072",
              refund_student_payment_id: localId,
              provider_event_id: "evt_refund_10",
              amount: 10,
              occurred_at: "2026-08-23T10:00:00Z",
              type: "SAIDA",
              category: "ESTORNO_MENSALIDADE",
            },
            {
              id: "00000000-0000-4000-8000-000000000073",
              refund_student_payment_id: localId,
              provider_event_id: "evt_refund_20",
              amount: 20,
              occurred_at: "2026-08-24T15:00:00Z",
              type: "SAIDA",
              category: "ESTORNO_MENSALIDADE",
            },
          ],
        ],
      ]),
      statement: [
        {
          id: "st_receipt_7",
          type: "PAYMENT_RECEIVED",
          paymentId: "pay_statement_partial",
          value: 100,
          date: "2026-08-20",
        },
        {
          id: "st_refund_10",
          type: "PAYMENT_REVERSAL",
          paymentId: "pay_statement_partial",
          value: -10,
          date: "2026-08-23",
        },
        {
          id: "st_refund_20",
          type: "PAYMENT_REVERSAL",
          payment: { id: "pay_statement_partial" },
          value: -20,
          date: "2026-08-24",
        },
      ],
    });
    const statementIssues = issues.filter((issue) =>
      issue.source === "STATEMENT"
    );
    if (statementIssues.length > 0) {
      throw new Error(
        `valid statement refund events were rejected: ${
          statementIssues.map((issue) => issue.kind).join(",")
        }`,
      );
    }
  },
);

Deno.test(
  "statement refund exposes missing output with installment and event evidence",
  () => {
    const localId = "00000000-0000-4000-8000-000000000008";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [{
        id: "pay_statement_missing_output",
        customer: "cus_8",
        status: "RECEIVED",
        value: 90,
        refundedValue: 15,
        creditDate: "2026-08-20",
        installment: "ins_8",
      }],
      localPayments: [{
        id: localId,
        tenant_id: "school",
        student_id: "student",
        asaas_payment_id: "pay_statement_missing_output",
        value: 90,
        status: "RECEIVED",
        provider_status: "RECEIVED",
        credited_at: "2026-08-20T12:00:00Z",
        refunded_amount: 15,
        ledger_entry_created: true,
      }],
      customerByStudentId: new Map([["student", "cus_8"]]),
      grossLedgerByPaymentId: new Map([
        [
          localId,
          [{
            id: "00000000-0000-4000-8000-000000000081",
            student_payment_id: localId,
            amount: 90,
            occurred_at: "2026-08-20T12:00:00Z",
            type: "ENTRADA",
            category: "MENSALIDADE",
          }],
        ],
      ]),
      statement: [{
        id: "st_refund_missing_output",
        type: "PAYMENT_REVERSAL",
        paymentId: "pay_statement_missing_output",
        value: -15,
        date: "2026-08-25",
      }],
    });
    const missing = issues.find((issue) =>
      issue.kind === "STATEMENT_REFUND_MISSING_LOCAL_LEDGER"
    );
    if (!missing) throw new Error("provider refund output drift was hidden");
    if (
      missing.details.providerInstallmentId !== "ins_8" ||
      missing.details.statementId !== "st_refund_missing_output"
    ) {
      throw new Error("refund issue lost installment/event evidence");
    }
    if (
      !issues.some((issue) => issue.kind === "STATEMENT_REFUND_TOTAL_MISMATCH")
    ) {
      throw new Error("provider/local refund total drift was hidden");
    }
  },
);

Deno.test(
  "duplicate provider transfer references remain visible and critical",
  () => {
    const reference = "wisewolf-teacher-closing:closing_duplicate";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [],
      localPayments: [],
      localTransfers: [{
        id: "attempt_duplicate",
        closing_id: "closing_duplicate",
        tenant_id: "school",
        external_reference: reference,
        provider_transfer_id: "tr_duplicate_1",
        provider_status: "DONE",
        status: "COMPLETED",
        expected_amount: 250,
      }],
      providerTransfers: [
        {
          id: "tr_duplicate_1",
          externalReference: reference,
          status: "DONE",
          value: 250,
        },
        {
          id: "tr_duplicate_2",
          externalReference: reference,
          status: "DONE",
          value: 250,
        },
      ],
    });
    const duplicate = issues.find((issue) =>
      issue.kind === "PROVIDER_TRANSFER_DUPLICATE_EXTERNAL_REFERENCE"
    );
    if (!duplicate || duplicate.severity !== "CRITICAL") {
      throw new Error("duplicate externalReference was collapsed or softened");
    }
    const providerTransfers = duplicate.details.providerTransfers;
    if (!Array.isArray(providerTransfers) || providerTransfers.length !== 2) {
      throw new Error("duplicate issue did not preserve every provider row");
    }
    const ids = new Set(
      providerTransfers.map((transfer) =>
        typeof transfer === "object" && transfer !== null && "id" in transfer
          ? transfer.id
          : null
      ),
    );
    if (!ids.has("tr_duplicate_1") || !ids.has("tr_duplicate_2")) {
      throw new Error("duplicate issue hid a provider transfer id");
    }
  },
);

Deno.test(
  "provider transfer id cannot override a different closing reference",
  () => {
    const referenceA = "wisewolf-teacher-closing:closing_a";
    const referenceB = "wisewolf-teacher-closing:closing_b";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [],
      localPayments: [],
      localTransfers: [
        {
          id: "attempt_a",
          closing_id: "closing_a",
          tenant_id: "school",
          external_reference: referenceA,
          provider_transfer_id: "tr_b",
          provider_status: "DONE",
          status: "COMPLETED",
          expected_amount: 250,
        },
        {
          id: "attempt_b",
          closing_id: "closing_b",
          tenant_id: "school",
          external_reference: referenceB,
          provider_transfer_id: "tr_a",
          provider_status: "DONE",
          status: "COMPLETED",
          expected_amount: 250,
        },
      ],
      providerTransfers: [
        {
          id: "tr_a",
          externalReference: referenceA,
          status: "DONE",
          value: 250,
        },
        {
          id: "tr_b",
          externalReference: referenceB,
          status: "DONE",
          value: 250,
        },
      ],
    });
    const mismatches = issues.filter((issue) =>
      issue.kind === "TRANSFER_REFERENCE_MISMATCH" &&
      issue.severity === "CRITICAL"
    );
    if (mismatches.length !== 2) {
      throw new Error("swapped transfer ownership was silently accepted");
    }
  },
);

Deno.test(
  "Hub, SaaS and top-up payments are routed to their own local ledgers",
  () => {
    const hubId = "10000000-0000-4000-8000-000000000001";
    const saasId = "20000000-0000-4000-8000-000000000002";
    const topupId = "30000000-0000-4000-8000-000000000003";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [
        {
          id: "pay_hub",
          externalReference: `hub:${hubId}`,
          status: "RECEIVED",
          value: 49,
        },
        {
          id: "pay_saas",
          externalReference: `saas:${saasId}`,
          status: "RECEIVED",
          value: 299,
        },
        {
          id: "pay_topup",
          externalReference: `wolfie-topup-order:${topupId}`,
          status: "RECEIVED",
          value: 10,
        },
      ],
      localPayments: [],
      productPaymentByProviderId: new Map([
        [
          "pay_hub",
          [{
            family: "HUB",
            localEntityId: hubId,
            externalReference: `hub:${hubId}`,
          }],
        ],
        [
          "pay_saas",
          [{
            family: "SAAS",
            localEntityId: saasId,
            externalReference: `saas:${saasId}`,
          }],
        ],
        [
          "pay_topup",
          [{
            family: "WOLFIE_TOPUP",
            localEntityId: topupId,
            externalReference: `wolfie-topup-order:${topupId}`,
          }],
        ],
      ]),
    });
    if (
      issues.some((issue) =>
        issue.kind === "PROVIDER_PAYMENT_MISSING_LOCAL" ||
        issue.kind === "PROVIDER_CUSTOMER_UNRESOLVED" ||
        issue.kind.startsWith("PRODUCT_PAYMENT_")
      )
    ) {
      throw new Error(
        `valid product payments were misrouted: ${
          issues.map((issue) => issue.kind).join(",")
        }`,
      );
    }
  },
);

Deno.test(
  "recognized product reference reports its own missing ledger without student noise",
  () => {
    const checkoutId = "40000000-0000-4000-8000-000000000004";
    const reference = `hub:${checkoutId}`;
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [{
        id: "pay_hub_unlinked",
        externalReference: reference,
        customer: "cus_hub",
        status: "RECEIVED",
        value: 49,
      }],
      localPayments: [],
      productReferenceByExternalReference: new Map([
        [reference, [{ family: "HUB", localEntityId: checkoutId }]],
      ]),
    });
    if (
      !issues.some((issue) => issue.kind === "PRODUCT_PAYMENT_MISSING_LOCAL")
    ) {
      throw new Error(
        "missing Hub payment was not routed to Hub reconciliation",
      );
    }
    if (
      issues.some((issue) =>
        issue.kind === "PROVIDER_PAYMENT_MISSING_LOCAL" ||
        issue.kind === "PROVIDER_CUSTOMER_UNRESOLVED"
      )
    ) {
      throw new Error("Hub payment produced false student/customer alarms");
    }
  },
);

Deno.test(
  "unknown provider reference remains visible as an unresolved payment",
  () => {
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [{
        id: "pay_unknown_product",
        externalReference: "unknown:opaque",
        customer: "cus_unknown",
        status: "RECEIVED",
        value: 12,
      }],
      localPayments: [],
    });
    if (
      !issues.some((issue) =>
        issue.kind === "PROVIDER_PAYMENT_MISSING_LOCAL"
      ) ||
      !issues.some((issue) => issue.kind === "PROVIDER_CUSTOMER_UNRESOLVED")
    ) {
      throw new Error("unknown provider payment was hidden by product routing");
    }
  },
);

Deno.test(
  "cash receipt undo compares the gross reversal without false provider drift",
  () => {
    const localId = "50000000-0000-4000-8000-000000000005";
    const issues = buildReconciliationIssues({
      ...empty,
      providerPayments: [{
        id: "pay_cash_undone",
        customer: "cus_cash",
        status: "PENDING",
        value: 75,
        refundedValue: 0,
      }],
      localPayments: [{
        id: localId,
        tenant_id: "school",
        student_id: "student_cash",
        asaas_payment_id: "pay_cash_undone",
        value: 75,
        status: "REFUNDED",
        provider_status: "PENDING",
        paid_at: "2026-08-20T12:00:00Z",
        refunded_amount: 75,
        last_provider_event_id: "evt_cash_undone",
        last_provider_event_at: "2026-08-22T10:00:00Z",
        ledger_entry_created: true,
        raw_payload: { event: "PAYMENT_RECEIVED_IN_CASH_UNDONE" },
      }],
      customerByStudentId: new Map([["student_cash", "cus_cash"]]),
      grossLedgerByPaymentId: new Map([
        [
          localId,
          [{
            student_payment_id: localId,
            amount: 75,
            occurred_at: "2026-08-20T12:00:00Z",
            type: "ENTRADA",
            category: "MENSALIDADE",
          }],
        ],
      ]),
      refundLedgerByPaymentId: new Map([
        [
          localId,
          [{
            refund_student_payment_id: localId,
            provider_event_id: "evt_cash_undone",
            amount: 75,
            occurred_at: "2026-08-22T10:00:00Z",
            type: "SAIDA",
            category: "ESTORNO_MENSALIDADE",
          }],
        ],
      ]),
    });
    const forbidden = new Set([
      "REFUNDED_AMOUNT_MISMATCH",
      "REFUNDED_RECEIPT_CONTEXT_MISSING",
      "LEDGER_GROSS_ENTRY_MISSING",
      "LEDGER_REFUND_TOTAL_MISMATCH",
    ]);
    const invalid = issues.filter((issue) => forbidden.has(issue.kind));
    if (invalid.length > 0) {
      throw new Error(
        `valid cash undo was rejected: ${invalid.map((issue) => issue.kind)}`,
      );
    }
  },
);
