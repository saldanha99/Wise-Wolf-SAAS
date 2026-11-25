/// <reference lib="deno.ns" />
import { hubPurchaseEventId, hubPurchasePayload, sendHubPurchaseCapi } from "./hub-purchase-capi.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const metadata = {
  fulfillment_snapshot: { email_recipient: "Maria@Example.com", whatsapp_recipient: "12999999999", user_id: "u-1", plan_code: "WOLFIE_RITMO" },
  marketing: { fbp: "fb.1.1700000000000.123456789", fbc: "fb.1.1700000000000.AbC_123", page_url: "https://wisewolflanguage.com.br/wolfie", client_user_agent: "Mozilla/5.0" },
};

Deno.test("event_id do servidor é o mesmo do Pixel", () => {
  assertEquals(hubPurchaseEventId("abc"), "hub_checkout:abc");
});

Deno.test("Purchase com dados em hash, fbp/fbc e página do checkout", async () => {
  const payload = await hubPurchasePayload({ checkoutId: "abc", amount: 99.9, metadata, eventTime: 1 });
  const event = (payload!.data as Record<string, unknown>[])[0];
  const user = event.user_data as Record<string, unknown>;
  assertEquals(event.event_name, "Purchase");
  assertEquals(event.event_id, "hub_checkout:abc");
  assertEquals(event.action_source, "website");
  assertEquals(event.event_source_url, "https://wisewolflanguage.com.br/wolfie");
  assertEquals(String((user.em as string[])[0]).length, 64);
  assertEquals(JSON.stringify(user).includes("maria"), false);
  assertEquals(user.fbp, "fb.1.1700000000000.123456789");
  assertEquals((event.custom_data as Record<string, unknown>).content_ids, ["WOLFIE_RITMO"]);
});

Deno.test("sessão de teste não vira Purchase", async () => {
  assertEquals(await hubPurchasePayload({ checkoutId: "x", amount: 1, metadata: { ...metadata, test_fixture: true } }), null);
});

Deno.test("sem token não chama o Meta", async () => {
  let called = false;
  const result = await sendHubPurchaseCapi(
    { checkoutId: "x", amount: 1, metadata },
    { pixelId: "1", token: "", fetchImpl: (() => { called = true; return Promise.resolve(new Response("{}")); }) as typeof fetch },
  );
  assertEquals(result, "SKIPPED");
  assertEquals(called, false);
});
