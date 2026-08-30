import {
  adoptHubProviderCreationBinding,
  cancelHubProviderSubscriptionOnce,
  HubProviderOperationError,
  markHubProviderCreationSubmitting,
  runHubProviderCancellation,
} from "./hub-provider-operations.ts";
import type { ResolvedAsaasIntegration } from "./tenant-integration-broker.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const target = {
  providerSubscriptionId: "sub_hub_1",
  providerCustomerId: "cus_hub_1",
  checkoutId: "11111111-1111-4111-8111-111111111111",
};

const integration: ResolvedAsaasIntegration = {
  integrationId: "22222222-2222-4222-8222-222222222222",
  tenantId: "school-wise-wolf",
  provider: "asaas",
  mode: "PLATFORM_MANAGED_ROOT",
  version: 7,
  environment: "platform",
  baseUrl: "https://api.asaas.com/v3",
  apiKey: "test-secret-never-sent",
};

function operation(action = "STARTED") {
  return {
    action,
    operationId: "33333333-3333-4333-8333-333333333333",
    leaseToken: "44444444-4444-4444-8444-444444444444",
    status: "READY",
    snapshot: { targets: [target] },
  };
}

function adminWithClaim(action: "VERIFY_REQUIRED" | "RECONCILE_ONLY") {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const data = name === "hub_begin_provider_cancellation"
          ? operation(action === "VERIFY_REQUIRED" ? "STARTED" : "RESUME")
          : name === "hub_claim_provider_cancellation_target"
          ? { ok: true, action, target }
          : name === "hub_mark_provider_cancellation_submitting"
          ? { ok: true, action: "SUBMIT_ALLOWED" }
          : name === "hub_finalize_provider_cancellation"
          ? { ok: true, operationId: operation().operationId }
          : { ok: true };
        return Promise.resolve({ data, error: null });
      },
    },
  };
}

const resolver = async () => integration;

Deno.test("Hub provider creation crosses the semantic lifecycle RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  await markHubProviderCreationSubmitting({
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: { ok: true }, error: null });
      },
    },
    attemptId: "77777777-7777-4777-8777-777777777777",
    claimToken: "88888888-8888-4888-8888-888888888888",
    accountId: "55555555-5555-4555-8555-555555555555",
    checkoutId: target.checkoutId,
  });
  assert(
    calls.length === 1 &&
      calls[0].name === "hub_mark_provider_creation_submitting" &&
      calls[0].args.p_account_id ===
        "55555555-5555-4555-8555-555555555555" &&
      calls[0].args.p_checkout_id === target.checkoutId,
    "creation submit must bind the exact account and checkout lifecycle",
  );
});

Deno.test("Hub provider creation fails closed when cancellation owns fence", async () => {
  let code = "";
  try {
    await markHubProviderCreationSubmitting({
      admin: {
        rpc() {
          return Promise.resolve({
            data: { ok: false, reason: "account_lifecycle_fenced" },
            error: null,
          });
        },
      },
      attemptId: "77777777-7777-4777-8777-777777777777",
      claimToken: "88888888-8888-4888-8888-888888888888",
      accountId: "55555555-5555-4555-8555-555555555555",
      checkoutId: target.checkoutId,
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_PROVIDER_LIFECYCLE_FENCED",
    "creation must not POST after cancellation claimed the account",
  );
});

Deno.test("recovered Hub provider entity is adopted through the lifecycle fence", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  await adoptHubProviderCreationBinding({
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: {
            ok: true,
            operation: "SUBSCRIPTION_CREATE",
            providerEntityId: target.providerSubscriptionId,
          },
          error: null,
        });
      },
    },
    attemptId: "77777777-7777-4777-8777-777777777777",
    claimToken: "88888888-8888-4888-8888-888888888888",
    accountId: "55555555-5555-4555-8555-555555555555",
    checkoutId: target.checkoutId,
    providerEntityId: target.providerSubscriptionId,
    providerStatus: "ACTIVE",
  });
  assert(
    calls.length === 1 &&
      calls[0].name === "hub_adopt_provider_creation_binding" &&
      calls[0].args.p_account_id ===
        "55555555-5555-4555-8555-555555555555" &&
      calls[0].args.p_checkout_id === target.checkoutId &&
      calls[0].args.p_provider_entity_id === target.providerSubscriptionId &&
      calls[0].args.p_provider_status === "ACTIVE",
    "recovery adoption must bind claim, account, checkout and provider id",
  );
});

