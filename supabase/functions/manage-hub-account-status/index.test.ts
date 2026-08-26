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
    const shared = await Deno.readTextFile(
      new URL("../_shared/hub-provider-operations.ts", import.meta.url),
    );
    const cancellation = shared.indexOf('method: "DELETE"');
    const finalization = shared.indexOf(
      '"hub_finalize_provider_cancellation"',
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
      source.includes("runHubProviderCancellation({") &&
        source.includes('operationKind: "ACCOUNT_STATUS"'),
      "status changes must use the durable provider operation",
    );
    assert(
      !source.includes("ASAAS_API_URL") &&
        !source.includes("ASAAS_ACCESS_TOKEN") &&
        shared.includes("resolvePlatformAsaasIntegration") &&
        shared.includes('"subscription.read"') &&
        shared.includes('"subscription.delete"'),
      "admin cancellation must use version-bound platform broker capabilities",
    );
    assert(
      shared.indexOf("const observed = await exactProviderLookup(") <
          shared.indexOf('method: "DELETE"') &&
        shared.indexOf('"hub_mark_provider_cancellation_submitting"') <
          shared.indexOf('method: "DELETE"') &&
        shared.includes("hubProviderCancellationDecision(") &&
        shared.includes('action === "RECONCILE_ONLY"') &&
        shared.includes("resolvePlatformAsaasIntegration"),
      "provider identity and its local binding must be rechecked before DELETE",
    );
  },
});
