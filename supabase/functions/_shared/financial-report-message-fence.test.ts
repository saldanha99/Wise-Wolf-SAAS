import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  claimFinancialReportMessage,
  financialReportMessageFinish,
  finishFinancialReportMessage,
  markFinancialReportMessageSubmitting,
  monthlyTeacherClosingSubject,
} from "./financial-report-message-fence.ts";

function rpcClient(
  handler: (
    name: string,
    args: Record<string, unknown>,
  ) => { data: unknown; error: unknown },
) {
  return {
    rpc: (name: string, args: Record<string, unknown>) =>
      Promise.resolve(handler(name, args)),
  };
}

Deno.test("financial report claim preserves the complete logical key", async () => {
  let called = "";
  let args: Record<string, unknown> = {};
  const claim = await claimFinancialReportMessage(
    rpcClient((name, input) => {
      called = name;
      args = input;
      return {
        data: {
          ok: true,
          action: "SUBMIT_ONCE",
          attempt_id: "attempt-1",
          claim_token: input.p_claim_token,
        },
        error: null,
      };
    }),
    {
      tenantId: "school-one",
      notificationKind: "DRE_REPORT",
      subjectId: "school-one:manual",
      refDate: "2026-08-25",
    },
  );
  assertEquals(called, "claim_financial_report_message");
  assertEquals(args.p_tenant_id, "school-one");
  assertEquals(args.p_notification_kind, "DRE_REPORT");
  assertEquals(args.p_subject_id, "school-one:manual");
  assertEquals(args.p_ref_date, "2026-08-25");
  assertEquals(claim.action, "SUBMIT_ONCE");
});

Deno.test("financial report mark and finish reuse the claim token", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = rpcClient((name, args) => {
    calls.push({ name, args });
    return {
      data: name.startsWith("mark_")
        ? { ok: true, status: "SUBMITTING" }
        : { ok: true, status: "UNKNOWN" },
      error: null,
    };
  });
  const claim = {
    ok: true,
    action: "SUBMIT_ONCE" as const,
    attempt_id: "attempt-1",
    claim_token: "claim-1",
  };
  await markFinancialReportMessageSubmitting(client, claim);
  await finishFinancialReportMessage(client, claim, {
    status: "UNKNOWN",
    providerHttpStatus: 504,
    error: "provider_delivery_outcome_unknown",
  });
  assertEquals(calls.map((call) => call.name), [
    "mark_financial_report_message_submitting",
    "finish_financial_report_message",
  ]);
  assertEquals(calls[0].args.p_claim_token, "claim-1");
  assertEquals(calls[1].args.p_claim_token, "claim-1");
});

Deno.test("financial report refuses an incomplete claim", async () => {
  await assertRejects(
    () =>
      markFinancialReportMessageSubmitting(
        rpcClient(() => ({ data: null, error: null })),
        { ok: true, action: "SUBMIT_ONCE" },
      ),
    Error,
    "financial_report_message_claim_token_missing",
  );
});

Deno.test("financial report maps ambiguous delivery to terminal UNKNOWN", () => {
  assertEquals(
    financialReportMessageFinish({
      outcome: "ambiguous",
      messageId: null,
      httpStatus: 503,
    }),
    {
      status: "UNKNOWN",
      providerHttpStatus: 503,
      error: "provider_delivery_outcome_unknown",
    },
  );
  assertEquals(
    financialReportMessageFinish({
      outcome: "accepted",
      messageId: "message-1",
      httpStatus: 200,
    }).status,
    "SENT",
  );
  assertEquals(
    financialReportMessageFinish({
      outcome: "accepted",
      messageId: null,
      httpStatus: 200,
    }),
    {
      status: "UNKNOWN",
      providerHttpStatus: 200,
      error: "provider_acceptance_without_message_id",
    },
  );
  assertEquals(
    financialReportMessageFinish({
      outcome: "rejected",
      messageId: null,
      httpStatus: 400,
    }).status,
    "FAILED",
  );
});

Deno.test("monthly closing subject versions the exact financial snapshot", () => {
  const base = {
    teacherId: "10000000-0000-4000-8000-000000000001",
    month: "2026-08",
    closingId: "20000000-0000-4000-8000-000000000001",
    lessons: 12,
    amount: 99.9,
  };
  assertEquals(
    monthlyTeacherClosingSubject(base),
    "10000000-0000-4000-8000-000000000001:2026-08:" +
      "20000000-0000-4000-8000-000000000001:12:9990",
  );
  assertEquals(
    monthlyTeacherClosingSubject({ ...base, amount: 100 }),
    "10000000-0000-4000-8000-000000000001:2026-08:" +
      "20000000-0000-4000-8000-000000000001:12:10000",
  );
});
