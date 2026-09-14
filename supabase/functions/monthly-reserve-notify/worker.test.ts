import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { reserveNotificationMessage } from "./message.ts";
import { type ReserveWorkerDependencies, runReserveSweep } from "./worker.ts";

Deno.test("large closing keeps message below provider budget and preserves review warning", () => {
  const message = reserveNotificationMessage("CAIXINHA_CLOSE", {
    month: "2026-09",
    totais: {
      folha: 20000,
      caixinha: 10000,
      caixinha_sem_aviso: 9000,
      caixinha_revisao: 1000,
      completar: 10000,
      devolver: 0,
    },
    professores: Array.from(
      { length: 100 },
      (_, i) => ({
        teacher_name: `Teacher ${i} ${"X".repeat(120)}`,
        folha: 200,
        caixinha: 100,
        diferenca: 100,
        caixinha_revisao: 10,
        itens: [
          "SEM_AVISO",
          "RESERVA_EM_REVISAO",
          "PREPAGO_SEM_RESERVA",
          "AVISO_DE_OUTRO_MES",
        ].map((motivo) => ({ motivo, diferenca: 25 })),
      }),
    ),
  });
  assertEquals(message.length < 8000, true);
  assertStringIncludes(message, "professores detalhados no painel");
  assertStringIncludes(
    message,
    "Não transfira, complete ou devolva valores automaticamente",
  );
  assertStringIncludes(message, "Financeiro → Caixinha × Folha");
});

Deno.test("closing summarizes per-teacher reasons and never recommends automatic transfers with reversals", () => {
  const message = reserveNotificationMessage("CAIXINHA_CLOSE", {
    month: "2026-09",
    totais: {
      folha: 200,
      caixinha: 80,
      caixinha_sem_aviso: 90,
      caixinha_revisao: 25,
      completar: 120,
      devolver: 0,
    },
    professores: [{
      teacher_name: "Teacher QA",
      folha: 200,
      caixinha: 80,
      caixinha_sem_aviso: 90,
      caixinha_revisao: 25,
      diferenca: 120,
      itens: [{ motivo: "SEM_AVISO", diferenca: 70 }, {
        motivo: "SEM_AVISO",
        diferenca: 50,
      }, { motivo: "RESERVA_EM_REVISAO", diferenca: 0 }],
    }],
  });
  assertStringIncludes(
    message,
    "sem aviso confirmado: 2 registro(s), diferença R$ 120,00",
  );
  assertStringIncludes(message, "reserva cancelada/estornada em revisão");
  assertStringIncludes(message, "Reserva histórica em revisão: R$ 25,00");
  assertStringIncludes(
    message,
    "Não transfira, complete ou devolva valores automaticamente",
  );
  assertStringIncludes(
    message,
    "diferença R$ 120,00 — revisar antes de ajustar",
  );
  assertStringIncludes(
    message,
    "Aviso confirmado não comprova separação bancária",
  );
});

const source = {
  modo: "MENSAL",
  sequencia: 2,
  meses: 6,
  month: "2026-10",
  student_name: "Aluno teste",
  parcela: 200,
  recebido_total: 1200,
  reservado: 800,
  recebido_em: "2026-09-01",
  professores: [],
};
const route = {
  instanceName: "test-instance",
  destination: "123456789012@g.us",
  integrationId: "integration",
  integrationVersion: 1,
  baseUrl: "https://example.invalid",
  apiKey: "test-placeholder",
};
function harness(options: {
  finishStatus?: string;
  finishDelivery?: string;
  outcome?: "accepted" | "ambiguous" | "rejected";
  failAt?: string;
  denyAt?: string;
  sendThrows?: boolean;
  mismatch?: boolean;
} = {}) {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  const dependencies: ReserveWorkerDependencies = {
    client: {
      rpc(name, args) {
        calls.push(name);
        if (name === options.failAt) {
          return Promise.resolve({
            data: null,
            error: { code: "TEST_ERROR" },
          });
        }
        if (name === options.denyAt) {
          return Promise.resolve({
            data: { ok: false },
            error: null,
          });
        }
        let data: unknown = { ok: true };
        if (name === "claim_prepayment_financial_recomputations") data = [];
        if (name === "monthly_reserve_notification_pending") {
          data = [{
            id: "attempt",
            tenant_id: "tenant",
          }];
        }
        if (name === "claim_monthly_reserve_notification") {
          data = {
            ok: true,
            id: "attempt",
            tenant_id: "tenant",
            claim_token: "claim",
            notification_kind: "INSTALLMENT_SPLIT",
          };
        }
        if (name === "monthly_reserve_notification_source") data = source;
        if (name === "authorize_monthly_reserve_notification") {
          data = {
            ok: true,
            id: "attempt",
            destination: route.destination,
            instance_name: route.instanceName,
            message_body: options.mismatch
              ? "changed"
              : reserveNotificationMessage("INSTALLMENT_SPLIT", source),
          };
        }
        if (name === "finish_monthly_reserve_notification") {
          submitted.push(args);
          data = {
            ok: true,
            status: options.finishStatus ?? "SUBMITTING",
            delivery_status: options.finishDelivery ?? "accepted",
          };
        }
        return Promise.resolve({ data, error: null });
      },
    },
    resolveRoute() {
      calls.push("route");
      return Promise.resolve(route);
    },
    hash(value) {
      calls.push("hash");
      return Promise.resolve(value);
    },
    send(_route, text) {
      calls.push("provider_post");
      assertStringIncludes(text, "parcela 2/6");
      if (options.sendThrows) throw new Error("simulated_network_loss");
      return Promise.resolve({
        outcome: options.outcome ?? "accepted",
        messageId: "provider-id",
        httpStatus: 200,
      });
    },
  };
  return { dependencies, calls, submitted };
}

