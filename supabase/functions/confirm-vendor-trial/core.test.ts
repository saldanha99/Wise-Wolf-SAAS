/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildTeacherClaimUrl,
  parseVendorTrialLookup,
  shouldNotifyTeacher,
  vendorTrialErrorStatus,
} from "./core.ts";

Deno.test("accepts exactly one opaque lookup", () => {
  assertEquals(
    parseVendorTrialLookup(
      "https://example.test?token=abcdefghijklmnopqrstuvwxyz123456",
    ),
    { token: "abcdefghijklmnopqrstuvwxyz123456", legacyOpportunityId: null },
  );
  assertThrows(() =>
    parseVendorTrialLookup(
      "https://example.test?legacy=00000000-0000-4000-8000-000000000001",
    )
  );
  assertThrows(() => parseVendorTrialLookup("https://example.test"));
  assertThrows(() =>
    parseVendorTrialLookup(
      "https://example.test?token=abcdefghijklmnopqrstuvwxyz123456&legacy=00000000-0000-4000-8000-000000000001",
    )
  );
});

Deno.test("notifies only a newly-created teacher request", () => {
  assertEquals(
    shouldNotifyTeacher({
      ok: true,
      newlyRequested: true,
      state: "AWAITING_TEACHER",
    }),
    true,
  );
  assertEquals(
    shouldNotifyTeacher({
      ok: true,
      newlyRequested: false,
      state: "AWAITING_TEACHER",
    }),
    false,
  );
  assertEquals(
    shouldNotifyTeacher({
      ok: true,
      newlyRequested: true,
      state: "CONFIRMED",
    }),
    false,
  );
});

Deno.test("builds a PII-free authenticated teacher claim URL", () => {
  assertEquals(
    buildTeacherClaimUrl(
      "https://school.example.com/path?old=value",
      "00000000-0000-4000-8000-000000000001",
      3,
    ),
    "https://school.example.com/claim-opportunity?id=00000000-0000-4000-8000-000000000001&g=3",
  );
  assertEquals(
    buildTeacherClaimUrl(
      "http://untrusted.example.com",
      "00000000-0000-4000-8000-000000000001",
      3,
    ),
    null,
  );
});

Deno.test("maps expected conflicts without returning a server error", () => {
  assertEquals(vendorTrialErrorStatus("teacher_schedule_conflict"), 409);
  assertEquals(vendorTrialErrorStatus("link_expired"), 410);
  assertEquals(vendorTrialErrorStatus("unknown"), 500);
});
