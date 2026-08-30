import {
  providerPaymentSplitMatches,
  type ProviderSplitPolicy,
} from "../_shared/student-provider-lifecycle.ts";

export type ProviderPayment = Record<string, unknown> & {
  id?: unknown;
  status?: unknown;
  billingType?: unknown;
  dueDate?: unknown;
  value?: unknown;
  customer?: unknown;
  deleted?: unknown;
  externalReference?: unknown;
  subscription?: unknown;
};

export const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const digits = (value: unknown): string =>
  String(value || "").replace(/\D/g, "");

export function normalizeBrazilianPhone(value: unknown): string | null {
  let phone = digits(value);
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  return /^55\d{10,11}$/.test(phone) ? phone : null;
}

export function nextUpcomingDueDate(
  now: Date,
  dueDay: number,
  timeZone = "America/Sao_Paulo",
): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const safeDueDay = Math.min(28, Math.max(1, Math.trunc(dueDay) || 10));
  const monthOffset = day >= safeDueDay ? 1 : 0;
  const candidate = new Date(
    Date.UTC(year, month - 1 + monthOffset, safeDueDay),
  );
  return candidate.toISOString().slice(0, 10);
}

const OPEN_STATUSES = new Set(["PENDING", "OVERDUE"]);
const BLOCKING_MANUAL_PIX_STATUSES = new Set([
  // CONFIRMED is not settled cash and must not grant access, but the payer has
  // already committed to that charge. Creating a parallel Pix can therefore
  // collect the same competence twice.
  "CONFIRMED",
  "DUNNING_REQUESTED",
  "AWAITING_RISK_ANALYSIS",
  "APPROVED_BY_RISK_ANALYSIS",
  "AUTHORIZED",
]);
const VOID_PAYMENT_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "DELETED",
  "REFUNDED",
]);
const PIX_COMPATIBLE_TYPES = new Set(["PIX", "BOLETO", "UNDEFINED"]);

export function paymentBelongsToStudent(
  payment: ProviderPayment,
  studentId: string,
  subscriptionId: string,
): boolean {
  const externalReference = text(payment.externalReference);
  const manualReferenceParts = externalReference.split(":");
  const isManualPixReference = manualReferenceParts.length === 4 &&
    manualReferenceParts[0] === "manual-pix" &&
    manualReferenceParts[1].length > 0 &&
    manualReferenceParts[2] === "student" &&
    manualReferenceParts[3] === studentId;
  return externalReference === studentId ||
    isManualPixReference ||
    Boolean(subscriptionId && text(payment.subscription) === subscriptionId);
}

export function manualPixProviderReference(
  issuanceId: string,
  studentId: string,
): string {
  return `manual-pix:${issuanceId}:student:${studentId}`;
}

export function manualPixIssuanceIdFromReference(
  externalReference: unknown,
  studentId: string,
): string | null {
  const match = text(externalReference).match(
    /^manual-pix:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):student:([0-9a-f-]+)$/i,
  );
  return match && match[2] === studentId ? match[1].toLowerCase() : null;
}

export function recurringPaymentSourceKey(
  payment: ProviderPayment,
  studentId: string,
  subscriptionId: string,
): string | null {
  if (!subscriptionId || text(payment.subscription) !== subscriptionId) {
    return null;
  }
  const externalReference = text(payment.externalReference);
  if (externalReference === studentId) return `subscription:${studentId}`;
  const enrollmentReference = externalReference.match(
    /^enrollment:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):subscription$/i,
  );
  return enrollmentReference
    ? `subscription:${enrollmentReference[1].toLowerCase()}`
    : null;
}

export function providerPaymentMatchesManualIssuance(
  payment: ProviderPayment,
  expected: {
    externalReference: string;
    customerId: string;
    dueDate: string;
    value: number;
    splitPolicy: ProviderSplitPolicy;
  },
): boolean {
  const providerValue = Number(payment.value);
  return payment.deleted !== true &&
    text(payment.id) !== "" &&
    text(payment.externalReference) === expected.externalReference &&
    text(payment.customer) === expected.customerId &&
    text(payment.billingType).toUpperCase() === "PIX" &&
    text(payment.subscription) === "" &&
    text(payment.dueDate) === expected.dueDate &&
    Number.isFinite(providerValue) &&
    Math.round(providerValue * 100) === Math.round(expected.value * 100) &&
    providerPaymentSplitMatches(payment, expected.splitPolicy);
}

