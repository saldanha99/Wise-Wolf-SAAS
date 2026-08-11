/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  clientIp,
  parseBillingType,
  parseCreditCard,
  safeProviderMessage,
} from "./core.ts";

Deno.test("aceita apenas as tres formas de pagamento suportadas", () => {
  assertEquals(parseBillingType(" pix "), "PIX");
  assertEquals(parseBillingType("BOLETO"), "BOLETO");
  assertEquals(parseBillingType("credit_card"), "CREDIT_CARD");
  assertEquals(parseBillingType("UNDEFINED"), null);
});

Deno.test("normaliza o cartao sem reter caracteres de formatacao", () => {
  assertEquals(
    parseCreditCard({
      holderName: "  Titular Teste ",
      number: "4111 1111 1111 1111",
      expiryMonth: "9",
      expiryYear: "2030",
      ccv: "123",
    }),
    {
      holderName: "Titular Teste",
      number: "4111111111111111",
      expiryMonth: "09",
      expiryYear: "2030",
      ccv: "123",
    },
  );
});

Deno.test("rejeita cartao incompleto", () => {
  assertEquals(
    parseCreditCard({ holderName: "A", number: "123", ccv: "1" }),
    null,
  );
});

Deno.test("usa o primeiro IP encaminhado e rejeita texto arbitrario", () => {
  assertEquals(
    clientIp(new Headers({ "x-forwarded-for": "203.0.113.2, 10.0.0.1" })),
    "203.0.113.2",
  );
  assertEquals(clientIp(new Headers({ "x-forwarded-for": "not-an-ip" })), null);
});

Deno.test("oculta sequencias que parecem cartao ou documento", () => {
  assertEquals(
    safeProviderMessage("Cartao 4111111111111111 CPF 287.188.848-57 recusado"),
    "Cartao [cartao oculto] CPF [documento oculto] recusado",
  );
});
