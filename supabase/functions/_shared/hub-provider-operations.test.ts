import {
  adoptHubProviderCreationBinding,
  cancelHubProviderSubscriptionOnce,
  HubProviderOperationError,
  markHubProviderCreationSubmitting,
  runHubAbandonedCheckoutCancellation,
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

// ---------------------------------------------------------------------------
// Checkout abandonado: banco e Asaas dublados, nada sai para a rede.

const abandonedCheckoutId = "66666666-6666-4666-8666-666666666666";
const abandonedSubscription = {
  providerSubscriptionId: "sub_abandoned",
  providerCustomerId: "cus_abandoned",
  checkoutId: abandonedCheckoutId,
};

function abandonedBegin(action = "STARTED") {
  return {
    ok: true,
    action,
    operationId: "77777777-7777-4777-8777-777777777771",
    leaseToken: "77777777-7777-4777-8777-777777777772",
    snapshot: {
      checkoutId: abandonedCheckoutId,
      targets: [abandonedSubscription],
      payment: {
        providerPaymentId: "pay_abandoned",
        providerCustomerId: "cus_abandoned",
        providerSubscriptionId: "sub_abandoned",
        checkoutId: abandonedCheckoutId,
      },
    },
  };
}

function abandonedAdmin(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    names: () => calls.map((call) => call.name),
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const data = name in overrides
          ? overrides[name]
          : name === "hub_begin_abandoned_checkout_cancellation"
          ? abandonedBegin()
          : name === "hub_claim_provider_cancellation_target"
          ? { ok: true, action: "VERIFY_REQUIRED" }
          : name === "hub_mark_abandoned_checkout_subscription_submitting"
          ? { ok: true, action: "SUBMIT_ALLOWED" }
          : name === "hub_mark_abandoned_checkout_payment_submitting"
          ? { ok: true, action: "SUBMIT_ALLOWED" }
          : name === "hub_abort_abandoned_checkout_cancellation"
          ? { ok: true, action: "ABORTED" }
          : name === "hub_finalize_abandoned_checkout_cancellation"
          ? { ok: true, idempotent: false, status: "CANCELLED" }
          : { ok: true };
        return Promise.resolve({ data, error: null });
      },
    },
  };
}

const activeSubscription = () =>
  Response.json({
    id: "sub_abandoned",
    customer: "cus_abandoned",
    externalReference: `hub:${abandonedCheckoutId}`,
    status: "ACTIVE",
  });

const providerPayment = (patch: Record<string, unknown> = {}) =>
  Response.json({
    id: "pay_abandoned",
    customer: "cus_abandoned",
    subscription: "sub_abandoned",
    externalReference: `hub:${abandonedCheckoutId}`,
    status: "PENDING",
    ...patch,
  });

// Roteia por "MÉTODO recurso" e consome as respostas em ordem.
function scriptedFetch(script: Record<string, Array<() => Response>>) {
  const requests: string[] = [];
  const fetcher = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method || "GET");
    const resource = url.includes("/payments/") ? "payment" : "subscription";
    const key = `${method} ${resource}`;
    requests.push(key);
    if (url.includes(integration.apiKey)) {
      throw new Error("a chave do Asaas não pode ir na URL");
    }
    const next = script[key]?.shift();
    if (!next) throw new Error(`requisição inesperada: ${key}`);
    return Promise.resolve(next());
  };
  return { requests, fetcher };
}

Deno.test("checkout abandonado: assinatura e depois cobrança, um DELETE cada", async () => {
  const admin = abandonedAdmin();
  const provider = scriptedFetch({
    "GET payment": [
      () => providerPayment(),
      () => providerPayment(),
      () => providerPayment({ deleted: true }),
    ],
    "GET subscription": [
      activeSubscription,
      () => new Response(null, { status: 404 }),
    ],
    "DELETE subscription": [() => Response.json({ deleted: true })],
    "DELETE payment": [() => Response.json({ deleted: true })],
  });
  const result = await runHubAbandonedCheckoutCancellation({
    admin: admin.client,
    checkoutId: abandonedCheckoutId,
    fetcher: provider.fetcher,
    resolveIntegration: resolver,
  });
  assert(result.outcome === "CANCELLED", "o checkout deveria ser cancelado");
  assert(
    provider.requests.join(",") ===
      "GET payment,GET subscription,DELETE subscription,GET subscription," +
        "GET payment,DELETE payment,GET payment",
    `ordem de chamadas ao provedor inesperada: ${provider.requests.join(",")}`,
  );
  const names = admin.names();
  assert(
    names.indexOf("hub_bind_provider_operation_integration") <
        names.indexOf("hub_claim_provider_cancellation_target") &&
      names.indexOf("hub_mark_abandoned_checkout_subscription_submitting") <
        names.indexOf("hub_mark_abandoned_checkout_payment_submitting") &&
      names.lastIndexOf("hub_complete_abandoned_checkout_payment") <
        names.indexOf("hub_finalize_abandoned_checkout_cancellation"),
    "cerca, ordem assinatura→cobrança ou finalização fora de ordem",
  );
  const paymentCompletion = admin.calls.find((call) =>
    call.name === "hub_complete_abandoned_checkout_payment"
  );
  assert(
    paymentCompletion?.args.p_outcome === "CONFIRMED",
    "cobrança removida por este DELETE deve ficar CONFIRMED",
  );
});

