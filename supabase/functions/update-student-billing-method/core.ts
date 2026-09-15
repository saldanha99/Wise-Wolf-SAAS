export const BILLING_TYPES = ["PIX", "BOLETO", "CREDIT_CARD"] as const;

export type BillingType = typeof BILLING_TYPES[number];

export type CreditCardInput = {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
};

export type SubscriptionPayment = {
  id: string;
  subscription: string;
  status: string;
  dueDate: string;
  value: number;
  billingType?: string | null;
};

export const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const digits = (value: unknown): string =>
  String(value || "").replace(/\D/g, "");

export function parseBillingType(value: unknown): BillingType | null {
  const candidate = text(value).toUpperCase();
  return BILLING_TYPES.includes(candidate as BillingType)
    ? candidate as BillingType
    : null;
}

export function parseCreditCard(value: unknown): CreditCardInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  const parsed = {
    holderName: text(card.holderName),
    number: digits(card.number),
    expiryMonth: digits(card.expiryMonth).padStart(2, "0"),
    expiryYear: digits(card.expiryYear),
    ccv: digits(card.ccv),
  };

  if (
    parsed.holderName.length < 3 ||
    parsed.number.length < 13 || parsed.number.length > 19 ||
    !/^(0[1-9]|1[0-2])$/.test(parsed.expiryMonth) ||
    !/^\d{4}$/.test(parsed.expiryYear) ||
    parsed.ccv.length < 3 || parsed.ccv.length > 4
  ) return null;

  return parsed;
}

/**
 * Asaas may expose the saved card number either on the subscription or in a
 * nested creditCard object. Accept only an explicit card-number/last-four
 * field; a token, brand or successful PUT is not proof of the requested card.
 */
export function providerSubscriptionCardMatchesLast4(
  value: unknown,
  expectedLast4: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const subscription = value as Record<string, unknown>;
  const nested = subscription.creditCard &&
      typeof subscription.creditCard === "object" &&
      !Array.isArray(subscription.creditCard)
    ? subscription.creditCard as Record<string, unknown>
    : {};
  const candidates = [
    nested.creditCardNumber,
    nested.cardNumber,
    nested.number,
    nested.last4,
    subscription.creditCardNumber,
    subscription.cardNumber,
    subscription.last4,
  ];
  const normalizedExpected = digits(expectedLast4);
  return normalizedExpected.length === 4 && candidates.some((candidate) => {
    const normalized = digits(candidate);
    return normalized.length >= 4 && normalized.endsWith(normalizedExpected);
  });
}

export function clientIp(headers: Headers): string | null {
  const forwarded = text(headers.get("x-forwarded-for")).split(",")[0]?.trim();
  const candidate = forwarded || text(headers.get("cf-connecting-ip")) ||
    text(headers.get("x-real-ip"));
  if (
    !candidate || candidate.length > 64 || !/^[0-9a-f:.]+$/i.test(candidate)
  ) return null;
  return candidate;
}

export function safeProviderMessage(value: unknown): string {
  const raw = text(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[cartao oculto]")
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[documento oculto]")
    .replace(/\s{2,}/g, " ")
    .trim();
  return raw
    ? raw.slice(0, 240)
    : "Operacao recusada pelo provedor de pagamento.";
}

export function parseSubscriptionPayments(
  value: unknown,
  subscriptionId: string,
): SubscriptionPayment[] {
  const source = Array.isArray(value) ? value : [];
  return source.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const payment = entry as Record<string, unknown>;
    const id = text(payment.id);
    const subscription = text(payment.subscription);
    const status = text(payment.status).toUpperCase();
    const dueDate = text(payment.dueDate);
    const amount = Number(payment.value);
    if (
      !id || subscription !== subscriptionId || status !== "OVERDUE" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(amount) ||
      amount <= 0 || payment.deleted === true
    ) return [];
    if (hasOverdueProviderReversal(payment)) {
      throw new Error("overdue_provider_reversal_requires_review");
    }
    return [{
      id,
      subscription,
      status,
      dueDate,
      value: amount,
      billingType: text(payment.billingType).toUpperCase() || null,
    }];
  }).sort((left, right) =>
    left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id)
  );
}