export function selectOpenPixPayment(
  payments: ProviderPayment[],
): ProviderPayment | null {
  return payments
    .filter((payment) =>
      text(payment.id) &&
      OPEN_STATUSES.has(text(payment.status).toUpperCase()) &&
      PIX_COMPATIBLE_TYPES.has(text(payment.billingType).toUpperCase())
    )
    .sort((left, right) =>
      text(left.dueDate).localeCompare(text(right.dueDate))
    )[0] || null;
}

export function providerPaymentMatchesMonthlyCompetence(
  payment: ProviderPayment,
  expected: {
    studentId: string;
    subscriptionId: string;
    customerId: string;
    dueDate: string;
    value: number;
    splitPolicy: ProviderSplitPolicy;
  },
): boolean {
  const status = text(payment.status).toUpperCase();
  const billingType = text(payment.billingType).toUpperCase();
  const providerValue = Number(payment.value);
  return payment.deleted !== true &&
    text(payment.id) !== "" &&
    OPEN_STATUSES.has(status) &&
    PIX_COMPATIBLE_TYPES.has(billingType) &&
    text(payment.customer) === expected.customerId &&
    text(payment.dueDate) === expected.dueDate &&
    Number.isFinite(providerValue) &&
    Math.round(providerValue * 100) === Math.round(expected.value * 100) &&
    providerPaymentSplitMatches(payment, expected.splitPolicy) &&
    paymentBelongsToStudent(
      payment,
      expected.studentId,
      expected.subscriptionId,
    );
}

export function selectExactMonthlyPixPayment(
  payments: ProviderPayment[],
  expected: Parameters<typeof providerPaymentMatchesMonthlyCompetence>[1],
): ProviderPayment | null {
  const matches = payments.filter((payment) =>
    providerPaymentMatchesMonthlyCompetence(payment, expected)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function hasOpenNonPixPayment(payments: ProviderPayment[]): boolean {
  return payments.some((payment) => {
    if (!text(payment.id)) return false;
    const status = text(payment.status).toUpperCase();
    return BLOCKING_MANUAL_PIX_STATUSES.has(status) ||
      (OPEN_STATUSES.has(status) &&
        !PIX_COMPATIBLE_TYPES.has(text(payment.billingType).toUpperCase()));
  });
}

/**
 * A settled or otherwise live charge already occupying the target due date is
 * a financial commitment even when it is no longer "open". It must block a
 * second manual creation for the same monthly competence.
 */
export function paymentOccupiesDueDate(
  payment: ProviderPayment,
  dueDate: string,
): boolean {
  if (!text(payment.id) || payment.deleted === true) return false;
  if (text(payment.dueDate) !== dueDate) return false;
  return !VOID_PAYMENT_STATUSES.has(text(payment.status).toUpperCase());
}

export function formatManualPixMessage(input: {
  studentName: string;
  value: number;
  dueDate: string;
  pixPayload: string;
  brandName: string;
}): string {
  const firstName = text(input.studentName).split(/\s+/)[0] || "aluno";
  const [year, month, day] = input.dueDate.split("-");
  const formattedDueDate = year && month && day
    ? `${day}/${month}/${year}`
    : input.dueDate;
  const formattedValue = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(input.value);

  return [
    `Olá, ${firstName}!`,
    "",
    `Segue o Pix copia e cola da sua mensalidade ${
      text(input.brandName) || "da escola"
    } no valor de *${formattedValue}*, com vencimento em *${formattedDueDate}*:`,
    "",
    input.pixPayload,
    "",
    "Esta cobrança é individual e já está vinculada ao seu cadastro. Assim que o valor for recebido no saldo, a plataforma fará a baixa automaticamente.",
  ].join("\n");
}
