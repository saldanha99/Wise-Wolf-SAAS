/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

const FUNCTION_SCOPES: Record<string, string> = {
  "sync-student-asaas": "authorization.tenantId",
  "create-asaas-subscription": "authorization.tenantId",
  "create-enrollment-pix": "authorization.tenantId",
  "generate-student-manual-pix": "tenantId",
  "update-student-billing-method": "authorization.tenantId",
  "sync-plan-change-billing": "tenantId",
  "sync-subscription-status": "tenantId",
  "admin-update-subscription": "owners[0].tenant_id",
  "delete-student-account": "targetTenantId",
  "school-admin": "tenantId",
};

const FUNCTION_PURPOSES: Record<string, string[]> = {
  "sync-student-asaas": ["customer.create", "customer.read"],
  "create-asaas-subscription": [
    "payment.read",
    "payment.create",
    "subscription.create",
  ],
  "create-enrollment-pix": ["payment.read", "payment.create"],
  "generate-student-manual-pix": ["customer.create", "payment.create"],
  "update-student-billing-method": [
    "payment.update",
    "subscription.read",
    "subscription.update",
  ],
  "sync-plan-change-billing": ["subscription.update"],
  "sync-subscription-status": ["subscription.read"],
  "admin-update-subscription": ["subscription.read", "subscription.update"],
  "delete-student-account": ["customer.delete", "subscription.delete"],
  "school-admin": ["payment.delete", "subscription.delete"],
};

const PROVIDER_ORDER: Record<
  string,
  { handler: string; resolver: string; provider: string }
> = {
  "sync-student-asaas": {
    handler: "serve(async",
    resolver: "await resolveAsaasIntegration",
    provider: "const lookup = await findUniqueAsaasEntity",
  },
  "create-asaas-subscription": {
    handler: "serve(async",
    resolver: "await resolveAsaasIntegration",
    provider: "const details = await loadOneTimePaymentDetails",
  },
  "create-enrollment-pix": {
    handler: "serve(async",
    resolver: "await resolveAsaasIntegration",
    provider: "const checked = await verifyEnrollmentPayment",
  },
  "generate-student-manual-pix": {
    handler: "serve(async",
    resolver: "resolveAsaasIntegration(",
    provider: "const linkedCustomer = await providerRequest",
  },
  "update-student-billing-method": {
    handler: "serve(async",
    resolver: "await resolveAsaasIntegration",
    provider: "const currentResult = await guardSubscription",
  },
  "sync-plan-change-billing": {
    handler: "serve(async",
    resolver: "await resolveAsaasIntegration",
    provider: "res = await fetch",
  },
  "sync-subscription-status": {
    handler: "serve(async",
    resolver: "await resolveAsaasIntegration",
    provider: "const guard = await guardAsaasMutationTarget",
  },
  "admin-update-subscription": {
    handler: "serve(async",
    resolver: "await resolveAsaasIntegration",
    provider: "response = await fetch",
  },
  "delete-student-account": {
    handler: "serve(async",
    resolver: "resolveAsaasIntegration(",
    provider: "const response = await fetch",
  },
  "school-admin": {
    handler: "export async function handleRequest",
    resolver: "schoolAsaasIntegration(",
    provider: "await callAsaas",
  },
};

Deno.test({
  name:
    "school Asaas functions require a tenant broker without global fallback",
  permissions: { read: true },
  async fn() {
    const forbidden = [
      `Deno.env.get("ASAAS_${"API_KEY"}")`,
      `Deno.env.get("ASAAS_${"ACCESS_TOKEN"}")`,
      `Deno.env.get("ASAAS_${"API_URL"}")`,
      `https://api${"-sandbox"}.asaas.com`,
      `https://api${"."}asaas.com`,
    ];

    for (
      const [functionName, tenantExpression] of Object.entries(
        FUNCTION_SCOPES,
      )
    ) {
      const source = await Deno.readTextFile(
        new URL(`../${functionName}/index.ts`, import.meta.url),
      );
      assert(
        source.includes("resolveAsaasIntegration"),
        `${functionName} must resolve Asaas through the tenant broker`,
      );
      assert(
        source.includes(tenantExpression),
        `${functionName} must pass its canonical tenant scope`,
      );
      assert(
        /[A-Za-z]*[iI]ntegration\.baseUrl/.test(source) &&
          /[A-Za-z]*[iI]ntegration\.apiKey/.test(source),
        `${functionName} provider transport must require a resolved integration`,
      );
      for (const purpose of FUNCTION_PURPOSES[functionName]) {
        assert(
          source.includes(`"${purpose}"`),
          `${functionName} must declare provider purpose ${purpose}`,
        );
      }
      const order = PROVIDER_ORDER[functionName];
      const handlerSource = source.slice(source.indexOf(order.handler));
      const resolverIndex = handlerSource.indexOf(order.resolver);
      const providerIndex = handlerSource.indexOf(order.provider);
      assert(
        resolverIndex >= 0 && providerIndex > resolverIndex,
        `${functionName} must fail closed before its first provider operation`,
      );
      for (const token of forbidden) {
        assert(
          !source.includes(token),
          `${functionName} must not contain global Asaas fallback ${token}`,
        );
      }
    }
  },
});

