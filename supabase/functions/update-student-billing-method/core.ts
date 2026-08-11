export const BILLING_TYPES = ["PIX", "BOLETO", "CREDIT_CARD"] as const;

export type BillingType = typeof BILLING_TYPES[number];

export type CreditCardInput = {
  holderName: string;
  number: string;
  expiryMonth: string;
  expiryYear: string;
  ccv: string;
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
