/// <reference lib="deno.ns" />

import { affiliateCodeFromInvite } from "./index.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: esperado ${expected}, veio ${actual}`);
  }
}

Deno.test("cupom do convite segue a normalização do banco", () => {
  assertEquals(affiliateCodeFromInvite(" afiliada10 "), "AFILIADA10", "espaço");
  assertEquals(affiliateCodeFromInvite("gabi-20!"), "GABI-20", "símbolo");
});

Deno.test("cupom fora do formato vira null e o banco gera um", () => {
  assertEquals(affiliateCodeFromInvite("ab"), null, "curto demais");
  assertEquals(affiliateCodeFromInvite("-ABCD"), null, "começa com traço");
  assertEquals(affiliateCodeFromInvite(null), null, "ausente");
  assertEquals(affiliateCodeFromInvite(42), null, "não é texto");
});
