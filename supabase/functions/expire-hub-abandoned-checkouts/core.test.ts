/// <reference lib="deno.ns" />

import { HubProviderOperationError } from "../_shared/hub-provider-operations.ts";
import {
  parseAbandonedCheckoutRequest,
  processAbandonedCheckouts,
} from "./core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const eligible = "11111111-1111-4111-8111-111111111111";
const resumed = "22222222-2222-4222-8222-222222222222";
const blocked = "33333333-3333-4333-8333-333333333333";
const failing = "44444444-4444-4444-8444-444444444444";

function listingAdmin(rows: unknown[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: rows, error: null });
      },
    },
  };
}

Deno.test("a varredura só roda os elegíveis e conta os bloqueados por motivo", async () => {
  const admin = listingAdmin([
    { checkout_id: resumed, block_reason: null, operation_open: true },
    { checkout_id: eligible, block_reason: null, operation_open: false },
    {
      checkout_id: blocked,
      block_reason: "PAYMENT_APPLIED",
      operation_open: false,
    },
    { checkout_id: failing, block_reason: null, operation_open: false },
    { checkout_id: "não-é-uuid", block_reason: null, operation_open: false },
  ]);
  const ran: string[] = [];
  const summary = await processAbandonedCheckouts(admin.client, {
    limit: 10,
    runner: ({ checkoutId }) => {
      ran.push(checkoutId);
      if (checkoutId === failing) {
        return Promise.reject(
          new HubProviderOperationError("HUB_PROVIDER_LOOKUP_FAILED"),
        );
      }
      return Promise.resolve(
        checkoutId === resumed
          ? {
            outcome: "ABORTED",
            checkoutId,
            operationId: "op",
            reason: "PAYMENT_SETTLED_AT_PROVIDER",
          }
          : {
            outcome: "CANCELLED",
            checkoutId,
            operationId: "op",
            idempotent: false,
          },
      );
    },
  });
  assert(
    ran.join(",") === [resumed, eligible, failing].join(","),
    "bloqueado e id inválido não podem chegar ao provedor",
  );
  assert(
    summary.listed === 4 && summary.cancelled === 1 && summary.aborted === 1 &&
      summary.failed === 1 && summary.blocked.PAYMENT_APPLIED === 1 &&
      summary.failures[0]?.code === "HUB_PROVIDER_LOOKUP_FAILED",
    `resumo da varredura incorreto: ${JSON.stringify(summary)}`,
  );
  assert(
    admin.calls.length === 1 &&
      admin.calls[0].name === "hub_list_abandoned_checkouts" &&
      admin.calls[0].args.p_limit === 10,
    "a lista deve vir da RPC do serviço com o limite pedido",
  );
});

Deno.test("checkout pedido explicitamente não consulta a lista", async () => {
  const admin = listingAdmin([]);
  const summary = await processAbandonedCheckouts(admin.client, {
    limit: 10,
    checkoutId: eligible,
    runner: ({ checkoutId }) =>
      Promise.resolve({
        outcome: "SKIPPED",
        checkoutId,
        reason: "ABANDONMENT_WINDOW_NOT_REACHED",
      }),
  });
  assert(
    admin.calls.length === 0 && summary.skipped === 1 &&
      summary.blocked.ABANDONMENT_WINDOW_NOT_REACHED === 1,
    "pedido de um checkout só deve rodar aquele checkout",
  );
});

Deno.test("o corpo da requisição é validado e o limite fica entre 1 e 25", () => {
  const empty = parseAbandonedCheckoutRequest({});
  const big = parseAbandonedCheckoutRequest({ limit: 999 });
  const invalid = parseAbandonedCheckoutRequest({ checkoutId: "x; drop" });
  assert(empty.ok && empty.limit === 10 && empty.checkoutId === null, "padrão");
  assert(big.ok && big.limit === 25, "teto do lote");
  assert(!invalid.ok, "checkout inválido deve ser recusado");
});
