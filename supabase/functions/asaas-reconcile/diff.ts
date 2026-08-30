import { providerPaymentStatusRejectsCreditDate } from "../create-asaas-subscription/provider-identity.ts";

export type Severity = "INFO" | "WARNING" | "HIGH" | "CRITICAL";

export type ReconciliationIssue = {
  tenant_id: string | null;
  source: "PAYMENT" | "STATEMENT" | "TRANSFER" | "LEDGER";
  kind: string;
  severity: Severity;
  provider_entity_id: string | null;
  local_entity_id: string | null;
  fingerprint: string;
  details: Record<string, unknown>;
};

export type ProviderPayment = {
  id: string;
  customer?: string | null;
  subscription?: string | null;
  externalReference?: string | null;
  status?: string | null;
  value?: number | null;
  billingType?: string | null;
  dueDate?: string | null;
  paymentDate?: string | null;
  creditDate?: string | null;
  refundedValue?: number | null;
  installment?: string | null;
  deleted?: boolean | null;
};

export type LocalPayment = {
  id: string;
  tenant_id?: string | null;
  student_id?: string | null;
  asaas_payment_id?: string | null;
  value?: number | null;
  status?: string | null;
  provider_status?: string | null;
  created_at?: string | null;
  due_date?: string | null;
  payment_date?: string | null;
  credited_at?: string | null;
  paid_at?: string | null;
  refunded_amount?: number | null;
  last_provider_event_id?: string | null;
  last_provider_event_at?: string | null;
  ledger_entry_created?: boolean | null;
  billing_type?: string | null;
  raw_payload?: unknown;
};

export type ProductPaymentFamily = "HUB" | "SAAS" | "WOLFIE_TOPUP";

export type LocalProductPayment = {
  family: ProductPaymentFamily;
  localEntityId: string;
  externalReference?: string | null;
};

export type LocalProductReference = {
  family: ProductPaymentFamily;
  localEntityId: string;
};

export type LocalLedgerEntry = {
  id?: string | null;
  student_payment_id?: string | null;
  refund_student_payment_id?: string | null;
  provider_event_id?: string | null;
  amount?: number | null;
  occurred_at?: string | null;
  type?: string | null;
  category?: string | null;
};

export type ProviderStatementEntry = {
  id?: string | null;
  type?: string | null;
  value?: number | null;
  date?: string | null;
  payment?: string | { id?: string | null } | null;
  paymentId?: string | null;
  splitId?: string | null;
};

export type LocalTransferAttempt = {
  id: string;
  closing_id: string;
  tenant_id: string;
  external_reference: string;
  provider_transfer_id?: string | null;
  provider_status?: string | null;
  status: string;
  expected_amount: number;
};

export type ProviderTransfer = {
  id?: string | null;
  externalReference?: string | null;
  status?: string | null;
  value?: number | null;
};

export type TransferAuditPlan =
  | "LIST_PROVIDER_TRANSFERS"
  | "SKIP_DISABLED_WITHOUT_LOCAL_ATTEMPTS";

export function planTransferAudit(
  teacherTransferEnabled: boolean,
  localTransferCount: number,
): TransferAuditPlan {
  if (!Number.isSafeInteger(localTransferCount) || localTransferCount < 0) {
    throw new Error("local_transfer_count_invalid");
  }
  if (teacherTransferEnabled) return "LIST_PROVIDER_TRANSFERS";
  if (localTransferCount > 0) {
    throw new Error("local_transfers_present_while_teacher_transfers_disabled");
  }
  return "SKIP_DISABLED_WITHOUT_LOCAL_ATTEMPTS";
}

export async function runTransferAudit(
  teacherTransferEnabled: boolean,
  localTransferCount: number,
  listProviderTransfers: () => Promise<ProviderTransfer[]>,
): Promise<{
  plan: TransferAuditPlan;
  providerTransfers: ProviderTransfer[];
}> {
  const plan = planTransferAudit(
    teacherTransferEnabled,
    localTransferCount,
  );
  if (plan === "SKIP_DISABLED_WITHOUT_LOCAL_ATTEMPTS") {
    return { plan, providerTransfers: [] };
  }
  return { plan, providerTransfers: await listProviderTransfers() };
}

function cents(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const match = value.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || null;
}

function productFamilyFromReference(
  value: unknown,
): ProductPaymentFamily | null {
  if (typeof value !== "string") return null;
  const reference = value.trim();
  if (/^hub:[0-9a-f-]{36}$/i.test(reference)) return "HUB";
  if (/^saas:[0-9a-f-]{36}$/i.test(reference)) return "SAAS";
  if (/^(wolfie-topup-order|topup):[0-9a-f-]{36}$/i.test(reference)) {
    return "WOLFIE_TOPUP";
  }
  return null;
}

function lastProviderEventName(payment: LocalPayment): string | null {
  if (
    !payment.raw_payload || typeof payment.raw_payload !== "object" ||
    Array.isArray(payment.raw_payload)
  ) return null;
  const event = (payment.raw_payload as Record<string, unknown>).event;
  return typeof event === "string" ? event.trim().toUpperCase() : null;
}

export function statementPaymentId(
  entry: ProviderStatementEntry,
): string | null {
  if (typeof entry.paymentId === "string" && entry.paymentId) {
    return entry.paymentId;
  }
  if (typeof entry.payment === "string" && entry.payment) return entry.payment;
  if (entry.payment && typeof entry.payment === "object") {
    return typeof entry.payment.id === "string" ? entry.payment.id : null;
  }
  return null;
}

function addIssue(
  map: Map<string, ReconciliationIssue>,
  issue: ReconciliationIssue,
): void {
  map.set(issue.fingerprint, issue);
}

