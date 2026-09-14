/** Operator-only seven-case plan. Private manifests never belong in Git. */
export type Row = Record<string, unknown>;
export type Integration = {
  integrationId: string;
  tenantId: string;
  version: number;
  mode: string;
  environment: string;
  baseUrl: string;
  apiKey: string;
};
export interface AdjudicationCase {
  case_key: string;
  disposition: "IMPORT_STUDENT" | "IMPORT_UNASSIGNED" | "DUPLICATE_OF";
  expected_payment: Row;
  student_id?: string | null;
  expected_canonical?: Row | null;
  prepayment?: { mode: "MENSAL"; months: 6; first_month: string } | null;
  reason: string;
}
export interface Manifest {
  version: 1;
  tenant_id: "school-wise-wolf";
  batch_id: string;
  operator: string;
  approval_ref: string;
  cases: AdjudicationCase[];
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Row =>
  !!value && typeof value === "object" && !Array.isArray(value);
const fail = (code: string): never => {
  throw new Error(code);
};
function keys(value: Row, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    fail("manifest_unknown_fields");
  }
}
const date = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const time = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(time.getTime()) &&
    time.toISOString().slice(0, 10) === value;
};
export function amountCents(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^\d+(\.\d{1,2})?$/.test(String(value))
  ) return fail("amount_invalid");
  const [whole, fractional = ""] = String(value).split(".");
  const result = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  return Number.isSafeInteger(result) && result > 0
    ? result
    : fail("amount_invalid");
}
function expectedPayment(value: unknown, canonical: boolean) {
  if (!object(value)) return fail("manifest_payment_invalid");
  keys(value, [
    "id",
    "customer",
    "value",
    "dueDate",
    "paymentDate",
    "creditDate",
    "subscription",
  ]);
  if (
    !/^pay_[A-Za-z0-9]+$/.test(String(value.id)) ||
    !/^cus_[A-Za-z0-9]+$/.test(String(value.customer)) ||
    !date(value.dueDate) || !date(value.paymentDate) ||
    (!canonical && !date(value.creditDate)) ||
    (canonical
      ? !/^sub_[A-Za-z0-9]+$/.test(String(value.subscription))
      : value.subscription != null)
  ) fail("manifest_payment_invalid");
  amountCents(value.value);
}
export function parseManifest(value: unknown): Manifest {
  if (!object(value)) return fail("manifest_invalid");
  keys(value, [
    "version",
    "tenant_id",
    "batch_id",
    "operator",
    "approval_ref",
    "cases",
  ]);
  if (
    value.version !== 1 || value.tenant_id !== "school-wise-wolf" ||
    !uuid.test(String(value.batch_id)) ||
    typeof value.operator !== "string" || value.operator.trim().length < 3 ||
    value.operator.length > 120 ||
    !/^[0-9a-f]{64}$/.test(String(value.approval_ref)) ||
    !Array.isArray(value.cases) || value.cases.length !== 7
  ) fail("manifest_invalid");
  const cases = value.cases as unknown[];
  const seen = new Set<string>();
  const providers = new Set<string>();
  let students = 0;
  let unassigned = 0;
  let duplicates = 0;
  let monthly = 0;
  for (const item of cases) {
    if (!object(item)) return fail("manifest_case_invalid");
    keys(item, [
      "case_key",
      "disposition",
      "expected_payment",
      "student_id",
      "expected_canonical",
      "prepayment",
      "reason",
    ]);
    if (
      !/^C\d{2}$/.test(String(item.case_key)) ||
      seen.has(String(item.case_key)) || typeof item.reason !== "string" ||
      item.reason.trim().length < 12 || item.reason.length > 500
    ) fail("manifest_case_invalid");
    seen.add(String(item.case_key));
    expectedPayment(item.expected_payment, false);
    const payment = item.expected_payment as Row;
    if (providers.has(String(payment.id))) fail("manifest_duplicate_provider");
    providers.add(String(payment.id));
    if (item.disposition === "IMPORT_STUDENT") {
      students++;
      if (
        !uuid.test(String(item.student_id)) || item.expected_canonical != null
      ) fail("manifest_student_invalid");
      if (item.prepayment != null) {
        monthly++;
        if (!object(item.prepayment)) {
          return fail("manifest_prepayment_invalid");
        }
        keys(item.prepayment, ["mode", "months", "first_month"]);
        if (
          item.prepayment.mode !== "MENSAL" || item.prepayment.months !== 6 ||
          !date(item.prepayment.first_month) ||
          item.prepayment.first_month !==
            `${String(payment.creditDate).slice(0, 7)}-01`
        ) fail("manifest_prepayment_invalid");
      }
    } else if (item.disposition === "IMPORT_UNASSIGNED") {
      unassigned++;
      if (
        item.student_id != null || item.prepayment != null ||
        item.expected_canonical != null
      ) fail("manifest_unassigned_invalid");
    } else if (item.disposition === "DUPLICATE_OF") {
      duplicates++;
      expectedPayment(item.expected_canonical, true);
      const canonical = item.expected_canonical as Row;
      if (
        item.student_id != null || item.prepayment != null ||
        canonical.id === payment.id ||
        canonical.customer !== payment.customer ||
        canonical.paymentDate !== payment.paymentDate ||
        amountCents(canonical.value) !== amountCents(payment.value)
      ) fail("manifest_duplicate_invalid");
    } else fail("manifest_disposition_invalid");
  }
  if (students !== 2 || unassigned !== 4 || duplicates !== 1 || monthly !== 1) {
    fail("manifest_scope_invalid");
  }
  const canonical =
    ((cases as Row[]).find((item: Row) =>
      item.disposition === "DUPLICATE_OF"
    ) as Row).expected_canonical as Row;
  if (providers.has(String(canonical.id))) fail("manifest_canonical_is_import");
  return value as unknown as Manifest;
}
export function minimalPayment(input: unknown): Row {
  if (!object(input)) return fail("provider_snapshot_invalid");
  const result: Row = {};
  for (
    const key of [
      "id",
      "customer",
      "status",
      "value",
      "dueDate",
      "paymentDate",
      "creditDate",
      "subscription",
      "externalReference",
      "deleted",
      "refundedValue",
    ]
  ) {
    if (input[key] !== undefined) result[key] = input[key];
  }
  // Presence, not any potentially personal dispute details, is sufficient.
  if (input.chargeback != null) result.chargeback = { present: true };
  if (input.refunds != null) {
    if (!Array.isArray(input.refunds)) return fail("provider_refunds_invalid");
    result.refunds = input.refunds.map((refund) => {
      if (!object(refund)) return fail("provider_refunds_invalid");
      return { status: refund.status ?? null, value: refund.value ?? null };
    });
  }
  return result;
}
function assertProof(proof: Row, expected: Row, canonical: boolean) {
  if (
    proof.status !== (canonical ? "RECEIVED_IN_CASH" : "RECEIVED") ||
    proof.deleted === true || proof.chargeback != null ||
    Number(proof.refundedValue ?? 0) !== 0 ||
    (Array.isArray(proof.refunds) &&
      proof.refunds.some((r) =>
        !["CANCELLED", "DENIED"].includes(String((r as Row).status))
      ))
  ) fail("provider_reversal_or_unsettled");
  if (proof.externalReference != null && proof.externalReference !== "") {
    fail("provider_origin_changed");
  }
  for (
    const key of [
      "id",
      "customer",
      "dueDate",
      "paymentDate",
      "creditDate",
      "subscription",
    ]
  ) {
    if ((proof[key] ?? null) !== (expected[key] ?? null)) {
      fail("provider_expected_snapshot_changed");
    }
  }
  if (amountCents(proof.value) !== amountCents(expected.value)) {
    fail("provider_expected_amount_changed");
  }
}
function identity(integration: Integration) {
  return JSON.stringify([
    integration.integrationId,
    integration.tenantId,
    integration.version,
    integration.mode,
    integration.environment,
    integration.baseUrl,
    integration.apiKey,
  ]);
}
export interface Dependencies {
  resolve(): Promise<Integration>;
  get(integration: Integration, path: string): Promise<unknown>;
  apply(
    manifest: Manifest,
    proofs: Row[],
    integration: Integration,
    commit: boolean,
  ): Promise<Row>;
  now?(): Date;
}
export async function adjudicate(
  input: unknown,
  dependencies: Dependencies,
  commit = false,
): Promise<Row> {
  const manifest = parseManifest(input);
  const now = dependencies.now ?? (() => new Date());
  const started = now().getTime();
  const integration = await dependencies.resolve();
  if (
    integration.tenantId !== manifest.tenant_id ||
    integration.mode !== "PLATFORM_MANAGED_ROOT" || !integration.apiKey
  ) fail("integration_scope_invalid");
  const proofs = await Promise.all(manifest.cases.map(async (item) => {
    const fetchProof = async (expected: Row, canonical: boolean) => {
      const path = `/payments/${encodeURIComponent(String(expected.id))}`;
      const first = minimalPayment(await dependencies.get(integration, path));
      assertProof(first, expected, canonical);
      const second = minimalPayment(await dependencies.get(integration, path));
      assertProof(second, expected, canonical);
      if (JSON.stringify(first) !== JSON.stringify(second)) {
        fail("provider_snapshot_race");
      }
      return second;
    };
    const [payment, canonical] = await Promise.all([
      fetchProof(item.expected_payment, false),
      item.expected_canonical
        ? fetchProof(item.expected_canonical, true)
        : Promise.resolve(null),
    ]);
    return {
      case_key: item.case_key,
      payment,
      canonical_payment: canonical,
      observed_at: now().toISOString(),
    };
  }));
  const final = await dependencies.resolve();
  if (identity(integration) !== identity(final)) fail("integration_rotated");
  if (now().getTime() - started > 20_000) {
    fail("provider_proof_deadline_exceeded");
  }
  // apply performs validation again under DB locks. It is never retried here:
  // an uncertain connection is reconciled by repeating this immutable batch.
  const result = await dependencies.apply(manifest, proofs, final, commit);
  if (result.ok !== true || result.committed !== commit) {
    fail("adjudication_database_unconfirmed");
  }
  return result;
}
