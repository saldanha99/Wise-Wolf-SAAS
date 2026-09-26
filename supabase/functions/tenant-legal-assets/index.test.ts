import { normalizeAffiliateCouponInput, offerKindMatches } from "./index.ts";

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
