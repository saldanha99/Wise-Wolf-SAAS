export type ProviderPayment = Record<string, unknown> & {
  id?: unknown;
  status?: unknown;
  billingType?: unknown;
  dueDate?: unknown;
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
  const candidate = new Date(Date.UTC(year, month - 1 + monthOffset, safeDueDay));
  return candidate.toISOString().slice(0, 10);
}

const OPEN_STATUSES = new Set(["PENDING", "OVERDUE"]);
const PIX_COMPATIBLE_TYPES = new Set(["PIX", "BOLETO", "UNDEFINED"]);

export function paymentBelongsToStudent(
  payment: ProviderPayment,
  studentId: string,
  subscriptionId: string,
): boolean {
  return text(payment.externalReference) === studentId ||
    Boolean(subscriptionId && text(payment.subscription) === subscriptionId);
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

export function hasOpenNonPixPayment(payments: ProviderPayment[]): boolean {
  return payments.some((payment) =>
    text(payment.id) &&
    OPEN_STATUSES.has(text(payment.status).toUpperCase()) &&
    !PIX_COMPATIBLE_TYPES.has(text(payment.billingType).toUpperCase())
  );
}

export function formatManualPixMessage(input: {
  studentName: string;
  value: number;
  dueDate: string;
  pixPayload: string;
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
    `Olá, ${firstName}! 🐺`,
    "",
    `Segue o Pix copia e cola da sua mensalidade Wise Wolf no valor de *${formattedValue}*, com vencimento em *${formattedDueDate}*:`,
    "",
    input.pixPayload,
    "",
    "Esta cobrança é individual e já está vinculada ao seu cadastro. Assim que o pagamento for confirmado, a plataforma fará a baixa automaticamente.",
  ].join("\n");
}