function hasOverdueProviderReversal(payment: Record<string, unknown>): boolean {
  if (Number(payment.refundedValue ?? 0) !== 0 || payment.chargeback != null) {
    return true;
  }
  if (payment.refunds == null) return false;
  return !Array.isArray(payment.refunds) ||
    payment.refunds.some((refund) =>
      !refund || typeof refund !== "object" ||
      !["CANCELLED", "DENIED"].includes(text(refund.status).toUpperCase())
    );
}

export function overdueSummary(payments: SubscriptionPayment[]) {
  return {
    count: payments.length,
    total: Math.round(
      payments.reduce((sum, payment) => sum + payment.value, 0) * 100,
    ) / 100,
    oldestDueDate: payments[0]?.dueDate ?? null,
    confirmationKey: overdueConfirmationKey(payments),
  };
}

export function overdueConfirmationKey(payments: SubscriptionPayment[]) {
  if (payments.length === 0) return "NO_OVERDUE_PAYMENTS";
  // Versioned financial snapshot, not an authorization token. Only selected
  // billing facts cross this boundary; never serialize the provider payload.
  const snapshots = payments.map((payment) => {
    const amountCents = Math.round(payment.value * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error("overdue_confirmation_amount_invalid");
    }
    return JSON.stringify([
      payment.id,
      amountCents,
      payment.dueDate,
      text(payment.billingType).toUpperCase() || null,
      text(payment.status).toUpperCase(),
      payment.subscription,
    ]);
  }).sort();
  return `OVERDUE_V2:[${snapshots.join(",")}]`;
}

export function overduePaymentSnapshot(payment: SubscriptionPayment) {
  return {
    id: payment.id,
    subscription: payment.subscription,
    status: payment.status,
    dueDate: payment.dueDate,
    value_cents: Math.round(payment.value * 100),
    billingType: text(payment.billingType).toUpperCase() || null,
  };
}

/** Updating the subscription may legitimately convert PIX/BOLETO to card.
 * It must never change the amount, due date or identity that the payer approved. */
export function overdueChargeFactsMatch(
  approved: SubscriptionPayment,
  observed: Record<string, unknown>,
): boolean {
  if (hasOverdueProviderReversal(observed)) return false;
  const parsed = parseSubscriptionPayments([observed], approved.subscription);
  if (parsed.length !== 1) return false;
  const current = parsed[0];
  return current.id === approved.id && current.dueDate === approved.dueDate &&
    Math.round(current.value * 100) === Math.round(approved.value * 100) &&
    [text(approved.billingType).toUpperCase(), "CREDIT_CARD"].includes(
      text(current.billingType).toUpperCase(),
    );
}

export async function validateOverdueCardObligations(
  client: {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: unknown }>;
  },
  input: {
    tenantId: string;
    studentId: string;
    subscriptionId: string;
    payments: SubscriptionPayment[];
  },
): Promise<boolean> {
  try {
    const result = await client.rpc(
      "validate_student_overdue_card_obligations",
      {
        p_tenant_id: input.tenantId,
        p_student_id: input.studentId,
        p_subscription_id: input.subscriptionId,
        p_payment_snapshots: input.payments.map(overduePaymentSnapshot),
      },
    );
    return !result.error && !!result.data && typeof result.data === "object" &&
      !Array.isArray(result.data) &&
      (result.data as Record<string, unknown>).ok === true;
  } catch {
    return false;
  }
}

const SETTLED_OR_PROCESSING_STATUSES = new Set([
  "CONFIRMED",
  "RECEIVED",
  "RECEIVED_IN_CASH",
  "AWAITING_RISK_ANALYSIS",
  "APPROVED_BY_RISK_ANALYSIS",
  "AUTHORIZED",
  "DUNNING_RECEIVED",
]);

export function paymentNoLongerNeedsCharge(status: unknown): boolean {
  return SETTLED_OR_PROCESSING_STATUSES.has(text(status).toUpperCase());
}
