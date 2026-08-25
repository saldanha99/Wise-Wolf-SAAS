/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name: "checkout stages fulfillment before creating provider resources",
  permissions: { read: true },
  async fn() {
    const checkoutSource = await Deno.readTextFile(
      new URL("../create-hub-checkout/index.ts", import.meta.url),
    );
    const stagePosition = checkoutSource.indexOf(
      '.from("hub_fulfillment_outbox")',
    );
    const providerPosition = checkoutSource.indexOf(
      'await asaasRequest("/customers"',
    );
    assert(stagePosition >= 0, "checkout must stage its fulfillment outbox");
    assert(
      providerPosition >= 0 && stagePosition < providerPosition,
      "outbox staging must succeed before any provider resource is created",
    );
    assert(
      checkoutSource.includes("metadata: isTestFixture"),
      "fixture suppression must be persisted with both channels",
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
