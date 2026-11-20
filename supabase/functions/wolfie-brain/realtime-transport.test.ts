/// <reference lib="deno.ns" />

import { canReuseSessionForRealtime } from "./realtime-transport.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("fresh or live conversation is reused by the live voice", () => {
  assertEquals(canReuseSessionForRealtime({}), true, "fresh");
  assertEquals(
    canReuseSessionForRealtime({ realtime_first_client_turn_id: "rt-1" }),
    true,
    "already live",
  );
});

Deno.test("classic conversation is not reused by the live voice", () => {
  assertEquals(
    canReuseSessionForRealtime({ classic_first_client_turn_id: "cl-1" }),
    false,
    "classic",
  );
});

Deno.test("conversation handed off to classic is not reused by the live voice", () => {
  assertEquals(
    canReuseSessionForRealtime({
      realtime_first_client_turn_id: "rt-1",
      classic_handoff_at: "2026-11-20T16:00:00Z",
    }),
    false,
    "handed off",
  );
});
