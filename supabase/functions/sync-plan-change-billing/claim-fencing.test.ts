/// <reference lib="deno.ns" />

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

Deno.test({
  name: "plan-change worker claims a tenant-scoped leased batch",
  permissions: { read: true },
  async fn() {
    const source = await read("./index.ts");

    assertStringIncludes(source, '"claim_plan_changes_awaiting_billing"');
    assertStringIncludes(source, "p_tenant_id: auth.context.tenantId");
    assertStringIncludes(source, "p_lease_seconds: 900");
    assert(!source.includes('"plan_changes_awaiting_billing"'));
    assert(!source.includes('"mark_plan_change_billing"'));
  },
});

Deno.test({
  name: "every plan-change completion carries its fencing token",
  permissions: { read: true },
  async fn() {
    const source = await read("./index.ts");

    assertStringIncludes(source, '"finish_plan_change_billing_claim"');
    assertStringIncludes(source, "p_claim_token: claimToken");
    assertStringIncludes(source, "row.billing_claim_token");
    assertEquals(
      source.match(/finishPlanChangeClaim\(/g)?.length,
      13,
      "all terminal branches must finish or release their own claim",
    );
    assertStringIncludes(source, '"defer_plan_change_billing_claim"');
  },
});

Deno.test({
  name: "provider ownership guard remains before the fenced PUT",
  permissions: { read: true },
  async fn() {
    const source = await read("./index.ts");
    const guard = source.indexOf("await guardAsaasMutationTarget");
    const providerPut = source.indexOf('method: "PUT"');

    assert(guard >= 0 && providerPut > guard);
    assertStringIncludes(source, "signal: AbortSignal.timeout(15_000)");
    assertStringIncludes(source, "revalidateCanonicalAsaasBinding");
    assertStringIncludes(
      source,
      "sync_plan_change_subscription_postcondition",
    );
    assertStringIncludes(source, "claimAsaasSubscriptionMutation");
    assertStringIncludes(source, "markAsaasSubscriptionMutationSubmitting");
    assertStringIncludes(source, 'status: "UNKNOWN"');
    assertStringIncludes(source, "ambiguousProviderMutationStatus");
    assert(
      providerPut > source.indexOf("markAsaasSubscriptionMutationSubmitting"),
    );
  },
});

Deno.test({
  name: "database claim uses skip-locked and blocks stale regression",
  permissions: { read: true },
  async fn() {
    const migration = await read(
      "../../migrations/20260825161000_claim_plan_change_billing.sql",
    );

    assertStringIncludes(migration, "for update of queued skip locked");
    assertStringIncludes(
      migration,
      "plan_change.billing_claim_token is distinct from p_claim_token",
    );
    assertStringIncludes(
      migration,
      "if plan_change.billing_sync_status = 'SYNCED' then",
    );
    assertStringIncludes(migration, "'ignored_regression', not p_ok");
    assertStringIncludes(
      migration,
      "drop function if exists public.mark_plan_change_billing",
    );
    const serializationMigration = await read(
      "../../migrations/20260825202000_serialize_subscription_mutations.sql",
    );
    assertStringIncludes(
      serializationMigration,
      "asaas_subscription_mutation_one_active_uidx",
    );
    assertStringIncludes(
      serializationMigration,
      "operation.intent_key <> 'plan-change:' || queued.id::text",
    );
    assertStringIncludes(
      serializationMigration,
      "from public.student_plan_changes as earlier",
    );
    assertStringIncludes(
      serializationMigration,
      "defer_plan_change_billing_claim",
    );
  },
});
