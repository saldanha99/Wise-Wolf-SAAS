/// <reference lib="deno.ns" />

import {
  OPEN_STUDENT_PAYMENT_STATUSES,
  studentBillingDateInSaoPaulo,
  studentPaymentBusinessDaysLate,
  studentPaymentIsBeyondTolerance,
} from "./wolfie-product-access.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${
      JSON.stringify(actual)
    }`,
  );
}

Deno.test("student billing date uses the Sao Paulo calendar boundary", () => {
  assertEquals(
    studentBillingDateInSaoPaulo(new Date("2026-09-01T02:59:59.000Z")),
    "2026-08-31",
    "the instant before midnight in Sao Paulo must remain on the previous day",
  );
  assertEquals(
    studentBillingDateInSaoPaulo(new Date("2026-09-01T03:00:00.000Z")),
    "2026-09-01",
    "Sao Paulo midnight must advance the billing date",
  );
});

Deno.test("student payment tolerance counts weekdays and blocks only after seven", () => {
  assertEquals(
    studentPaymentBusinessDaysLate("2026-08-20", "2026-08-31"),
    7,
    "weekends must not consume contractual tolerance",
  );
  assert(
    !studentPaymentIsBeyondTolerance("2026-08-20", "2026-08-31"),
    "the seventh business day must remain accessible",
  );
  assert(
    studentPaymentIsBeyondTolerance("2026-08-20", "2026-09-01"),
    "access must suspend on the eighth business day",
  );
  assertEquals(
    studentPaymentBusinessDaysLate("2026-09-01", "2026-08-31"),
    0,
    "future charges must not be overdue",
  );
});

Deno.test("student payment authority rejects invalid dates and statuses stay narrow", () => {
  assertEquals(
    OPEN_STUDENT_PAYMENT_STATUSES,
    ["PENDING", "OVERDUE"],
    "only open delinquent payments may suspend access",
  );
  let rejected = false;
  try {
    studentPaymentIsBeyondTolerance("2026-02-30", "2026-03-15");
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  assert(rejected, "invalid provider dates must fail closed");
});

Deno.test({
  name: "all Wolfie learning gates consume the same billing authority",
  permissions: { read: true },
  async fn() {
    const gates = [
      {
        name: "live proxy",
        path: "../wolfie-live-proxy/index.ts",
        start: "// ── Payment check",
        end: "// ── Create wolfie_sessions record",
      },
      {
        name: "activity",
        path: "../wolfie-activity/index.ts",
        start: "async function assertBillingAccess",
        end: "async function loadOwnedSession",
      },
      {
        name: "brain",
        path: "../wolfie-brain/index.ts",
        start: "async function checkWolfieBillingAccess",
        end: "async function checkWolfieRealtimeQuota",
      },
      {
        name: "realtime session",
        path: "../wolfie-realtime-session/index.ts",
        start: "async function checkRealtimeAccess",
        end: "async function retrieveKnowledge",
      },
    ];

    for (const gate of gates) {
      const source = await Deno.readTextFile(
        new URL(gate.path, import.meta.url),
      );
      const start = source.indexOf(gate.start);
      const end = source.indexOf(gate.end, start);
      assert(start >= 0 && end > start, `${gate.name} billing gate is missing`);
      const billingGate = source.slice(start, end);
      for (
        const contract of [
          "OPEN_STUDENT_PAYMENT_STATUSES",
          "studentBillingDateInSaoPaulo()",
          "studentPaymentIsBeyondTolerance(",
          '.eq("student_id"',
          '.eq("tenant_id"',
          '.lt("due_date"',
        ]
      ) {
        assert(
          billingGate.includes(contract),
          `${gate.name} does not enforce ${contract}`,
        );
      }
      assert(
        !billingGate.includes("86_400_000") &&
          !billingGate.includes("SETTLED_PAYMENT_STATUSES") &&
          !billingGate.includes("DELINQUENT_PAYMENT_STATUSES"),
        `${gate.name} still contains a divergent calendar-day/status rule`,
      );
    }
  },
});