Deno.test("testMode does not claim, materialize, resolve secrets or send", async () => {
  const h = harness();
  const result = await runReserveSweep(h.dependencies, { testMode: true });
  assertEquals(h.calls, []);
  assertEquals(result.accepted, 0);
});
Deno.test("full monthly pipeline fences exact payload immediately before one POST", async () => {
  const h = harness();
  const result = await runReserveSweep(h.dependencies);
  const post = h.calls.indexOf("provider_post");
  assertEquals(h.calls[post - 1], "authorize_monthly_reserve_notification");
  assertEquals(h.calls.filter((call) => call === "provider_post").length, 1);
  assertEquals(result.accepted, 1);
  assertEquals(result.delivered, 0);
});
Deno.test("only a delivered/read finish counts as delivered", async () => {
  const h = harness({ finishStatus: "SENT", finishDelivery: "delivered" });
  const result = await runReserveSweep(h.dependencies);
  assertEquals(result.delivered, 1);
  assertEquals(result.accepted, 0);
  const malformed = await runReserveSweep(
    harness({ finishStatus: "SENT", finishDelivery: "accepted" }).dependencies,
  );
  assertEquals(malformed.delivered, 0);
});
for (
  const stage of [
    "claim_monthly_reserve_notification",
    "prepare_monthly_reserve_notification",
    "authorize_monthly_reserve_notification",
  ]
) {
  Deno.test(`denied ${stage} never sends`, async () => {
    const h = harness({ denyAt: stage });
    await runReserveSweep(h.dependencies);
    assertEquals(h.calls.includes("provider_post"), false);
  });
}
Deno.test("mismatching final authorization is terminal unknown without POST", async () => {
  const h = harness({ mismatch: true });
  const result = await runReserveSweep(h.dependencies);
  assertEquals(h.calls.includes("provider_post"), false);
  assertEquals(result.unknown, 1);
  assertEquals(
    (h.submitted[0] as Record<string, unknown>).p_outcome,
    "ambiguous",
  );
});
Deno.test("provider timeout records UNKNOWN and never resends", async () => {
  const h = harness({ sendThrows: true });
  const result = await runReserveSweep(h.dependencies);
  assertEquals(h.calls.filter((call) => call === "provider_post").length, 1);
  assertEquals(result.unknown, 1);
  assertEquals(
    (h.submitted[0] as Record<string, unknown>).p_outcome,
    "ambiguous",
  );
});
Deno.test("database loss after POST never performs a second provider attempt", async () => {
  const h = harness({ failAt: "finish_monthly_reserve_notification" });
  const result = await runReserveSweep(h.dependencies);
  assertEquals(h.calls.filter((call) => call === "provider_post").length, 1);
  assertEquals(result.unknown, 1);
});
Deno.test("ambiguous and rejected are not delivered or silently retried", async () => {
  for (
    const [outcome, status] of [["ambiguous", "UNKNOWN"], [
      "rejected",
      "FAILED",
    ]] as const
  ) {
    const h = harness({ outcome, finishStatus: status });
    const result = await runReserveSweep(h.dependencies);
    assertEquals(result.accepted + result.delivered, 0);
    assertEquals(h.calls.filter((call) => call === "provider_post").length, 1);
  }
});
Deno.test("pending failure fails closed before credentials", async () => {
  const h = harness({ failAt: "monthly_reserve_notification_pending" });
  await assertRejects(() => runReserveSweep(h.dependencies));
  assertEquals(h.calls, [
    "claim_prepayment_financial_recomputations",
    "monthly_reserve_notification_pending",
  ]);
});
Deno.test("monthly summary distinguishes unproven reserve and never claims a payment", () => {
  const text = reserveNotificationMessage("CAIXINHA_CLOSE", {
    month: "2026-09",
    totais: { folha: 100, caixinha: 50, caixinha_sem_aviso: 20, completar: 50 },
    professores: [{
      teacher_name: "Teste",
      folha: 100,
      caixinha: 50,
      diferenca: 50,
    }],
  });
  assertStringIncludes(text, "sem aviso comprovado: *R$ 20,00*");
  assertStringIncludes(text, "conferir complemento R$ 50,00");
  assertStringIncludes(text, "não movimenta dinheiro nem quita a folha");
});
Deno.test("first/native and legacy installments cannot use monthly sender", () => {
  for (
    const modified of [{ ...source, sequencia: 1 }, {
      ...source,
      modo: "LEGADO",
    }]
  ) {
    let threw = false;
    try {
      reserveNotificationMessage("INSTALLMENT_SPLIT", modified);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }
});

Deno.test("financial recompute drains before notifications even with no WhatsApp targets", async () => {
  const h = harness();
  const calls: Array<{ name: string; args: unknown }> = [];
  h.dependencies.client = {
    rpc(name, args) {
      calls.push({ name, args });
      const data = name === "claim_prepayment_financial_recomputations"
        ? [{
          tenant_id: "school",
          student_id: "student",
          version: 7,
          claim_token: "token",
        }]
        : name === "monthly_reserve_notification_pending"
        ? []
        : { ok: true };
      return Promise.resolve({ data, error: null });
    },
  };
  const result = await runReserveSweep(h.dependencies);
  assertEquals(calls.map((call) => call.name), [
    "claim_prepayment_financial_recomputations",
    "recompute_student_financial_status",
    "complete_prepayment_financial_recompute",
    "monthly_reserve_notification_pending",
  ]);
  assertEquals(calls[2].args, {
    p_tenant: "school",
    p_student: "student",
    p_claim_token: "token",
    p_version: 7,
    p_error: null,
  });
  assertEquals(result.recomputed, 1);
  assertEquals(h.calls.includes("provider_post"), false);
});
Deno.test("failed recompute records retryable internal error rather than false success", async () => {
  const h = harness();
  let completion: unknown;
  h.dependencies.client = {
    rpc(name, args) {
      if (name === "complete_prepayment_financial_recompute") completion = args;
      const data = name === "claim_prepayment_financial_recomputations"
        ? [{
          tenant_id: "school",
          student_id: "student",
          version: 7,
          claim_token: "token",
        }]
        : name === "monthly_reserve_notification_pending"
        ? []
        : name === "recompute_student_financial_status"
        ? { ok: false, error: "private details omitted" }
        : { ok: true };
      return Promise.resolve({ data, error: null });
    },
  };
  const result = await runReserveSweep(h.dependencies);
  assertEquals(result.recomputed, 0);
  assertEquals(result.recomputeFailed, 1);
  assertEquals(
    (completion as Record<string, unknown>).p_error,
    "financial_recompute_not_confirmed",
  );
});

Deno.test("DB acknowledgement retry preserves known provider identity without re-POST", async () => {
  const h = harness();
  const original = h.dependencies.client.rpc;
  const attempts: Array<Record<string, unknown>> = [];
  h.dependencies.client.rpc = (name, args) => {
    if (name === "finish_monthly_reserve_notification") {
      attempts.push(args ?? {});
      if (attempts.length === 1) {
        return Promise.resolve({
          data: null,
          error: { code: "temporary_database_loss" },
        });
      }
    }
    return original(name, args);
  };
  await runReserveSweep(h.dependencies);
  assertEquals(attempts.length, 2);
  assertEquals(attempts[1].p_provider_message_id, "provider-id");
  assertEquals(attempts[1].p_outcome, "accepted");
  assertEquals(h.calls.filter((call) => call === "provider_post").length, 1);
});
