/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name:
    "Hub self-service cancellation preserves provider-first ordering and scope",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const shared = await Deno.readTextFile(
      new URL("../_shared/hub-provider-operations.ts", import.meta.url),
    );
    const providerCancellation = shared.indexOf('method: "DELETE"');
    const synchronizationBarrier = shared.indexOf(
      '"hub_begin_provider_cancellation"',
    );
    const localFinalization = shared.indexOf(
      '"hub_finalize_provider_cancellation"',
    );
    assert(
      providerCancellation >= 0 && localFinalization > providerCancellation,
      "the Asaas recurrence must be cancelled before local finalization",
    );
    assert(
      synchronizationBarrier >= 0 &&
        synchronizationBarrier < providerCancellation &&
        shared.includes('action === "RECONCILE_ONLY"'),
      "a database barrier must close provider-link races before cancellation",
    );
    assert(
      source.includes("allowService: false"),
      "self-service must reject service credentials at the HTTP boundary",
    );
    assert(
      !source.includes("ASAAS_API_URL") &&
        !source.includes("ASAAS_ACCESS_TOKEN") &&
        shared.includes("resolvePlatformAsaasIntegration"),
      "self-service cancellation must use the canonical platform broker",
    );
    assert(
      source.includes('operationKind: "CORE_CANCELLATION"') &&
        source.includes("actorUserId"),
      "membership authority must be rechecked for the exact account",
    );
    assert(
      source.includes("return json(200, result)") &&
        !source.includes("providerSubscriptionIds:") &&
        !source.includes("provider_subscription_id:"),
      "the HTTP response must not expose provider identifiers",
    );
    assert(
      shared.includes('redirect: "error"'),
      "provider cancellation must not follow redirects",
    );
    const providerLookup = shared.indexOf("await exactProviderLookup(");
    const providerDelete = shared.indexOf('method: "DELETE"');
    assert(
      providerLookup >= 0 && providerDelete > providerLookup &&
        shared.includes("hubProviderCancellationDecision(") &&
        shared.includes("hub_claim_provider_cancellation_target") &&
        shared.indexOf('"hub_mark_provider_cancellation_submitting"') <
          providerDelete,
      "every DELETE must follow exact customer and checkout identity proof",
    );
  },
});
