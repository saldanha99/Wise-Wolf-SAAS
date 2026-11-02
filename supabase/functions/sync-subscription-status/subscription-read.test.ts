import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { type CanonicalAsaasMutationTarget } from "../_shared/asaas-mutation-guard.ts";
import {
  proveLegacySubscriptionRead,
  type ReadIdentity,
  readSubscriptionForStatusSync,
} from "./subscription-read.ts";

const target: CanonicalAsaasMutationTarget = {
  tenantId: "school-test",
  studentId: "00000000-0000-4000-8000-000000000011",
  resource: "subscription",
  entityId: "sub_test",
  customerId: "cus_test",
  subscriptionId: "sub_test",
  subscriptionMatch: "entity_id",
};
const local: ReadIdentity = {
  id: target.studentId,
  tenant_id: target.tenantId,
  asaas_customer_id: "cus_test",
  subscription_id: "sub_test",
  cpf: "12345678909",
  guardian_cpf: null,
  guardian_name: null,
  full_name: "Aluno Sintético",
  email: "fixture@example.invalid",
  phone: "11987654321",
};
const subscription = {
  id: "sub_test",
  customer: "cus_test",
  externalReference: null,
  status: "ACTIVE",
};
const customer = {
  id: "cus_test",
  cpfCnpj: "123.456.789-09",
  name: "Aluno Sintético",
  email: "fixture@example.invalid",
  mobilePhone: "5511987654321",
};
const bindings = [{ id: target.studentId }];

Deno.test("leitura legada exige documento exato e vínculo único de aluno/escola/assinatura", () => {
  assertEquals(
    proveLegacySubscriptionRead(
      target,
      local,
      bindings,
      subscription,
      customer,
    ),
    true,
  );
  for (
    const changed of [
      { ...local, id: "outro" },
      { ...local, tenant_id: "outra-escola" },
      { ...local, asaas_customer_id: "cus_other" },
      { ...local, subscription_id: "sub_other" },
      { ...local, cpf: "98765432100" },
      { ...local, cpf: "123" },
    ]
  ) {
    assertEquals(
      proveLegacySubscriptionRead(
        target,
        changed,
        bindings,
        subscription,
        customer,
      ),
      false,
    );
  }
  assertEquals(
    proveLegacySubscriptionRead(
      target,
      local,
      [...bindings, { id: "outro" }],
      subscription,
      customer,
    ),
    false,
  );
  assertEquals(
    proveLegacySubscriptionRead(target, local, [], subscription, customer),
    false,
  );
});

Deno.test("referência externa estrangeira e objeto de outra pessoa nunca viram prova legada", () => {
  for (
    const changed of [
      { ...subscription, id: "sub_other" },
      { ...subscription, customer: "cus_other" },
      { ...subscription, externalReference: "outro-aluno" },
    ]
  ) {
    assertEquals(
      proveLegacySubscriptionRead(target, local, bindings, changed, customer),
      false,
    );
  }
  assertEquals(
    proveLegacySubscriptionRead(target, local, bindings, subscription, {
      ...customer,
      id: "cus_other",
    }),
    false,
  );
  assertEquals(
    proveLegacySubscriptionRead(
      { ...target, resource: "payment" },
      local,
      bindings,
      subscription,
      customer,
    ),
    false,
  );
});

Deno.test("responsável só comprova pelo documento já cadastrado com o nome do responsável", () => {
  const guardian = {
    ...local,
    cpf: null,
    guardian_cpf: "12345678909",
    guardian_name: "Responsável sintético",
  };
  assertEquals(
    proveLegacySubscriptionRead(
      target,
      guardian,
      bindings,
      subscription,
      customer,
    ),
    true,
  );
  assertEquals(
    proveLegacySubscriptionRead(
      target,
      { ...guardian, guardian_name: null, email: null },
      bindings,
      subscription,
      customer,
    ),
    false,
  );
});

Deno.test("sem documento exige nome, email E telefone; divergência documental não usa fallback", () => {
  const noDocument = { ...local, cpf: null };
  assertEquals(
    proveLegacySubscriptionRead(
      target,
      noDocument,
      bindings,
      subscription,
      customer,
    ),
    true,
  );
  for (
    const changed of [
      { ...customer, email: "other@example.invalid" },
      { ...customer, name: "Outro Aluno" },
      { ...customer, mobilePhone: "11900000000" },
      { ...customer, mobilePhone: null },
    ]
  ) {
    assertEquals(
      proveLegacySubscriptionRead(
        target,
        noDocument,
        bindings,
        subscription,
        changed,
      ),
      false,
    );
  }
  assertEquals(
    proveLegacySubscriptionRead(
      target,
      { ...local, cpf: "98765432100" },
      bindings,
      subscription,
      customer,
    ),
    false,
  );
});

function adminFixture(): SupabaseClient {
  let lookup = 0;
  return {
    from() {
      const result = ++lookup === 1
        ? { data: local, error: null }
        : { data: bindings, error: null };
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        or() {
          return query;
        },
        limit() {
          return Promise.resolve(result);
        },
        maybeSingle() {
          return Promise.resolve(result);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

Deno.test("sincronização só faz GET, espelha removida como DELETED e guarda prova para fencing", async () => {
  const requests: { url: string; method: string | undefined }[] = [];
  const result = await readSubscriptionForStatusSync({
    admin: adminFixture(),
    baseUrl: "https://api-sandbox.asaas.com/v3",
    apiKey: "fixture",
    target,
    fetcher: (input, init) => {
      requests.push({ url: String(input), method: init?.method });
      return Promise.resolve(
        Response.json(
          String(input).includes("/subscriptions/")
            ? { ...subscription, deleted: true }
            : customer,
        ),
      );
    },
  });
  assertEquals(requests.map((r) => r.method), ["GET", "GET"]);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.entity.status, "DELETED");
    assertEquals(result.identitySnapshot?.cpf, local.cpf);
    assertEquals(result.identitySnapshot?.email, local.email);
  }
});

Deno.test("404 e indisponibilidade não fazem consulta adicional nem aceitam identidade", async () => {
  for (const status of [404, 401, 503]) {
    let requests = 0;
    const result = await readSubscriptionForStatusSync({
      admin: adminFixture(),
      baseUrl: "https://api-sandbox.asaas.com/v3",
      apiKey: "fixture",
      target,
      fetcher: () => {
        requests++;
        return Promise.resolve(new Response(null, { status }));
      },
    });
    assertEquals(result.ok, false);
    assertEquals(requests, 1);
    if (!result.ok) {
      assertEquals(result.code, status === 404 ? "NOT_FOUND" : "LOOKUP_FAILED");
    }
  }
});
