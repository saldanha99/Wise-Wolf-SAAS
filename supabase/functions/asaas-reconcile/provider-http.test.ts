import { providerRetryDelayMs } from "./provider-http.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}

Deno.test("Asaas rate limits honor Retry-After and stop after a bounded retry budget", () => {
  assertEquals(
    providerRetryDelayMs(429, "12", 0, 12_000, 0),
    12_000,
    "seconds",
  );
  assertEquals(
    providerRetryDelayMs(
      429,
      "Thu, 01 Jan 1970 00:00:20 GMT",
      1,
      10_250,
      10_000,
    ),
    10_250,
    "HTTP date",
  );
  assertEquals(
    providerRetryDelayMs(429, null, 0, 65_000, 0),
    65_000,
    "safe default",
  );
  assertEquals(
    providerRetryDelayMs(429, null, 4, 999_999, 0),
    null,
    "retry ceiling",
  );
  assertEquals(
    providerRetryDelayMs(429, "121", 0, 120_000, 0),
    null,
    "long Retry-After never runs early",
  );
  assertEquals(
    providerRetryDelayMs(429, "121", 0, 121_000, 0),
    121_000,
    "long Retry-After runs only when the full wait fits",
  );
});

Deno.test("transient provider failures use short exponential retries only", () => {
  assertEquals(
    providerRetryDelayMs(503, null, 0, 1_000, 0),
    1_000,
    "first retry",
  );
  assertEquals(
    providerRetryDelayMs(503, null, 2, 4_000, 0),
    4_000,
    "third retry",
  );
  assertEquals(
    providerRetryDelayMs(503, null, 2, 3_999, 0),
    null,
    "deadline budget",
  );
  assertEquals(
    providerRetryDelayMs(503, null, 3, 999_999, 0),
    null,
    "retry ceiling",
  );
  assertEquals(
    providerRetryDelayMs(404, null, 0, 999_999, 0),
    null,
    "permanent error",
  );
});
