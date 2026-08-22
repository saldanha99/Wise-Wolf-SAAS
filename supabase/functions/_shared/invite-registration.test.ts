/// <reference lib="deno.ns" />

import {
  InviteRegistrationError,
  isServerInviteId,
  validateClaimedInvite,
} from "./invite-registration.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const schoolInfo = {
  legalName: "School A Ltda",
  cnpj: "12345678000190",
  address: "Rua Segura, 100",
  email: "legal@school-a.example",
  phone: "11999999999",
  city: "Sao Paulo",
  state: "SP",
  legalRepresentativeName: "Representante A",
  legalRepresentativeSignaturePath:
    "school-a/legal-representative-signature/00000000-0000-4000-8000-000000000011.png",
};

Deno.test("aceita apenas UUID de capacidade server-side", () => {
  assert(
    isServerInviteId("00000000-0000-4000-8000-000000000001"),
    "UUID valido foi rejeitado",
  );
  assert(
    !isServerInviteId("eyJ0ZW5hbnRJZCI6Im91dHJvIn0="),
    "base64 foi aceito",
  );
  assert(
    !isServerInviteId({ tenantId: "other" }),
    "objeto editavel foi aceito",
  );
});

Deno.test("valida tenant e condicao vindos da oferta reivindicada", () => {
  const value = validateClaimedInvite({
    _offerId: "00000000-0000-4000-8000-000000000001",
    kind: "TEACHER_INVITE",
    tenantId: "school-a",
    hourlyRate: 50,
    subject: "Ingles",
    schoolInfo,
  }, "TEACHER_INVITE");
  assert(value.tenantId === "school-a", "tenant canonico foi perdido");
});

Deno.test("rejeita convite de professor sem identidade juridica server-side", () => {
  let rejected = false;
  try {
    validateClaimedInvite({
      _offerId: "00000000-0000-4000-8000-000000000001",
      kind: "TEACHER_INVITE",
      tenantId: "school-a",
      hourlyRate: 50,
      subject: "Ingles",
      schoolInfo: { legalName: "School A Ltda" },
    }, "TEACHER_INVITE");
  } catch (error) {
    rejected = error instanceof InviteRegistrationError;
  }
  assert(rejected, "snapshot juridico incompleto foi aceito");
});

Deno.test("rejeita assinatura privada de outro tenant", () => {
  let rejected = false;
  try {
    validateClaimedInvite({
      _offerId: "00000000-0000-4000-8000-000000000001",
      kind: "TEACHER_INVITE",
      tenantId: "school-b",
      hourlyRate: 50,
      subject: "Ingles",
      schoolInfo,
    }, "TEACHER_INVITE");
  } catch (error) {
    rejected = error instanceof InviteRegistrationError;
  }
  assert(rejected, "path juridico cross-tenant foi aceito");
});

Deno.test("rejeita condicao comercial fora dos limites", () => {
  let rejected = false;
  try {
    validateClaimedInvite({
      _offerId: "00000000-0000-4000-8000-000000000001",
      kind: "VENDOR_INVITE",
      tenantId: "school-a",
      commissionRate: 999_999_999,
    }, "VENDOR_INVITE");
  } catch (error) {
    rejected = error instanceof InviteRegistrationError;
  }
  assert(rejected, "comissao adulterada foi aceita");
});
