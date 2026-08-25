/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name: "Hub Core checkout records versioned legal acceptance before billing",
  permissions: { read: true },
  async fn() {
    const checkoutSource = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );
    const validationIndex = checkoutSource.indexOf(
      "hasCurrentHubCoreLegalAcceptance({",
    );
    const acceptanceIndex = checkoutSource.indexOf(
      '.from("hub_core_legal_acceptances")',
    );
    const catalogGuardIndex = checkoutSource.indexOf(
      '.rpc("hub_catalog_checkout_is_ready")',
    );
    const catalogBlockIndex = checkoutSource.indexOf(
      'error: "HUB_CATALOG_NOT_READY"',
    );
    const catalogReturnIndex = checkoutSource.lastIndexOf(
      "return json(503",
      catalogBlockIndex,
    );
    const handlerIndex = checkoutSource.indexOf("serve(async (req) => {");
    const firstProviderCallIndex = checkoutSource.indexOf(
      "await asaasRequest(",
      handlerIndex,
    );
    const providerBillingIndex = checkoutSource.indexOf(
      'asaasRequest("/subscriptions"',
    );

    assert(validationIndex >= 0, "Hub Core legal input must be validated");
    assert(
      catalogGuardIndex > validationIndex,
      "Hub Core catalog must be checked",
    );
    assert(
      catalogReturnIndex > catalogGuardIndex &&
        catalogBlockIndex > catalogReturnIndex &&
        firstProviderCallIndex > catalogBlockIndex,
      "an unready Hub catalog must return before any provider call",
    );
    assert(
      acceptanceIndex > validationIndex,
      "acceptance must follow validation",
    );
    assert(
      providerBillingIndex > acceptanceIndex,
      "acceptance must be durable before provider billing",
    );
    assert(
      checkoutSource.includes("acceptedTerms = body.acceptedTerms === true") &&
        checkoutSource.includes(
          "acceptedPrivacy = body.acceptedPrivacy === true",
        ),
      "booleans must require explicit true values",
    );
    assert(
      checkoutSource.includes("terms_version: termsVersion") &&
        checkoutSource.includes("privacy_version: privacyVersion") &&
        checkoutSource.includes("legal_acceptance_id: hubLegalAcceptanceId"),
      "checkout metadata must bind both legal versions and the acceptance row",
    );
    assert(
      !checkoutSource.includes("marketingConsent"),
      "checkout legal acceptance must not imply marketing consent",
    );
  },
});
