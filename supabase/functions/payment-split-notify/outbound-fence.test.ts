import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  claimPaymentSplitMessage,
  finishPaymentSplitMessage,
  markPaymentSplitMessageSubmitting,
  paymentSplitMessageFinish,
} from "./outbound-fence.ts";

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

Deno.test("payment split claim binds the exact tenant and payment", async () => {
  let called = "";
  let args: Record<string, unknown> = {};
  const claim = await claimPaymentSplitMessage(
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
    { tenantId: "school-one", paymentId: "payment-1" },
  );
  assertEquals(called, "claim_asaas_payment_split_message");
  assertEquals(args.p_tenant_id, "school-one");
  assertEquals(args.p_payment_id, "payment-1");
  assertEquals(claim.action, "SUBMIT_ONCE");
});

Deno.test("payment split mark and finish reuse the immutable claim token", async () => {
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
  await markPaymentSplitMessageSubmitting(client, claim);
  await finishPaymentSplitMessage(client, claim, {
    status: "UNKNOWN",
    providerHttpStatus: 504,
    error: "provider_delivery_outcome_unknown",
  });
  assertEquals(calls.map((call) => call.name), [
    "mark_asaas_payment_split_message_submitting",
    "finish_asaas_payment_split_message",
  ]);
  assertEquals(calls[0].args.p_claim_token, "claim-1");
  assertEquals(calls[1].args.p_claim_token, "claim-1");
  assertEquals(calls[1].args.p_status, "UNKNOWN");
});

Deno.test("payment split refuses mark without a complete claim", async () => {
  await assertRejects(
    () =>
      markPaymentSplitMessageSubmitting(
        rpcClient(() => ({ data: null, error: null })),
        { ok: true, action: "SUBMIT_ONCE" },
      ),
    Error,
    "payment_split_message_claim_token_missing",
  );
});

Deno.test("payment split treats timeout and 5xx as terminal UNKNOWN", () => {
  assertEquals(
    paymentSplitMessageFinish({
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
    paymentSplitMessageFinish({
      outcome: "accepted",
      messageId: "message-1",
      httpStatus: 200,
    }).status,
    "SENT",
  );
  assertEquals(
    paymentSplitMessageFinish({
      outcome: "rejected",
      messageId: null,
      httpStatus: 400,
    }).status,
    "FAILED",
  );
});
