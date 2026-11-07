import {
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  bindStudentAsaasCreationLifecycle,
  claimAsaasCreation,
  findUniqueAsaasEntity,
  markStudentAsaasCreationSubmitting,
  recordAsaasCreationState,
  releaseStudentAsaasCreationLifecycle,
} from "../_shared/asaas-creation-guard.ts";
import type { PaymentAdminClient } from "../_shared/payment-auth.ts";
import {
  canonicalEnrollmentSplitPolicy,
  providerSplitPayload,
} from "../_shared/student-provider-lifecycle.ts";
import type {
  AsaasIntegrationPurpose,
  ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";

/**
 * Cobrança única da renovação com pagamento integral adiantado.
 *
 * A cobrança leva `externalReference = <id do aluno>`: é a referência canônica
 * que o webhook e `apply_active_student_payment_event` já aceitam para gerar a
 * linha em `student_payments`. Quando ela vira RECEIVED, o gatilho no banco
 * registra a cobertura dos meses. Nada aqui marca pagamento nem cobertura.
 *
 * Cliente e cobrança passam pelo mesmo trilho durável dos outros criadores
 * (`claim` → `submitting` → POST → `record`): resultado incerto nunca vira um
 * segundo POST; a próxima tentativa reconcilia antes de qualquer coisa.
 */

type Row = Record<string, unknown>;

export type UpfrontSource = {
  offerId: string;
  tenantId: string;
  studentId: string;
  customerId: string | null;
  billingType: "PIX" | "BOLETO" | "CREDIT_CARD";
  termMonths: number;
  firstDueDate: string;
  lastDueDate: string;
  totalCents: number;
  dueDate: string;
  billingName: string;
  billingCpf: string;
  billingPhone: string;
  billingEmail: string;
  postalCode: string;
  address: string;
  addressNumber: string;
};

export type UpfrontOutcome =
  | {
    status: "SYNCED";
    customerId: string;
    paymentId: string;
    invoiceUrl: string | null;
    error: null;
  }
  | {
    status: "FAILED" | "REVIEW";
    customerId: string | null;
    paymentId: null;
    invoiceUrl: null;
    error: string;
  };

export type UpfrontDeps = {
  admin: PaymentAdminClient;
  resolve: (
    purpose: AsaasIntegrationPurpose,
  ) => Promise<ResolvedAsaasIntegration>;
  revalidate: (
    purpose: "customer.create" | "payment.create",
    expected: ResolvedAsaasIntegration,
  ) => Promise<ResolvedAsaasIntegration>;
  bindCustomer: (customerId: string) => Promise<boolean>;
};

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const obj = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const digits = (value: unknown): string =>
  String(value ?? "").replace(/\D/g, "");

export function parseUpfrontSource(value: unknown): UpfrontSource | null {
  const s = obj(value);
  const u = obj(s.upfront);
  const billingType = text(s.billing_type);
  const customer = text(s.customer_id);
  if (
    s.strategy !== "UPFRONT_CHARGE" || !text(s.id) || !text(s.tenant_id) ||
    !text(s.student_id) ||
    !["PIX", "BOLETO", "CREDIT_CARD"].includes(billingType) ||
    ![6, 12].includes(Number(s.term_months)) || !isDate(s.first_due_date) ||
    !isDate(s.last_due_date) || !isDate(u.due_date) ||
    !Number.isSafeInteger(u.total_cents) || Number(u.total_cents) <= 0 ||
    (customer && !/^cus_/.test(customer))
  ) return null;
  return {
    offerId: text(s.id),
    tenantId: text(s.tenant_id),
    studentId: text(s.student_id),
    customerId: customer || null,
    billingType: billingType as UpfrontSource["billingType"],
    termMonths: Number(s.term_months),
    firstDueDate: String(s.first_due_date),
    lastDueDate: String(s.last_due_date),
    totalCents: Number(u.total_cents),
    dueDate: String(u.due_date),
    billingName: text(u.billing_name).replace(/\s+/g, " "),
    billingCpf: digits(u.billing_cpf),
    billingPhone: digits(u.billing_phone),
    billingEmail: text(u.billing_email),
    postalCode: text(u.postal_code),
    address: text(u.address),
    addressNumber: text(u.address_number),
  };
}

const monthLabel = (date: string): string =>
  `${date.slice(5, 7)}/${date.slice(0, 4)}`;

/**
 * Sem palavra que tire a cobrança de "mensalidade": `payment_is_tuition` recusa
 * "taxa", "multa", "extra", "material", "reposição" e "matrícula"; e a cobertura
 * só vale para mensalidade. Por isso o nome da escola não entra no texto.
 * O sufixo com a oferta é o que identifica esta cobrança na conciliação.
 */
export function upfrontDescription(s: UpfrontSource): string {
  return `Renovação do curso - ${s.termMonths} meses (${
    monthLabel(s.firstDueDate)
  } a ${monthLabel(s.lastDueDate)}) - ref ${s.offerId.slice(0, 8)}`;
}

export function upfrontPaymentMatches(
  payment: Row,
  s: UpfrontSource,
  customerId: string,
): boolean {
  return payment.deleted !== true && text(payment.id) !== "" &&
    text(payment.customer) === customerId &&
    text(payment.externalReference) === s.studentId &&
    !text(payment.subscription) &&
    Math.round(Number(payment.value) * 100) === s.totalCents &&
    text(payment.description) === upfrontDescription(s);
}

export function invoiceUrlOf(payment: Row): string | null {
  const url = text(payment.invoiceUrl) || text(payment.bankSlipUrl);
  return /^https:\/\/[^\s"<>]+$/.test(url) ? url : null;
}

function customerBelongsToStudent(
  customer: Row,
  s: UpfrontSource,
  requireReference: boolean,
): boolean {
  const reference = text(customer.externalReference);
  return customer.deleted !== true && text(customer.id) !== "" &&
    digits(customer.cpfCnpj) === s.billingCpf &&
    (reference === s.studentId || (!requireReference && reference === ""));
}

async function request(
  integration: ResolvedAsaasIntegration,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: Row }> {
  const response = await fetch(
    `${integration.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
    {
      ...init,
      headers: {
        access_token: integration.apiKey,
        "Content-Type": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(
        init.method && init.method !== "GET" ? 65000 : 12000,
      ),
    },
  );
  return {
    ok: response.ok,
    status: response.status,
    data: obj(await response.json().catch(() => null)),
  };
}

const review = (
  error: string,
  customerId: string | null = null,
): UpfrontOutcome => ({
  status: "REVIEW",
  customerId,
  paymentId: null,
  invoiceUrl: null,
  error,
});
const failed = (
  error: string,
  customerId: string | null = null,
): UpfrontOutcome => ({
  status: "FAILED",
  customerId,
  paymentId: null,
  invoiceUrl: null,
  error,
});

type CustomerResult = { id: string } | { outcome: UpfrontOutcome };

async function ensureCustomer(
  deps: UpfrontDeps,
  s: UpfrontSource,
  integration: ResolvedAsaasIntegration,
): Promise<CustomerResult> {
  if (s.customerId) {
    const linked = await request(
      integration,
      `customers/${encodeURIComponent(s.customerId)}`,
    );
    if (!linked.ok) {
      return { outcome: review(`customer_read_${linked.status}`) };
    }
    // Cliente já vinculado ao perfil: o vínculo é a prova. Cadastro antigo pode
    // não ter referência, mas o CPF precisa ser o do titular.
    return customerBelongsToStudent(linked.data, s, false)
      ? { id: s.customerId }
      : { outcome: review("customer_identity_mismatch") };
  }

  const payload: Row = {
    name: s.billingName,
    cpfCnpj: s.billingCpf,
    mobilePhone: s.billingPhone,
    externalReference: s.studentId,
    ...(s.billingEmail ? { email: s.billingEmail } : {}),
    ...(s.postalCode ? { postalCode: s.postalCode } : {}),
    ...(s.address ? { address: s.address } : {}),
    ...(s.addressNumber ? { addressNumber: s.addressNumber } : {}),
  };
  const logicalKey = `student-customer:${s.studentId}`;
  // Mesma chave lógica dos outros criadores de cliente: a impressão digital já
  // gravada vale, senão dados que mudaram virariam "revisão" sem motivo.
  const stored = await deps.admin.from("asaas_provider_creation_attempts")
    .select("external_reference,request_fingerprint")
    .eq("tenant_id", s.tenantId)
    .eq("operation", "CUSTOMER_CREATE")
    .eq("logical_key", logicalKey)
    .maybeSingle();
  if (stored.error) return { outcome: review("customer_attempt_read_failed") };
  if (
    stored.data && text(stored.data.external_reference) !== s.studentId
  ) return { outcome: review("customer_attempt_reference_mismatch") };
  const claim = await claimAsaasCreation(deps.admin, {
    tenantId: s.tenantId,
    operation: "CUSTOMER_CREATE",
    logicalKey,
    externalReference: s.studentId,
    requestFingerprint: text(stored.data?.request_fingerprint) ||
      await asaasCreationFingerprint({
        tenantId: s.tenantId,
        operation: "CUSTOMER_CREATE",
        logicalKey,
        payload,
      }),
  });
  if (claim.action === "IN_PROGRESS") {
    return { outcome: review("customer_creation_in_progress") };
  }
  if (claim.action === "REVIEW_REQUIRED" || !claim.ok) {
    return { outcome: review("customer_creation_requires_review") };
  }
  const lifecycle = {
    tenantId: s.tenantId,
    studentId: s.studentId,
    bindingKind: "CUSTOMER" as const,
    expectedCustomerId: null,
  };
  if (!await bindStudentAsaasCreationLifecycle(deps.admin, claim, lifecycle)) {
    return { outcome: review("customer_lifecycle_blocked") };
  }

  let customerId = "";
  if (claim.action === "ALREADY_SUCCEEDED") {
    customerId = text(claim.provider_entity_id);
    const known = customerId
      ? await request(
        integration,
        `customers/${encodeURIComponent(customerId)}`,
      )
      : null;
    if (!known?.ok || !customerBelongsToStudent(known.data, s, true)) {
      return { outcome: review("customer_recovery_mismatch") };
    }
  } else {
    // CPF é a identidade no provedor: lê tudo antes de decidir.
    const found = await findUniqueAsaasEntity<Row>({
      baseUrl: integration.baseUrl,
      apiKey: integration.apiKey,
      path: "customers",
      query: { cpfCnpj: s.billingCpf },
      matches: (candidate) => customerBelongsToStudent(candidate, s, true),
      conflicts: (candidate) =>
        candidate.deleted !== true &&
        digits(candidate.cpfCnpj) === s.billingCpf,
    });
    if (found.kind === "UNAVAILABLE") {
      await recordAsaasCreationState(deps.admin, claim, {
        status: claim.action === "RECONCILE_REQUIRED" ? "UNKNOWN" : "RETRY",
        httpStatus: found.httpStatus ?? null,
        error: "customer_lookup_unavailable",
      });
      return { outcome: review("customer_lookup_unavailable") };
    }
    if (found.kind === "DUPLICATE" || found.kind === "CONFLICT") {
      await recordAsaasCreationState(deps.admin, claim, {
        status: "BLOCKED",
        error: "provider_customer_identity_conflict",
      });
      return { outcome: review("customer_cpf_conflict") };
    }
    if (found.kind === "FOUND") {
      customerId = text(found.entity.id);
      await recordAsaasCreationState(deps.admin, claim, {
        status: "SUCCEEDED",
        providerEntityId: customerId,
        providerStatus: text(found.entity.status),
      });
    } else if (claim.action === "RECONCILE_REQUIRED") {
      await recordAsaasCreationState(deps.admin, claim, {
        status: "UNKNOWN",
        error: "provider_customer_not_yet_observed",
      });
      return { outcome: review("customer_not_yet_observed") };
    } else {
      await markStudentAsaasCreationSubmitting(deps.admin, claim, lifecycle);
      let submit: ResolvedAsaasIntegration;
      try {
        submit = await deps.revalidate("customer.create", integration);
      } catch {
        await recordAsaasCreationState(deps.admin, claim, {
          status: "BLOCKED",
          error: "customer_capability_changed_before_submit",
        });
        return { outcome: review("customer_capability_changed") };
      }
      let created: Awaited<ReturnType<typeof request>>;
      try {
        created = await request(submit, "customers", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      } catch {
        await recordAsaasCreationState(deps.admin, claim, {
          status: "UNKNOWN",
          error: "provider_customer_post_outcome_unknown",
        });
        return { outcome: review("customer_post_outcome_unknown") };
      }
      customerId = text(created.data.id);
      const outcome = asaasCreationHttpOutcome(
        created.ok,
        created.status,
        customerId,
      );
      const exact = outcome !== "SUCCEEDED" ||
        customerBelongsToStudent(created.data, s, true);
      await recordAsaasCreationState(deps.admin, claim, {
        status: exact ? outcome : "BLOCKED",
        providerEntityId: customerId,
        providerStatus: text(created.data.status),
        httpStatus: created.status,
        error: !exact
          ? "provider_customer_post_identity_mismatch"
          : outcome === "SUCCEEDED"
          ? null
          : outcome === "FAILED"
          ? "provider_customer_creation_rejected"
          : "provider_customer_post_outcome_unknown",
      });
      if (!exact) return { outcome: review("customer_post_identity_mismatch") };
      if (outcome === "FAILED") {
        return { outcome: failed(`customer_create_${created.status}`) };
      }
      if (outcome === "UNKNOWN") {
        return { outcome: review("customer_post_outcome_unknown") };
      }
    }
  }

  if (!await deps.bindCustomer(customerId)) {
    return { outcome: review("customer_binding_changed") };
  }
  if (
    !await releaseStudentAsaasCreationLifecycle(deps.admin, claim, {
      tenantId: s.tenantId,
      studentId: s.studentId,
      providerEntityId: customerId,
    })
  ) {
    return { outcome: review("customer_lifecycle_release_failed", customerId) };
  }
  return { id: customerId };
}

async function ensurePayment(
  deps: UpfrontDeps,
  s: UpfrontSource,
  customerId: string,
  integration: ResolvedAsaasIntegration,
): Promise<UpfrontOutcome> {
  const synced = (payment: Row): UpfrontOutcome => ({
    status: "SYNCED",
    customerId,
    paymentId: text(payment.id),
    invoiceUrl: invoiceUrlOf(payment),
    error: null,
  });
  const { data: tenant, error: tenantError } = await deps.admin
    .from("tenants")
    .select("asaas_wallet_id,asaas_split_percentage")
    .eq("id", s.tenantId)
    .maybeSingle();
  if (tenantError || !tenant) {
    return review("tenant_billing_unavailable", customerId);
  }
  const split = canonicalEnrollmentSplitPolicy(
    integration.mode,
    tenant.asaas_wallet_id,
    tenant.asaas_split_percentage,
  );
  if (!split) return review("tenant_split_policy_invalid", customerId);

  const logicalKey = `renewal-upfront:${s.offerId}`;
  // A data da cobrança pode andar entre tentativas: fica fora da impressão digital.
  const claim = await claimAsaasCreation(deps.admin, {
    tenantId: s.tenantId,
    operation: "PAYMENT_CREATE",
    logicalKey,
    externalReference: s.studentId,
    requestFingerprint: await asaasCreationFingerprint({
      tenantId: s.tenantId,
      operation: "PAYMENT_CREATE",
      logicalKey,
      customerId,
      billingType: s.billingType,
      totalCents: s.totalCents,
      description: upfrontDescription(s),
    }),
  });
  if (claim.action === "IN_PROGRESS") {
    return review("payment_creation_in_progress", customerId);
  }
  if (claim.action === "REVIEW_REQUIRED" || !claim.ok) {
    return review("payment_creation_requires_review", customerId);
  }
  const lifecycle = {
    tenantId: s.tenantId,
    studentId: s.studentId,
    bindingKind: "STUDENT_PAYMENT" as const,
    expectedCustomerId: customerId,
  };
  if (!await bindStudentAsaasCreationLifecycle(deps.admin, claim, lifecycle)) {
    return review("payment_lifecycle_blocked", customerId);
  }
  const release = (paymentId: string) =>
    releaseStudentAsaasCreationLifecycle(deps.admin, claim, {
      tenantId: s.tenantId,
      studentId: s.studentId,
      providerEntityId: paymentId,
    });

  if (claim.action === "ALREADY_SUCCEEDED") {
    const paymentId = text(claim.provider_entity_id);
    const known = paymentId
      ? await request(integration, `payments/${encodeURIComponent(paymentId)}`)
      : null;
    if (!known?.ok || !upfrontPaymentMatches(known.data, s, customerId)) {
      return review("payment_recovery_mismatch", customerId);
    }
    await release(paymentId);
    return synced(known.data);
  }

  const found = await findUniqueAsaasEntity<Row>({
    baseUrl: integration.baseUrl,
    apiKey: integration.apiKey,
    path: "payments",
    query: { customer: customerId, externalReference: s.studentId },
    matches: (candidate) => upfrontPaymentMatches(candidate, s, customerId),
  });
  if (found.kind === "UNAVAILABLE") {
    await recordAsaasCreationState(deps.admin, claim, {
      status: claim.action === "RECONCILE_REQUIRED" ? "UNKNOWN" : "RETRY",
      httpStatus: found.httpStatus ?? null,
      error: "payment_lookup_unavailable",
    });
    return review("payment_lookup_unavailable", customerId);
  }
  if (found.kind === "DUPLICATE" || found.kind === "CONFLICT") {
    await recordAsaasCreationState(deps.admin, claim, {
      status: "BLOCKED",
      error: "provider_payment_duplicate",
    });
    return review("payment_duplicate", customerId);
  }
  if (found.kind === "FOUND") {
    await recordAsaasCreationState(deps.admin, claim, {
      status: "SUCCEEDED",
      providerEntityId: text(found.entity.id),
      providerStatus: text(found.entity.status),
    });
    await release(text(found.entity.id));
    return synced(found.entity);
  }
  if (claim.action === "RECONCILE_REQUIRED") {
    await recordAsaasCreationState(deps.admin, claim, {
      status: "UNKNOWN",
      error: "provider_payment_not_yet_observed",
    });
    return review("payment_not_yet_observed", customerId);
  }

  await markStudentAsaasCreationSubmitting(deps.admin, claim, lifecycle);
  let submit: ResolvedAsaasIntegration;
  try {
    submit = await deps.revalidate("payment.create", integration);
  } catch {
    await recordAsaasCreationState(deps.admin, claim, {
      status: "BLOCKED",
      error: "payment_capability_changed_before_submit",
    });
    return review("payment_capability_changed", customerId);
  }
  const splitPayload = providerSplitPayload(split);
  let created: Awaited<ReturnType<typeof request>>;
  try {
    created = await request(submit, "payments", {
      method: "POST",
      body: JSON.stringify({
        customer: customerId,
        billingType: s.billingType,
        value: s.totalCents / 100,
        dueDate: s.dueDate,
        description: upfrontDescription(s),
        externalReference: s.studentId,
        ...(splitPayload ? { split: splitPayload } : {}),
      }),
    });
  } catch {
    await recordAsaasCreationState(deps.admin, claim, {
      status: "UNKNOWN",
      error: "provider_payment_post_outcome_unknown",
    });
    return review("payment_post_outcome_unknown", customerId);
  }
  const paymentId = text(created.data.id);
  const outcome = asaasCreationHttpOutcome(
    created.ok,
    created.status,
    paymentId,
  );
  const exact = outcome !== "SUCCEEDED" ||
    upfrontPaymentMatches(created.data, s, customerId);
  await recordAsaasCreationState(deps.admin, claim, {
    status: exact ? outcome : "BLOCKED",
    providerEntityId: paymentId,
    providerStatus: text(created.data.status),
    httpStatus: created.status,
    error: !exact
      ? "provider_payment_post_identity_mismatch"
      : outcome === "SUCCEEDED"
      ? null
      : outcome === "FAILED"
      ? "provider_payment_creation_rejected"
      : "provider_payment_post_outcome_unknown",
  });
  if (!exact) return review("payment_post_identity_mismatch", customerId);
  if (outcome === "FAILED") {
    return failed(`payment_create_${created.status}`, customerId);
  }
  if (outcome === "UNKNOWN") {
    return review("payment_post_outcome_unknown", customerId);
  }
  await release(paymentId);
  return synced(created.data);
}

export async function processUpfrontCharge(
  deps: UpfrontDeps,
  s: UpfrontSource,
): Promise<UpfrontOutcome> {
  if (
    s.billingCpf.length !== 11 || s.billingPhone.length < 10 || !s.billingName
  ) return review("billing_identity_incomplete");
  const [customerIntegration, paymentIntegration] = await Promise.all([
    deps.resolve("customer.create"),
    deps.resolve("payment.create"),
  ]);
  if (
    customerIntegration.integrationId !== paymentIntegration.integrationId ||
    customerIntegration.version !== paymentIntegration.version ||
    customerIntegration.apiKey !== paymentIntegration.apiKey
  ) return review("integration_capability_mismatch");
  const customer = await ensureCustomer(deps, s, customerIntegration);
  if ("outcome" in customer) return customer.outcome;
  return await ensurePayment(deps, s, customer.id, paymentIntegration);
}
