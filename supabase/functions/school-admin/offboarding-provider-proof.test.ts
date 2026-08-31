/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyExactDeletedOffboardingPaymentProof,
  isExactDeletedOffboardingPaymentProof,
  isExactPreservedOffboardingPaymentSnapshot,
} from "./index.ts";

type ProofInput = Parameters<
  typeof isExactDeletedOffboardingPaymentProof
>[0];

function exactDeletedProof(): ProofInput {
  return {
    targetStatus: "offboarded",
    billingCancelFromDate: "2026-08-01",
    frozen: {
      id: "2d2e4ea9-4ed5-4382-8300-2e6e45efe9f9",
      asaasPaymentId: "pay_r9msrpmf1ddh6fh1",
      dueDate: "2026-08-15",
      value: 279,
      status: "PENDING",
    },
    local: {
      id: "2d2e4ea9-4ed5-4382-8300-2e6e45efe9f9",
      primaryProviderId: "pay_r9msrpmf1ddh6fh1",
      legacyProviderId: "pay_r9msrpmf1ddh6fh1",
      dueDate: "2026-08-15",
      value: 279,
      status: "PENDING",
      providerStatus: "PENDING",
      paidAt: null,
      creditedAt: null,
      ledgerEntryCreated: false,
      refundedAmount: 0,
    },
    provider: {
      id: "pay_r9msrpmf1ddh6fh1",
      customer: "cus_rafael",
      subscription: "sub_rafael",
      dueDate: "2026-08-15",
      value: 279,
      status: "PENDING",
      deleted: true,
      paymentDate: null,
      creditDate: null,
    },
    customerId: "cus_rafael",
    subscriptionId: "sub_rafael",
  };
}

Deno.test(
  "offboarding admits a frozen local PENDING charge only with exact deleted provider proof",
  () => {
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof(exactDeletedProof()),
      "OPEN_DELETABLE",
    );
    assertEquals(
      isExactDeletedOffboardingPaymentProof(exactDeletedProof()),
      true,
    );
  },
);

Deno.test(
  "suspension admits the same exact proof for a frozen future charge",
  () => {
    const suspendedFutureCharge: ProofInput = {
      ...exactDeletedProof(),
      targetStatus: "suspended",
      billingCancelFromDate: "2026-09-01",
      frozen: {
        ...exactDeletedProof().frozen,
        dueDate: "2026-09-20",
      },
      local: {
        ...exactDeletedProof().local,
        dueDate: "2026-09-20",
      },
      provider: {
        ...exactDeletedProof().provider,
        dueDate: "2026-09-20",
      },
    };
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof(suspendedFutureCharge),
      "OPEN_DELETABLE",
    );
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof({
        ...suspendedFutureCharge,
        frozen: {
          ...suspendedFutureCharge.frozen,
          dueDate: "2026-08-20",
        },
        local: {
          ...suspendedFutureCharge.local,
          dueDate: "2026-08-20",
        },
        provider: {
          ...suspendedFutureCharge.provider,
          dueDate: "2026-08-20",
        },
      }),
      null,
      "the current competence remains outside the suspension cancellation boundary",
    );
  },
);

Deno.test(
  "offboarding admits an exact frozen/local OVERDUE deletion proof but never CONFIRMED",
  () => {
    const overdue: ProofInput = {
      ...exactDeletedProof(),
      frozen: { ...exactDeletedProof().frozen, status: "OVERDUE" },
      local: {
        ...exactDeletedProof().local,
        status: "OVERDUE",
        providerStatus: "OVERDUE",
      },
      provider: { ...exactDeletedProof().provider, status: "OVERDUE" },
    };
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof(overdue),
      "OPEN_DELETABLE",
    );
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof({
        ...overdue,
        local: {
          ...overdue.local,
          status: "CONFIRMED",
          providerStatus: "CONFIRMED",
        },
        provider: { ...overdue.provider, status: "CONFIRMED" },
      }),
      null,
    );
  },
);

Deno.test(
  "offboarding retry recognizes an exactly reconciled PAYMENT_DELETED webhook",
  () => {
    const reconciled: ProofInput = {
      ...exactDeletedProof(),
      local: {
        ...exactDeletedProof().local,
        status: "CANCELLED",
        providerStatus: "DELETED",
      },
    };
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof(reconciled),
      "ALREADY_RECONCILED",
    );
    assertEquals(isExactDeletedOffboardingPaymentProof(reconciled), true);

    const reconciledOverdue: ProofInput = {
      ...reconciled,
      frozen: { ...reconciled.frozen, status: "OVERDUE" },
      provider: { ...reconciled.provider, status: "OVERDUE" },
    };
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof(reconciledOverdue),
      "ALREADY_RECONCILED",
    );

    assertEquals(
      classifyExactDeletedOffboardingPaymentProof({
        ...reconciled,
        local: { ...reconciled.local, providerStatus: "CANCELLED" },
      }),
      null,
      "the webhook reconciliation marker must be provider_status=DELETED",
    );
    assertEquals(
      classifyExactDeletedOffboardingPaymentProof({
        ...reconciled,
        local: { ...reconciled.local, paidAt: "2026-08-15" },
      }),
      null,
      "a settled local charge can never converge through deletion proof",
    );
  },
);