Deno.test("recovered Hub provider entity cannot adopt after cancellation", async () => {
  let code = "";
  try {
    await adoptHubProviderCreationBinding({
      admin: {
        rpc() {
          return Promise.resolve({
            data: { ok: false, reason: "account_lifecycle_fenced" },
            error: null,
          });
        },
      },
      attemptId: "77777777-7777-4777-8777-777777777777",
      claimToken: null,
      accountId: "55555555-5555-4555-8555-555555555555",
      checkoutId: target.checkoutId,
      providerEntityId: target.providerSubscriptionId,
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_PROVIDER_LIFECYCLE_FENCED",
    "an ALREADY_SUCCEEDED recovery must not link after cancellation starts",
  );
});

Deno.test("first claimed target performs exact GET then one DELETE", async () => {
  const admin = adminWithClaim("VERIFY_REQUIRED");
  const methods: string[] = [];
  let getCount = 0;
  const result = await runHubProviderCancellation({
    admin: admin.client,
    operationKind: "ACCOUNT_STATUS",
    accountId: "55555555-5555-4555-8555-555555555555",
    actorUserId: null,
    targetStatus: "SUSPENDED",
    resolveIntegration: resolver,
    fetcher: async (_input, init) => {
      const method = String(init?.method || "GET");
      methods.push(method);
      if (method === "GET") {
        getCount += 1;
        return getCount === 1
          ? Response.json({
            id: target.providerSubscriptionId,
            customer: target.providerCustomerId,
            externalReference: `hub:${target.checkoutId}`,
            status: "ACTIVE",
          })
          : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 200 });
    },
  });
  assert(result.ok === true, "operation should finalize");
  assert(
    methods.join(",") === "GET,DELETE,GET",
    "must GET, DELETE once, then prove terminal state",
  );
  assert(
    admin.calls.some((call) =>
      call.name === "hub_bind_provider_operation_integration" &&
      call.args.p_integration_version === 7
    ),
    "integration version must be durably bound",
  );
});

Deno.test("ambiguous retry is GET-only and accepts terminal state", async () => {
  const admin = adminWithClaim("RECONCILE_ONLY");
  const methods: string[] = [];
  await runHubProviderCancellation({
    admin: admin.client,
    operationKind: "CORE_CANCELLATION",
    accountId: "55555555-5555-4555-8555-555555555555",
    actorUserId: "66666666-6666-4666-8666-666666666666",
    resolveIntegration: resolver,
    fetcher: async (_input, init) => {
      methods.push(String(init?.method || "GET"));
      return Response.json({
        id: target.providerSubscriptionId,
        customer: target.providerCustomerId,
        externalReference: `hub:${target.checkoutId}`,
        status: "INACTIVE",
      });
    },
  });
  assert(methods.join(",") === "GET", "retry must never repeat DELETE");
});

Deno.test("ambiguous retry seeing ACTIVE fails closed without DELETE", async () => {
  const admin = adminWithClaim("RECONCILE_ONLY");
  const methods: string[] = [];
  let code = "";
  try {
    await runHubProviderCancellation({
      admin: admin.client,
      operationKind: "ACCOUNT_STATUS",
      accountId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      targetStatus: "CLOSED",
      resolveIntegration: resolver,
      fetcher: async (_input, init) => {
        methods.push(String(init?.method || "GET"));
        return Response.json({
          id: target.providerSubscriptionId,
          customer: target.providerCustomerId,
          externalReference: `hub:${target.checkoutId}`,
          status: "ACTIVE",
        });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    "active ambiguous target must require review",
  );
  assert(methods.join(",") === "GET", "ambiguous retry must stay GET-only");
});

Deno.test("another Hub operation at SUBMITTING globally blocks DELETE", async () => {
  const calls: string[] = [];
  const admin = {
    rpc(name: string, _args: Record<string, unknown>) {
      calls.push(name);
      const data = name === "hub_begin_provider_cancellation"
        ? operation("STARTED")
        : name === "hub_claim_provider_cancellation_target"
        ? { ok: true, action: "VERIFY_REQUIRED", target }
        : name === "hub_mark_provider_cancellation_submitting"
        ? {
          ok: true,
          action: "RECONCILE_ONLY",
          reason: "PROVIDER_DELETE_ALREADY_SUBMITTED",
        }
        : { ok: true };
      return Promise.resolve({ data, error: null });
    },
  };
  const methods: string[] = [];
  let code = "";
  try {
    await runHubProviderCancellation({
      admin,
      operationKind: "ACCOUNT_STATUS",
      accountId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      targetStatus: "SUSPENDED",
      resolveIntegration: resolver,
      fetcher: async (_input, init) => {
        methods.push(String(init?.method || "GET"));
        return Response.json({
          id: target.providerSubscriptionId,
          customer: target.providerCustomerId,
          externalReference: `hub:${target.checkoutId}`,
          status: "ACTIVE",
        });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    "a second operation must reconcile the first provider mutation",
  );
  assert(
    methods.join(",") === "GET",
    "a competing operation may verify with GET but must never DELETE",
  );
  assert(
    calls.includes("hub_mark_provider_cancellation_submitting"),
    "the common provider boundary must perform the final concurrency check",
  );
});

Deno.test("snapshot drift at the final boundary blocks DELETE", async () => {
  const calls: string[] = [];
  const admin = {
    rpc(name: string, _args: Record<string, unknown>) {
      calls.push(name);
      const data = name === "hub_begin_provider_cancellation"
        ? operation("STARTED")
        : name === "hub_claim_provider_cancellation_target"
        ? { ok: true, action: "VERIFY_REQUIRED", target }
        : name === "hub_mark_provider_cancellation_submitting"
        ? {
          ok: false,
          action: "REVIEW_REQUIRED",
          reason: "LOCAL_SCOPE_CHANGED",
        }
        : { ok: true };
      return Promise.resolve({ data, error: null });
    },
  };
  const methods: string[] = [];
  let code = "";
  try {
    await runHubProviderCancellation({
      admin,
      operationKind: "ACCOUNT_STATUS",
      accountId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      targetStatus: "SUSPENDED",
      resolveIntegration: resolver,
      fetcher: async (_input, init) => {
        methods.push(String(init?.method || "GET"));
        return Response.json({
          id: target.providerSubscriptionId,
          customer: target.providerCustomerId,
          externalReference: `hub:${target.checkoutId}`,
          status: "ACTIVE",
        });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    "a changed immutable account scope must require review",
  );
  assert(
    methods.join(",") === "GET",
    "snapshot drift may be observed with GET but must never DELETE",
  );
  assert(
    !calls.includes("hub_complete_provider_cancellation_target") &&
      !calls.includes("hub_finalize_provider_cancellation"),
    "a drifted target must not be completed or finalized",
  );
});

Deno.test("DELETE 2xx is not finalized until exact GET proves terminal", async () => {
  const admin = adminWithClaim("VERIFY_REQUIRED");
  const methods: string[] = [];
  let code = "";
  try {
    await runHubProviderCancellation({
      admin: admin.client,
      operationKind: "ACCOUNT_STATUS",
      accountId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      targetStatus: "SUSPENDED",
      resolveIntegration: resolver,
      fetcher: async (_input, init) => {
        const method = String(init?.method || "GET");
        methods.push(method);
        return method === "DELETE"
          ? new Response(null, { status: 200 })
          : Response.json({
            id: target.providerSubscriptionId,
            customer: target.providerCustomerId,
            externalReference: `hub:${target.checkoutId}`,
            status: "ACTIVE",
          });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
    "an accepted but still-active scheduler must remain ambiguous",
  );
  assert(
    methods.join(",") === "GET,DELETE,GET",
    "terminal proof must immediately follow the one DELETE",
  );
  assert(
    !admin.calls.some((call) =>
      call.name === "hub_complete_provider_cancellation_target" ||
      call.name === "hub_finalize_provider_cancellation"
    ),
    "local finalization must wait for terminal provider proof",
  );
});

Deno.test("read/delete integration version mismatch blocks before provider IO", async () => {
  const admin = adminWithClaim("VERIFY_REQUIRED");
  let providerCalls = 0;
  let code = "";
  try {
    await runHubProviderCancellation({
      admin: admin.client,
      operationKind: "ACCOUNT_STATUS",
      accountId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      targetStatus: "CLOSED",
      resolveIntegration: async (_admin, purpose) => ({
        ...integration,
        version: purpose === "subscription.read" ? 7 : 8,
      }),
      fetcher: async () => {
        providerCalls += 1;
        return new Response(null, { status: 500 });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_PROVIDER_INTEGRATION_VERSION_CHANGED",
    "version drift must fail closed",
  );
  assert(providerCalls === 0, "provider must not be called on version drift");
});

Deno.test("read/delete credential drift blocks before provider IO", async () => {
  const admin = adminWithClaim("VERIFY_REQUIRED");
  let providerCalls = 0;
  let code = "";
  try {
    await runHubProviderCancellation({
      admin: admin.client,
      operationKind: "ACCOUNT_STATUS",
      accountId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      targetStatus: "CLOSED",
      resolveIntegration: async (_admin, purpose) => ({
        ...integration,
        apiKey: purpose === "subscription.read"
          ? "read-secret-never-sent"
          : "delete-secret-never-sent",
      }),
      fetcher: async () => {
        providerCalls += 1;
        return new Response(null, { status: 500 });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_PROVIDER_INTEGRATION_VERSION_CHANGED",
    "credential drift under one version must fail closed",
  );
  assert(
    providerCalls === 0,
    "provider must not be called on credential drift",
  );
});

Deno.test("credential rotation after submit claim blocks DELETE", async () => {
  const admin = adminWithClaim("VERIFY_REQUIRED");
  let deleteResolutionCount = 0;
  const methods: string[] = [];
  let code = "";
  try {
    await runHubProviderCancellation({
      admin: admin.client,
      operationKind: "ACCOUNT_STATUS",
      accountId: "55555555-5555-4555-8555-555555555555",
      actorUserId: null,
      targetStatus: "CLOSED",
      resolveIntegration: async (_admin, purpose) => {
        if (purpose === "subscription.delete") deleteResolutionCount += 1;
        return {
          ...integration,
          apiKey: deleteResolutionCount >= 2
            ? "rotated-after-claim-never-sent"
            : integration.apiKey,
        };
      },
      fetcher: async (_input, init) => {
        const method = String(init?.method || "GET");
        methods.push(method);
        return Response.json({
          id: target.providerSubscriptionId,
          customer: target.providerCustomerId,
          externalReference: `hub:${target.checkoutId}`,
          status: "ACTIVE",
        });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_PROVIDER_INTEGRATION_VERSION_CHANGED",
    "post-claim credential rotation must fail closed",
  );
  assert(
    methods.join(",") === "GET",
    "post-claim credential rotation must stop before DELETE",
  );
});

Deno.test("concurrent webhook cancellation retries GET-only", async () => {
  const calls: string[] = [];
  const admin = {
    rpc(name: string, _args: Record<string, unknown>) {
      calls.push(name);
      const data = name === "hub_claim_webhook_provider_cancellation"
        ? {
          ok: true,
          action: "RECONCILE_ONLY",
          operationId: operation().operationId,
          leaseToken: operation().leaseToken,
        }
        : { ok: true };
      return Promise.resolve({ data, error: null });
    },
  };
  const methods: string[] = [];
  let code = "";
  try {
    await cancelHubProviderSubscriptionOnce({
      admin,
      accountId: "55555555-5555-4555-8555-555555555555",
      target,
      resolveIntegration: resolver,
      fetcher: async (_input, init) => {
        methods.push(String(init?.method || "GET"));
        return Response.json({
          id: target.providerSubscriptionId,
          customer: target.providerCustomerId,
          externalReference: `hub:${target.checkoutId}`,
          status: "ACTIVE",
        });
      },
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    calls[0] === "hub_claim_webhook_provider_cancellation",
    "webhook must durably claim before provider IO",
  );
  assert(
    code === "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    "ambiguous active webhook target must require review",
  );
  assert(methods.join(",") === "GET", "concurrent webhook must not DELETE");
});

Deno.test("webhook target reaches terminal state before operation finalization", async () => {
  const calls: string[] = [];
  const admin = {
    rpc(name: string, _args: Record<string, unknown>) {
      calls.push(name);
      const data = name === "hub_claim_webhook_provider_cancellation"
        ? {
          ok: true,
          action: "VERIFY_REQUIRED",
          operationId: operation().operationId,
          leaseToken: operation().leaseToken,
        }
        : name === "hub_mark_provider_cancellation_submitting"
        ? { ok: true, action: "SUBMIT_ALLOWED" }
        : { ok: true };
      return Promise.resolve({ data, error: null });
    },
  };
  const methods: string[] = [];
  let getCount = 0;
  await cancelHubProviderSubscriptionOnce({
    admin,
    accountId: "55555555-5555-4555-8555-555555555555",
    target,
    resolveIntegration: resolver,
    fetcher: async (_input, init) => {
      const method = String(init?.method || "GET");
      methods.push(method);
      if (method === "GET") {
        getCount += 1;
        return getCount === 1
          ? Response.json({
            id: target.providerSubscriptionId,
            customer: target.providerCustomerId,
            externalReference: `hub:${target.checkoutId}`,
            status: "ACTIVE",
          })
          : new Response(null, { status: 410 });
      }
      return new Response(null, { status: 200 });
    },
  });
  assert(
    methods.join(",") === "GET,DELETE,GET",
    "fresh claim deletes once and confirms terminal state",
  );
  assert(
    calls.indexOf("hub_complete_provider_cancellation_target") <
      calls.indexOf("hub_finalize_webhook_provider_cancellation"),
    "target confirmation must precede operation finalization",
  );
});
