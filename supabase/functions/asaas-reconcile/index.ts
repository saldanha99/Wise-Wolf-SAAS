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

async function providerGet<T>(
  integration: ResolvedAsaasIntegration,
  path: string,
): Promise<T> {
  const response = await fetch(`${integration.baseUrl}${path}`, {
    method: "GET",
    headers: { accept: "application/json", access_token: integration.apiKey },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as T;
  if (!response.ok) throw new ProviderGetError(response.status);
  return body;
}

async function providerListAll<T>(
  integration: ResolvedAsaasIntegration,
  path: string,
  params: URLSearchParams,
  cursorKey: string,
  cursorState: CursorState,
  onCursor: (next: CursorState) => Promise<void>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0, pages = 0; pages < 1_000; offset += 100, pages++) {
    const pageParams = new URLSearchParams(params);
    pageParams.set("limit", "100");
    pageParams.set("offset", String(offset));
    const page = await providerGet<ProviderList<T>>(
      integration,
      `${path}?${pageParams}`,
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
  };
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

    const [
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
    const issues = buildReconciliationIssues({
      windowStart,
      windowEnd,
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
    return new Response(
      JSON.stringify({ error: "ASAAS_RECONCILIATION_FAILED", runId }),
      {
        status: 500,
        headers: corsHeaders,
      },
    );
  }
});
