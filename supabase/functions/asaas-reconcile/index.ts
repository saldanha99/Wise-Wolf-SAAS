/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";
import {
  buildReconciliationIssues,
  type LocalLedgerEntry,
  type LocalPayment,
  type LocalProductPayment,
  type LocalProductReference,
  type LocalTransferAttempt,
  type ProviderPayment,
  type ProviderStatementEntry,
  type ProviderTransfer,
  runTransferAudit,
  statementPaymentId,
} from "./diff.ts";
import {
  HISTORICAL_REPAIR_BUDGET_MS,
  providerRetryDelayMs,
  waitForProvider,
} from "./provider-http.ts";
import {
  type AuthoritativeUnlinkedRepairTarget,
  customerBindingSnapshot,
  parseAuthoritativeUnlinkedRepairTarget,
  paymentBindingSnapshot,
  sameIntegrationIdentity,
  subscriptionBindingSnapshot,
} from "./unlinked-repair.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const REFERENCE_TENANT_ID = "school-wise-wolf";

type ProviderList<T> = {
  data?: T[];
  hasMore?: boolean;
  totalCount?: number;
};

type CursorState = Record<string, number>;

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function validDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
  );
}

class ProviderGetError extends Error {
  constructor(readonly status: number) {
    super(`asaas_get_${status}`);
    this.name = "ProviderGetError";
  }
}

class ProviderRepairDeadlineError extends Error {
  constructor() {
    super("asaas_repair_deadline_exhausted");
    this.name = "ProviderRepairDeadlineError";
  }
}

function stringDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || null;
}

function localPaymentTouchesWindow(
  payment: LocalPayment,
  windowStart: string,
  windowEnd: string,
): boolean {
  return [
    payment.created_at,
    payment.due_date,
    payment.payment_date,
    payment.credited_at,
    payment.last_provider_event_at,
  ]
    .map(stringDateOnly)
    .some((date) => Boolean(date && date >= windowStart && date <= windowEnd));
}

function moneyCents(value: unknown): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function providerStatementDate(entry: ProviderStatementEntry): string | null {
  return stringDateOnly(entry.date);
}

type HistoricalRepairMetrics = {
  requested: boolean;
  creditDatesRepaired: number;
  creditDatesAlreadyRepaired: number;
  deletedPaymentsCancelled: number;
  deletedPaymentsAlreadyCancelled: number;
  skipped: number;
};

type ProviderGetOptions = {
  retryRateLimit?: boolean;
  retryTransient?: boolean;
  deadlineAt?: number;
  beforeAttempt?: () => Promise<void>;
  onRetryWait?: (input: {
    status: number;
    attempt: number;
    delayMs: number;
  }) => Promise<void>;
};

type UnlinkedRepairResult = {
  status: number;
  body: Record<string, unknown>;
};

function exactProviderIdentifier(
  value: unknown,
  prefix: "pay" | "cus" | "sub",
): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return new RegExp(`^${prefix}_[A-Za-z0-9]{4,120}$`).test(normalized)
    ? normalized
    : null;
}

function sameResolvedIntegration(
  left: ResolvedAsaasIntegration,
  right: ResolvedAsaasIntegration,
): boolean {
  return sameIntegrationIdentity(left, right) && left.apiKey === right.apiKey;
}

