import { offerKindMatches } from "./index.ts";

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
