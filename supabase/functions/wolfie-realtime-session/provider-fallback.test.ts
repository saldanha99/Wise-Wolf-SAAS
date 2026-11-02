/// <reference lib="deno.ns" />

import { realtimeProviderFallback } from "./provider-fallback.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Realtime distinguishes exhausted credits from a temporary rate limit", () => {
  const exhausted = realtimeProviderFallback(429, "credit_balance_exhausted");
  assert(exhausted.status === 503, "exhausted credits must not invite a retry");
  assert(
    exhausted.code === "REALTIME_PROVIDER_BILLING_BLOCKED",
    "expected a specific, non-retryable code",
  );
  assert(
    exhausted.message.includes("digitando"),
    "text practice stays available",
  );

  const projectLimit = realtimeProviderFallback(
    429,
    "project_spend_limit_exceeded",
  );
  assert(
    projectLimit.status === 503,
    "a spend limit also needs account action",
  );

  const limited = realtimeProviderFallback(429, "rate_limit_exceeded");
  assert(limited.status === 429, "temporary rate limit keeps its status");
  assert(limited.code === "REALTIME_RATE_LIMITED", "expected rate-limit code");

  const unavailable = realtimeProviderFallback(502, "unknown");
  assert(
    unavailable.code === "REALTIME_PROVIDER_UNAVAILABLE",
    "expected generic fallback",
  );
});