async function applyAuthoritativeUnlinkedRepair(input: {
  admin: SupabaseClient;
  target: AuthoritativeUnlinkedRepairTarget;
}): Promise<UnlinkedRepairResult> {
  const deadlineAt = Date.now() + 20_000;
  const { data: local, error: localError } = await input.admin
    .from("student_payments")
    .select("id,tenant_id,student_id,asaas_payment_id,asaas_id")
    .eq("id", input.target.localPaymentId)
    .eq("tenant_id", REFERENCE_TENANT_ID)
    .maybeSingle();
  if (localError) throw localError;
  if (!local) {
    return {
      status: 409,
      body: { success: false, reason: "LOCAL_PAYMENT_NOT_FOUND" },
    };
  }
  if (local.student_id && local.student_id !== input.target.studentId) {
    return {
      status: 409,
      body: { success: false, reason: "LOCAL_PAYMENT_ALREADY_BOUND" },
    };
  }
  const providerIds = [local.asaas_payment_id, local.asaas_id]
    .map((value) => exactProviderIdentifier(value, "pay"))
    .filter((value): value is string => Boolean(value));
  const uniqueProviderIds = [...new Set(providerIds)];
  if (uniqueProviderIds.length !== 1) {
    return {
      status: 409,
      body: { success: false, reason: "LOCAL_PROVIDER_PAYMENT_NOT_UNIQUE" },
    };
  }
  const providerId = uniqueProviderIds[0];

  const [firstPaymentIntegration, firstCustomerIntegration] = await Promise.all(
    [
      resolveAsaasIntegration(
        input.admin,
        REFERENCE_TENANT_ID,
        "payment.read",
      ),
      resolveAsaasIntegration(
        input.admin,
        REFERENCE_TENANT_ID,
        "customer.read",
      ),
    ],
  );
  if (
    !sameResolvedIntegration(firstPaymentIntegration, firstCustomerIntegration)
  ) {
    throw new Error("integration_unlinked_repair_resolution_mismatch");
  }
  const firstPayment = await providerGet<ProviderPayment>(
    firstPaymentIntegration,
    `/payments/${encodeURIComponent(providerId)}`,
    { deadlineAt },
  );
  if (firstPayment.id !== providerId) {
    return {
      status: 409,
      body: { success: false, reason: "PROVIDER_PAYMENT_IDENTITY_MISMATCH" },
    };
  }
  const customerId = exactProviderIdentifier(firstPayment.customer, "cus");
  const subscriptionId = firstPayment.subscription == null
    ? null
    : exactProviderIdentifier(firstPayment.subscription, "sub");
  if (!customerId || (firstPayment.subscription != null && !subscriptionId)) {
    return {
      status: 409,
      body: { success: false, reason: "PROVIDER_PARENT_IDENTITY_INVALID" },
    };
  }
  let firstSubscriptionIntegration: ResolvedAsaasIntegration | null = null;
  if (subscriptionId) {
    firstSubscriptionIntegration = await resolveAsaasIntegration(
      input.admin,
      REFERENCE_TENANT_ID,
      "subscription.read",
    );
    if (
      !sameResolvedIntegration(
        firstPaymentIntegration,
        firstSubscriptionIntegration,
      )
    ) throw new Error("integration_unlinked_repair_resolution_mismatch");
  }
  const [firstCustomer, firstSubscription] = await Promise.all([
    providerGet<Record<string, unknown>>(
      firstCustomerIntegration,
      `/customers/${encodeURIComponent(customerId)}`,
      { deadlineAt },
    ),
    subscriptionId
      ? providerGet<Record<string, unknown>>(
        firstSubscriptionIntegration!,
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { deadlineAt },
      )
      : Promise.resolve(null),
  ]);
  if (
    exactProviderIdentifier(firstCustomer.id, "cus") !== customerId ||
    (subscriptionId &&
      exactProviderIdentifier(firstSubscription?.id, "sub") !== subscriptionId)
  ) {
    return {
      status: 409,
      body: { success: false, reason: "PROVIDER_PARENT_IDENTITY_MISMATCH" },
    };
  }

  // Re-resolve every capability and re-read every provider fact immediately
  // before the RPC. A credential/version rotation or changing identity aborts
  // without mutating the local binding.
  const secondCapabilities = await Promise.all([
    resolveAsaasIntegration(
      input.admin,
      REFERENCE_TENANT_ID,
      "payment.read",
    ),
    resolveAsaasIntegration(
      input.admin,
      REFERENCE_TENANT_ID,
      "customer.read",
    ),
    subscriptionId
      ? resolveAsaasIntegration(
        input.admin,
        REFERENCE_TENANT_ID,
        "subscription.read",
      )
      : Promise.resolve(null),
  ]);
  const [secondPaymentIntegration, secondCustomerIntegration] =
    secondCapabilities;
  const secondSubscriptionIntegration = secondCapabilities[2];
  if (
    !sameResolvedIntegration(
      firstPaymentIntegration,
      secondPaymentIntegration,
    ) ||
    !sameResolvedIntegration(
      firstPaymentIntegration,
      secondCustomerIntegration,
    ) ||
    (subscriptionId &&
      (!secondSubscriptionIntegration ||
        !sameResolvedIntegration(
          firstPaymentIntegration,
          secondSubscriptionIntegration,
        )))
  ) throw new Error("integration_unlinked_repair_rotated");

  const secondPayment = await providerGet<ProviderPayment>(
    secondPaymentIntegration,
    `/payments/${encodeURIComponent(providerId)}`,
    { deadlineAt },
  );
  if (
    paymentBindingSnapshot(firstPayment) !==
      paymentBindingSnapshot(secondPayment) ||
    secondPayment.id !== providerId ||
    exactProviderIdentifier(secondPayment.customer, "cus") !== customerId ||
    (secondPayment.subscription == null ? null : exactProviderIdentifier(
        secondPayment.subscription,
        "sub",
      )) !== subscriptionId
  ) {
    return {
      status: 409,
      body: { success: false, reason: "PROVIDER_PAYMENT_CHANGED" },
    };
  }
  const [secondCustomer, secondSubscription] = await Promise.all([
    providerGet<Record<string, unknown>>(
      secondCustomerIntegration,
      `/customers/${encodeURIComponent(customerId)}`,
      { deadlineAt },
    ),
    subscriptionId
      ? providerGet<Record<string, unknown>>(
        secondSubscriptionIntegration!,
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { deadlineAt },
      )
      : Promise.resolve(null),
  ]);
  if (
    customerBindingSnapshot(firstCustomer) !==
      customerBindingSnapshot(secondCustomer) ||
    (subscriptionId &&
      subscriptionBindingSnapshot(firstSubscription) !==
        subscriptionBindingSnapshot(secondSubscription))
  ) {
    return {
      status: 409,
      body: { success: false, reason: "PROVIDER_PARENT_CHANGED" },
    };
  }

  // Resolve once more after the final provider reads. The database mutation
  // receives this exact broker identity and locks the connection row before
  // validating it, closing the rotation window between this check and write.
  const finalCapabilities = await Promise.all([
    resolveAsaasIntegration(
      input.admin,
      REFERENCE_TENANT_ID,
      "payment.read",
    ),
    resolveAsaasIntegration(
      input.admin,
      REFERENCE_TENANT_ID,
      "customer.read",
    ),
    subscriptionId
      ? resolveAsaasIntegration(
        input.admin,
        REFERENCE_TENANT_ID,
        "subscription.read",
      )
      : Promise.resolve(null),
  ]);
  const [finalPaymentIntegration, finalCustomerIntegration] = finalCapabilities;
  const finalSubscriptionIntegration = finalCapabilities[2];
  if (
    !sameResolvedIntegration(
      secondPaymentIntegration,
      finalPaymentIntegration,
    ) ||
    !sameResolvedIntegration(
      secondPaymentIntegration,
      finalCustomerIntegration,
    ) ||
    (subscriptionId &&
      (!finalSubscriptionIntegration ||
        !sameResolvedIntegration(
          secondPaymentIntegration,
          finalSubscriptionIntegration,
        )))
  ) throw new Error("integration_unlinked_repair_rotated");

  const { data, error } = await input.admin.rpc(
    "repair_authoritative_unlinked_student_payment_fenced",
    {
      p_expected_local_payment_id: input.target.localPaymentId,
      p_expected_student_id: input.target.studentId,
      p_expected_tenant_id: REFERENCE_TENANT_ID,
      p_expected_integration_id: finalPaymentIntegration.integrationId,
      p_expected_integration_version: finalPaymentIntegration.version,
      p_expected_integration_mode: finalPaymentIntegration.mode,
      p_authoritative_payment: secondPayment,
      p_authoritative_subscription: secondSubscription,
      p_authoritative_customer: secondCustomer,
      p_sync_contract_due_day: input.target.syncContractDueDay,
      p_reason:
        "Conciliação autoritativa de cobrança legada sem vínculo, validada por CPF e contato",
    },
  );
  if (error) throw error;
  const result = data && typeof data === "object"
    ? data as Record<string, unknown>
    : {};
  if (result.ok !== true) {
    return {
      status: 409,
      body: {
        success: false,
        reason: typeof result.reason === "string"
          ? result.reason
          : "AUTHORITATIVE_BINDING_REJECTED",
      },
    };
  }
  if (!["BOUND", "ALREADY_BOUND"].includes(String(result.action || ""))) {
    throw new Error("authoritative_unlinked_repair_result_invalid");
  }
  return {
    status: 200,
    body: {
      success: true,
      action: result.action,
      localPaymentId: input.target.localPaymentId,
      studentId: input.target.studentId,
      contractDueDaySynced: result.contract_due_day_synced === true,
      financialStatus: result.financial_status || null,
    },
  };
}

