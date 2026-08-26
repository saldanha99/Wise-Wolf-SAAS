import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { overdueNotificationKind, paymentNotificationFinish } from "./core.ts";

Deno.test("payment reminder maps an accepted provider response to SENT", () => {
  assertEquals(
    paymentNotificationFinish({
      outcome: "accepted",
      messageId: "message-1",
      httpStatus: 201,
    }),
    { status: "SENT", providerHttpStatus: 201, error: null },
  );
});

Deno.test("payment reminder never retries an ambiguous provider outcome", () => {
  assertEquals(
    paymentNotificationFinish({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: 504,
    }),
    {
      status: "UNKNOWN",
      providerHttpStatus: 504,
      error: "provider_delivery_outcome_unknown",
    },
  );
  assertEquals(
    paymentNotificationFinish({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: null,
    }).status,
    "UNKNOWN",
  );
});

Deno.test("payment reminder records a definitive rejection as FAILED", () => {
  assertEquals(
    paymentNotificationFinish({
      outcome: "rejected",
      messageId: null,
      httpStatus: 400,
    }),
    {
      status: "FAILED",
      providerHttpStatus: 400,
      error: "provider_delivery_rejected",
    },
  );
});

Deno.test("overdue milestones have a closed durable notification kind", () => {
  assertEquals(overdueNotificationKind(3), "PAYMENT_OVERDUE_3");
  assertEquals(overdueNotificationKind(10), "PAYMENT_OVERDUE_10");
  assertEquals(overdueNotificationKind(20), "PAYMENT_OVERDUE_20");
  assertThrows(
    () => overdueNotificationKind(4),
    Error,
    "unsupported_payment_overdue_milestone",
  );
});
