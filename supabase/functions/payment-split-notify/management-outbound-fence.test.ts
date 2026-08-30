import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyMonthlyPaymentClosureDeliveryResult,
  managementGroupMessageFinish,
} from "./management-outbound-fence.ts";

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

Deno.test("monthly delivery result binds tenant, period and durable attempt", async () => {
  let called = "";
  let args: Record<string, unknown> = {};
  const applied = await applyMonthlyPaymentClosureDeliveryResult(
    rpcClient((name, input) => {
      called = name;
      args = input;
      return { data: true, error: null };
    }),
    {
      tenantId: "school-one",
      periodStart: "2026-08-01",
      attemptId: "attempt-one",
    },
  );

  assertEquals(applied, true);
  assertEquals(called, "apply_monthly_payment_closure_delivery_result");
  assertEquals(args, {
    p_tenant_id: "school-one",
    p_period_start: "2026-08-01",
    p_attempt_id: "attempt-one",
  });
});

Deno.test("monthly delivery result refuses an unpersisted reconciliation", async () => {
  await assertRejects(
    () =>
      applyMonthlyPaymentClosureDeliveryResult(
        rpcClient(() => ({ data: false, error: null })),
        {
          tenantId: "school-one",
          periodStart: "2026-08-01",
          attemptId: "attempt-one",
        },
      ),
    Error,
    "monthly_payment_closure_delivery_result_failed",
  );
});

Deno.test("management provider failures are terminal and explicit", () => {
  assertEquals(
    managementGroupMessageFinish({
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
    managementGroupMessageFinish({
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
