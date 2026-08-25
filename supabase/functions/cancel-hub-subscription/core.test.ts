/// <reference lib="deno.ns" />

import {
  cancellationAlreadyScheduled,
  CancellationValidationError,
  collectProviderSubscriptionIds,
  parseCancellationRequest,
} from "./core.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const assertCode = (run: () => unknown, code: string) => {
  try {
    run();
  } catch (error) {
    assert(
      error instanceof CancellationValidationError && error.code === code,
      `expected ${code}`,
    );
    return;
  }
  throw new Error(`expected ${code}`);
};

Deno.test("Hub cancellation requires an exact account and confirmation", () => {
  const accountId = "550e8400-e29b-41d4-a716-446655440000";
  const request = parseCancellationRequest({
    accountId,
    confirmation: " cancelar ",
  });
  assert(request.accountId === accountId, "the account must be preserved");
  assertCode(
    () => parseCancellationRequest({ accountId, confirmation: "CONFIRMAR" }),
    "INVALID_HUB_CANCELLATION_REQUEST",
  );
  assertCode(
    () =>
      parseCancellationRequest({
        accountId,
        confirmation: "CANCELAR",
        tenantId: "another-account",
      }),
    "INVALID_HUB_CANCELLATION_REQUEST",
  );
});

Deno.test("provider reconciliation collects every account recurrence once", () => {
  const providerIds = collectProviderSubscriptionIds(
    { provider: "ASAAS", provider_subscription_id: "sub_current" },
    [
      {
        status: "PAID",
        asaas_subscription_id: "sub_current",
        asaas_payment_id: "pay_first",
      },
      {
        status: "PENDING",
        asaas_subscription_id: "sub_replacement",
        asaas_payment_id: null,
      },
      {
        status: "CREATED",
        asaas_subscription_id: null,
        asaas_payment_id: null,
      },
    ],
  );
  assert(
    providerIds.join(",") === "sub_current,sub_replacement",
    "every provider schedule must be cancelled exactly once",
  );
});

Deno.test("ambiguous provider state fails closed before local cancellation", () => {
  assertCode(
    () =>
      collectProviderSubscriptionIds(
        { provider: "ASAAS", provider_subscription_id: "sub_current" },
        [{ status: "PAID", asaas_subscription_id: null }],
      ),
    "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
  );
  assertCode(
    () =>
      collectProviderSubscriptionIds(
        { provider: "OTHER", provider_subscription_id: "sub_current" },
        [],
      ),
    "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
  );
});

Deno.test("cancel-at-period-end metadata is accepted only as boolean true", () => {
  assert(
    cancellationAlreadyScheduled({ cancelAtPeriodEnd: true }),
    "a confirmed cancellation must be recognized",
  );
  assert(
    !cancellationAlreadyScheduled({ cancelAtPeriodEnd: "true" }),
    "string metadata must fail closed",
  );
});
