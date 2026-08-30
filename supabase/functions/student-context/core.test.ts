/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resolveStudentAccess } from "./core.ts";

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
