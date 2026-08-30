import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  authorizeManagementPaymentNotificationSubmission,
  beginManagementPaymentNotificationSubmission,
  claimManagementPaymentNotification,
  finishManagementPaymentNotification,
  loadManagementPaymentNotificationSource,
  managementPaymentNotificationFinish,
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

Deno.test("management payment claim binds exact tenant and durable payment intent", async () => {
  let called = "";
  let args: Record<string, unknown> = {};
  const claim = await claimManagementPaymentNotification(
    rpcClient((name, input) => {
      called = name;
      args = input;
      return {
        data: {
          ok: true,
          action: "SUBMIT_ONCE",
          attempt_id: "attempt-1",
          claim_token: input.p_claim_token,
          notification_kind: "PAYMENT_SPLIT",
        },
        error: null,
      };
    }),
    { tenantId: "school-one", paymentId: "payment-1" },
  );
  assertEquals(called, "claim_management_payment_notification");
  assertEquals(args.p_tenant_id, "school-one");
  assertEquals(args.p_payment_id, "payment-1");
  assertEquals(claim.notification_kind, "PAYMENT_SPLIT");
});

Deno.test("financial source snapshot is loaded through the canonical database RPC", async () => {
  let called = "";
  let args: Record<string, unknown> = {};
  const source = await loadManagementPaymentNotificationSource(
    rpcClient((name, input) => {
      called = name;
      args = input;
      return {
        data: {
          payment_id: "payment-1",
          tenant_id: "school-one",
          value: 169,
        },
        error: null,
      };
    }),
    {
      tenantId: "school-one",
      paymentId: "payment-1",
      notificationKind: "PAYMENT_RECEIVED",
    },
  );
  assertEquals(called, "management_payment_notification_source_snapshot");
  assertEquals(args.p_notification_kind, "PAYMENT_RECEIVED");
  assertEquals(source.value, 169);
});

Deno.test("prepare seals destination, source, instance, integration version and body", async () => {
  let called = "";
  let args: Record<string, unknown> = {};
  const submission = await beginManagementPaymentNotificationSubmission(
    rpcClient((name, input) => {
      called = name;
      args = input;
      return {
        data: {
          ok: true,
          action: "PREPARED",
          provider_destination: "120363000000000000@g.us",
          provider_instance_name: "school-instance",
          provider_integration_id: "51000000-0000-4000-8000-000000000001",
          provider_integration_version: 7,
          message_body: "Pagamento recebido",
          source_snapshot_hash: "b".repeat(64),
        },
        error: null,
      };
    }),
    {
      ok: true,
      action: "SUBMIT_ONCE",
      attempt_id: "attempt-1",
      claim_token: "claim-1",
    },
    {
      expectedDestination: "120363000000000000@g.us",
      providerDestination: "120363000000000000@g.us",
      providerInstanceName: "school-instance",
      integrationId: "51000000-0000-4000-8000-000000000001",
      integrationVersion: 7,
      sourceSnapshot: { payment_id: "payment-1", value: 169 },
      messageBody: "Pagamento recebido",
    },
  );
  assertEquals(called, "begin_management_payment_notification_submission");
  assertEquals(args.p_claim_token, "claim-1");
  assertEquals(args.p_integration_version, 7);
  assertEquals(args.p_source_snapshot, {
    payment_id: "payment-1",
    value: 169,
  });
  assertEquals(submission.source_snapshot_hash, "b".repeat(64));
  assertEquals(submission.action, "PREPARED");
});

