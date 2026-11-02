/// <reference lib="deno.ns" />

import { affiliateCodeFromInvite, registeredAffiliateCode } from "./index.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: esperado ${expected}, veio ${actual}`);
  }
}

Deno.test("cupom do convite segue a normalização do banco", () => {
  assertEquals(affiliateCodeFromInvite(" afiliada10 "), "AFILIADA10", "espaço");
  assertEquals(affiliateCodeFromInvite("gabi-20!"), "GABI-20", "símbolo");
});

Deno.test("a conclusão recebe o cupom que ficou na conta, nunca um palpite", () => {
  assertEquals(
    registeredAffiliateCode({ affiliate_code: "AFILIADA10" }),
    "AFILIADA10",
    "cupom do convite",
  );
  assertEquals(
    registeredAffiliateCode({ affiliate_code: "gabriela7k2" }),
    "GABRIELA7K2",
    "cupom gerado pelo banco",
  );
  assertEquals(
    registeredAffiliateCode({ affiliate_code: null }),
    null,
    "sem cupom",
  );
  assertEquals(registeredAffiliateCode(null), null, "leitura falhou");
});

Deno.test("cupom fora do formato vira null e o banco gera um", () => {
  assertEquals(affiliateCodeFromInvite("ab"), null, "curto demais");
  assertEquals(affiliateCodeFromInvite("-ABCD"), null, "começa com traço");
  assertEquals(affiliateCodeFromInvite(null), null, "ausente");
  assertEquals(affiliateCodeFromInvite(42), null, "não é texto");
});
