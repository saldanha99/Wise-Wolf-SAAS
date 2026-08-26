import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "./asaas-capability-fence.ts";
import type {
  AsaasIntegrationPurpose,
  ResolvedAsaasIntegration,
  TenantIntegrationRpcClient,
} from "./tenant-integration-broker.ts";

const expected: ResolvedAsaasIntegration = {
  integrationId: "00000000-0000-4000-8000-000000000001",
  tenantId: "school-wise-wolf",
  provider: "asaas",
  mode: "PLATFORM_MANAGED_ROOT",
  version: 7,
  environment: "platform",
  baseUrl: "https://api.asaas.com/v3",
  apiKey: "credential-version-seven",
};

const admin = {} as TenantIntegrationRpcClient;

async function expectFailure(
  mutation: Partial<ResolvedAsaasIntegration>,
  failure: "UNAVAILABLE" | "CHANGED" = "CHANGED",
): Promise<void> {
  let submitted = false;
  try {
    const fresh = await revalidateAsaasMutationCapability(
      admin,
      {
        tenantId: expected.tenantId,
        purpose: "payment.create",
        expected,
      },
      {
        resolve: async () => ({ ...expected, ...mutation }),
      },
    );
    submitted = true;
    void fresh;
  } catch (error) {
    if (
      !(error instanceof AsaasCapabilityFenceError) ||
      error.failure !== failure
    ) {
      throw error;
    }
  }
  if (submitted) throw new Error("capability drift reached provider submit");
}

Deno.test("stable exact capability returns the freshly resolved credential", async () => {
  const fresh = { ...expected };
  let purpose: AsaasIntegrationPurpose | null = null;
  const resolved = await revalidateAsaasMutationCapability(
    admin,
    {
      tenantId: expected.tenantId,
      purpose: "customer.create",
      expected,
    },
    {
      resolve: async (_admin, _tenantId, requestedPurpose) => {
        purpose = requestedPurpose;
        return fresh;
      },
    },
  );
  if (purpose !== "customer.create" || resolved !== fresh) {
    throw new Error("exact mutation capability was not freshly resolved");
  }
});

Deno.test("integration rotation between claim and submit fails closed", async () => {
  await expectFailure({
    integrationId: "00000000-0000-4000-8000-000000000002",
    version: 8,
    apiKey: "credential-version-eight",
  });
});

Deno.test("credential-only rotation between claim and submit fails closed", async () => {
  await expectFailure({ apiKey: "rotated-without-database-version" });
});

Deno.test("disabled capability between claim and submit fails closed", async () => {
  let submitted = false;
  try {
    await revalidateAsaasMutationCapability(
      admin,
      {
        tenantId: expected.tenantId,
        purpose: "transfer.submit",
        expected,
      },
      {
        resolve: async () => {
          throw new Error("integration_disabled");
        },
      },
    );
    submitted = true;
  } catch (error) {
    if (
      !(error instanceof AsaasCapabilityFenceError) ||
      error.failure !== "UNAVAILABLE"
    ) throw error;
  }
  if (submitted) throw new Error("disabled capability reached provider submit");
});

Deno.test("canonical capability identity fields cannot drift", async () => {
  await expectFailure({ tenantId: "other-tenant" });
  await expectFailure({ baseUrl: "https://api-sandbox.asaas.com/v3" });
  await expectFailure({ environment: "sandbox" });
  await expectFailure({ mode: "TENANT_BYOK" });
});

