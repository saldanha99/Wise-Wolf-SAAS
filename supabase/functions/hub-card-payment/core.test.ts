/// <reference lib="deno.ns" />
import {
  asaasCardPayload,
  buyerIp,
  cardInputError,
  declineMessage,
  hasCardOutside,
  luhnValid,
  parseExpiry,
  paymentApproved,
  validCpfCnpj,
} from "./core.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const NOW = new Date("2026-11-22T12:00:00Z");
// Número de teste público (Visa de homologação), CPF de teste autorizado no runbook de E2E.
const CARD = { number: "4111 1111 1111 1111", holderName: "Maria Teste", expiry: "12/28", cvv: "123" };
const HOLDER = { cpfCnpj: "287.188.848-57", postalCode: "12245-000", addressNumber: "10", phone: "(12) 99999-9999" };

Deno.test("Luhn: aceita número válido e recusa um dígito trocado", () => {
  assertEquals(luhnValid("4111111111111111"), true);
  assertEquals(luhnValid("4111111111111112"), false);
  assertEquals(luhnValid("4111"), false);
});

Deno.test("validade: vale até o fim do mês impresso, vencida e mês 13 não", () => {
  assertEquals(parseExpiry("11/26", NOW), { month: "11", year: "2026" });
  assertEquals(parseExpiry("10/26", NOW), null);
  assertEquals(parseExpiry("13/28", NOW), null);
  assertEquals(parseExpiry("1/2030", NOW), { month: "01", year: "2030" });
});

Deno.test("CPF/CNPJ com dígito verificador", () => {
  assertEquals(validCpfCnpj("28718884857"), true);
  assertEquals(validCpfCnpj("28718884858"), false);
  assertEquals(validCpfCnpj("11111111111"), false);
  assertEquals(validCpfCnpj("11.222.333/0001-81"), true);
});

Deno.test("primeiro campo inválido, sem ecoar o valor", () => {
  assertEquals(cardInputError(CARD, HOLDER, NOW), null);
  assertEquals(cardInputError({ ...CARD, number: "4111111111111112" }, HOLDER, NOW), "CARD_NUMBER_INVALID");
  assertEquals(cardInputError({ ...CARD, cvv: "12" }, HOLDER, NOW), "CARD_CVV_INVALID");
  assertEquals(cardInputError({ ...CARD, cvv: "12a3" }, HOLDER, NOW), "CARD_CVV_INVALID");
  assertEquals(cardInputError({ ...CARD, expiry: "01/20" }, HOLDER, NOW), "CARD_EXPIRY_INVALID");
  assertEquals(cardInputError({ ...CARD, holderName: "M4ria" }, HOLDER, NOW), "CARD_HOLDER_INVALID");
  assertEquals(cardInputError(CARD, { ...HOLDER, postalCode: "123" }, NOW), "HOLDER_POSTAL_CODE_INVALID");
  assertEquals(cardInputError(CARD, { ...HOLDER, phone: "999" }, NOW), "HOLDER_PHONE_INVALID");
  assertEquals(cardInputError(null, HOLDER, NOW), "CARD_NUMBER_INVALID");
});

Deno.test("payload do Asaas só com dígitos e o e-mail da conta logada", () => {
  const payload = asaasCardPayload(CARD, HOLDER, "maria@example.com", NOW);
  assertEquals(payload.creditCard, { holderName: "Maria Teste", number: "4111111111111111", expiryMonth: "12", expiryYear: "2028", ccv: "123" });
  assertEquals(payload.creditCardHolderInfo.cpfCnpj, "28718884857");
  assertEquals(payload.creditCardHolderInfo.postalCode, "12245000");
  assertEquals(payload.creditCardHolderInfo.phone, "12999999999");
  assertEquals(payload.creditCardHolderInfo.email, "maria@example.com");
});

Deno.test("IP do comprador é o primeiro do X-Forwarded-For (o Caddy grava o real)", () => {
  assertEquals(buyerIp(new Headers({ "x-forwarded-for": "200.10.20.30, 172.18.0.5" })), "200.10.20.30");
  assertEquals(buyerIp(new Headers({ "x-forwarded-for": "2804:14c::1, 172.18.0.5" })), "2804:14c::1");
  assertEquals(buyerIp(new Headers({ "x-forwarded-for": "999.1.1.1" })), null);
  assertEquals(buyerIp(new Headers({})), null);
});

Deno.test("aprovado só CONFIRMED/RECEIVED; recusa sem eco de número longo", () => {
  assertEquals(paymentApproved({ status: "CONFIRMED" }), true);
  assertEquals(paymentApproved({ status: "PENDING" }), false);
  assertEquals(
    declineMessage({ errors: [{ description: "Transação não autorizada para 4111111111111111" }] }),
    "Transação não autorizada para",
  );
  assertEquals(declineMessage(null), "O cartão não foi aprovado. Confira os dados ou use outro cartão.");
});

Deno.test("cartão fora do campo card é recusado", () => {
  assertEquals(hasCardOutside({ checkoutId: "x", card: {} }), false);
  assertEquals(hasCardOutside({ checkoutId: "x", number: "4111" }), true);
  assertEquals(hasCardOutside({ creditCard: {} }), true);
});
