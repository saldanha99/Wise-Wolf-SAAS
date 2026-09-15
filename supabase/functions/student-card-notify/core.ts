import { buildStudentBillingLink } from "../_shared/student-billing-link.ts";

export type Row = Record<string, unknown>;
export type CardSource = {
  tenant_id: string;
  student_id: string;
  payment_id: string;
  provider_payment_id: string;
  customer_id: string;
  subscription_id: string;
  value: number;
  due_date: string;
  event_id: string;
  event_hash: string;
  event_at: string;
  billing_type: "CREDIT_CARD";
  recipient_phone: string;
  recipient_name: string;
  student_name: string;
  card_last4: string | null;
};

export function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}

function text(value: unknown, max = 160): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= max && value.trim() === value;
}

export function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value;
}

function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  const result = Math.round(value * 100);
  return Number.isSafeInteger(result) &&
      Math.abs(value * 100 - result) < 0.000001
    ? result
    : null;
}

/** The DB supplies the payer, never request input or an inferred child contact. */
export function parseCardSource(value: unknown): CardSource | null {
  const row = object(value);
  for (
    const key of [
      "tenant_id",
      "student_id",
      "payment_id",
      "provider_payment_id",
      "customer_id",
      "subscription_id",
      "event_id",
      "event_hash",
      "event_at",
      "recipient_name",
      "student_name",
    ]
  ) if (!text(row[key])) return null;
  if (
    !/^pay_[A-Za-z0-9_]+$/.test(String(row.provider_payment_id)) ||
    !/^cus_[A-Za-z0-9_]+$/.test(String(row.customer_id)) ||
    !/^sub_[A-Za-z0-9_]+$/.test(String(row.subscription_id)) ||
    !/^[a-f0-9]{64}$/.test(String(row.event_hash)) ||
    !Number.isFinite(Date.parse(String(row.event_at))) ||
    !validDate(row.due_date) || cents(row.value) === null ||
    row.billing_type !== "CREDIT_CARD" ||
    typeof row.recipient_phone !== "string" ||
    !/^[1-9][0-9]{10,14}$/.test(row.recipient_phone) ||
    !(row.card_last4 === null ||
      (typeof row.card_last4 === "string" && /^\d{4}$/.test(row.card_last4)))
  ) return null;
  // Keep the exact sealed schema, not arbitrary provider/request attributes.
  return {
    tenant_id: row.tenant_id as string,
    student_id: row.student_id as string,
    payment_id: row.payment_id as string,
    provider_payment_id: row.provider_payment_id as string,
    customer_id: row.customer_id as string,
    subscription_id: row.subscription_id as string,
    value: row.value as number,
    due_date: row.due_date,
    event_id: row.event_id as string,
    event_hash: row.event_hash as string,
    event_at: row.event_at as string,
    billing_type: "CREDIT_CARD",
    recipient_phone: row.recipient_phone,
    recipient_name: row.recipient_name as string,
    student_name: row.student_name as string,
    card_last4: row.card_last4 as string | null,
  };
}

export type ProviderPayment = {
  id: string;
  customer: string;
  subscription: string;
  status: "PENDING" | "OVERDUE";
  billingType: "CREDIT_CARD";
  value: number;
  dueDate: string;
  deleted: false;
  creditCardLast4: string | null;
};
export type ProviderSubscription = {
  id: string;
  customer: string;
  status: "ACTIVE";
  billingType: "CREDIT_CARD";
  deleted: false;
  creditCardLast4: string | null;
};
export type CardProof = {
  payment: ProviderPayment;
  subscription: ProviderSubscription;
};
export type ProofResult = { ok: true; proof: CardProof } | {
  ok: false;
  reason:
    | "identity_mismatch"
    | "provider_settled"
    | "provider_reversal"
    | "provider_deleted"
    | "provider_not_eligible"
    | "snapshot_changed";
  suppress: boolean;
};

function last4(row: Row): string | null {
  const value = row.creditCardLast4 ?? object(row.creditCard).creditCardNumber;
  if (typeof value !== "string") return null;
  // Asaas returns the final four digits. Never retain PAN, token, brand or holder.
  return /^\d{4}$/.test(value) ? value : null;
}

function reversal(row: Row): boolean {
  return /REFUND|CHARGEBACK|AWAITING_CHARGEBACK/.test(String(row.status)) ||
    Number(row.refundedValue || 0) > 0 ||
    (Array.isArray(row.refunds) && row.refunds.length > 0) ||
    (row.chargeback != null && row.chargeback !== false);
}

