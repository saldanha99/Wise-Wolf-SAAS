// Cartão digitado no NOSSO formulário (checkout transparente do Asaas), 22/11/2026.
//
// O Asaas não tem campo seguro de navegador: toda chamada exige a chave secreta da
// conta, então o número do cartão PASSA por esta edge function a caminho do Asaas
// (modelo: lib/cartao.ts + server/anualParcelado.ts do MotoFix). Regras:
//   - nunca guardar número, validade ou CVV (nem banco, nem arquivo, nem log, nem resposta);
//   - validar antes de mandar (cartão inválido não vira tentativa no Asaas);
//   - mensagens de erro NUNCA trazem o dado digitado;
//   - depois da tentativa, só os 4 últimos dígitos e a bandeira (do Asaas) são gravados.
// Fluxo e proteções: docs/PAGAMENTOS-CARTAO.md.

export const onlyDigits = (value: unknown) => String(value ?? "").replace(/\D/g, "");

/** Dígito verificador do número do cartão (Luhn). */
export function luhnValid(number: string): boolean {
  const d = onlyDigits(number);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Mês e ano (4 dígitos) da validade, ou null se inválida/vencida. Vale até o fim do mês impresso. */
export function parseExpiry(
  value: unknown,
  now = new Date(),
): { month: string; year: string } | null {
  const m = String(value ?? "").trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  if (month < 1 || month > 12) return null;
  const endOfMonth = new Date(Date.UTC(year, month, 1));
  if (endOfMonth.getTime() <= now.getTime()) return null;
  if (year > now.getUTCFullYear() + 20) return null;
  return { month: String(month).padStart(2, "0"), year: String(year) };
}

/** CPF (11) ou CNPJ (14) com dígitos verificadores. */
export function validCpfCnpj(value: unknown): boolean {
  const d = onlyDigits(value);
  if (d.length === 11) {
    if (/^(\d)\1{10}$/.test(d)) return false;
    const calc = (len: number) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
      const r = (sum * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
  }
  if (d.length === 14) {
    if (/^(\d)\1{13}$/.test(d)) return false;
    const calc = (len: number) => {
      const weights = len === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      let sum = 0;
      for (let i = 0; i < len; i++) sum += Number(d[i]) * weights[i];
      const r = sum % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
  }
  return false;
}

export interface CardInput {
  number?: unknown;
  holderName?: unknown;
  expiry?: unknown;
  cvv?: unknown;
}

export interface HolderInput {
  cpfCnpj?: unknown;
  postalCode?: unknown;
  addressNumber?: unknown;
  phone?: unknown;
}

export type CardFieldError =
  | "CARD_NUMBER_INVALID"
  | "CARD_HOLDER_INVALID"
  | "CARD_EXPIRY_INVALID"
  | "CARD_CVV_INVALID"
  | "HOLDER_DOCUMENT_INVALID"
  | "HOLDER_POSTAL_CODE_INVALID"
  | "HOLDER_ADDRESS_NUMBER_INVALID"
  | "HOLDER_PHONE_INVALID";

/** Primeiro campo inválido, ou null. Nunca devolve o valor digitado. */
export function cardInputError(
  card: CardInput | null | undefined,
  holder: HolderInput | null | undefined,
  now = new Date(),
): CardFieldError | null {
  const number = onlyDigits(card?.number);
  if (!luhnValid(number)) return "CARD_NUMBER_INVALID";
  const name = String(card?.holderName ?? "").trim();
  if (name.length < 3 || name.length > 100 || /\d/.test(name)) return "CARD_HOLDER_INVALID";
  if (!parseExpiry(card?.expiry, now)) return "CARD_EXPIRY_INVALID";
  const cvv = onlyDigits(card?.cvv);
  if (String(card?.cvv ?? "").trim() !== cvv || cvv.length < 3 || cvv.length > 4) {
    return "CARD_CVV_INVALID";
  }
  if (!validCpfCnpj(holder?.cpfCnpj)) return "HOLDER_DOCUMENT_INVALID";
  if (onlyDigits(holder?.postalCode).length !== 8) return "HOLDER_POSTAL_CODE_INVALID";
  const addressNumber = String(holder?.addressNumber ?? "").trim();
  if (!addressNumber || addressNumber.length > 20) return "HOLDER_ADDRESS_NUMBER_INVALID";
  const phone = onlyDigits(holder?.phone);
  if (phone.length < 10 || phone.length > 11) return "HOLDER_PHONE_INVALID";
  return null;
}

/**
 * Monta `creditCard` e `creditCardHolderInfo` do Asaas (como o `dadosDoCartao` do MotoFix).
 * Chame só depois de `cardInputError` devolver null.
 */
export function asaasCardPayload(
  card: CardInput,
  holder: HolderInput,
  email: string,
  now = new Date(),
): { creditCard: Record<string, string>; creditCardHolderInfo: Record<string, string> } {
  const expiry = parseExpiry(card.expiry, now);
  if (!expiry) throw new Error("CARD_EXPIRY_INVALID");
  const name = String(card.holderName).trim().slice(0, 100);
  const phone = onlyDigits(holder.phone);
  return {
    creditCard: {
      holderName: name,
      number: onlyDigits(card.number),
      expiryMonth: expiry.month,
      expiryYear: expiry.year,
      ccv: onlyDigits(card.cvv),
    },
    creditCardHolderInfo: {
      name,
      email: String(email || "").trim(),
      cpfCnpj: onlyDigits(holder.cpfCnpj),
      postalCode: onlyDigits(holder.postalCode),
      addressNumber: String(holder.addressNumber).trim().slice(0, 20),
      phone,
      mobilePhone: phone,
    },
  };
}

/**
 * IP do comprador (o Asaas exige `remoteIp` no antifraude). Caminho na VPS:
 * comprador → Caddy (não confia no X-Forwarded-For do cliente e grava o IP real) →
 * Kong (acrescenta o IP do Caddy) → edge. Logo o PRIMEIRO item é o do comprador.
 * Nunca usar o IP do servidor.
 */
export function buyerIp(headers: Headers): string | null {
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(first)) {
    return first.split(".").every((part) => Number(part) <= 255) ? first : null;
  }
  if (/^[0-9a-f:]{2,39}$/i.test(first) && first.includes(":")) return first.toLowerCase();
  return null;
}

/** Resultado do Asaas → aprovado? */
export function paymentApproved(payment: unknown): boolean {
  const status = String((payment as { status?: unknown })?.status ?? "").toUpperCase();
  return status === "CONFIRMED" || status === "RECEIVED";
}

/** Mensagem do Asaas para o comprador, sem eco de dado digitado (só texto do provedor, curto). */
export function declineMessage(body: unknown): string {
  const errors = (body as { errors?: { code?: unknown; description?: unknown }[] })?.errors;
  const description = Array.isArray(errors) ? String(errors[0]?.description ?? "") : "";
  const clean = description.replace(/\d{6,}/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
  return clean || "O cartão não foi aprovado. Confira os dados ou use outro cartão.";
}

/** Corpo de requisição com campo de cartão fora do lugar esperado é recusado. */
const CARD_KEYS = new Set(["number", "cvv", "ccv", "cardnumber", "creditcard", "expiry", "expirymonth", "expiryyear"]);
export function hasCardOutside(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) =>
    key !== "card" && CARD_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, ""))
  );
}

/** IP privado/loopback: sinal de que a cadeia de proxies mudou (todos dividiriam o mesmo teto). */
export function isPrivateIp(ip: string): boolean {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip) || ip === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(ip);
}
