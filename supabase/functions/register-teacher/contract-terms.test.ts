/// <reference lib="deno.ns" />

import {
  acceptedTeacherContractTermsVersion,
  TEACHER_CONTRACT_TERMS_VERSION,
} from "./contract-terms.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("cadastro de professor so grava o contrato com a clausula do registro das aulas", () => {
  assert(
    TEACHER_CONTRACT_TERMS_VERSION === 2,
    "versao atual do contrato mudou sem revisar a edge",
  );
  assert(
    acceptedTeacherContractTermsVersion(2) === 2,
    "a versao atual foi recusada",
  );
});

Deno.test("pagina antiga (sem versao) ou versao desconhecida e recusada", () => {
  for (const value of [undefined, null, 1, 3, "2", 2.5, {}]) {
    assert(
      acceptedTeacherContractTermsVersion(value) === null,
      `versao ${JSON.stringify(value)} foi aceita`,
    );
  }
});