/** Check raw negative facts before discarding all but the financial whitelist. */
export function verifyCardProof(
  source: CardSource,
  rawPayment: unknown,
  rawSubscription: unknown,
): ProofResult {
  const payment = object(rawPayment);
  const subscription = object(rawSubscription);
  if (
    payment.id !== source.provider_payment_id ||
    payment.customer !== source.customer_id ||
    payment.subscription !== source.subscription_id ||
    subscription.id !== source.subscription_id ||
    subscription.customer !== source.customer_id
  ) return { ok: false, reason: "identity_mismatch", suppress: true };
  if (payment.deleted === true || subscription.deleted === true) {
    return { ok: false, reason: "provider_deleted", suppress: true };
  }
  if (reversal(payment) || reversal(subscription)) {
    return { ok: false, reason: "provider_reversal", suppress: true };
  }
  if (
    ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"].includes(
      String(payment.status),
    ) || payment.paymentDate || payment.clientPaymentDate
  ) return { ok: false, reason: "provider_settled", suppress: true };
  if (
    !["PENDING", "OVERDUE"].includes(String(payment.status)) ||
    payment.billingType !== "CREDIT_CARD" ||
    subscription.status !== "ACTIVE" ||
    subscription.billingType !== "CREDIT_CARD" ||
    !(payment.deleted === undefined || payment.deleted === false) ||
    !(subscription.deleted === undefined || subscription.deleted === false)
  ) return { ok: false, reason: "provider_not_eligible", suppress: false };
  if (
    cents(payment.value) !== cents(source.value) ||
    payment.dueDate !== source.due_date ||
    !validDate(payment.dueDate) ||
    (last4(payment) !== null && last4(subscription) !== null &&
      last4(payment) !== last4(subscription)) ||
    (source.card_last4 !== null &&
      (last4(payment) !== source.card_last4 ||
        last4(subscription) !== source.card_last4))
  ) return { ok: false, reason: "snapshot_changed", suppress: false };
  return {
    ok: true,
    proof: {
      payment: {
        id: payment.id as string,
        customer: payment.customer as string,
        subscription: payment.subscription as string,
        status: payment.status as ProviderPayment["status"],
        billingType: "CREDIT_CARD",
        value: payment.value as number,
        dueDate: payment.dueDate,
        deleted: false,
        creditCardLast4: last4(payment),
      },
      subscription: {
        id: subscription.id as string,
        customer: subscription.customer as string,
        status: "ACTIVE",
        billingType: "CREDIT_CARD",
        deleted: false,
        creditCardLast4: last4(subscription),
      },
    },
  };
}

export function sameSnapshot(left: unknown, right: unknown): boolean {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      );
    }
    return value;
  }
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function safeName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f<>*_`\[\]\\]/g, " ")
    .replace(/https?:\S+/gi, "").replace(/\s+/g, " ").trim().slice(0, 100);
}

export function cardFailureMessage(
  source: CardSource,
  brand: string,
  trustedPortalUrl: string | null,
): string {
  const money = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(source.value);
  const due = source.due_date.split("-").reverse().join("/");
  return [
    `Olá, ${safeName(source.recipient_name)}! Aqui é a ${safeName(brand)}.`,
    `Não foi possível processar no cartão a cobrança de ${money}, com vencimento em ${due}, referente a ${
      safeName(source.student_name)
    }.`,
    "Confira ou atualize a forma de pagamento no portal do aluno:",
    buildStudentBillingLink(trustedPortalUrl),
    "Entre na conta do aluno correspondente. Não envie número do cartão, código de segurança ou senha pelo WhatsApp.",
    "Se já regularizou, confira a situação no portal ou fale com a escola.",
  ].join("\n\n");
}

export type SendResult = {
  outcome: "accepted" | "rejected" | "ambiguous";
  messageId: string | null;
  httpStatus: number | null;
};

/** Exactly one POST; no JID heuristics, key fallback, retry, body/error logging. */
export async function sendCardNotice(
  route: { baseUrl: string; apiKey: string; instanceName: string },
  destination: string,
  message: string,
  fetcher: typeof fetch = fetch,
): Promise<SendResult> {
  try {
    const response = await fetcher(
      `${route.baseUrl}/message/sendText/${
        encodeURIComponent(route.instanceName)
      }`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: route.apiKey },
        body: JSON.stringify({
          number: destination,
          text: message,
          delay: 1200,
          linkPreview: false,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) {
      return {
        outcome:
          [408, 425, 429].includes(response.status) || response.status >= 500
            ? "ambiguous"
            : "rejected",
        messageId: null,
        httpStatus: response.status,
      };
    }
    const payload = object(await response.json().catch(() => null));
    const id = object(payload.key).id ?? payload.id;
    return {
      outcome: "accepted",
      messageId: text(id, 320) ? id : null,
      httpStatus: response.status,
    };
  } catch {
    return { outcome: "ambiguous", messageId: null, httpStatus: null };
  }
}