async function applyHistoricalFactRepairs(input: {
  admin: SupabaseClient;
  paymentIntegration: ResolvedAsaasIntegration;
  providerPayments: ProviderPayment[];
  localPayments: LocalPayment[];
  statement: ProviderStatementEntry[];
  grossLedgerByPaymentId: Map<string, LocalLedgerEntry[]>;
  refundLedgerByPaymentId: Map<string, LocalLedgerEntry[]>;
  repairCreditDates: boolean;
  repairDeletedPayments: boolean;
  providerGetOptions: ProviderGetOptions;
  onProgress: (metrics: HistoricalRepairMetrics) => Promise<void>;
}): Promise<HistoricalRepairMetrics> {
  const metrics: HistoricalRepairMetrics = {
    requested: true,
    creditDatesRepaired: 0,
    creditDatesAlreadyRepaired: 0,
    deletedPaymentsCancelled: 0,
    deletedPaymentsAlreadyCancelled: 0,
    skipped: 0,
  };
  const providerById = new Map(
    input.providerPayments.map((payment) => [payment.id, payment]),
  );
  const statementByPaymentId = new Map<string, ProviderStatementEntry[]>();
  for (const entry of input.statement) {
    const paymentId = statementPaymentId(entry);
    if (!paymentId || entry.type !== "PAYMENT_RECEIVED") continue;
    const entries = statementByPaymentId.get(paymentId) || [];
    entries.push(entry);
    statementByPaymentId.set(paymentId, entries);
  }

  // Fill only a missing historical cash date. The RPC rechecks every field,
  // the unique gross ledger and the independent statement row under lock.
  for (const local of input.repairCreditDates ? input.localPayments : []) {
    const providerId = String(local.asaas_payment_id || "").trim();
    const listedProvider = providerById.get(providerId);
    if (
      !listedProvider || listedProvider.status !== "RECEIVED" ||
      listedProvider.deleted === true ||
      String(local.status || "").toUpperCase() !== "RECEIVED" ||
      local.credited_at
    ) continue;
    // The list response only discovers the candidate. Re-read the exact
    // payment immediately before mutation so a stale page can never authorize
    // a historical repair.
    const provider = await providerGet<ProviderPayment>(
      input.paymentIntegration,
      `/payments/${encodeURIComponent(providerId)}`,
      input.providerGetOptions,
    );
    if (
      provider.id !== providerId || provider.status !== "RECEIVED" ||
      provider.deleted === true
    ) {
      metrics.skipped += 1;
      continue;
    }
    const creditDate = stringDateOnly(provider.creditDate);
    const statements = (statementByPaymentId.get(providerId) || []).filter(
      (entry) =>
        providerStatementDate(entry) === creditDate &&
        moneyCents(entry.value) === moneyCents(provider.value),
    );
    if (
      !creditDate || statements.length !== 1 ||
      (input.grossLedgerByPaymentId.get(local.id) || []).length !== 1 ||
      (input.refundLedgerByPaymentId.get(local.id) || []).length !== 0
    ) {
      metrics.skipped += 1;
      continue;
    }
    const { data, error } = await input.admin.rpc(
      "repair_authoritative_legacy_payment_credit",
      {
        p_expected_local_payment_id: local.id,
        p_expected_tenant_id: local.tenant_id,
        p_authoritative_payment: provider,
        p_authoritative_statement: statements[0],
        p_reason:
          "Conciliação histórica Asaas: GET da cobrança e extrato único concordam",
      },
    );
    if (error) throw error;
    if (data?.ok !== true) {
      metrics.skipped += 1;
    } else if (data.action === "ALREADY_REPAIRED") {
      metrics.creditDatesAlreadyRepaired += 1;
    } else {
      metrics.creditDatesRepaired += 1;
    }
    await input.onProgress({ ...metrics });
  }

  const deletedCandidates = input.repairDeletedPayments
    ? input.localPayments.filter((local) => {
      const provider = providerById.get(String(local.asaas_payment_id || ""));
      return Boolean(
        provider?.deleted === true && provider.subscription &&
          ["PENDING", "OVERDUE", "CANCELLED"].includes(
            String(local.status || "").toUpperCase(),
          ) &&
          (input.grossLedgerByPaymentId.get(local.id) || []).length === 0 &&
          (input.refundLedgerByPaymentId.get(local.id) || []).length === 0,
      );
    })
    : [];
  let subscriptionIntegration: ResolvedAsaasIntegration | null = null;
  const parentById = new Map<string, Record<string, unknown>>();
  if (deletedCandidates.length > 0) {
    subscriptionIntegration = await resolveAsaasIntegration(
      input.admin,
      REFERENCE_TENANT_ID,
      "subscription.read",
    );
    if (
      subscriptionIntegration.integrationId !==
        input.paymentIntegration.integrationId ||
      subscriptionIntegration.version !== input.paymentIntegration.version
    ) {
      throw new Error("integration_repair_resolution_mismatch");
    }
  }
  for (const local of deletedCandidates) {
    const providerId = String(local.asaas_payment_id || "");
    const provider = await providerGet<ProviderPayment>(
      input.paymentIntegration,
      `/payments/${encodeURIComponent(providerId)}`,
      input.providerGetOptions,
    );
    if (
      provider.id !== providerId || provider.deleted !== true ||
      !provider.subscription
    ) {
      metrics.skipped += 1;
      continue;
    }
    const subscriptionId = String(provider.subscription || "").trim();
    let parent = parentById.get(subscriptionId);
    if (!parent) {
      parent = await providerGet<Record<string, unknown>>(
        subscriptionIntegration!,
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        input.providerGetOptions,
      );
      parentById.set(subscriptionId, parent);
    }
    const { data, error } = await input.admin.rpc(
      "repair_authoritative_deleted_legacy_payment",
      {
        p_expected_local_payment_id: local.id,
        p_expected_student_id: local.student_id || null,
        p_expected_tenant_id: local.tenant_id,
        p_authoritative_payment: provider,
        p_authoritative_subscription: parent,
        p_reason:
          "Conciliação histórica Asaas: cobrança excluída no provedor e sem evidência de caixa",
      },
    );
    if (error) throw error;
    if (data?.ok !== true) {
      metrics.skipped += 1;
    } else if (data.action === "ALREADY_CANCELLED") {
      metrics.deletedPaymentsAlreadyCancelled += 1;
    } else {
      metrics.deletedPaymentsCancelled += 1;
    }
    await input.onProgress({ ...metrics });
  }
  return metrics;
}