Deno.test(
  "retained current invoice must remain identical to the frozen claim snapshot",
  () => {
    const frozen: Parameters<
      typeof isExactPreservedOffboardingPaymentSnapshot
    >[0] = {
      id: "2d2e4ea9-4ed5-4382-8300-2e6e45efe9f9",
      asaasPaymentId: "pay_current_month",
      dueDate: "2026-08-15",
      value: 279,
      status: "PENDING",
      providerStatus: "PENDING",
    };
    const local: Parameters<
      typeof isExactPreservedOffboardingPaymentSnapshot
    >[1] = {
      id: frozen.id,
      primaryProviderId: frozen.asaasPaymentId,
      legacyProviderId: frozen.asaasPaymentId,
      dueDate: frozen.dueDate,
      value: frozen.value,
      status: frozen.status,
      providerStatus: frozen.providerStatus,
    };
    assertEquals(
      isExactPreservedOffboardingPaymentSnapshot(frozen, local),
      true,
    );
    for (
      const changed of [
        { ...local, id: "3d2e4ea9-4ed5-4382-8300-2e6e45efe9f9" },
        { ...local, primaryProviderId: "pay_other" },
        { ...local, dueDate: "2026-08-16" },
        { ...local, value: 278.99 },
        { ...local, status: "OVERDUE" },
        { ...local, providerStatus: "OVERDUE" },
      ]
    ) {
      assertEquals(
        isExactPreservedOffboardingPaymentSnapshot(frozen, changed),
        false,
      );
    }
  },
);

Deno.test(
  "offboarding deleted-payment proof rejects every missing or divergent identity fact",
  () => {
    const cases: Array<{ name: string; input: ProofInput }> = [
      {
        name: "not a supported inactive lifecycle target",
        input: { ...exactDeletedProof(), targetStatus: "active" },
      },
      {
        name: "outside the frozen cancellation period",
        input: {
          ...exactDeletedProof(),
          frozen: { ...exactDeletedProof().frozen, dueDate: "2026-07-15" },
          local: { ...exactDeletedProof().local, dueDate: "2026-07-15" },
          provider: { ...exactDeletedProof().provider, dueDate: "2026-07-15" },
        },
      },
      {
        name: "local accounting row is not PENDING",
        input: {
          ...exactDeletedProof(),
          local: { ...exactDeletedProof().local, status: "OVERDUE" },
        },
      },
      {
        name: "provider object is still live",
        input: {
          ...exactDeletedProof(),
          provider: { ...exactDeletedProof().provider, deleted: false },
        },
      },
      {
        name: "customer differs",
        input: {
          ...exactDeletedProof(),
          provider: { ...exactDeletedProof().provider, customer: "cus_other" },
        },
      },
      {
        name: "subscription differs",
        input: {
          ...exactDeletedProof(),
          provider: {
            ...exactDeletedProof().provider,
            subscription: "sub_other",
          },
        },
      },
      {
        name: "payment id differs",
        input: {
          ...exactDeletedProof(),
          provider: { ...exactDeletedProof().provider, id: "pay_other" },
        },
      },
      {
        name: "amount differs",
        input: {
          ...exactDeletedProof(),
          provider: { ...exactDeletedProof().provider, value: 278.99 },
        },
      },
      {
        name: "due date differs",
        input: {
          ...exactDeletedProof(),
          provider: { ...exactDeletedProof().provider, dueDate: "2026-08-16" },
        },
      },
      {
        name: "local settlement evidence exists",
        input: {
          ...exactDeletedProof(),
          local: { ...exactDeletedProof().local, paidAt: "2026-08-14" },
        },
      },
      {
        name: "local ledger was posted",
        input: {
          ...exactDeletedProof(),
          local: { ...exactDeletedProof().local, ledgerEntryCreated: true },
        },
      },
      {
        name: "provider payment was received",
        input: {
          ...exactDeletedProof(),
          local: {
            ...exactDeletedProof().local,
            providerStatus: "RECEIVED",
          },
          provider: {
            ...exactDeletedProof().provider,
            status: "RECEIVED",
            paymentDate: "2026-08-14",
          },
        },
      },
    ];

    for (const testCase of cases) {
      assertEquals(
        isExactDeletedOffboardingPaymentProof(testCase.input),
        false,
        testCase.name,
      );
    }
  },
);
