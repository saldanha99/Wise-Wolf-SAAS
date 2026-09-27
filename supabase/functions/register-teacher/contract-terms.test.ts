/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  assertOfferedTeacherContractTermsVersion,
  ContractTermsVersionMismatchError,
  offeredTeacherContractTermsVersion,
  recordTeacherContractTerms,
  requestedTeacherContractTermsVersion,
  TEACHER_CONTRACT_TERMS_VERSION,
} from "./contract-terms.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("era para recusar");
}

/** Cliente dublado: registra as chamadas e devolve o que o teste mandar. */
function fakeAdmin(options: {
  rpc?: { data: unknown; error: unknown };
  insertError?: unknown;
}) {
  const calls: {
    rpc: Array<{ fn: string; args: unknown }>;
    inserts: Array<{ table: string; row: Record<string, unknown> }>;
  } = { rpc: [], inserts: [] };
  const admin = {
    rpc(fn: string, args: unknown) {
      calls.rpc.push({ fn, args });
      return Promise.resolve(options.rpc ?? { data: null, error: null });
    },
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          calls.inserts.push({ table, row });
          return Promise.resolve({ error: options.insertError ?? null });
        },
      };
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

Deno.test("pagina antiga (sem versao) ou versao desconhecida e recusada", () => {
  assert(
    TEACHER_CONTRACT_TERMS_VERSION === 2,
    "versao mais nova do contrato mudou sem revisar a edge",
  );
  assert(requestedTeacherContractTermsVersion(2) === 2, "versao 2 recusada");
  assert(requestedTeacherContractTermsVersion(1) === 1, "versao 1 recusada");
  for (const value of [undefined, null, 0, 3, "2", 2.5, {}]) {
    assert(
      requestedTeacherContractTermsVersion(value) === null,
      `versao ${JSON.stringify(value)} foi aceita`,
    );
  }
});

Deno.test("a versao vem da escola do convite, e a pagina tem de ter mostrado ela", async () => {
  const { admin, calls } = fakeAdmin({ rpc: { data: 2, error: null } });
  assert(
    await offeredTeacherContractTermsVersion(admin, "escola-a") === 2,
    "versao oferecida pela escola nao foi lida",
  );
  assert(
    calls.rpc[0]?.fn === "contract_terms_offered_version" &&
      JSON.stringify(calls.rpc[0]?.args) ===
        JSON.stringify({ p_tenant: "escola-a", p_contract_kind: "TEACHER" }),
    "consultou outra coisa que nao a versao do professor da escola do convite",
  );
  assert(
    assertOfferedTeacherContractTermsVersion(2, 2) === 2,
    "versao igual a oferecida foi recusada",
  );
  // Escola sem a decisao (oferece 1) e pagina mostrando a clausula: recusa.
  let mismatch: unknown = null;
  try {
    assertOfferedTeacherContractTermsVersion(2, 1);
  } catch (error) {
    mismatch = error;
  }
  assert(
    mismatch instanceof ContractTermsVersionMismatchError,
    "pagina com a clausula foi aceita numa escola que nao a oferece",
  );
});

Deno.test("sem conseguir ler a versao da escola, o cadastro nao conclui", async () => {
  for (
    const rpc of [
      { data: null, error: { message: "timeout" } },
      { data: null, error: null },
      { data: "2", error: null },
      { data: 99, error: null },
    ]
  ) {
    const { admin } = fakeAdmin({ rpc });
    const error = await rejects(() =>
      offeredTeacherContractTermsVersion(admin, "escola-a")
    );
    assert(
      error instanceof Error &&
        error.message === "contract_terms_offer_unavailable",
      `resposta ${JSON.stringify(rpc)} virou versao`,
    );
  }
});

Deno.test("o aceite do convite e gravado com a origem, o convite e a versao", async () => {
  const { admin, calls } = fakeAdmin({});
  await recordTeacherContractTerms(admin, {
    tenantId: "escola-a",
    userId: "11111111-1111-4111-8111-111111111111",
    offerId: "22222222-2222-4222-8222-222222222222",
    termsVersion: 2,
    acceptedAt: "2026-09-27T12:00:00.000Z",
  });
  assert(calls.inserts.length === 1, "aceite nao foi gravado");
  const [{ table, row }] = calls.inserts;
  assert(table === "contract_terms_acceptances", `gravou em ${table}`);
  assert(
    row.tenant_id === "escola-a" &&
      row.user_id === "11111111-1111-4111-8111-111111111111" &&
      row.contract_kind === "TEACHER" &&
      row.terms_version === 2 &&
      row.source === "TEACHER_INVITE" &&
      row.source_id === "22222222-2222-4222-8222-222222222222" &&
      row.accepted_at === "2026-09-27T12:00:00.000Z",
    `aceite gravado errado: ${JSON.stringify(row)}`,
  );

  const failing = fakeAdmin({ insertError: { message: "permission denied" } });
  const error = await rejects(() =>
    recordTeacherContractTerms(failing.admin, {
      tenantId: "escola-a",
      userId: "u",
      offerId: "o",
      termsVersion: 2,
      acceptedAt: "2026-09-27T12:00:00.000Z",
    })
  );
  assert(
    error instanceof Error && error.message === "contract_terms_record_failed",
    "falha ao gravar o aceite passou em silencio",
  );
});

/**
 * A ordem no handler e o que protege o aceite: a versao pedida e conferida
 * antes de tudo (409 sem gastar o convite), a oferecida depois de reservar o
 * convite e ANTES de criar a conta, o aceite e gravado antes de finalizar o
 * convite (falhou → cadastro desfeito), e a divergencia vira 409.
 */
Deno.test("o cadastro confere e grava a versao na ordem certa", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const at = (needle: string) => {
    const index = source.indexOf(needle);
    assert(index >= 0, `trecho ausente no handler: ${needle}`);
    return index;
  };
  const requested = at("requestedTeacherContractTermsVersion(");
  const claim = at("await claimInvite(");
  const offered = at(
    "await offeredTeacherContractTermsVersion(admin, invite.tenantId)",
  );
  const createUser = at("admin.auth.admin");
  const snapshot = at("contractTermsVersion,\n        },");
  const record = at("await recordTeacherContractTerms(admin, {");
  const finalize = at("await finalizeInvite(");
  assert(
    requested < claim,
    "versao pedida conferida depois de reservar o convite",
  );
  assert(
    claim < offered && offered < createUser,
    "versao da escola conferida fora de hora",
  );
  assert(
    snapshot < record && record < finalize,
    "aceite gravado depois de finalizar o convite",
  );
  assert(
    /instanceof ContractTermsVersionMismatchError\)\s*\{\s*return json\([^)]*\}, 409\)/
      .test(source),
    "divergencia de versao nao vira 409",
  );
  assert(
    source.includes("termsVersion: contractTermsVersion") &&
      source.includes("offerId: invite.offerId"),
    "o aceite nao grava a versao oferecida ou o convite",
  );
});