Deno.test("checkout abandonado: cobrança já paga encerra sem mutação", async () => {
  const admin = abandonedAdmin();
  const provider = scriptedFetch({
    "GET payment": [() => providerPayment({ status: "RECEIVED" })],
  });
  const result = await runHubAbandonedCheckoutCancellation({
    admin: admin.client,
    checkoutId: abandonedCheckoutId,
    fetcher: provider.fetcher,
    resolveIntegration: resolver,
  });
  assert(
    result.outcome === "ABORTED" &&
      result.reason === "PAYMENT_SETTLED_AT_PROVIDER",
    "pagamento confirmado deve abortar a operação",
  );
  assert(
    !provider.requests.some((request) => request.startsWith("DELETE")),
    "nenhum DELETE pode sair para quem já pagou",
  );
  assert(
    !admin.names().includes("hub_claim_provider_cancellation_target") &&
      !admin.names().includes("hub_finalize_abandoned_checkout_cancellation"),
    "operação abortada não reivindica alvo nem finaliza",
  );
});

Deno.test("checkout abandonado: pagamento no meio do cancelamento não apaga a cobrança", async () => {
  const admin = abandonedAdmin();
  const provider = scriptedFetch({
    "GET payment": [
      () => providerPayment(),
      () => providerPayment({ status: "CONFIRMED" }),
    ],
    "GET subscription": [
      activeSubscription,
      () => new Response(null, { status: 404 }),
    ],
    "DELETE subscription": [() => Response.json({ deleted: true })],
  });
  const result = await runHubAbandonedCheckoutCancellation({
    admin: admin.client,
    checkoutId: abandonedCheckoutId,
    fetcher: provider.fetcher,
    resolveIntegration: resolver,
  });
  assert(
    result.outcome === "ABORTED" &&
      result.reason === "PAYMENT_SETTLED_DURING_CANCELLATION",
    "pagamento confirmado depois do DELETE da assinatura deve abortar",
  );
  assert(
    !provider.requests.includes("DELETE payment") &&
      !admin.names().includes("hub_finalize_abandoned_checkout_cancellation"),
    "cobrança paga não pode ser apagada nem o checkout cancelado",
  );
});

Deno.test("checkout abandonado: retentativa depois de DELETE perdido só faz GET", async () => {
  const admin = abandonedAdmin({
    hub_begin_abandoned_checkout_cancellation: abandonedBegin("RESUME"),
    hub_claim_provider_cancellation_target: {
      ok: true,
      action: "RECONCILE_ONLY",
    },
  });
  const provider = scriptedFetch({
    "GET payment": [() => providerPayment()],
    "GET subscription": [activeSubscription],
  });
  let code = "";
  try {
    await runHubAbandonedCheckoutCancellation({
      admin: admin.client,
      checkoutId: abandonedCheckoutId,
      fetcher: provider.fetcher,
      resolveIntegration: resolver,
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_SUBSCRIPTION_RECONCILIATION_REQUIRED",
    "assinatura ativa depois de um DELETE submetido é revisão",
  );
  assert(
    !provider.requests.some((request) => request.startsWith("DELETE")) &&
      !admin.names().includes(
        "hub_mark_abandoned_checkout_subscription_submitting",
      ),
    "o segundo DELETE nunca pode sair",
  );
});

Deno.test("checkout abandonado: falha de rede no DELETE da cobrança não finaliza", async () => {
  const admin = abandonedAdmin();
  const provider = scriptedFetch({
    "GET payment": [() => providerPayment(), () => providerPayment()],
    "GET subscription": [
      activeSubscription,
      () => new Response(null, { status: 404 }),
    ],
    "DELETE subscription": [() => Response.json({ deleted: true })],
    "DELETE payment": [() => {
      throw new TypeError("rede caiu");
    }],
  });
  let code = "";
  try {
    await runHubAbandonedCheckoutCancellation({
      admin: admin.client,
      checkoutId: abandonedCheckoutId,
      fetcher: provider.fetcher,
      resolveIntegration: resolver,
    });
  } catch (error) {
    code = error instanceof HubProviderOperationError ? error.code : "other";
  }
  assert(
    code === "HUB_PROVIDER_CANCELLATION_OUTCOME_UNKNOWN",
    "resultado desconhecido deve ficar para reconciliação",
  );
  assert(
    !admin.names().includes("hub_complete_abandoned_checkout_payment") &&
      !admin.names().includes("hub_finalize_abandoned_checkout_cancellation"),
    "sem prova da remoção, nada é concluído",
  );
});

Deno.test("checkout abandonado: bloqueado no banco não chama o provedor", async () => {
  const admin = abandonedAdmin({
    hub_begin_abandoned_checkout_cancellation: {
      ok: false,
      action: "SKIPPED",
      reason: "PAYMENT_APPLIED",
    },
  });
  let resolved = 0;
  const result = await runHubAbandonedCheckoutCancellation({
    admin: admin.client,
    checkoutId: abandonedCheckoutId,
    fetcher: () => {
      throw new Error("nenhuma chamada ao Asaas era esperada");
    },
    resolveIntegration: () => {
      resolved += 1;
      return Promise.resolve(integration);
    },
  });
  assert(
    result.outcome === "SKIPPED" && result.reason === "PAYMENT_APPLIED" &&
      resolved === 0 && admin.calls.length === 1,
    "checkout não elegível não pode tocar no provedor",
  );
});
