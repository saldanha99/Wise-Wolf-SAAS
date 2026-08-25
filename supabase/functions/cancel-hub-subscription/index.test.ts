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
    const providerCancellation = source.indexOf(
      "await cancelProviderSubscription(providerSubscriptionId)",
    );
    const synchronizationBarrier = source.indexOf(
      '"hub_begin_core_cancellation"',
    );
    const localFinalization = source.indexOf(
      '"hub_schedule_core_cancellation"',
    );
    assert(
      providerCancellation >= 0 && localFinalization > providerCancellation,
      "the Asaas recurrence must be cancelled before local finalization",
    );
    assert(
      synchronizationBarrier >= 0 &&
        synchronizationBarrier < providerCancellation &&
        source.includes(
          '.contains("metadata", { cancellationInProgress: true })',
        ),
      "a database barrier must close provider-link races before cancellation",
    );
    assert(
      source.includes("allowService: false"),
      "self-service must reject service credentials at the HTTP boundary",
    );
    assert(
      source.includes('.eq("account_id", accountId)') &&
        source.includes('.eq("user_id", actorUserId)') &&
        source.includes('.in("membership_role", ["OWNER", "ADMIN"])'),
      "membership authority must be rechecked for the exact account",
    );
    assert(
      source.includes("return json(200, result as Record<string, unknown>)") &&
        !source.includes("providerSubscriptionIds:") &&
        !source.includes("provider_subscription_id:"),
      "the HTTP response must not expose provider identifiers",
    );
    assert(
      source.includes('redirect: "error"'),
      "provider cancellation must not follow redirects",
    );
  },
});
