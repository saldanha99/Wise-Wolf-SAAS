/// <reference lib="deno.ns" />

import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  businessDaysAfter,
  resolveDisplayedStreak,
  resolveStudentAccess,
  resolveStudentBilling,
} from "./core.ts";

const studentId = "20000000-0000-4000-8000-000000000001";

Deno.test("unfinished authoritative enrollment keeps pedagogy locked", () => {
  for (
    const processingState of [
      "PROFILE_READY",
      "BILLING_READY",
      "AWAITING_PAYMENT",
      "FAILED_RETRYABLE",
    ]
  ) {
    assertEquals(
      resolveStudentAccess([{
        processing_state: processingState,
        processing_by: studentId,
        consumed_by: null,
        consumed_at: null,
      }], studentId),
      {
        status: "PENDING_ACTIVATION",
        enrollmentState: processingState,
      },
    );
  }
});

Deno.test("only completion consumed by this student unlocks pedagogy", () => {
  assertEquals(
    resolveStudentAccess([{
      processing_state: "COMPLETED",
      processing_by: studentId,
      consumed_by: studentId,
      consumed_at: "2026-08-30T10:00:00.000Z",
    }], studentId),
    { status: "ACTIVE", enrollmentState: "COMPLETED" },
  );
  assertEquals(
    resolveStudentAccess([{
      processing_state: "COMPLETED",
      processing_by: studentId,
      consumed_by: null,
      consumed_at: null,
    }], studentId),
    { status: "PENDING_ACTIVATION", enrollmentState: "COMPLETED" },
  );
});

Deno.test("manual and legacy profiles without an enrollment offer remain active", () => {
  assertEquals(resolveStudentAccess([], studentId), {
    status: "ACTIVE",
    enrollmentState: null,
  });
});

Deno.test("financial tolerance counts weekdays after the due date", () => {
  assertEquals(businessDaysAfter("2026-08-28", "2026-08-30"), 0);
  assertEquals(businessDaysAfter("2026-08-28", "2026-08-31"), 1);
  assertEquals(businessDaysAfter("2026-08-28", "2026-09-08"), 7);
  assertEquals(businessDaysAfter("2026-08-28", "2026-09-09"), 8);
});

Deno.test("student remains overdue through the seventh business day", () => {
  const payments = [{ due_date: "2026-08-28", status: "OVERDUE" }];

  assertEquals(resolveStudentBilling(payments, "2026-09-08"), {
    status: "OVERDUE",
    oldestDue: "2026-08-28",
    businessDaysLate: 7,
  });
  assertEquals(resolveStudentBilling(payments, "2026-09-09"), {
    status: "SUSPENDED",
    oldestDue: "2026-08-28",
    businessDaysLate: 8,
  });
});

Deno.test("oldest open payment controls access and pending provider state is included", () => {
  assertEquals(
    resolveStudentBilling([
      { due_date: "2026-09-08", status: "OVERDUE" },
      { due_date: "2026-08-28", status: "PENDING" },
      { due_date: "2026-07-01", status: "RECEIVED" },
    ], "2026-09-09"),
    {
      status: "SUSPENDED",
      oldestDue: "2026-08-28",
      businessDaysLate: 8,
    },
  );
});

Deno.test("no past-due open payment keeps financial access regular", () => {
  assertEquals(
    resolveStudentBilling([
      { due_date: "2026-09-10", status: "PENDING" },
      { due_date: "2026-08-20", status: "RECEIVED" },
    ], "2026-09-09"),
    {
      status: "OK",
      oldestDue: null,
      businessDaysLate: 0,
    },
  );
});

Deno.test("invalid calendar input fails closed instead of shifting dates", () => {
  assertThrows(
    () => businessDaysAfter("2026-02-30", "2026-03-10"),
    RangeError,
    "invalid_calendar_date",
  );
});

Deno.test("opening the portal does not invent practice and expired streak displays zero", () => {
  assertEquals(resolveDisplayedStreak(8, "2026-08-31", "2026-08-31"), 8);
  assertEquals(resolveDisplayedStreak(8, "2026-08-30", "2026-08-31"), 8);
  assertEquals(resolveDisplayedStreak(8, "2026-08-29", "2026-08-31"), 0);
  assertEquals(resolveDisplayedStreak(8, null, "2026-08-31"), 0);
});
