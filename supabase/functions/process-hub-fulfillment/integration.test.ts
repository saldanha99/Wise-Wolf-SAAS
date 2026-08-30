/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name:
    "fresh and resumed checkouts durably stage exact fulfillment before provider creation",
  permissions: { read: true },
  async fn() {
    const checkoutSource = await Deno.readTextFile(
      new URL("../create-hub-checkout/index.ts", import.meta.url),
    );
    const snapshotPosition = checkoutSource.indexOf(
      "fulfillment_snapshot:",
    );
    const checkoutInsertPosition = checkoutSource.indexOf(
      '.from("hub_checkout_sessions")\n        .insert({',
    );
    const stagePosition = checkoutSource.indexOf(
      '"hub_ensure_checkout_fulfillment_outbox"',
    );
    const providerPosition = checkoutSource.indexOf(
      "customerResponse = await fetch(",
    );
    assert(
      snapshotPosition >= 0 && snapshotPosition < checkoutInsertPosition,
      "the checkout insert must freeze the exact fulfillment identity",
    );
    assert(
      checkoutInsertPosition >= 0 && checkoutInsertPosition < stagePosition,
      "the durable checkout root must exist before transactional staging",
    );
    assert(
      providerPosition >= 0 && stagePosition < providerPosition,
      "the transactional outbox postcondition must pass before any provider POST",
    );
    assert(
      checkoutSource.includes(
        "deliberately outside the fresh-only block: a retry must prove",
      ),
      "the same outbox fence must execute for fresh and resumed checkouts",
    );
    assert(
      !checkoutSource.includes('.from("hub_fulfillment_outbox")'),
      "checkout must not bypass the atomic outbox RPC with direct inserts",
    );
    assert(
      checkoutSource.includes("resolvePlatformAsaasIntegration(") &&
        checkoutSource.includes('"customer.create"') &&
        checkoutSource.includes(
          "`${customerCreateIntegration.baseUrl}/customers`",
        ),
      "provider creation must use the scoped platform integration broker",
    );
    assert(
      checkoutSource.includes("test_fixture: isTestFixture"),
      "fixture suppression must be frozen in the checkout snapshot",
    );
  },
});

Deno.test({
  name: "paid webhook schedules fulfillment without blocking activation",
  permissions: { read: true },
  async fn() {
    const webhookSource = await Deno.readTextFile(
      new URL("../asaas-webhook/index.ts", import.meta.url),
    );
    assert(
      webhookSource.includes("EdgeRuntime.waitUntil(delivery)"),
      "delivery kickoff must run as a background task",
    );
    assert(
      webhookSource.indexOf(
        'finishHubPaymentEvent(supabase, claim.eventKey, "PROCESSED")',
      ) < webhookSource.lastIndexOf("scheduleHubFulfillment(checkoutId)"),
      "financial event persistence must finish before delivery kickoff",
    );
  },
});

Deno.test({
  name: "fulfillment worker fences provider dispatches and owns lease updates",
  permissions: { read: true },
  async fn() {
    const workerSource = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    assert(
      workerSource.includes('.eq("lease_token", row.lease_token)'),
      "all delivery state transitions must be bound to the active lease token",
    );
    assert(
      workerSource.includes("markProviderDispatchStarted(admin, row)"),
      "provider dispatch intent must be persisted before external side effects",
    );
    assert(
      workerSource.includes('"Idempotency-Key"'),
      "Resend requests must carry a stable idempotency key",
    );
    assert(
      workerSource.includes("sendWhatsTextDetailed"),
      "Evolution acceptance and ambiguous outcomes must not share a boolean",
    );
    assert(
      workerSource.includes('status: uncertain ? "UNCERTAIN"'),
      "ambiguous WhatsApp outcomes must be quarantined without blind retries",
    );
    assert(
      workerSource.includes("const HUB_FULFILLMENT_CONCURRENCY = 2"),
      "provider dispatch concurrency must remain below provider burst limits",
    );
  },
});

Deno.test({
  name: "release smoke authenticates without claiming real fulfillment",
  permissions: { read: true },
  async fn() {
    const releaseSource = await Deno.readTextFile(
      new URL("../../../deploy/vps/release.sh", import.meta.url),
    );
    assert(
      releaseSource.includes(
        'wait_for_service_http_status 200 "fulfillment autenticado sem fixture existente"',
      ),
      "release must exercise the authenticated worker path",
    );
    assert(
      releaseSource.includes(
        '"checkoutId":"00000000-0000-4000-8000-000000000000","limit":1',
      ),
      "authenticated smoke must target a valid nonexistent fixture UUID",
    );
  },
});