Deno.test({
  name: "every scoped Asaas one-way route uses a freshly fenced capability",
  permissions: { read: true },
  async fn() {
    const read = (path: string) =>
      Deno.readTextFile(new URL(path, import.meta.url));
    const [
      sync,
      enrollment,
      manual,
      subscription,
      transfer,
      adminUpdate,
      planChange,
      billingMethod,
      schoolAdmin,
      deleteStudent,
      wolfieTopup,
      saasCheckout,
      hubOperations,
      hubCheckout,
    ] = await Promise.all([
      read("../sync-student-asaas/index.ts"),
      read("../create-enrollment-pix/index.ts"),
      read("../generate-student-manual-pix/index.ts"),
      read("../create-asaas-subscription/index.ts"),
      read("../transfer-teacher-pay/index.ts"),
      read("../admin-update-subscription/index.ts"),
      read("../sync-plan-change-billing/index.ts"),
      read("../update-student-billing-method/index.ts"),
      read("../school-admin/index.ts"),
      read("../delete-student-account/index.ts"),
      read("../create-wolfie-topup/index.ts"),
      read("../create-saas-checkout/index.ts"),
      read("./hub-provider-operations.ts"),
      read("../create-hub-checkout/index.ts"),
    ]);

    const revalidationCount = (source: string) =>
      source.match(/await revalidateAsaasMutationCapability\(/g)?.length ?? 0;
    if (
      revalidationCount(sync) !== 1 ||
      revalidationCount(enrollment) !== 1 ||
      revalidationCount(manual) !== 2 ||
      revalidationCount(subscription) !== 3 ||
      revalidationCount(transfer) !== 1 ||
      revalidationCount(adminUpdate) !== 1 ||
      revalidationCount(planChange) !== 1 ||
      revalidationCount(billingMethod) !== 1 ||
      revalidationCount(schoolAdmin) !== 1 ||
      revalidationCount(deleteStudent) !== 2 ||
      revalidationCount(wolfieTopup) !== 1 ||
      revalidationCount(saasCheckout) !== 2 ||
      revalidationCount(hubCheckout) !== 1
    ) {
      throw new Error(
        "an Asaas mutation is missing its final capability fence",
      );
    }

    const requiredTransportTokens = [
      [sync, "`${submitIntegration.baseUrl}/customers`"],
      [enrollment, "`${submitIntegration.baseUrl}/payments`"],
      [manual, 'submitCustomerIntegration,\n              "/customers"'],
      [manual, 'submitPaymentIntegration,\n              "/payments"'],
      [subscription, "`${submitIntegration.baseUrl}/payments`"],
      [subscription, "`${submitIntegration.baseUrl}/subscriptions`"],
      [subscription, "`${submitProRataIntegration.baseUrl}/payments`"],
      [transfer, "`${submitIntegration.baseUrl}/transfers`"],
      [adminUpdate, "`${submitIntegration.baseUrl}/subscriptions/"],
      [planChange, "`${submitIntegration.baseUrl}/subscriptions/"],
      [billingMethod, "`${requestIntegration.baseUrl}${path}`"],
      [schoolAdmin, "`${integration.baseUrl}${path}`"],
      [
        deleteStudent,
        "`${submitSubscriptionIntegration.baseUrl}/subscriptions/",
      ],
      [deleteStudent, "`${submitCustomerIntegration.baseUrl}/customers/"],
      [wolfieTopup, "`${freshSubmitIntegration.baseUrl}/payments`"],
      [
        saasCheckout,
        "`${freshCustomerCreateIntegration.baseUrl}/customers`",
      ],
      [
        saasCheckout,
        "`${freshSubscriptionCreateIntegration.baseUrl}/subscriptions`",
      ],
      [hubCheckout, "`${customerCreateIntegration.baseUrl}/customers`"],
      [
        hubCheckout,
        "`${subscriptionCreateIntegration.baseUrl}/subscriptions`",
      ],
    ] as const;
    for (const [source, token] of requiredTransportTokens) {
      if (!source.includes(token)) {
        throw new Error(
          `provider mutation did not use fresh capability: ${token}`,
        );
      }
    }

    for (
      const source of [
        sync,
        enrollment,
        manual,
        subscription,
        wolfieTopup,
        saasCheckout,
        hubCheckout,
      ]
    ) {
      if (source.includes('status: unavailable ? "RETRY" : "BLOCKED"')) {
        throw new Error(
          "a post-mark capability failure cannot return to RETRY",
        );
      }
    }

    for (
      const purpose of [
        "customer.create",
        "payment.create",
        "subscription.create",
        "subscription.update",
        "subscription.delete",
        "customer.delete",
        "payment.update",
        "payment.delete",
        "transfer.submit",
      ]
    ) {
      if (
        ![
          sync,
          enrollment,
          manual,
          subscription,
          transfer,
          adminUpdate,
          planChange,
          billingMethod,
          schoolAdmin,
          deleteStudent,
          wolfieTopup,
          saasCheckout,
          hubCheckout,
        ].some((source) => source.includes(`"${purpose}"`))
      ) {
        throw new Error(`missing exact mutation purpose ${purpose}`);
      }
    }

    if (
      !billingMethod.includes('if (normalizedMethod !== "GET")') ||
      !billingMethod.includes('"subscription.update"') ||
      !billingMethod.includes('"payment.update"')
    ) {
      throw new Error("billing mutations do not fence their exact purpose");
    }

    const hubResolveCount = hubOperations.match(
      /freshDeleteIntegration = await revalidateHubDeleteCapability\(/g,
    )?.length ?? 0;
    if (
      hubResolveCount !== 2 ||
      !hubOperations.includes(
        "`${freshDeleteIntegration.baseUrl}/subscriptions/",
      )
    ) {
      throw new Error("Hub cancellation DELETE is missing its final fence");
    }

    const firstHubMark = hubCheckout.indexOf(
      "await markHubProviderCreationSubmitting(",
    );
    const secondHubMark = hubCheckout.indexOf(
      "await markHubProviderCreationSubmitting(",
      firstHubMark + 1,
    );
    const hubCustomerCapability = hubCheckout.indexOf(
      'await providerMutationIntegration(\n              "customer.create"',
      firstHubMark,
    );
    const hubCustomerPost = hubCheckout.indexOf(
      "customerResponse = await fetch(",
      hubCustomerCapability,
    );
    const hubSubscriptionCapability = hubCheckout.indexOf(
      'await providerMutationIntegration(\n            "subscription.create"',
      secondHubMark,
    );
    const hubSubscriptionPost = hubCheckout.indexOf(
      "subscriptionResponse = await fetch(",
      hubSubscriptionCapability,
    );
    if (
      firstHubMark < 0 || secondHubMark < 0 ||
      hubCustomerCapability <= firstHubMark ||
      hubCustomerPost <= hubCustomerCapability ||
      hubSubscriptionCapability <= secondHubMark ||
      hubSubscriptionPost <= hubSubscriptionCapability
    ) {
      throw new Error(
        "Hub checkout does not resolve the exact create capability after its submit mark",
      );
    }
  },
});
