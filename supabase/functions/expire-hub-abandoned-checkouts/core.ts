/// <reference lib="deno.ns" />

import {
  type HubAbandonedCheckoutResult,
  HubProviderOperationError,
  runHubAbandonedCheckoutCancellation,
} from "../_shared/hub-provider-operations.ts";

// Cliente estrutural (o mesmo desenho do módulo compartilhado) para o teste
// rodar sem o cliente de rede do Supabase.
// deno-lint-ignore no-explicit-any
type AdminClient = any;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AbandonedCheckoutRunSummary = {
  listed: number;
  cancelled: number;
  aborted: number;
  skipped: number;
  failed: number;
  blocked: Record<string, number>;
  failures: Array<{ checkoutId: string; code: string }>;
};

type Runner = (input: {
  admin: AdminClient;
  checkoutId: string;
}) => Promise<HubAbandonedCheckoutResult>;

function normalizeLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(Math.trunc(value), 25));
}

export function parseAbandonedCheckoutRequest(
  body: unknown,
): { ok: true; limit: number; checkoutId: string | null } | {
  ok: false;
  error: string;
} {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  let checkoutId: string | null = null;
  if (typeof record.checkoutId === "string" && record.checkoutId.trim()) {
    checkoutId = record.checkoutId.trim();
    if (!UUID_PATTERN.test(checkoutId)) {
      return { ok: false, error: "invalid_checkout_id" };
    }
  }
  return { ok: true, limit: normalizeLimit(record.limit), checkoutId };
}

// Processa um checkout por vez: cada um tem a sua operação durável, e uma
// falha (provedor fora, resposta perdida) fica para a próxima rodada horária
// sem atrasar os demais.
export async function processAbandonedCheckouts(
  admin: AdminClient,
  options: { limit: number; checkoutId?: string | null; runner?: Runner },
): Promise<AbandonedCheckoutRunSummary> {
  const runner = options.runner || runHubAbandonedCheckoutCancellation;
  const summary: AbandonedCheckoutRunSummary = {
    listed: 0,
    cancelled: 0,
    aborted: 0,
    skipped: 0,
    failed: 0,
    blocked: {},
    failures: [],
  };

  let checkoutIds: string[] = [];
  if (options.checkoutId) {
    checkoutIds = [options.checkoutId];
  } else {
    const { data, error } = await admin.rpc("hub_list_abandoned_checkouts", {
      p_limit: options.limit,
    });
    if (error) throw new Error("hub_abandoned_checkout_list_failed");
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const record = row as Record<string, unknown>;
      const id = typeof record.checkout_id === "string"
        ? record.checkout_id
        : "";
      if (!UUID_PATTERN.test(id)) continue;
      summary.listed += 1;
      const reason = typeof record.block_reason === "string"
        ? record.block_reason
        : null;
      if (reason && record.operation_open !== true) {
        summary.blocked[reason] = (summary.blocked[reason] || 0) + 1;
        continue;
      }
      checkoutIds.push(id);
    }
  }

  for (const checkoutId of checkoutIds) {
    try {
      const result = await runner({ admin, checkoutId });
      if (result.outcome === "CANCELLED") summary.cancelled += 1;
      else if (result.outcome === "ABORTED") summary.aborted += 1;
      else {
        summary.skipped += 1;
        summary.blocked[result.reason] = (summary.blocked[result.reason] ||
          0) + 1;
      }
    } catch (error) {
      summary.failed += 1;
      summary.failures.push({
        checkoutId,
        code: error instanceof HubProviderOperationError
          ? error.code
          : "HUB_ABANDONED_CHECKOUT_FAILED",
      });
    }
  }
  return summary;
}