Deno.test({
  name: "platform wallet splits never leak into tenant-owned credentials",
  permissions: { read: true },
  async fn() {
    for (
      const functionName of [
        "create-asaas-subscription",
        "create-enrollment-pix",
        "generate-student-manual-pix",
      ]
    ) {
      const source = await Deno.readTextFile(
        new URL(`../${functionName}/index.ts`, import.meta.url),
      );
      const hasRootOnlySplit = source.includes(
        "canonicalEnrollmentSplitPolicy(",
      ) && /[A-Za-z]*[iI]ntegration\.mode,/.test(source) &&
        source.includes("asaas_wallet_id");
      assert(
        hasRootOnlySplit,
        `${functionName} must apply legacy wallet split only on the platform root account`,
      );
    }
  },
});

Deno.test({
  name: "provider creations are durably claimed before every Asaas POST",
  permissions: { read: true },
  async fn() {
    for (
      const functionName of [
        "sync-student-asaas",
        "create-asaas-subscription",
        "create-enrollment-pix",
      ]
    ) {
      const source = await Deno.readTextFile(
        new URL(`../${functionName}/index.ts`, import.meta.url),
      );
      assert(
        source.includes("claimAsaasCreation") &&
          source.includes("findUniqueAsaasEntity") &&
          (source.includes("markAsaasCreationSubmitting") ||
            source.includes("markStudentAsaasCreationSubmitting")) &&
          source.includes("recordAsaasCreationState"),
        `${functionName} must use the persistent single-submit state machine`,
      );
      assert(
        !source.includes('"RECEIVED", "CONFIRMED"') &&
          !source.includes('"CONFIRMED", "RECEIVED"'),
        `${functionName} must not activate enrollment on CONFIRMED`,
      );
    }

    const subscriptionSource = await Deno.readTextFile(
      new URL("../create-asaas-subscription/index.ts", import.meta.url),
    );
    assert(
      subscriptionSource.includes('status_financial: "PENDING"') &&
        subscriptionSource.includes('"AWAITING_PAYMENT"') &&
        subscriptionSource.includes("PAYMENT_RECEIVED will complete"),
      "creating a subscription must wait for a settled provider payment",
    );
  },
});

Deno.test({
  name: "global school billing automations isolate work by tenant",
  permissions: { read: true },
  async fn() {
    const planSource = await Deno.readTextFile(
      new URL("../sync-plan-change-billing/index.ts", import.meta.url),
    );
    assert(
      planSource.includes("scopeAutomationRows") &&
        planSource.includes("const groups = new Map") &&
        planSource.includes("for (const [tenantId, tenantRows] of groups)"),
      "plan-change sync must scope manual runs and group cron rows by tenant",
    );
    assert(
      planSource.includes('tenantId,\n        "subscription.update"'),
      "each plan-change tenant group must resolve its own subscription writer",
    );

    const statusSource = await Deno.readTextFile(
      new URL("../sync-subscription-status/index.ts", import.meta.url),
    );
    assert(
      statusSource.includes(
        'select("id, tenant_id, asaas_customer_id, subscription_id")',
      ) &&
        statusSource.includes("const groups = new Map") &&
        statusSource.includes(
          "for (const [tenantId, tenantStudents] of groups)",
        ),
      "subscription status sync must group provider reads by tenant",
    );
    assert(
      statusSource.includes("fetchAllSubscriptionProfiles") &&
        statusSource.includes('.order("id", { ascending: true })') &&
        statusSource.includes(".limit(1_000)") &&
        statusSource.includes('.gt("id", afterId)') &&
        !statusSource.includes(".limit(500)"),
      "subscription status sync must page through every eligible profile",
    );
    assert(
      statusSource.includes('tenantId,\n          "subscription.read"') &&
        statusSource.includes("all_subscriptions_404"),
      "each tenant must resolve independently and keep the all-404 write barrier",
    );

    const manualPixSource = await Deno.readTextFile(
      new URL("../generate-student-manual-pix/index.ts", import.meta.url),
    );
    const evolutionResolver = manualPixSource.indexOf(
      "await resolveEvolutionIntegration",
    );
    const evolutionSend = manualPixSource.indexOf(
      "const delivery = await sendWhatsapp",
    );
    assert(
      evolutionResolver >= 0 &&
        evolutionSend > evolutionResolver &&
        manualPixSource.includes('"message.send_text"') &&
        !manualPixSource.includes('Deno.env.get("EVOLUTION_API_URL")') &&
        !manualPixSource.includes('Deno.env.get("EVOLUTION_API_KEY")'),
      "manual Pix messaging must resolve Evolution per tenant before sending",
    );
  },
});
