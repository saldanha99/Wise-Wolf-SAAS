/// <reference lib="deno.ns" />

import {
  saasPlanSaleBlockCode,
  TEACHER_PLAN_NOT_FOR_SALE,
} from "./provider-safety.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

Deno.test("plano Teacher é recusado; plano de escola segue", () => {
  assert(
    saasPlanSaleBlockCode("teacher") === TEACHER_PLAN_NOT_FOR_SALE,
    "teacher é recusado",
  );
  assert(
    saasPlanSaleBlockCode(" Teacher ") === TEACHER_PLAN_NOT_FOR_SALE,
    "caixa e espaço não furam a recusa",
  );
  assert(
    TEACHER_PLAN_NOT_FOR_SALE === "TEACHER_PLAN_NOT_FOR_SALE",
    "código combinado com a direção",
  );
  assert(saasPlanSaleBlockCode("school") === null, "escola é vendida");
  // Sem tipo, o banco assume 'school' (default da coluna).
  assert(saasPlanSaleBlockCode(null) === null, "ausente segue como escola");
});

Deno.test({
  name: "a recusa vem antes de qualquer escrita no banco e de qualquer Asaas",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const planLookup = source.indexOf('.from("saas_plans")');
    const block = source.indexOf(
      "saasPlanSaleBlockCode(plan.plan_type)",
    );
    assert(planLookup >= 0, "lê o plano");
    assert(block > planLookup, "a recusa usa o plano lido do banco");
    // Toda escrita e todo efeito externo vêm depois da recusa.
    const sideEffects = [
      '"consume_saas_checkout_rate_limit"',
      '.from("saas_leads")',
      '.from("saas_checkout_intents")\n        .insert(',
      "claimAsaasCreation(",
      "customerResponse = await fetch(",
      "subscriptionResponse = await fetch(",
    ];
    for (const marker of sideEffects) {
      const position = source.indexOf(marker);
      assert(position >= 0, `marcador encontrado: ${marker}`);
      assert(
        block < position,
        `a recusa do plano Teacher precisa vir antes de ${marker}`,
      );
    }
    const response = source.slice(block, block + 400);
    assert(
      response.includes("code: planSaleBlock") && response.includes("400"),
      "a recusa devolve o código para a tela",
    );
  },
});
