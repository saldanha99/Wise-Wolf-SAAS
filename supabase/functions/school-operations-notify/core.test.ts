import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { operationMessage } from "./core.ts";
Deno.test("lead origin is explicit about uncertainty and never invents paid acquisition", () => {
  const msg = operationMessage({
    kind: "LEAD_ORIGIN",
    name: "Fixture",
    origin: { channel: "DIRECT_UNKNOWN", form_source: "blog_form" },
  }, "https://example.invalid");
  assert(msg.includes("Direto / não identificado"));
  assert(msg.includes("Campanha: Não informada"));
  assert(!msg.includes("Tráfego pago"));
});
Deno.test("attendance notice preserves measured times, asks review and does not determine a sanction", () => {
  const msg = operationMessage({
    kind: "TEACHER_LATE",
    name: "Fixture\n*admin*",
    scheduled_start_at: "2026-10-27T12:00:00Z",
    first_join_at: "2026-10-27T12:07:00Z",
    late_minutes: 7,
  }, "https://example.invalid");
  assert(msg.includes("27/10/2026, 09:07"));
  assert(msg.includes("7 min"));
  assert(msg.includes("não determina culpa"));
  assert(!msg.includes("\n*admin*"));
});
Deno.test("unverified evidence cannot be rendered as late attendance", () => {
  assertThrows(() =>
    operationMessage(
      { kind: "UNVERIFIED", late_minutes: null },
      "https://example.invalid",
    )
  );
  assertThrows(() =>
    operationMessage(
      { kind: "STUDENT_LATE", late_minutes: 0 },
      "https://example.invalid",
    )
  );
  assertEquals(
    operationMessage({
      kind: "LEAD_ORIGIN",
      origin: { channel: "PAID", utm_campaign: "campaign" },
    }, "https://example.invalid").includes("Tráfego pago"),
    true,
  );
});
