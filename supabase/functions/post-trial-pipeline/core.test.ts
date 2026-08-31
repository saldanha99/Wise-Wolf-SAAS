/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AutomationClaimStore,
  claimAutomationDelivery,
  classifyProviderHttpResponse,
  isEnrollmentOfferReminderEligible,
  isMeaningfulEnrollmentOffer,
  isOpenConversionStatus,
  isPendingEnrollmentLinkStatus,
  shouldReleaseAutomationClaim,
} from "./core.ts";

Deno.test("claim returns the exact inserted receipt and releases only that id", async () => {
  const deletedIds: string[] = [];
  const store: AutomationClaimStore = {
    hasReceipt: () => Promise.resolve(false),
    insertReceipt: () => Promise.resolve({ id: "receipt-exact-1" }),
    deleteReceiptById: (id) => {
      deletedIds.push(id);
      return Promise.resolve();
    },
  };

  const claim = await claimAutomationDelivery(
    store,
    "TRIAL_NO_PROPOSAL_NUDGE",
    "opportunity-1",
    "2026-08-31",
  );

  assertEquals(claim?.id, "receipt-exact-1");
  await claim?.undo();
  assertEquals(deletedIds, ["receipt-exact-1"]);
});

Deno.test("claim does not insert when an earlier delivery receipt exists", async () => {
  let inserts = 0;
  const store: AutomationClaimStore = {
    hasReceipt: () => Promise.resolve(true),
    insertReceipt: () => {
      inserts++;
      return Promise.resolve({ id: "unexpected" });
    },
    deleteReceiptById: () => Promise.resolve(),
  };

  const claim = await claimAutomationDelivery(
    store,
    "ENROLL_REMIND_D1",
    "link-1",
    "2026-08-31",
  );

  assertEquals(claim, null);
  assertEquals(inserts, 0);
});

Deno.test("only a definitive provider rejection releases the receipt", () => {
  assertEquals(shouldReleaseAutomationClaim("REJECTED"), true);
  assertEquals(shouldReleaseAutomationClaim("ACCEPTED"), false);
  assertEquals(shouldReleaseAutomationClaim("UNCERTAIN"), false);
});

Deno.test("provider timeout and server errors remain uncertain", () => {
  assertEquals(classifyProviderHttpResponse(200), "ACCEPTED");
  assertEquals(classifyProviderHttpResponse(400), "REJECTED");
  assertEquals(classifyProviderHttpResponse(401), "REJECTED");
  assertEquals(classifyProviderHttpResponse(429), "REJECTED");
  assertEquals(classifyProviderHttpResponse(408), "UNCERTAIN");
  assertEquals(classifyProviderHttpResponse(500), "UNCERTAIN");
  assertEquals(classifyProviderHttpResponse(503), "UNCERTAIN");
});

Deno.test("post-trial delivery is allowed only for an OPEN opportunity", () => {
  assertEquals(isOpenConversionStatus("OPEN"), true);
  assertEquals(isOpenConversionStatus(" open "), true);
  assertEquals(isOpenConversionStatus("LOST"), false);
  assertEquals(isOpenConversionStatus("WON"), false);
  assertEquals(isOpenConversionStatus(null), false);
});

Deno.test("enrollment reminders require the link to remain PENDING", () => {
  assertEquals(isPendingEnrollmentLinkStatus("PENDING"), true);
  assertEquals(isPendingEnrollmentLinkStatus("PROCESSING"), false);
  assertEquals(isPendingEnrollmentLinkStatus("USED"), false);
  assertEquals(isPendingEnrollmentLinkStatus("EXPIRED"), false);
});

Deno.test("revoked or expired untouched offers do not suppress trial recovery", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const base = {
    kind: "ENROLLMENT",
    opportunity_id: "opportunity-1",
    processing_state: "NOT_STARTED",
    expires_at: "2026-09-07T12:00:00.000Z",
  };

  assertEquals(
    isMeaningfulEnrollmentOffer(base, "opportunity-1", now),
    true,
  );
  assertEquals(
    isMeaningfulEnrollmentOffer(
      { ...base, revoked_at: "2026-08-30T12:00:00.000Z" },
      "opportunity-1",
      now,
    ),
    false,
  );
  assertEquals(
    isMeaningfulEnrollmentOffer(
      { ...base, expires_at: "2026-08-30T12:00:00.000Z" },
      "opportunity-1",
      now,
    ),
    false,
  );
});

Deno.test("started enrollment suppresses recovery but never receives a reminder", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const started = {
    kind: "ENROLLMENT",
    opportunity_id: "opportunity-1",
    processing_state: "PROFILE_READY",
    revoked_at: null,
    consumed_at: null,
    expires_at: "2026-08-30T12:00:00.000Z",
  };

  assertEquals(
    isMeaningfulEnrollmentOffer(started, "opportunity-1", now),
    true,
  );
  assertEquals(
    isEnrollmentOfferReminderEligible(started, "opportunity-1", now),
    false,
  );
});

Deno.test("only an active untouched matching enrollment offer receives reminders", () => {
  const now = Date.parse("2026-08-31T12:00:00.000Z");
  const active = {
    kind: "ENROLLMENT",
    opportunity_id: "opportunity-1",
    processing_state: "NOT_STARTED",
    revoked_at: null,
    consumed_at: null,
    expires_at: "2026-09-07T12:00:00.000Z",
  };

  assertEquals(
    isEnrollmentOfferReminderEligible(active, "opportunity-1", now),
    true,
  );
  assertEquals(
    isEnrollmentOfferReminderEligible(
      { ...active, opportunity_id: "opportunity-2" },
      "opportunity-1",
      now,
    ),
    false,
  );
  assertEquals(
    isEnrollmentOfferReminderEligible(
      { ...active, kind: "INVITE" },
      "opportunity-1",
      now,
    ),
    false,
  );
});