Deno.test("provider authorization seals endpoint and credential fingerprints", async () => {
  let called = "";
  let args: Record<string, unknown> = {};
  const authorization = await authorizeManagementPaymentNotificationSubmission(
    rpcClient((name, input) => {
      called = name;
      args = input;
      return {
        data: {
          ok: true,
          action: "SUBMITTING",
          provider_destination: "120363000000000000@g.us",
          provider_instance_name: "school-instance",
          provider_integration_id: "51000000-0000-4000-8000-000000000001",
          provider_integration_version: 7,
          provider_endpoint_hash: "a".repeat(64),
          provider_credential_hash: "c".repeat(64),
          message_body: "Pagamento recebido",
          source_snapshot_hash: "b".repeat(64),
          snapshot_hash: "d".repeat(64),
        },
        error: null,
      };
    }),
    {
      ok: true,
      action: "SUBMIT_ONCE",
      attempt_id: "attempt-1",
      claim_token: "claim-1",
    },
    {
      integrationId: "51000000-0000-4000-8000-000000000001",
      integrationVersion: 7,
      providerEndpointHash: "a".repeat(64),
      providerCredentialHash: "c".repeat(64),
    },
  );
  assertEquals(called, "authorize_management_payment_notification_submission");
  assertEquals(args.p_claim_token, "claim-1");
  assertEquals(args.p_provider_endpoint_hash, "a".repeat(64));
  assertEquals(args.p_provider_credential_hash, "c".repeat(64));
  assertEquals(authorization.snapshot_hash, "d".repeat(64));
});

Deno.test("finish reuses the immutable claim and persists provider receipt", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = rpcClient((name, args) => {
    calls.push({ name, args });
    return {
      data: {
        ok: true,
        status: "SENT",
        provider_delivery_status: "delivered",
      },
      error: null,
    };
  });
  const persisted = await finishManagementPaymentNotification(
    client,
    {
      ok: true,
      action: "SUBMIT_ONCE",
      attempt_id: "attempt-1",
      claim_token: "claim-1",
    },
    {
      status: "SENT",
      providerMessageId: "provider-message-1",
      providerHttpStatus: 200,
    },
  );
  assertEquals(calls[0].name, "finish_management_payment_notification");
  assertEquals(calls[0].args.p_claim_token, "claim-1");
  assertEquals(calls[0].args.p_provider_message_id, "provider-message-1");
  assertEquals(persisted, {
    status: "SENT",
    providerDeliveryStatus: "delivered",
  });
});

Deno.test("submission refuses an incomplete durable claim", async () => {
  await assertRejects(
    () =>
      beginManagementPaymentNotificationSubmission(
        rpcClient(() => ({ data: null, error: null })),
        { ok: true, action: "SUBMIT_ONCE" },
        {
          expectedDestination: "120363000000000000@g.us",
          providerDestination: "120363000000000000@g.us",
          providerInstanceName: "school-instance",
          integrationId: "51000000-0000-4000-8000-000000000001",
          integrationVersion: 1,
          sourceSnapshot: { payment_id: "payment-1" },
          messageBody: "Pagamento recebido",
        },
      ),
    Error,
    "management_payment_notification_claim_token_missing",
  );
});

Deno.test("timeout is terminal UNKNOWN and keeps the provider message id", () => {
  assertEquals(
    managementPaymentNotificationFinish({
      outcome: "ambiguous",
      messageId: "maybe-sent",
      httpStatus: 503,
    }),
    {
      status: "UNKNOWN",
      providerMessageId: "maybe-sent",
      providerHttpStatus: 503,
      error: "provider_delivery_outcome_unknown",
    },
  );
  assertEquals(
    managementPaymentNotificationFinish({
      outcome: "accepted",
      messageId: "sent-1",
      httpStatus: 200,
    }).status,
    "SENT",
  );
  assertEquals(
    managementPaymentNotificationFinish({
      outcome: "accepted",
      messageId: null,
      httpStatus: 200,
    }),
    {
      status: "UNKNOWN",
      providerMessageId: null,
      providerHttpStatus: 200,
      error: "provider_acceptance_without_message_id",
    },
  );
  assertEquals(
    managementPaymentNotificationFinish({
      outcome: "rejected",
      messageId: null,
      httpStatus: 400,
    }).status,
    "FAILED",
  );
});