export function buildReconciliationIssues(input: {
  windowStart: string;
  windowEnd: string;
  referenceTenantId?: string | null;
  providerPayments: ProviderPayment[];
  localPayments: LocalPayment[];
  statement: ProviderStatementEntry[];
  grossLedgerByPaymentId: Map<string, LocalLedgerEntry[]>;
  refundLedgerByPaymentId: Map<string, LocalLedgerEntry[]>;
  customerByStudentId: Map<string, string>;
  studentByCustomerId: Map<
    string,
    Array<{ id: string; tenantId: string | null }>
  >;
  productPaymentByProviderId: Map<string, LocalProductPayment[]>;
  productReferenceByExternalReference: Map<string, LocalProductReference[]>;
  providerTransfers: ProviderTransfer[];
  localTransfers: LocalTransferAttempt[];
}): ReconciliationIssue[] {
  const issues = new Map<string, ReconciliationIssue>();
  const providerCandidatesById = new Map<string, ProviderPayment[]>();
  for (const payment of input.providerPayments) {
    const candidates = providerCandidatesById.get(payment.id) || [];
    candidates.push(payment);
    providerCandidatesById.set(payment.id, candidates);
  }
  const providerById = new Map<string, ProviderPayment>();
  for (const [providerId, candidates] of providerCandidatesById) {
    if (candidates.length === 1) {
      providerById.set(providerId, candidates[0]);
      continue;
    }
    addIssue(issues, {
      tenant_id: null,
      source: "PAYMENT",
      kind: "PROVIDER_PAYMENT_ID_COLLISION",
      severity: "CRITICAL",
      provider_entity_id: providerId,
      local_entity_id: null,
      fingerprint: `provider-payment-id-collision:${providerId}`,
      details: { count: candidates.length, candidates },
    });
  }
  const localIsInWindow = (payment: LocalPayment): boolean => {
    const dates = [
      payment.created_at,
      payment.due_date,
      payment.payment_date,
      payment.credited_at,
      payment.last_provider_event_at,
    ]
      .map(dateOnly)
      .filter((value): value is string => Boolean(value));
    return dates.some(
      (value) => value >= input.windowStart && value <= input.windowEnd,
    );
  };
  const localCandidatesByProviderId = new Map<string, LocalPayment[]>();
  for (const payment of input.localPayments) {
    if (!payment.asaas_payment_id) continue;
    const candidates = localCandidatesByProviderId.get(
      payment.asaas_payment_id,
    ) || [];
    candidates.push(payment);
    localCandidatesByProviderId.set(payment.asaas_payment_id, candidates);
  }
  const localByProviderId = new Map<string, LocalPayment>();
  for (const [providerId, candidates] of localCandidatesByProviderId) {
    if (candidates.length === 1) {
      localByProviderId.set(providerId, candidates[0]);
      continue;
    }
    addIssue(issues, {
      tenant_id: input.referenceTenantId || null,
      source: "PAYMENT",
      kind: "LOCAL_PAYMENT_PROVIDER_ID_COLLISION",
      severity: "CRITICAL",
      provider_entity_id: providerId,
      local_entity_id: null,
      fingerprint: `local-payment-provider-id-collision:${providerId}`,
      details: {
        count: candidates.length,
        localPaymentIds: candidates.map((candidate) => candidate.id),
        tenantIds: candidates.map((candidate) => candidate.tenant_id || null),
      },
    });
  }

  for (const [customerId, candidates] of input.studentByCustomerId) {
    if (candidates.length <= 1) continue;
    addIssue(issues, {
      tenant_id: input.referenceTenantId || null,
      source: "PAYMENT",
      kind: "LOCAL_CUSTOMER_IDENTITY_COLLISION",
      severity: "CRITICAL",
      provider_entity_id: customerId,
      local_entity_id: null,
      fingerprint: `local-customer-identity-collision:${customerId}`,
      details: { candidates },
    });
  }

  for (const [providerId, candidates] of input.productPaymentByProviderId) {
    if (candidates.length <= 1) continue;
    addIssue(issues, {
      tenant_id: null,
      source: "PAYMENT",
      kind: "PRODUCT_PAYMENT_PROVIDER_ID_COLLISION",
      severity: "CRITICAL",
      provider_entity_id: providerId,
      local_entity_id: null,
      fingerprint: `product-payment-provider-id-collision:${providerId}`,
      details: { candidates },
    });
  }

  for (
    const [externalReference, candidates] of input
      .productReferenceByExternalReference
  ) {
    if (candidates.length <= 1) continue;
    addIssue(issues, {
      tenant_id: null,
      source: "PAYMENT",
      kind: "PRODUCT_PAYMENT_REFERENCE_COLLISION",
      severity: "CRITICAL",
      provider_entity_id: null,
      local_entity_id: null,
      fingerprint: `product-payment-reference-collision:${externalReference}`,
      details: { externalReference, candidates },
    });
  }

  for (const [providerId, studentPayments] of localCandidatesByProviderId) {
    const productPayments = input.productPaymentByProviderId.get(providerId) ||
      [];
    if (productPayments.length === 0) continue;
    const tenantIds = [
      ...new Set(
        studentPayments.map((payment) => payment.tenant_id).filter(Boolean),
      ),
    ];
    addIssue(issues, {
      tenant_id: tenantIds.length === 1
        ? tenantIds[0] || null
        : input.referenceTenantId || null,
      source: "PAYMENT",
      kind: "STUDENT_AND_PRODUCT_PAYMENT_PROVIDER_ID_COLLISION",
      severity: "CRITICAL",
      provider_entity_id: providerId,
      local_entity_id: studentPayments.length === 1
        ? studentPayments[0].id
        : null,
      fingerprint:
        `student-product-payment-provider-id-collision:${providerId}`,
      details: {
        studentPaymentIds: studentPayments.map((payment) => payment.id),
        productPayments,
      },
    });
  }

  for (const provider of input.providerPayments) {
    const externalReference = provider.externalReference?.trim() || "";
    const knownProductPayments = input.productPaymentByProviderId.get(
      provider.id,
    ) || [];
    if (knownProductPayments.length > 1) continue;
    const knownProductPayment = knownProductPayments[0];
    if (knownProductPayment) {
      if (
        externalReference && knownProductPayment.externalReference &&
        externalReference !== knownProductPayment.externalReference
      ) {
        addIssue(issues, {
          tenant_id: null,
          source: "PAYMENT",
          kind: "PRODUCT_PAYMENT_REFERENCE_MISMATCH",
          severity: "CRITICAL",
          provider_entity_id: provider.id,
          local_entity_id: knownProductPayment.localEntityId,
          fingerprint: `product-payment-reference:${provider.id}`,
          details: {
            family: knownProductPayment.family,
            providerReference: externalReference,
            expectedReference: knownProductPayment.externalReference,
          },
        });
      }
      continue;
    }

    const providerProductFamily = productFamilyFromReference(
      externalReference,
    );
    if (providerProductFamily) {
      const localProducts = input.productReferenceByExternalReference.get(
        externalReference,
      ) || [];
      if (localProducts.length > 1) continue;
      const localProduct = localProducts[0];
      if (!localProduct || localProduct.family !== providerProductFamily) {
        addIssue(issues, {
          tenant_id: null,
          source: "PAYMENT",
          kind: "PRODUCT_PAYMENT_REFERENCE_MISSING_LOCAL",
          severity: "CRITICAL",
          provider_entity_id: provider.id,
          local_entity_id: null,
          fingerprint: `product-reference-missing:${provider.id}`,
          details: {
            family: providerProductFamily,
            externalReference,
            providerStatus: provider.status || null,
          },
        });
      } else {
        addIssue(issues, {
          tenant_id: null,
          source: "PAYMENT",
          kind: "PRODUCT_PAYMENT_MISSING_LOCAL",
          severity: provider.status === "RECEIVED" ? "HIGH" : "WARNING",
          provider_entity_id: provider.id,
          local_entity_id: localProduct.localEntityId,
          fingerprint: `product-payment-missing:${provider.id}`,
          details: {
            family: providerProductFamily,
            externalReference,
            providerStatus: provider.status || null,
            value: provider.value ?? null,
          },
        });
      }
      continue;
    }

    const local = localByProviderId.get(provider.id);
    if (!local) {
      const canonicalStudentCandidates = provider.customer
        ? input.studentByCustomerId.get(provider.customer) || []
        : [];
      const canonicalStudent = canonicalStudentCandidates.length === 1
        ? canonicalStudentCandidates[0]
        : null;
      addIssue(issues, {
        tenant_id: canonicalStudent?.tenantId || input.referenceTenantId ||
          null,
        source: "PAYMENT",
        kind: "PROVIDER_PAYMENT_MISSING_LOCAL",
        severity: provider.status === "RECEIVED" ? "HIGH" : "WARNING",
        provider_entity_id: provider.id,
        local_entity_id: null,
        fingerprint: `payment-missing-local:${provider.id}`,
        details: {
          providerStatus: provider.status || null,
          customerId: provider.customer || null,
          canonicalStudentId: canonicalStudent?.id || null,
          value: provider.value ?? null,
          dueDate: provider.dueDate || null,
        },
      });
      if (!canonicalStudent) {
        addIssue(issues, {
          tenant_id: input.referenceTenantId || null,
          source: "PAYMENT",
          kind: "PROVIDER_CUSTOMER_UNRESOLVED",
          severity: "CRITICAL",
          provider_entity_id: provider.id,
          local_entity_id: null,
          fingerprint: `provider-customer-unresolved:${provider.id}`,
          details: { customerId: provider.customer || null },
        });
      }
      continue;
    }

    const localAccountingStatusForBinding = String(local.status || "")
      .trim().toUpperCase();
    if (
      (!local.tenant_id || !local.student_id) &&
      !["CANCELLED", "NAO_RECEITA"].includes(
        localAccountingStatusForBinding,
      )
    ) {
      const unlinkedSettledPayment = Boolean(local.tenant_id) &&
        !local.student_id &&
        ["RECEIVED", "RECEIVED_IN_CASH"].includes(
          localAccountingStatusForBinding,
        );
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PAYMENT_TENANT_OR_STUDENT_UNRESOLVED",
        // Settled cash without a student is an intentional manual-review
        // queue: guessing ownership would be worse than leaving it unlinked.
        // Missing tenant or an open recurring debt remains critical.
        severity: unlinkedSettledPayment ? "HIGH" : "CRITICAL",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `payment-unresolved:${provider.id}`,
        details: {
          tenantId: local.tenant_id || null,
          studentId: local.student_id || null,
        },
      });
    }

    const expectedCustomer = local.student_id
      ? input.customerByStudentId.get(local.student_id)
      : null;
    const canonicalStudentCandidates = provider.customer
      ? input.studentByCustomerId.get(provider.customer) || []
      : [];
    const canonicalStudent = canonicalStudentCandidates.length === 1
      ? canonicalStudentCandidates[0]
      : null;
    if (!provider.customer) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PROVIDER_CUSTOMER_UNRESOLVED",
        severity: "CRITICAL",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `provider-customer-unresolved:${provider.id}`,
        details: { customerId: null },
      });
    }
    if (local.student_id && !expectedCustomer) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "LOCAL_STUDENT_CUSTOMER_UNRESOLVED",
        severity: "HIGH",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `local-customer-unresolved:${provider.id}`,
        details: { studentId: local.student_id },
      });
    }
    if (
      expectedCustomer &&
      provider.customer &&
      expectedCustomer !== provider.customer
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PAYMENT_CUSTOMER_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `payment-customer-mismatch:${provider.id}`,
        details: { expectedCustomer, providerCustomer: provider.customer },
      });
    }
    if (
      canonicalStudent?.tenantId &&
      local.tenant_id &&
      canonicalStudent.tenantId !== local.tenant_id
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id,
        source: "PAYMENT",
        kind: "PAYMENT_TENANT_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `payment-tenant-mismatch:${provider.id}`,
        details: {
          localTenantId: local.tenant_id,
          canonicalTenantId: canonicalStudent.tenantId,
        },
      });
    }

    const localProviderStatus = local.provider_status ||
      (local.status === "NAO_RECEITA" ? null : local.status);
    const localAccountingStatus = String(local.status || "").trim()
      .toUpperCase();
    if (
      provider.deleted === true &&
      ["PENDING", "OVERDUE", "CONFIRMED"].includes(localAccountingStatus)
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PROVIDER_PAYMENT_DELETED_LOCAL_OPEN",
        severity: "HIGH",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `provider-payment-deleted-local-open:${provider.id}`,
        details: {
          providerStatus: provider.status || null,
          localProviderStatus,
          localAccountingStatus: local.status || null,
          value: local.value ?? null,
          dueDate: local.due_date || null,
        },
      });
    }
    const providerDeletionConverged = provider.deleted === true &&
      localAccountingStatus === "CANCELLED" &&
      String(localProviderStatus || "").trim().toUpperCase() === "DELETED";
    if (
      !providerDeletionConverged && provider.status &&
      localProviderStatus !== provider.status
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PAYMENT_STATUS_MISMATCH",
        severity: provider.status === "RECEIVED" ? "HIGH" : "WARNING",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `payment-status:${provider.id}`,
        details: {
          providerStatus: provider.status,
          localProviderStatus,
          localAccountingStatus: local.status || null,
        },
      });
    }

    if (cents(provider.value) !== cents(local.value)) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PAYMENT_VALUE_MISMATCH",
        severity: "HIGH",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `payment-value:${provider.id}`,
        details: {
          providerValue: provider.value ?? null,
          localValue: local.value ?? null,
        },
      });
    }

    const providerDueDate = dateOnly(provider.dueDate);
    const localDueDate = dateOnly(local.due_date);
    if (providerDueDate !== localDueDate) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PAYMENT_DUE_DATE_MISMATCH",
        severity: "WARNING",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `payment-due-date:${provider.id}`,
        details: { providerDueDate, localDueDate },
      });
    }

    const providerPaymentDate = dateOnly(provider.paymentDate);
    const localPaymentDate = dateOnly(local.payment_date);
    if (providerPaymentDate !== localPaymentDate) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "PAYMENT_DATE_MISMATCH",
        severity: provider.status === "RECEIVED" ? "HIGH" : "WARNING",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `payment-date:${provider.id}`,
        details: { providerPaymentDate, localPaymentDate },
      });
    }

    const localCreditDate = dateOnly(local.credited_at);
    if (
      providerPaymentStatusRejectsCreditDate(provider.status) &&
      localCreditDate
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "LOCAL_CREDIT_DATE_WITHOUT_PROVIDER_CREDIT",
        severity: "HIGH",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `credit-date-without-provider-receipt:${provider.id}`,
        details: {
          providerStatus: provider.status || null,
          providerCreditDate: dateOnly(provider.creditDate),
          localCreditDate,
        },
      });
    }

    // CONFIRMED means authorized/confirmed, not cash available. Asaas may
    // expose a future creditDate for cards in this state; local credited_at
    // must remain null until RECEIVED.
    const providerHasHistoricCash = provider.status === "RECEIVED" ||
      (provider.status === "REFUNDED" && Boolean(
        localCreditDate ||
          (input.grossLedgerByPaymentId.get(local.id) || []).length,
      ));
    if (providerHasHistoricCash) {
      const providerCreditDate = dateOnly(provider.creditDate);
      if (!providerCreditDate && provider.status === "RECEIVED") {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "PAYMENT",
          kind: "CREDIT_DATE_MISSING",
          severity: provider.billingType === "CREDIT_CARD" ? "HIGH" : "WARNING",
          provider_entity_id: provider.id,
          local_entity_id: local.id,
          fingerprint: `credit-date-provider-missing:${provider.id}`,
          details: {
            billingType: provider.billingType || null,
            paymentDate: provider.paymentDate || null,
          },
        });
      } else if (providerCreditDate !== localCreditDate) {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "PAYMENT",
          kind: localCreditDate
            ? "CREDIT_DATE_MISMATCH"
            : "LOCAL_CREDIT_DATE_MISSING",
          severity: "HIGH",
          provider_entity_id: provider.id,
          local_entity_id: local.id,
          fingerprint: `credit-date-local:${provider.id}`,
          details: { providerCreditDate, localCreditDate },
        });
      }
    }

    const providerRefundedAmount =
      lastProviderEventName(local) === "PAYMENT_RECEIVED_IN_CASH_UNDONE"
        ? provider.value || 0
        : provider.refundedValue || 0;
    if (cents(providerRefundedAmount) !== cents(local.refunded_amount || 0)) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "PAYMENT",
        kind: "REFUNDED_AMOUNT_MISMATCH",
        severity: "HIGH",
        provider_entity_id: provider.id,
        local_entity_id: local.id,
        fingerprint: `refund-value:${provider.id}`,
        details: {
          providerRefunded: providerRefundedAmount,
          localRefunded: local.refunded_amount || 0,
        },
      });
    }
  }

  for (const local of input.localPayments) {
    const providerId = local.asaas_payment_id || "";
    if (
      !providerId ||
      providerId.startsWith("MANUAL_") ||
      providerById.has(providerId) ||
      !localIsInWindow(local)
    ) {
      continue;
    }
    addIssue(issues, {
      tenant_id: local.tenant_id || null,
      source: "PAYMENT",
      kind: "LOCAL_PAYMENT_MISSING_PROVIDER_WINDOW",
      severity: local.status === "RECEIVED" ? "HIGH" : "WARNING",
      provider_entity_id: providerId,
      local_entity_id: local.id,
      fingerprint: `payment-missing-provider:${providerId}`,
      details: {
        localStatus: local.status || null,
        localValue: local.value ?? null,
      },
    });
  }

  const refundProviderEventCounts = new Map<string, number>();
  for (const refundEntries of input.refundLedgerByPaymentId.values()) {
    for (const refundEntry of refundEntries) {
      const eventId = refundEntry.provider_event_id?.trim();
      if (!eventId) continue;
      refundProviderEventCounts.set(
        eventId,
        (refundProviderEventCounts.get(eventId) || 0) + 1,
      );
    }
  }

  // Cash is represented by one immutable gross ENTRADA plus zero or more
  // positive SAIDAs. The payment flag describes only that gross receipt; a
  // refund must never shrink or remove it. NAO_RECEITA changes classification,
  // not the fact that cash entered and (possibly) left.
  for (const local of input.localPayments) {
    const grossEntries = input.grossLedgerByPaymentId.get(local.id) || [];
    const refundEntries = input.refundLedgerByPaymentId.get(local.id) || [];
    const refundTouchesWindow = refundEntries.some((entry) => {
      const date = dateOnly(entry.occurred_at);
      return Boolean(
        date && date >= input.windowStart && date <= input.windowEnd,
      );
    });
    if (!localIsInWindow(local) && !refundTouchesWindow) continue;

    const localStatus = String(local.status || "").toUpperCase();
    const cashReceiptUndone = lastProviderEventName(local) ===
      "PAYMENT_RECEIVED_IN_CASH_UNDONE";
    const isSettled = ["RECEIVED", "RECEIVED_IN_CASH", "NAO_RECEITA"]
      .includes(localStatus);
    const isRefunded = localStatus === "REFUNDED";
    const hasReceiptTimestamp = Boolean(
      local.credited_at || (cashReceiptUndone && local.paid_at),
    );
    const expectsGrossEntry = isSettled ||
      (isRefunded && hasReceiptTimestamp);
    const hasGrossEntry = grossEntries.length > 0;

    if (
      isRefunded &&
      !hasReceiptTimestamp &&
      (hasGrossEntry || local.ledger_entry_created === true)
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "REFUNDED_RECEIPT_CONTEXT_MISSING",
        severity: "HIGH",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `refunded-receipt-context:${local.id}`,
        details: {
          creditedAt: null,
          grossEntryCount: grossEntries.length,
          ledgerFlag: local.ledger_entry_created === true,
        },
      });
    }

    if (expectsGrossEntry && !hasGrossEntry) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "LEDGER_GROSS_ENTRY_MISSING",
        severity: "CRITICAL",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-gross-missing:${local.id}`,
        details: { ledgerFlag: local.ledger_entry_created === true },
      });
    }
    if (grossEntries.length > 1) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "LEDGER_GROSS_ENTRY_COUNT_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-gross-count:${local.id}`,
        details: { expectedCount: 1, actualCount: grossEntries.length },
      });
    }
    if (!expectsGrossEntry && hasGrossEntry && !isRefunded) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "UNEXPECTED_LEDGER_GROSS_ENTRY",
        severity: "CRITICAL",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-gross-unexpected:${local.id}`,
        details: {
          localStatus: local.status || null,
          value: local.value ?? null,
          refundedAmount: local.refunded_amount ?? null,
        },
      });
    }

    if (hasGrossEntry) {
      const expectedGrossAmount = Number(local.value || 0);
      const invalidGrossAmounts = grossEntries.filter((entry) =>
        cents(entry.amount) !== cents(expectedGrossAmount)
      );
      if (invalidGrossAmounts.length > 0) {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "LEDGER",
          kind: "LEDGER_GROSS_AMOUNT_MISMATCH",
          severity: "CRITICAL",
          provider_entity_id: local.asaas_payment_id || null,
          local_entity_id: local.id,
          fingerprint: `ledger-gross-amount:${local.id}`,
          details: {
            grossAmounts: grossEntries.map((entry) => entry.amount ?? null),
            expectedGrossAmount,
          },
        });
      }
      const expectedCategory = localStatus === "NAO_RECEITA"
        ? "aporte_ou_movimentacao"
        : "MENSALIDADE";
      const invalidGrossClassification = grossEntries.some((entry) =>
        entry.type !== "ENTRADA" ||
        entry.category !== expectedCategory ||
        Boolean(entry.refund_student_payment_id)
      );
      if (invalidGrossClassification) {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "LEDGER",
          kind: "LEDGER_GROSS_CLASSIFICATION_MISMATCH",
          severity: "HIGH",
          provider_entity_id: local.asaas_payment_id || null,
          local_entity_id: local.id,
          fingerprint: `ledger-gross-classification:${local.id}`,
          details: {
            actual: grossEntries.map((entry) => ({
              type: entry.type || null,
              category: entry.category || null,
              refundStudentPaymentId: entry.refund_student_payment_id || null,
            })),
            expectedType: "ENTRADA",
            expectedCategory,
          },
        });
      }
      const expectedOccurredDate = dateOnly(
        local.credited_at ||
          local.paid_at ||
          local.payment_date ||
          local.due_date,
      );
      const mismatchedGrossDates = expectedOccurredDate
        ? grossEntries.filter((entry) =>
          dateOnly(entry.occurred_at) !== expectedOccurredDate
        )
        : [];
      if (mismatchedGrossDates.length > 0) {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "LEDGER",
          kind: "LEDGER_GROSS_DATE_MISMATCH",
          severity: "HIGH",
          provider_entity_id: local.asaas_payment_id || null,
          local_entity_id: local.id,
          fingerprint: `ledger-gross-date:${local.id}`,
          details: {
            expectedOccurredDate,
            grossOccurredDates: grossEntries.map((entry) =>
              dateOnly(entry.occurred_at)
            ),
          },
        });
      }
    }

    // ledger_entry_created is intentionally compared only with the gross
    // receipt. Refund SAIDAs have their own reference and never satisfy it.
    if (Boolean(local.ledger_entry_created) !== hasGrossEntry) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "LEDGER_FLAG_MISMATCH",
        severity: hasGrossEntry ? "WARNING" : "HIGH",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-flag:${local.id}`,
        details: {
          ledgerFlag: local.ledger_entry_created === true,
          hasGrossEntry,
          refundEntryCount: refundEntries.length,
        },
      });
    }

    // Asaas may refund a CONFIRMED charge before crediting it. In that case
    // refunded_amount describes the provider lifecycle, but no cash ever
    // entered and therefore neither an ENTRADA nor a refund SAIDA is valid.
    const hasCashBasis = expectsGrossEntry || hasGrossEntry;
    const localRefundedAmount = Math.max(
      0,
      Number(local.refunded_amount || 0),
    );
    const expectedRefundAmount = hasCashBasis ? localRefundedAmount : 0;
    const actualRefundAmount = refundEntries.reduce((total, entry) => {
      const amount = Number(entry.amount);
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
    if (cents(actualRefundAmount) !== cents(expectedRefundAmount)) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "LEDGER_REFUND_TOTAL_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-refund-total:${local.id}`,
        details: {
          expectedRefundAmount,
          localRefundedAmount,
          hasCashBasis,
          actualRefundAmount,
          refundEntryCount: refundEntries.length,
        },
      });
    }

    const expectedRefundCategory = localStatus === "NAO_RECEITA"
      ? "estorno_aporte_ou_movimentacao"
      : "ESTORNO_MENSALIDADE";
    const invalidRefundClassification = refundEntries.some((entry) => {
      const amount = Number(entry.amount);
      return entry.type !== "SAIDA" ||
        entry.category !== expectedRefundCategory ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        Boolean(entry.student_payment_id);
    });
    if (invalidRefundClassification) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "LEDGER_REFUND_CLASSIFICATION_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-refund-classification:${local.id}`,
        details: {
          expectedType: "SAIDA",
          expectedCategory: expectedRefundCategory,
          invalidEntryCount: refundEntries.filter((entry) => {
            const amount = Number(entry.amount);
            return entry.type !== "SAIDA" ||
              entry.category !== expectedRefundCategory ||
              !Number.isFinite(amount) ||
              amount <= 0 ||
              Boolean(entry.student_payment_id);
          }).length,
        },
      });
    }

    const missingProviderEventCount = refundEntries.filter((entry) =>
      !entry.provider_event_id?.trim()
    ).length;
    if (missingProviderEventCount > 0) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "LEDGER_REFUND_PROVIDER_EVENT_MISSING",
        severity: "CRITICAL",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-refund-event-missing:${local.id}`,
        details: { missingProviderEventCount },
      });
    }

    const duplicateProviderEventIds = [
      ...new Set(
        refundEntries
          .map((entry) => entry.provider_event_id?.trim())
          .filter((value): value is string =>
            Boolean(value && (refundProviderEventCounts.get(value) || 0) > 1)
          ),
      ),
    ];
    if (duplicateProviderEventIds.length > 0) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "LEDGER",
        kind: "LEDGER_REFUND_PROVIDER_EVENT_DUPLICATE",
        severity: "CRITICAL",
        provider_entity_id: local.asaas_payment_id || null,
        local_entity_id: local.id,
        fingerprint: `ledger-refund-event-duplicate:${local.id}`,
        details: { providerEventIds: duplicateProviderEventIds },
      });
    }

    // A payment stores only the latest provider event. When it is one of the
    // refund events, it gives us an exact date assertion; later non-refund
    // events must not make an older valid SAIDA look stale.
    if (local.last_provider_event_id && local.last_provider_event_at) {
      const latestRefundEntries = refundEntries.filter((entry) =>
        entry.provider_event_id === local.last_provider_event_id
      );
      const expectedRefundDate = dateOnly(local.last_provider_event_at);
      if (
        latestRefundEntries.some((entry) =>
          dateOnly(entry.occurred_at) !== expectedRefundDate
        )
      ) {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "LEDGER",
          kind: "LEDGER_REFUND_DATE_MISMATCH",
          severity: "HIGH",
          provider_entity_id: local.asaas_payment_id || null,
          local_entity_id: local.id,
          fingerprint:
            `ledger-refund-date:${local.id}:${local.last_provider_event_id}`,
          details: {
            providerEventId: local.last_provider_event_id,
            expectedOccurredDate: expectedRefundDate,
            actualOccurredDates: latestRefundEntries.map((entry) =>
              dateOnly(entry.occurred_at)
            ),
          },
        });
      }
    }
  }

  const statementRefundsByPaymentId = new Map<
    string,
    ProviderStatementEntry[]
  >();
  for (const entry of input.statement) {
    if (
      entry.type !== "PAYMENT_RECEIVED" && entry.type !== "PAYMENT_REVERSAL"
    ) {
      continue;
    }
    const paymentId = statementPaymentId(entry);
    const isRefund = entry.type === "PAYMENT_REVERSAL";
    if (!paymentId) {
      addIssue(issues, {
        tenant_id: null,
        source: "STATEMENT",
        kind: isRefund
          ? "STATEMENT_REFUND_PAYMENT_ID_UNRESOLVED"
          : "STATEMENT_PAYMENT_ID_UNRESOLVED",
        severity: isRefund ? "HIGH" : "WARNING",
        provider_entity_id: entry.id || null,
        local_entity_id: null,
        fingerprint: `statement-${isRefund ? "refund" : "payment"}-unresolved:${
          entry.id || entry.date || "unknown"
        }`,
        details: {
          statementType: entry.type,
          value: entry.value ?? null,
          date: entry.date || null,
          splitId: entry.splitId || null,
        },
      });
      continue;
    }

    const providerSnapshot = providerById.get(paymentId);
    if (
      input.productPaymentByProviderId.has(paymentId) ||
      productFamilyFromReference(providerSnapshot?.externalReference)
    ) {
      continue;
    }

    const local = localByProviderId.get(paymentId);
    if (!local) {
      addIssue(issues, {
        tenant_id: input.referenceTenantId || null,
        source: "STATEMENT",
        kind: isRefund
          ? "STATEMENT_REFUND_MISSING_LOCAL_PAYMENT"
          : "STATEMENT_RECEIPT_MISSING_LOCAL_PAYMENT",
        severity: isRefund ? "CRITICAL" : "HIGH",
        provider_entity_id: paymentId,
        local_entity_id: null,
        fingerprint: `statement-${
          isRefund ? "refund" : "payment"
        }-missing-local:${paymentId}:${entry.id || entry.date || "unknown"}`,
        details: {
          statementId: entry.id || null,
          value: entry.value ?? null,
          date: entry.date || null,
          splitId: entry.splitId || null,
        },
      });
      continue;
    }

    if (isRefund) {
      const refundEntries = statementRefundsByPaymentId.get(paymentId) || [];
      refundEntries.push(entry);
      statementRefundsByPaymentId.set(paymentId, refundEntries);
      continue;
    }

    const statementDate = dateOnly(entry.date);
    const creditedDate = dateOnly(local.credited_at);
    const providerCreditDate = dateOnly(providerSnapshot?.creditDate);
    const statementOnlyCorroboratesMissingLocalCredit = !creditedDate &&
      providerSnapshot?.status === "RECEIVED" &&
      Boolean(statementDate) &&
      statementDate === providerCreditDate;
    if (
      statementDate !== creditedDate &&
      !statementOnlyCorroboratesMissingLocalCredit
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "STATEMENT",
        kind: "STATEMENT_CREDIT_DATE_MISMATCH",
        severity: "HIGH",
        provider_entity_id: paymentId,
        local_entity_id: local.id,
        fingerprint: `statement-credit-date:${paymentId}:${
          entry.id || statementDate || "unknown"
        }`,
        details: { statementDate, creditedDate },
      });
    }
    if (cents(entry.value) !== cents(local.value)) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "STATEMENT",
        kind: "STATEMENT_PAYMENT_VALUE_MISMATCH",
        severity: "HIGH",
        provider_entity_id: paymentId,
        local_entity_id: local.id,
        fingerprint: `statement-payment-value:${paymentId}:${
          entry.id || "unknown"
        }`,
        details: {
          statementValue: entry.value ?? null,
          localValue: local.value ?? null,
        },
      });
    }
  }

  // PAYMENT_REVERSAL is the provider's balance-impacting refund. Reconcile a
  // multiset of value/date events so partial refunds and installments are not
  // collapsed into a single total or hidden by equal external identifiers.
  for (const local of input.localPayments) {
    const paymentId = local.asaas_payment_id || "";
    if (!paymentId || paymentId.startsWith("MANUAL_")) continue;
    const providerRefunds = statementRefundsByPaymentId.get(paymentId) || [];
    const localRefunds = (input.refundLedgerByPaymentId.get(local.id) || [])
      .filter((refund) => {
        const date = dateOnly(refund.occurred_at);
        return Boolean(
          date && date >= input.windowStart && date <= input.windowEnd,
        );
      });
    if (providerRefunds.length === 0 && localRefunds.length === 0) continue;

    const remainingLocal = [...localRefunds];
    let providerRefundTotal = 0;
    for (let index = 0; index < providerRefunds.length; index++) {
      const providerRefund = providerRefunds[index];
      const rawValue = Number(providerRefund.value);
      const providerAmount = Number.isFinite(rawValue)
        ? Math.abs(rawValue)
        : null;
      const providerDate = dateOnly(providerRefund.date);
      const eventKey = providerRefund.id || `${paymentId}:${index}`;
      if (providerAmount === null || providerDate === null) {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "STATEMENT",
          kind: "STATEMENT_REFUND_EVENT_INVALID",
          severity: "CRITICAL",
          provider_entity_id: paymentId,
          local_entity_id: local.id,
          fingerprint: `statement-refund-invalid:${eventKey}`,
          details: {
            statementId: providerRefund.id || null,
            value: providerRefund.value ?? null,
            date: providerRefund.date || null,
          },
        });
        continue;
      }
      providerRefundTotal += providerAmount;
      if (rawValue >= 0) {
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "STATEMENT",
          kind: "STATEMENT_REFUND_SIGN_UNEXPECTED",
          severity: "WARNING",
          provider_entity_id: paymentId,
          local_entity_id: local.id,
          fingerprint: `statement-refund-sign:${eventKey}`,
          details: { statementValue: providerRefund.value ?? null },
        });
      }

      let matchIndex = remainingLocal.findIndex((refund) =>
        cents(refund.amount) === cents(providerAmount) &&
        dateOnly(refund.occurred_at) === providerDate
      );
      if (matchIndex >= 0) {
        remainingLocal.splice(matchIndex, 1);
        continue;
      }

      matchIndex = remainingLocal.findIndex((refund) =>
        cents(refund.amount) === cents(providerAmount)
      );
      if (matchIndex >= 0) {
        const localRefund = remainingLocal.splice(matchIndex, 1)[0];
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "STATEMENT",
          kind: "STATEMENT_REFUND_DATE_MISMATCH",
          severity: "CRITICAL",
          provider_entity_id: paymentId,
          local_entity_id: local.id,
          fingerprint: `statement-refund-date:${eventKey}`,
          details: {
            statementId: providerRefund.id || null,
            providerDate,
            localDate: dateOnly(localRefund.occurred_at),
            amount: providerAmount,
            providerEventId: localRefund.provider_event_id || null,
          },
        });
        continue;
      }

      matchIndex = remainingLocal.findIndex((refund) =>
        dateOnly(refund.occurred_at) === providerDate
      );
      if (matchIndex >= 0) {
        const localRefund = remainingLocal.splice(matchIndex, 1)[0];
        addIssue(issues, {
          tenant_id: local.tenant_id || null,
          source: "STATEMENT",
          kind: "STATEMENT_REFUND_VALUE_MISMATCH",
          severity: "CRITICAL",
          provider_entity_id: paymentId,
          local_entity_id: local.id,
          fingerprint: `statement-refund-value:${eventKey}`,
          details: {
            statementId: providerRefund.id || null,
            providerAmount,
            localAmount: localRefund.amount ?? null,
            date: providerDate,
            providerEventId: localRefund.provider_event_id || null,
          },
        });
        continue;
      }

      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "STATEMENT",
        kind: "STATEMENT_REFUND_MISSING_LOCAL_LEDGER",
        severity: "CRITICAL",
        provider_entity_id: paymentId,
        local_entity_id: local.id,
        fingerprint: `statement-refund-missing-ledger:${eventKey}`,
        details: {
          statementId: providerRefund.id || null,
          amount: providerAmount,
          date: providerDate,
          providerInstallmentId: providerById.get(paymentId)?.installment ||
            null,
        },
      });
    }

    const localRefundTotal = localRefunds.reduce((total, refund) => {
      const amount = Number(refund.amount);
      return total + (Number.isFinite(amount) ? amount : 0);
    }, 0);
    if (cents(providerRefundTotal) !== cents(localRefundTotal)) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "STATEMENT",
        kind: "STATEMENT_REFUND_TOTAL_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: paymentId,
        local_entity_id: local.id,
        fingerprint:
          `statement-refund-total:${paymentId}:${input.windowStart}:${input.windowEnd}`,
        details: {
          providerRefundTotal,
          localRefundTotal,
          providerEventCount: providerRefunds.length,
          localEventCount: localRefunds.length,
          providerInstallmentId: providerById.get(paymentId)?.installment ||
            null,
        },
      });
    }
    if (providerRefunds.length !== localRefunds.length) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "STATEMENT",
        kind: "STATEMENT_REFUND_EVENT_COUNT_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: paymentId,
        local_entity_id: local.id,
        fingerprint:
          `statement-refund-count:${paymentId}:${input.windowStart}:${input.windowEnd}`,
        details: {
          providerEventCount: providerRefunds.length,
          localEventCount: localRefunds.length,
        },
      });
    }

    for (const localRefund of remainingLocal) {
      addIssue(issues, {
        tenant_id: local.tenant_id || null,
        source: "STATEMENT",
        kind: "LOCAL_REFUND_LEDGER_MISSING_STATEMENT",
        severity: "CRITICAL",
        provider_entity_id: paymentId,
        local_entity_id: local.id,
        fingerprint: `local-refund-missing-statement:${
          localRefund.id || localRefund.provider_event_id || local.id
        }`,
        details: {
          providerEventId: localRefund.provider_event_id || null,
          amount: localRefund.amount ?? null,
          date: dateOnly(localRefund.occurred_at),
        },
      });
    }
  }

  const providerTransfersById = new Map<string, ProviderTransfer[]>();
  const providerTransfersByReference = new Map<string, ProviderTransfer[]>();
  for (const transfer of input.providerTransfers) {
    if (transfer.id) {
      const byId = providerTransfersById.get(transfer.id) || [];
      byId.push(transfer);
      providerTransfersById.set(transfer.id, byId);
    }
    if (transfer.externalReference) {
      const byReference = providerTransfersByReference.get(
        transfer.externalReference,
      ) || [];
      byReference.push(transfer);
      providerTransfersByReference.set(transfer.externalReference, byReference);
    }
  }
  const localTransferReferences = new Set(
    input.localTransfers.map((attempt) => attempt.external_reference),
  );

  for (const [providerId, transfers] of providerTransfersById) {
    if (transfers.length < 2) continue;
    addIssue(issues, {
      tenant_id: null,
      source: "TRANSFER",
      kind: "PROVIDER_TRANSFER_DUPLICATE_ID",
      severity: "CRITICAL",
      provider_entity_id: providerId,
      local_entity_id: null,
      fingerprint: `transfer-duplicate-id:${providerId}`,
      details: {
        providerTransferCount: transfers.length,
        providerTransfers: transfers.map((transfer, index) => ({
          occurrence: index + 1,
          id: transfer.id || null,
          externalReference: transfer.externalReference || null,
          status: transfer.status || null,
          value: transfer.value ?? null,
        })),
      },
    });
  }

  for (const [reference, transfers] of providerTransfersByReference) {
    if (transfers.length < 2) continue;
    const localAttempts = input.localTransfers.filter(
      (attempt) => attempt.external_reference === reference,
    );
    addIssue(issues, {
      tenant_id: localAttempts.length === 1 ? localAttempts[0].tenant_id : null,
      source: "TRANSFER",
      kind: "PROVIDER_TRANSFER_DUPLICATE_EXTERNAL_REFERENCE",
      severity: "CRITICAL",
      provider_entity_id: null,
      local_entity_id: localAttempts.length === 1 ? localAttempts[0].id : null,
      fingerprint: `transfer-duplicate-reference:${reference}`,
      details: {
        externalReference: reference,
        providerTransferCount: transfers.length,
        localAttemptCount: localAttempts.length,
        providerTransfers: transfers.map((transfer, index) => ({
          occurrence: index + 1,
          id: transfer.id || null,
          status: transfer.status || null,
          value: transfer.value ?? null,
        })),
      },
    });
  }

  for (const local of input.localTransfers) {
    const byId = local.provider_transfer_id
      ? providerTransfersById.get(local.provider_transfer_id) || []
      : [];
    const byReference = providerTransfersByReference.get(
      local.external_reference,
    ) || [];
    // An exact, unique provider id is authoritative. Falling back to the
    // reference is safe only when it also identifies exactly one transfer.
    // Duplicate groups are reported above in full and deliberately not
    // collapsed to an arbitrary last item.
    const provider = byId.length === 1
      ? byId[0]
      : byId.length === 0 && byReference.length === 1
      ? byReference[0]
      : undefined;
    if (!provider) {
      if (
        ["UNKNOWN", "SUBMITTED", "CLAIMED"].includes(local.status) ||
        byId.length > 1 ||
        byReference.length > 1
      ) {
        addIssue(issues, {
          tenant_id: local.tenant_id,
          source: "TRANSFER",
          kind: "TRANSFER_OUTCOME_UNRESOLVED",
          severity: "CRITICAL",
          provider_entity_id: local.provider_transfer_id || null,
          local_entity_id: local.id,
          fingerprint: `transfer-unresolved:${local.id}`,
          details: {
            status: local.status,
            externalReference: local.external_reference,
            providerIdMatchCount: byId.length,
            providerReferenceMatchCount: byReference.length,
          },
        });
      }
      continue;
    }
    const providerReference = String(provider.externalReference || "").trim();
    const localReference = String(local.external_reference || "").trim();
    if (providerReference !== localReference) {
      addIssue(issues, {
        tenant_id: local.tenant_id,
        source: "TRANSFER",
        kind: "TRANSFER_REFERENCE_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: provider.id || null,
        local_entity_id: local.id,
        fingerprint: `transfer-reference:${local.id}`,
        details: {
          providerReference: providerReference || null,
          expectedReference: localReference || null,
          matchedByProviderId: byId.length === 1,
        },
      });
    }
    if (cents(provider.value) !== cents(local.expected_amount)) {
      addIssue(issues, {
        tenant_id: local.tenant_id,
        source: "TRANSFER",
        kind: "TRANSFER_VALUE_MISMATCH",
        severity: "CRITICAL",
        provider_entity_id: provider.id || null,
        local_entity_id: local.id,
        fingerprint: `transfer-value:${local.id}`,
        details: {
          providerValue: provider.value ?? null,
          expectedValue: local.expected_amount,
        },
      });
    }
    if (
      provider.status &&
      provider.status !== local.provider_status
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id,
        source: "TRANSFER",
        kind: "TRANSFER_STATUS_MISMATCH",
        severity: "HIGH",
        provider_entity_id: provider.id || null,
        local_entity_id: local.id,
        fingerprint: `transfer-status:${local.id}`,
        details: {
          providerStatus: provider.status,
          localProviderStatus: local.provider_status,
          localState: local.status,
        },
      });
    }
    if (
      local.status === "UNKNOWN" ||
      (provider.status === "DONE" && local.status !== "COMPLETED")
    ) {
      addIssue(issues, {
        tenant_id: local.tenant_id,
        source: "TRANSFER",
        kind: "TRANSFER_LOCAL_STATE_STALE",
        severity: "CRITICAL",
        provider_entity_id: provider.id || null,
        local_entity_id: local.id,
        fingerprint: `transfer-state:${local.id}`,
        details: {
          providerStatus: provider.status || null,
          localStatus: local.status,
        },
      });
    }
  }

  for (const provider of input.providerTransfers) {
    const reference = provider.externalReference || "";
    if (
      reference.startsWith("wisewolf-teacher-closing:") &&
      !localTransferReferences.has(reference)
    ) {
      addIssue(issues, {
        tenant_id: input.referenceTenantId || null,
        source: "TRANSFER",
        kind: "PROVIDER_TRANSFER_MISSING_LOCAL_ATTEMPT",
        severity: "CRITICAL",
        provider_entity_id: provider.id || null,
        local_entity_id: null,
        fingerprint: `transfer-missing-local:${provider.id || reference}`,
        details: {
          externalReference: reference,
          providerStatus: provider.status || null,
        },
      });
    }
  }

  return [...issues.values()];
}
