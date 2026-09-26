/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
  assertFalse,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildCodeMessage,
  httpStatusForIssueError,
  type IssuedCode,
  parseCodeRequest,
  parseIssuedCode,
  settleStatusFor,
} from "./core.ts";

const TOKEN = "a".repeat(64);
const ISSUED = {
  ok: true,
  challenge_id: "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d",
  code: "042917",
  destination: "5511900000001",
  destination_masked: "(11) •••••-0001",
  relation: "GUARDIAN",
  tenant_id: "school-fixture",
  school_name: "Escola Fixture",
  student_first_name: "Pedro",
  expires_at: "2026-09-26T20:10:00Z",
};

Deno.test("pedido aceita só token de 64 hex e as duas relações", () => {
  assertEquals(parseCodeRequest({ token: TOKEN, relation: "SELF" }), {
    token: TOKEN,
    relation: "SELF",
  });
  assertEquals(
    parseCodeRequest({ token: ` ${TOKEN} `, relation: "GUARDIAN" })?.token,
    TOKEN,
  );
  assertEquals(
    parseCodeRequest({ token: TOKEN.toUpperCase(), relation: "SELF" }),
    null,
  );
  assertEquals(
    parseCodeRequest({ token: "a".repeat(63), relation: "SELF" }),
    null,
  );
  assertEquals(parseCodeRequest({ token: TOKEN, relation: "SCHOOL" }), null);
  assertEquals(parseCodeRequest(null), null);
  assertEquals(parseCodeRequest([TOKEN]), null);
});

Deno.test("resposta do banco vira código emitido ou recusa com espera", () => {
  const issued = parseIssuedCode(ISSUED) as IssuedCode;
  assertEquals(issued.code, "042917");
  assertEquals(issued.destination, "5511900000001");
  assertEquals(issued.relation, "GUARDIAN");
  assertEquals(
    parseIssuedCode({
      ok: false,
      error: "limite_de_envios",
      retry_after_seconds: 1799.2,
    }),
    {
      error: "limite_de_envios",
      retryAfterSeconds: 1800,
    },
  );
  assertEquals(parseIssuedCode({ ok: false, error: "link_expirado" }), {
    error: "link_expirado",
    retryAfterSeconds: null,
  });
  // Resposta malformada nunca vira envio.
  assert("error" in parseIssuedCode({ ...ISSUED, code: "12345" }));
  assert("error" in parseIssuedCode({ ...ISSUED, destination: "11900000001" }));
  assert("error" in parseIssuedCode({ ...ISSUED, relation: "SCHOOL" }));
  assert("error" in parseIssuedCode(null));
});

Deno.test("mensagem traz o código, a validade e o aviso de não repassar", () => {
  const guardian = buildCodeMessage({
    schoolName: "Escola Fixture",
    studentFirstName: "Pedro",
    relation: "GUARDIAN",
    code: "042917",
  });
  assert(guardian.includes("*042917*"));
  assert(guardian.includes("das aulas de Pedro"));
  assert(guardian.includes("10 minutos"));
  assert(guardian.includes("Não repasse"));
  assertFalse(guardian.includes("http"), "código não vai junto com link");

  const self = buildCodeMessage({
    schoolName: null,
    studentFirstName: "Ana",
    relation: "SELF",
    code: "000001",
  });
  assert(self.includes("das suas aulas"));
  assert(self.startsWith("*Escola*"));
});

Deno.test("resultado do envio decide o que conta no limite", () => {
  assertEquals(settleStatusFor({ outcome: "accepted" }), "SENT");
  assertEquals(
    settleStatusFor({ outcome: "rejected", throttled: true }),
    "NOT_SENT",
  );
  assertEquals(settleStatusFor({ outcome: "rejected" }), "NOT_SENT");
  assertEquals(settleStatusFor({ outcome: "ambiguous" }), "AMBIGUOUS");
});

Deno.test("recusas do banco têm status HTTP próprios", () => {
  assertEquals(httpStatusForIssueError("resposta_invalida"), 400);
  assertEquals(httpStatusForIssueError("link_expirado"), 410);
  assertEquals(httpStatusForIssueError("responsavel_obrigatorio"), 409);
  assertEquals(httpStatusForIssueError("telefone_nao_cadastrado"), 409);
  assertEquals(httpStatusForIssueError("limite_de_envios"), 429);
  assertEquals(httpStatusForIssueError("qualquer"), 503);
});