async function providerGet<T>(
  integration: ResolvedAsaasIntegration,
  path: string,
  options: ProviderGetOptions = {},
): Promise<T> {
  for (let attempt = 0;; attempt += 1) {
    await options.beforeAttempt?.();
    const deadlineRemainingMs = options.deadlineAt
      ? options.deadlineAt - Date.now()
      : Number.POSITIVE_INFINITY;
    if (deadlineRemainingMs <= 5_000) {
      throw new ProviderRepairDeadlineError();
    }
    const attemptTimeoutMs = options.deadlineAt ? 8_000 : 20_000;
    let response: Response;
    try {
      response = await fetch(`${integration.baseUrl}${path}`, {
        method: "GET",
        headers: {
          accept: "application/json",
          access_token: integration.apiKey,
        },
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(attemptTimeoutMs, deadlineRemainingMs - 5_000)),
        ),
      });
    } catch (error) {
      if (options.retryTransient !== true) throw error;
      const retryDelay = providerRetryDelayMs(
        0,
        null,
        attempt,
        Math.max(0, Number(options.deadlineAt || 0) - Date.now() - 13_000),
      );
      if (retryDelay === null) throw error;
      await options.onRetryWait?.({
        status: 0,
        attempt,
        delayMs: retryDelay,
      });
      await waitForProvider(retryDelay);
      continue;
    }
    const body = (await response.json().catch(() => ({}))) as T;
    if (response.ok) return body;
    const canRetry = response.status === 429
      ? options.retryRateLimit === true
      : options.retryTransient === true;
    if (!canRetry) throw new ProviderGetError(response.status);
    const retryDelay = providerRetryDelayMs(
      response.status,
      response.headers.get("retry-after"),
      attempt,
      Math.max(0, Number(options.deadlineAt || 0) - Date.now() - 13_000),
    );
    if (retryDelay === null) throw new ProviderGetError(response.status);
    await options.onRetryWait?.({
      status: response.status,
      attempt,
      delayMs: retryDelay,
    });
    await waitForProvider(retryDelay);
  }
}

async function providerListAll<T>(
  integration: ResolvedAsaasIntegration,
  path: string,
  params: URLSearchParams,
  cursorKey: string,
  cursorState: CursorState,
  onCursor: (next: CursorState) => Promise<void>,
  providerGetOptions?: ProviderGetOptions,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0, pages = 0; pages < 1_000; offset += 100, pages++) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", "100");
    pageParams.set("offset", String(offset));
    const page = await providerGet<ProviderList<T>>(
      integration,
      `${path}?${pageParams}`,
      providerGetOptions,
    );
    const data = Array.isArray(page.data) ? page.data : [];
    rows.push(...data);
    cursorState[cursorKey] = offset + data.length;
    await onCursor({ ...cursorState });
    if (page.hasMore !== true) return rows;
  }
  throw new Error(`${cursorKey}_page_limit`);
}

