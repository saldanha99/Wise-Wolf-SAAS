/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name: "Hub suspension cancels provider recurrence before local finalization",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const cancellation = source.indexOf(
      "await cancelProviderSubscription(providerSubscriptionId)",
    );
    const finalization = source.indexOf(
      '"hub_finalize_account_status_change"',
    );
    assert(cancellation >= 0, "provider cancellation must be explicit");
    assert(
      finalization > cancellation,
      "local suspension must happen only after provider cancellation",
    );
    assert(
      source.includes('allowedRoles: ["SUPER_ADMIN"]') &&
        source.includes("allowService: true"),
      "the status flow must remain internal-admin only",
    );
    assert(
      source.includes('.from("hub_checkout_sessions")') &&
        source.includes('["CREATED", "PENDING", "OVERDUE", "PAID"]'),
      "provider-backed checkouts must be reconciled before suspension",
    );
  },
});
