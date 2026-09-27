import {
  normalizeAffiliateCouponInput,
  offeredContractTermsVersion,
  offerKindMatches,
} from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("tipo publico da oferta nao pode rebaixar convite de professor", () => {
  assert(
    offerKindMatches("teacher", "TEACHER_INVITE"),
    "professor valido falhou",
  );
  assert(offerKindMatches("vendor", "VENDOR_INVITE"), "vendedor valido falhou");
  assert(
    !offerKindMatches("vendor", "TEACHER_INVITE"),
    "vendedor expos snapshot de professor",
  );
  assert(
    !offerKindMatches("teacher", "VENDOR_INVITE"),
    "professor aceitou convite de vendedor",
  );
});

Deno.test("cupom de afiliado e normalizado antes da validacao autoritativa", () => {
  assert(
    normalizeAffiliateCouponInput("  ww-indica_49  ") === "WW-INDICA_49",
    "cupom nao foi normalizado",
  );
  let rejected = false;
  try {
    normalizeAffiliateCouponInput("x");
  } catch {
    rejected = true;
  }
  assert(rejected, "cupom curto foi aceito");
});

Deno.test("versao do contrato da oferta vem da escola, e resposta estranha nao vira texto", () => {
  assert(offeredContractTermsVersion(2) === 2, "versao 2 da escola recusada");
  assert(offeredContractTermsVersion(1) === 1, "versao 1 da escola recusada");
  for (const value of [null, undefined, 0, -1, 1.5, "2", {}]) {
    let rejected = false;
    try {
      offeredContractTermsVersion(value);
    } catch {
      rejected = true;
    }
    assert(rejected, `versao ${JSON.stringify(value)} virou contrato`);
  }
});
