/// <reference lib="deno.ns" />

import {
  buildHubFulfillmentEmail,
  buildHubFulfillmentWhatsApp,
  DEFAULT_HUB_PUBLIC_URL,
  hubFulfillmentAccessUrl,
  hubFulfillmentProviderIdempotencyKey,
  isHubFulfillmentTestFixture,
  nextHubFulfillmentAttempt,
  normalizeHubFulfillmentPhone,
  normalizeHubFulfillmentPublicUrl,
} from "./core.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("Hub fulfillment suppresses fixtures and validates phones", () => {
  assert(
    isHubFulfillmentTestFixture({ test_fixture: true }),
    "fixture must be suppressed",
  );
  assert(
    !isHubFulfillmentTestFixture({ test_fixture: "true" }),
    "string flag must not suppress real users",
  );
  assert(
    normalizeHubFulfillmentPhone("(11) 99999-0000") === "5511999990000",
    "BR phone must be normalized",
  );
  assert(
    normalizeHubFulfillmentPhone("123") === null,
    "invalid phone must be rejected",
  );
});

Deno.test("Hub fulfillment copy uses the correct product destination", () => {
  const email = buildHubFulfillmentEmail({
    recipientName: "Ana <script>",
    productFamily: "HUB_CORE",
    planName: "Educador <Premium>",
    destinations: { hubUrl: "https://hub.wisewolflanguage.com.br/" },
  });
  const whatsapp = buildHubFulfillmentWhatsApp({
    recipientName: "Ana",
    productFamily: "WOLFIE_STANDALONE",
    planName: "Ritmo",
  });
  assert(
    email.html.includes("https://hub.wisewolflanguage.com.br"),
    "configured Hub URL must be used",
  );
  assert(!email.html.includes("<script>"), "email values must be escaped");
  assert(
    whatsapp.includes("https://wolfie.wisewolflanguage.com.br"),
    "Wolfie WhatsApp must link to Wolfie",
  );
  assert(
    hubFulfillmentAccessUrl("WOLFIE_STANDALONE").includes("wolfie"),
    "Wolfie route must stay isolated",
  );
});

Deno.test("Hub fulfillment URL defaults safely until the subdomain exists", () => {
  assert(
    hubFulfillmentAccessUrl("HUB_CORE") === DEFAULT_HUB_PUBLIC_URL,
    "Hub fallback must use the currently available system route",
  );
  assert(
    normalizeHubFulfillmentPublicUrl(
      "http://hub.wisewolflanguage.com.br",
      DEFAULT_HUB_PUBLIC_URL,
    ) === DEFAULT_HUB_PUBLIC_URL,
    "insecure HTTP destinations must be rejected",
  );
  assert(
    normalizeHubFulfillmentPublicUrl(
      "https://user:secret@hub.wisewolflanguage.com.br",
      DEFAULT_HUB_PUBLIC_URL,
    ) === DEFAULT_HUB_PUBLIC_URL,
    "credential-bearing destinations must be rejected",
  );
  assert(
    hubFulfillmentProviderIdempotencyKey({
      checkoutId: "84000000-0000-4000-8000-000000000102",
      channel: "EMAIL",
    }) ===
      "hub-fulfillment/email/84000000-0000-4000-8000-000000000102",
    "provider key must remain stable across retries",
  );
});

Deno.test("Hub fulfillment retries exponentially and stops", () => {
  const first = nextHubFulfillmentAttempt(1, 0);
  const seventh = nextHubFulfillmentAttempt(7, 0);
  const final = nextHubFulfillmentAttempt(8, 0);
  assert(
    first.status === "PENDING" &&
      first.nextAttemptAt === "1970-01-01T00:05:00.000Z",
    "first retry must wait five minutes",
  );
  assert(
    seventh.status === "PENDING" &&
      seventh.nextAttemptAt === "1970-01-01T05:20:00.000Z",
    "retry delay must be capped below six hours when appropriate",
  );
  assert(
    final.status === "FAILED" && final.nextAttemptAt === null,
    "eighth attempt must stop",
  );
});