async function fetchAllLocalPayments(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<LocalPayment[]> {
  const rows: LocalPayment[] = [];
  for (let from = 0, pages = 0; pages < 1_000; from += 1_000, pages++) {
    const { data, error } = await supabase
      .from("student_payments")
      .select(
        "id,tenant_id,student_id,asaas_payment_id,value,status,provider_status,created_at,due_date,payment_date,credited_at,paid_at,refunded_amount,last_provider_event_id,last_provider_event_at,ledger_entry_created,billing_type,raw_payload",
      )
      .eq("tenant_id", tenantId)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    const page = (data || []) as LocalPayment[];
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
  throw new Error("local_payments_page_limit");
}

type ProductPaymentState = {
  paymentByProviderId: Map<string, LocalProductPayment[]>;
  referenceByExternalReference: Map<string, LocalProductReference[]>;
  localEntityCount: number;
};

type HubCheckoutPaymentRow = {
  id: string;
  asaas_payment_id?: string | null;
};

type HubSubscriptionPaymentRow = {
  id: string | number;
  checkout_id: string;
  provider_payment_id?: string | null;
};

type SaasCheckoutPaymentRow = {
  id: string;
  tenant_id?: string | null;
  asaas_payment_id?: string | null;
};

type SaasInvoicePaymentRow = {
  id: string;
  tenant_id?: string | null;
  asaas_payment_id?: string | null;
};

type WolfieTopupPaymentRow = {
  id: string;
  provider_payment_id?: string | null;
};

async function fetchAllRows<T>(
  supabase: SupabaseClient,
  table: string,
  columns: string,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0, pages = 0; pages < 1_000; from += 1_000, pages++) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    const page = (data || []) as T[];
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
  throw new Error(`${table}_page_limit`);
}

async function fetchProductPaymentState(
  supabase: SupabaseClient,
): Promise<ProductPaymentState> {
  const [
    hubCheckouts,
    hubSubscriptionPayments,
    saasCheckouts,
    saasInvoices,
    topupOrders,
  ] = await Promise.all([
    fetchAllRows<HubCheckoutPaymentRow>(
      supabase,
      "hub_checkout_sessions",
      "id,asaas_payment_id",
    ),
    fetchAllRows<HubSubscriptionPaymentRow>(
      supabase,
      "hub_subscription_payments",
      "id,checkout_id,provider_payment_id",
    ),
    fetchAllRows<SaasCheckoutPaymentRow>(
      supabase,
      "saas_checkout_intents",
      "id,tenant_id,asaas_payment_id",
    ),
    fetchAllRows<SaasInvoicePaymentRow>(
      supabase,
      "saas_invoices",
      "id,tenant_id,asaas_payment_id",
    ),
    fetchAllRows<WolfieTopupPaymentRow>(
      supabase,
      "wolfie_topup_orders",
      "id,provider_payment_id",
    ),
  ]);

  const paymentByProviderId = new Map<string, LocalProductPayment[]>();
  const referenceByExternalReference = new Map<
    string,
    LocalProductReference[]
  >();
  const addPayment = (providerId: string, payment: LocalProductPayment) => {
    const candidates = paymentByProviderId.get(providerId) || [];
    candidates.push(payment);
    paymentByProviderId.set(providerId, candidates);
  };
  const addReference = (
    externalReference: string,
    reference: LocalProductReference,
  ) => {
    const candidates = referenceByExternalReference.get(externalReference) ||
      [];
    candidates.push(reference);
    referenceByExternalReference.set(externalReference, candidates);
  };
  const checkoutByHubId = new Map(
    hubCheckouts.map((checkout) => [checkout.id, checkout]),
  );
  const saasCheckoutIdsByTenant = new Map<string, string[]>();

  for (const checkout of hubCheckouts) {
    const externalReference = `hub:${checkout.id}`;
    addReference(externalReference, {
      family: "HUB",
      localEntityId: checkout.id,
    });
    if (checkout.asaas_payment_id) {
      addPayment(checkout.asaas_payment_id, {
        family: "HUB",
        localEntityId: checkout.id,
        externalReference,
      });
    }
  }
  for (const payment of hubSubscriptionPayments) {
    if (!payment.provider_payment_id) continue;
    const checkout = checkoutByHubId.get(payment.checkout_id);
    addPayment(payment.provider_payment_id, {
      family: "HUB",
      localEntityId: String(payment.id),
      externalReference: checkout ? `hub:${checkout.id}` : null,
    });
  }

  for (const checkout of saasCheckouts) {
    const externalReference = `saas:${checkout.id}`;
    addReference(externalReference, {
      family: "SAAS",
      localEntityId: checkout.id,
    });
    if (checkout.tenant_id) {
      const ids = saasCheckoutIdsByTenant.get(checkout.tenant_id) || [];
      ids.push(checkout.id);
      saasCheckoutIdsByTenant.set(checkout.tenant_id, ids);
    }
    if (checkout.asaas_payment_id) {
      addPayment(checkout.asaas_payment_id, {
        family: "SAAS",
        localEntityId: checkout.id,
        externalReference,
      });
    }
  }
  for (const invoice of saasInvoices) {
    if (!invoice.asaas_payment_id) continue;
    const checkoutIds = invoice.tenant_id
      ? saasCheckoutIdsByTenant.get(invoice.tenant_id) || []
      : [];
    addPayment(invoice.asaas_payment_id, {
      family: "SAAS",
      localEntityId: invoice.id,
      // A tenant with more than one checkout is deliberately not guessed.
      // The provider ID still proves this is a SaaS payment, while omitting
      // the expected reference avoids a false identity assertion.
      externalReference: checkoutIds.length === 1
        ? `saas:${checkoutIds[0]}`
        : null,
    });
  }

  for (const order of topupOrders) {
    const externalReference = `wolfie-topup-order:${order.id}`;
    const reference = {
      family: "WOLFIE_TOPUP" as const,
      localEntityId: order.id,
    };
    addReference(externalReference, reference);
    // Keep compatibility with the one historical alias that the webhook
    // accepts, while new charges use wolfie-topup-order:<uuid>.
    addReference(`topup:${order.id}`, reference);
    if (order.provider_payment_id) {
      addPayment(order.provider_payment_id, {
        ...reference,
        externalReference,
      });
    }
  }

  return {
    paymentByProviderId,
    referenceByExternalReference,
    localEntityCount: hubCheckouts.length + hubSubscriptionPayments.length +
      saasCheckouts.length + saasInvoices.length + topupOrders.length,
  };
}

async function fetchAllProfiles(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<
  Array<{
    id: string;
    tenant_id: string | null;
    asaas_customer_id: string | null;
  }>
> {
  const rows: Array<{
    id: string;
    tenant_id: string | null;
    asaas_customer_id: string | null;
  }> = [];
  for (let from = 0, pages = 0; pages < 1_000; from += 1_000, pages++) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id,tenant_id,asaas_customer_id")
      .eq("role", "STUDENT")
      .eq("tenant_id", tenantId)
      .not("asaas_customer_id", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
  throw new Error("profiles_page_limit");
}

async function fetchLedgerRows(
  supabase: SupabaseClient,
  tenantId: string,
  referenceColumn: "student_payment_id" | "refund_student_payment_id",
): Promise<LocalLedgerEntry[]> {
  const rows: LocalLedgerEntry[] = [];
  let afterId: string | null = null;
  for (let pages = 0; pages < 1_000; pages++) {
    let query = supabase
      .from("financial_transactions")
      .select(
        "id,student_payment_id,refund_student_payment_id,provider_event_id,amount,occurred_at,type,category",
      )
      .eq("tenant_id", tenantId)
      .not(referenceColumn, "is", null)
      .order("id", { ascending: true })
      .limit(1_000);
    if (afterId) query = query.gt("id", afterId);
    const { data, error } = await query;
    if (error) throw error;
    const page = (data || []) as LocalLedgerEntry[];
    rows.push(...page);
    if (page.length < 1_000) return rows;
    const nextId = page.at(-1)?.id;
    if (!nextId || nextId === afterId) throw new Error("ledger_cursor_stalled");
    afterId = nextId;
  }
  throw new Error(`${referenceColumn}_ledger_page_limit`);
}

function groupLedgerRows(
  rows: LocalLedgerEntry[],
  referenceColumn: "student_payment_id" | "refund_student_payment_id",
): Map<string, LocalLedgerEntry[]> {
  const grouped = new Map<string, LocalLedgerEntry[]>();
  for (const row of rows) {
    const paymentId = row[referenceColumn];
    if (!paymentId) continue;
    const entries = grouped.get(paymentId) || [];
    entries.push(row);
    grouped.set(paymentId, entries);
  }
  return grouped;
}

async function fetchLedgerState(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<{
  grossRows: LocalLedgerEntry[];
  refundRows: LocalLedgerEntry[];
  grossByPaymentId: Map<string, LocalLedgerEntry[]>;
  refundByPaymentId: Map<string, LocalLedgerEntry[]>;
}> {
  // Query both reference classes independently. A refund row must never be
  // mistaken for the unique gross receipt that drives ledger_entry_created.
  const [grossRows, refundRows] = await Promise.all([
    fetchLedgerRows(supabase, tenantId, "student_payment_id"),
    fetchLedgerRows(supabase, tenantId, "refund_student_payment_id"),
  ]);
  return {
    grossRows,
    refundRows,
    grossByPaymentId: groupLedgerRows(grossRows, "student_payment_id"),
    refundByPaymentId: groupLedgerRows(
      refundRows,
      "refund_student_payment_id",
    ),
  };
}

async function fetchTransferAttempts(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<LocalTransferAttempt[]> {
  const rows: LocalTransferAttempt[] = [];
  for (let from = 0, pages = 0; pages < 1_000; from += 1_000, pages++) {
    const { data, error } = await supabase
      .from("asaas_teacher_transfer_attempts")
      .select(
        "id,closing_id,tenant_id,external_reference,provider_transfer_id,provider_status,status,expected_amount",
      )
      .eq("tenant_id", tenantId)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    const page = (data || []) as LocalTransferAttempt[];
    rows.push(...page);
    if (page.length < 1_000) return rows;
  }
  throw new Error("local_transfers_page_limit");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowService: true,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  const request = (await req.json().catch(() => ({}))) as {
    lookbackDays?: unknown;
    windowStart?: unknown;
    windowEnd?: unknown;
    repairHistoricalFacts?: unknown;
    repairHistoricalCredits?: unknown;
    repairHistoricalDeletedPayments?: unknown;
    repairUnlinkedPayment?: unknown;
  };
  const repairHistoricalCredits = request.repairHistoricalFacts === true ||
    request.repairHistoricalCredits === true;
  const repairHistoricalDeletedPayments =
    request.repairHistoricalFacts === true ||
    request.repairHistoricalDeletedPayments === true;
  const repairHistoricalFacts = repairHistoricalCredits ||
    repairHistoricalDeletedPayments;
  const hasUnlinkedRepair = Object.prototype.hasOwnProperty.call(
    request,
    "repairUnlinkedPayment",
  );
  const unlinkedRepairTarget = hasUnlinkedRepair
    ? parseAuthoritativeUnlinkedRepairTarget(request.repairUnlinkedPayment)
    : null;
  if (hasUnlinkedRepair && !unlinkedRepairTarget) {
    return new Response(
      JSON.stringify({ error: "INVALID_UNLINKED_PAYMENT_REPAIR" }),
      { status: 400, headers: corsHeaders },
    );
  }
  if (unlinkedRepairTarget && repairHistoricalFacts) {
    return new Response(
      JSON.stringify({ error: "AMBIGUOUS_REPAIR_OPERATION" }),
      { status: 400, headers: corsHeaders },
    );
  }
  if (
    (repairHistoricalFacts || unlinkedRepairTarget) && !auth.context.isService
  ) {
    return new Response(
      JSON.stringify({ error: "SERVICE_ACCESS_REQUIRED_FOR_REPAIR" }),
      { status: 403, headers: corsHeaders },
    );
  }
  if (unlinkedRepairTarget) {
    try {
      const result = await applyAuthoritativeUnlinkedRepair({
        admin: auth.context.admin,
        target: unlinkedRepairTarget,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: corsHeaders,
      });
    } catch (error) {
      console.error("[asaas-reconcile] unlinked repair failed", {
        type: error instanceof Error ? error.name : "unknown",
      });
      const rateLimited = error instanceof ProviderGetError &&
        error.status === 429;
      const deadlineExhausted = error instanceof ProviderRepairDeadlineError;
      return new Response(
        JSON.stringify({
          error: rateLimited
            ? "ASAAS_RATE_LIMITED_RETRY_LATER"
            : deadlineExhausted
            ? "ASAAS_REPAIR_WINDOW_EXHAUSTED"
            : "AUTHORITATIVE_UNLINKED_REPAIR_FAILED",
          retryable: rateLimited || deadlineExhausted,
        }),
        {
          status: rateLimited ? 429 : deadlineExhausted ? 503 : 500,
          headers: corsHeaders,
        },
      );
    }
  }
  const yesterday = new Date();
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const parsedLookback = Number(request.lookbackDays);
  const lookbackDays = Number.isInteger(parsedLookback)
    ? Math.max(1, Math.min(parsedLookback, 366))
    : 45;
  const defaultEnd = dateOnly(yesterday);
  const defaultStartDate = new Date(`${defaultEnd}T12:00:00Z`);
  defaultStartDate.setUTCDate(defaultStartDate.getUTCDate() - lookbackDays + 1);
  const windowStart = validDate(request.windowStart)
    ? request.windowStart
    : dateOnly(defaultStartDate);
  const windowEnd = validDate(request.windowEnd)
    ? request.windowEnd
    : defaultEnd;
  const spanDays = Math.floor(
    (Date.parse(`${windowEnd}T12:00:00Z`) -
      Date.parse(`${windowStart}T12:00:00Z`)) /
      86_400_000,
  );
  if (spanDays < 0 || spanDays > 366) {
    return new Response(
      JSON.stringify({ error: "INVALID_RECONCILIATION_WINDOW" }),
      {
        status: 400,
        headers: corsHeaders,
      },
    );
  }
  // Repair requests are intentionally bounded. Normal reconciliation and
  // deploy smoke checks never enter provider retry waits.
  const repairProviderDeadlineAt = repairHistoricalFacts
    ? Date.now() + HISTORICAL_REPAIR_BUDGET_MS
    : undefined;

  let runId: string | null = null;
  try {
    const { data: started, error: startError } = await auth.context.admin.rpc(
      "begin_asaas_reconciliation_run",
      {
        p_window_start: windowStart,
        p_window_end: windowEnd,
        p_started_by: auth.context.userId,
      },
    );
    if (startError) throw startError;
    if (!started?.ok) {
      return new Response(
        JSON.stringify({
          error: "RECONCILIATION_ALREADY_RUNNING",
          runId: started?.run_id || null,
        }),
        { status: 409, headers: corsHeaders },
      );
    }
    runId = started.run_id;

    // This monitor intentionally audits only the explicitly bound root-account
    // tenant. It never falls back to a global credential for another school.
    // Resolve after creating the run so a missing/disabled integration becomes
    // an observable FAILED audit instead of a silent 500.
    const integration = await resolveAsaasIntegration(
      auth.context.admin,
      REFERENCE_TENANT_ID,
      "payment.list",
    );

    const cursorState: CursorState = {};
    const saveCursor = async (next: CursorState) => {
      const { error } = await auth.context.admin
        .from("asaas_reconciliation_runs")
        .update({ cursor_state: next, updated_at: new Date().toISOString() })
        .eq("id", runId);
      if (error) throw error;
    };
    let previousRepairProviderReadAt = 0;
    const paceProviderRead = async (minimumIntervalMs: number) => {
      if (!repairHistoricalFacts) return;
      const delayMs = Math.max(
        0,
        previousRepairProviderReadAt + minimumIntervalMs - Date.now(),
      );
      if (
        delayMs > 0 &&
        Date.now() + delayMs >= Number(repairProviderDeadlineAt || 0) - 5_000
      ) {
        throw new ProviderRepairDeadlineError();
      }
      if (delayMs > 0) await waitForProvider(delayMs);
      previousRepairProviderReadAt = Date.now();
    };
    const onRepairRetryWait: NonNullable<
      ProviderGetOptions["onRetryWait"]
    > = async ({ status, delayMs }) => {
      cursorState.provider_retry_waits =
        (cursorState.provider_retry_waits || 0) + 1;
      cursorState.provider_retry_status = status;
      cursorState.provider_retry_delay_ms = delayMs;
      await saveCursor({ ...cursorState });
    };
    // Discovery GETs are read-only and short-lived; the fresh GET immediately
    // authorizing a mutation remains deliberately slower. Both share one
    // clock, so the first authoritative read also waits a full 1.1 seconds.
    const repairAuditProviderGetOptions: ProviderGetOptions =
      repairHistoricalFacts
        ? {
          retryRateLimit: true,
          retryTransient: true,
          deadlineAt: repairProviderDeadlineAt,
          beforeAttempt: () => paceProviderRead(250),
          onRetryWait: onRepairRetryWait,
        }
        : {};
    const authoritativeRepairProviderGetOptions: ProviderGetOptions =
      repairHistoricalFacts
        ? {
          retryRateLimit: true,
          retryTransient: true,
          deadlineAt: repairProviderDeadlineAt,
          beforeAttempt: () => paceProviderRead(1_100),
          onRetryWait: onRepairRetryWait,
        }
        : {};

    const paymentParams = new URLSearchParams({ includeDeleted: "true" });
    paymentParams.set("dateCreated[ge]", windowStart);
    paymentParams.set("dateCreated[le]", windowEnd);
    const providerPayments = await providerListAll<ProviderPayment>(
      integration,
      "/payments",
      paymentParams,
      "payments_offset",
      cursorState,
      saveCursor,
      repairAuditProviderGetOptions,
    );

    const statementParams = new URLSearchParams({
      startDate: windowStart,
      finishDate: windowEnd,
      order: "asc",
    });
    const statement = await providerListAll<ProviderStatementEntry>(
      integration,
      "/financialTransactions",
      statementParams,
      "statement_offset",
      cursorState,
      saveCursor,
      repairAuditProviderGetOptions,
    );

    const localTransfers = await fetchTransferAttempts(
      auth.context.admin,
      REFERENCE_TENANT_ID,
    );
    const teacherTransferEnabled =
      Deno.env.get("ASAAS_TEACHER_TRANSFER_ENABLED") === "true";
    let transferIntegration: ResolvedAsaasIntegration | null = null;
    const transferAudit = await runTransferAudit(
      teacherTransferEnabled,
      localTransfers.length,
      async () => {
        transferIntegration = await resolveAsaasIntegration(
          auth.context.admin,
          REFERENCE_TENANT_ID,
          "transfer.list",
        );
        if (
          transferIntegration.integrationId !== integration.integrationId ||
          transferIntegration.version !== integration.version
        ) {
          throw new Error("integration_reconciliation_resolution_mismatch");
        }
        const transferParams = new URLSearchParams();
        transferParams.set("dateCreated[ge]", windowStart);
        transferParams.set("dateCreated[le]", windowEnd);
        return await providerListAll<ProviderTransfer>(
          transferIntegration,
          "/transfers",
          transferParams,
          "transfers_offset",
          cursorState,
          saveCursor,
          repairAuditProviderGetOptions,
        );
      },
    );
    const transferAuditPlan = transferAudit.plan;
    const providerTransfers = transferAudit.providerTransfers;
    if (transferAuditPlan === "SKIP_DISABLED_WITHOUT_LOCAL_ATTEMPTS") {
      cursorState.transfer_audit_skipped = 1;
      await saveCursor({ ...cursorState });
    }

    // A payment can have been created before the window and received inside
    // it. Enrich the payment list from statement references with individual
    // GETs; never import or mutate the provider/local payment.
    const providerPaymentIds = new Set(
      providerPayments.map((payment) => payment.id),
    );
    const statementPaymentIds = [
      ...new Set(
        statement
          .map(statementPaymentId)
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    for (let index = 0; index < statementPaymentIds.length; index++) {
      const paymentId = statementPaymentIds[index];
      if (providerPaymentIds.has(paymentId)) continue;
      try {
        const payment = await providerGet<ProviderPayment>(
          integration,
          `/payments/${encodeURIComponent(paymentId)}`,
          repairAuditProviderGetOptions,
        );
        if (payment?.id) {
          providerPayments.push(payment);
          providerPaymentIds.add(payment.id);
        }
      } catch (error) {
        // A genuine 404 remains evidence for the diff. Transient/provider
        // failures abort the run so an incomplete read is never reported as a
        // financial discrepancy.
        if (!(error instanceof ProviderGetError) || error.status !== 404) {
          throw error;
        }
      }
      cursorState.statement_payment_details = index + 1;
      if ((index + 1) % 25 === 0) await saveCursor({ ...cursorState });
    }
    await saveCursor({ ...cursorState });

    let [
      localPayments,
      profiles,
      ledgerState,
      productPaymentState,
    ] = await Promise.all([
      fetchAllLocalPayments(auth.context.admin, REFERENCE_TENANT_ID),
      fetchAllProfiles(auth.context.admin, REFERENCE_TENANT_ID),
      fetchLedgerState(auth.context.admin, REFERENCE_TENANT_ID),
      fetchProductPaymentState(auth.context.admin),
    ]);

    // Listing payments by creation date alone misses a charge created before
    // this window whose due/payment/credit date falls inside it. Complete the
    // read-only snapshot with an exact GET for every scoped local candidate.
    const localDetailCandidates = localPayments.filter((payment) => {
      const providerId = payment.asaas_payment_id || "";
      return Boolean(
        providerId &&
          !providerId.startsWith("MANUAL_") &&
          !providerPaymentIds.has(providerId) &&
          localPaymentTouchesWindow(payment, windowStart, windowEnd),
      );
    });
    for (let index = 0; index < localDetailCandidates.length; index++) {
      const paymentId = localDetailCandidates[index].asaas_payment_id!;
      try {
        const payment = await providerGet<ProviderPayment>(
          integration,
          `/payments/${encodeURIComponent(paymentId)}`,
          repairAuditProviderGetOptions,
        );
        if (payment?.id) {
          providerPayments.push(payment);
          providerPaymentIds.add(payment.id);
        }
      } catch (error) {
        if (!(error instanceof ProviderGetError) || error.status !== 404) {
          throw error;
        }
      }
      cursorState.local_payment_details = index + 1;
      if ((index + 1) % 25 === 0) await saveCursor({ ...cursorState });
    }
    await saveCursor({ ...cursorState });

    const providerTransferIds = new Set(
      providerTransfers
        .map((transfer) => transfer.id)
        .filter((value): value is string => Boolean(value)),
    );
    const transferDetailCandidates = localTransfers.filter((attempt) =>
      Boolean(
        attempt.provider_transfer_id &&
          !providerTransferIds.has(attempt.provider_transfer_id),
      )
    );
    if (transferDetailCandidates.length > 0) {
      if (!transferIntegration) {
        throw new Error("transfer_integration_required");
      }
      for (let index = 0; index < transferDetailCandidates.length; index++) {
        const transferId = transferDetailCandidates[index]
          .provider_transfer_id!;
        try {
          const transfer = await providerGet<ProviderTransfer>(
            transferIntegration,
            `/transfers/${encodeURIComponent(transferId)}`,
            repairAuditProviderGetOptions,
          );
          if (transfer?.id) {
            providerTransfers.push(transfer);
            providerTransferIds.add(transfer.id);
          }
        } catch (error) {
          if (!(error instanceof ProviderGetError) || error.status !== 404) {
            throw error;
          }
        }
        cursorState.local_transfer_details = index + 1;
        if ((index + 1) % 25 === 0) await saveCursor({ ...cursorState });
      }
    }
    await saveCursor({ ...cursorState });

    const { data: verified, error: verificationError } = await auth.context
      .admin.rpc(
        "record_tenant_integration_verified",
        {
          p_tenant_id: REFERENCE_TENANT_ID,
          p_provider: "asaas",
          p_expected_version: integration.version,
        },
      );
    if (verificationError || verified !== true) {
      throw verificationError || new Error("integration_verification_stale");
    }

    const customerByStudentId = new Map<string, string>();
    const studentsByCustomerCandidates = new Map<
      string,
      Array<{ id: string; tenantId: string | null }>
    >();
    for (const profile of profiles) {
      if (!profile.asaas_customer_id) continue;
      customerByStudentId.set(profile.id, profile.asaas_customer_id);
      const candidates =
        studentsByCustomerCandidates.get(profile.asaas_customer_id) || [];
      candidates.push({ id: profile.id, tenantId: profile.tenant_id });
      studentsByCustomerCandidates.set(profile.asaas_customer_id, candidates);
    }
    let historicalRepairs: HistoricalRepairMetrics = {
      requested: false,
      creditDatesRepaired: 0,
      creditDatesAlreadyRepaired: 0,
      deletedPaymentsCancelled: 0,
      deletedPaymentsAlreadyCancelled: 0,
      skipped: 0,
    };
    if (repairHistoricalFacts) {
      historicalRepairs = await applyHistoricalFactRepairs({
        admin: auth.context.admin,
        paymentIntegration: integration,
        providerPayments,
        localPayments,
        statement,
        grossLedgerByPaymentId: ledgerState.grossByPaymentId,
        refundLedgerByPaymentId: ledgerState.refundByPaymentId,
        repairCreditDates: repairHistoricalCredits,
        repairDeletedPayments: repairHistoricalDeletedPayments,
        providerGetOptions: authoritativeRepairProviderGetOptions,
        onProgress: async (progress) => {
          const { error } = await auth.context.admin
            .from("asaas_reconciliation_runs")
            .update({
              metrics: {
                partial: true,
                historicalRepairs: progress,
              },
              updated_at: new Date().toISOString(),
            })
            .eq("id", runId)
            .eq("status", "RUNNING");
          if (error) throw error;
        },
      });
      // Database triggers update paid_at and the immutable gross ledger date.
      // Re-read both snapshots so this very run reports the post-repair truth.
      [localPayments, ledgerState] = await Promise.all([
        fetchAllLocalPayments(auth.context.admin, REFERENCE_TENANT_ID),
        fetchLedgerState(auth.context.admin, REFERENCE_TENANT_ID),
      ]);
    }
    const issues = buildReconciliationIssues({
      windowStart,
      windowEnd,
      referenceTenantId: REFERENCE_TENANT_ID,
      providerPayments,
      localPayments,
      statement,
      grossLedgerByPaymentId: ledgerState.grossByPaymentId,
      refundLedgerByPaymentId: ledgerState.refundByPaymentId,
      customerByStudentId,
      studentByCustomerId: studentsByCustomerCandidates,
      productPaymentByProviderId: productPaymentState.paymentByProviderId,
      productReferenceByExternalReference:
        productPaymentState.referenceByExternalReference,
      providerTransfers,
      localTransfers,
    });
    for (let offset = 0; offset < issues.length; offset += 500) {
      const batch = issues.slice(offset, offset + 500).map((issue) => ({
        run_id: runId,
        ...issue,
      }));
      const { error } = await auth.context.admin
        .from("asaas_reconciliation_issues")
        .insert(batch);
      if (error) throw error;
    }

    const metrics = {
      providerPayments: providerPayments.length,
      statementEntries: statement.length,
      providerTransfers: providerTransfers.length,
      teacherTransferEnabled,
      transferAuditPlan,
      localPayments: localPayments.length,
      grossLedgerEntries: ledgerState.grossRows.length,
      refundLedgerEntries: ledgerState.refundRows.length,
      localTransfers: localTransfers.length,
      localProductEntities: productPaymentState.localEntityCount,
      localProductPaymentIds: productPaymentState.paymentByProviderId.size,
      tenantId: REFERENCE_TENANT_ID,
      historicalRepairs,
      issues: issues.length,
      severity: {
        critical: issues.filter((issue) => issue.severity === "CRITICAL")
          .length,
        high: issues.filter((issue) => issue.severity === "HIGH").length,
        warning: issues.filter((issue) => issue.severity === "WARNING").length,
        info: issues.filter((issue) => issue.severity === "INFO").length,
      },
    };
    const { error: finishError } = await auth.context.admin
      .from("asaas_reconciliation_runs")
      .update({
        status: "COMPLETED",
        metrics,
        cursor_state: cursorState,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", runId);
    if (finishError) throw finishError;

    return new Response(
      JSON.stringify({
        success: true,
        readOnlyProviderAccess: true,
        runId,
        windowStart,
        windowEnd,
        metrics,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (error) {
    console.error("[asaas-reconcile] run failed", {
      type: error instanceof Error ? error.name : "unknown",
    });
    if (runId) {
      await auth.context.admin
        .from("asaas_reconciliation_runs")
        .update({
          status: "FAILED",
          last_error: error instanceof Error
            ? error.message.slice(0, 500)
            : "unknown",
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", runId);
    }
    const rateLimited = error instanceof ProviderGetError &&
      error.status === 429;
    const repairDeadlineExhausted = error instanceof
      ProviderRepairDeadlineError;
    const retryable = rateLimited || repairDeadlineExhausted;
    return new Response(
      JSON.stringify({
        error: rateLimited
          ? "ASAAS_RATE_LIMITED_RETRY_LATER"
          : repairDeadlineExhausted
          ? "ASAAS_REPAIR_WINDOW_EXHAUSTED"
          : "ASAAS_RECONCILIATION_FAILED",
        retryable,
        runId,
      }),
      {
        status: rateLimited ? 429 : repairDeadlineExhausted ? 503 : 500,
        headers: corsHeaders,
      },
    );
  }
});
