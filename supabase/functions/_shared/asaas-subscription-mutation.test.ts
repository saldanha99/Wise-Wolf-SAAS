/// <reference lib="deno.ns" />

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  asaasSubscriptionMutationIntegrationSnapshot,
  claimAsaasSubscriptionMutation,
  finishAsaasSubscriptionMutation,
  markAsaasSubscriptionMutationSubmitting,
} from "./asaas-subscription-mutation.ts";

const integration = {
  integrationId: "integration-1",
  tenantId: "tenant-1",
  provider: "asaas" as const,
  mode: "TENANT_BYOK" as const,
  version: 7,
  environment: "production" as const,
  baseUrl: "https://api.asaas.com/v3",
  apiKey: "must-never-be-persisted",
};

Deno.test("integration snapshot never persists the credential", () => {
  const snapshot = asaasSubscriptionMutationIntegrationSnapshot(integration);
  assertEquals(snapshot.integrationId, "integration-1");
  assertEquals(snapshot.version, 7);
  assert(!("apiKey" in snapshot));
  assert(!JSON.stringify(snapshot).includes(integration.apiKey));
});

Deno.test("claim fingerprints the immutable payload and maps the fence", async () => {
  let rpcName = "";
  let rpcArgs: Record<string, unknown> = {};
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      rpcName = name;
      rpcArgs = args;
      return Promise.resolve({
        data: {
          ok: true,
          action: "SUBMIT_ONCE",
          operation_id: "operation-1",
          claim_token: "token-1",
        },
        error: null,
      });
    },
  };
  const claim = await claimAsaasSubscriptionMutation(admin, {
    tenantId: "tenant-1",
    studentId: "11111111-1111-4111-8111-111111111111",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    mutationKind: "PLAN_VALUE",
    intentKey: "plan-change:1",
    expectedState: { valueCents: 10000 },
    desiredState: { valueCents: 12000 },
    integration,
    mutationPayload: { valueCents: 12000, updatePendingPayments: true },
  });

  assertEquals(rpcName, "claim_asaas_subscription_mutation");
  assertEquals(claim.action, "SUBMIT_ONCE");
  assertEquals(claim.operationId, "operation-1");
  assertEquals(typeof rpcArgs.p_request_fingerprint, "string");
  assertEquals(String(rpcArgs.p_request_fingerprint).length, 64);
  assert(!JSON.stringify(rpcArgs).includes(integration.apiKey));
});

Deno.test("mark and finish always carry operation id plus claim token", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const admin = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const claim = {
    ok: true,
    action: "SUBMIT_ONCE" as const,
    operationId: "operation-1",
    claimToken: "token-1",
    reason: null,
    retryAfterSeconds: null,
  };
  assert(await markAsaasSubscriptionMutationSubmitting(admin, claim));
  assert(
    await finishAsaasSubscriptionMutation(admin, claim, {
      status: "SUCCEEDED",
      observedState: { maxPayments: 12 },
    }),
  );
  assertEquals(calls.map((call) => call.name), [
    "mark_asaas_subscription_mutation_submitting",
    "finish_asaas_subscription_mutation",
  ]);
  assertEquals(calls[0].args.p_claim_token, "token-1");
  assertEquals(calls[1].args.p_operation_id, "operation-1");
});
