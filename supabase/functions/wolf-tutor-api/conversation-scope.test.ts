/// <reference lib="deno.ns" />

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test({
  name: "Hub Wolfie binds persistence to the server-resolved account",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );

    assert(
      source.includes('productFamily: "SCHOOL"') &&
        source.includes('productFamily: "HUB_CORE"'),
      "school and Hub conversations must use explicit product families",
    );
    assert(
      source.includes(
        'const resolvedHubAccountId = typeof usage.accountId === "string"',
      ) && source.includes("hubAccountId: resolvedHubAccountId"),
      "Hub persistence scope must come from the account returned by the reservation",
    );
    assert(
      source.indexOf("hubReservation = {") <
        source.indexOf("const resolvedHubAccountId"),
      "an invalid reserved account response must still release its reservation",
    );
    assert(
      source.includes(
        '.select("id, student_id, product_family, hub_account_id")',
      ),
      "conversation lookup must load its immutable product and account scope",
    );
    assert(
      (source.match(/!conversationMatchesScope\(/g) ?? []).length >= 2,
      "existing and concurrently-created conversations must both fail closed on scope mismatch",
    );
    assert(
      source.includes("product_family: conversationScope.productFamily") &&
        source.includes("hub_account_id: conversationScope.hubAccountId"),
      "new conversations must persist the validated scope",
    );
  },
});

Deno.test({
  name: "Hub Wolfie loads only the reserved member profile",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );

    const reservationIndex = source.indexOf("const resolvedHubAccountId");
    const profileLookupIndex = source.indexOf('.from("hub_member_profiles")');
    const providerIndex = source.indexOf("new OpenAI({");

    assert(
      reservationIndex >= 0 &&
        profileLookupIndex > reservationIndex &&
        providerIndex > profileLookupIndex,
      "the member profile must be loaded after account resolution and before the provider",
    );
    assert(
      source.includes("const supabaseClient = auth.context.admin;") &&
        source.includes('.eq("account_id", resolvedHubAccountId)') &&
        source.includes('.eq("user_id", userId)'),
      "the privileged profile lookup must bind both the resolved account and authenticated user",
    );
    assert(
      source.includes(
        '"display_name, level, role, goal, interests, preferred_modality"',
      ),
      "only the member personalization fields should be loaded",
    );
    assert(
      source.includes('error: "HUB_PROFILE_UNAVAILABLE"') &&
        source.includes(
          "studentLevel = allowedLevels.includes(trustedHubLevel)",
        ) && source.includes(': "B1";'),
      "profile read failures must fail closed and missing or invalid levels must use B1",
    );
    assert(
      !source.includes('.from("hub_accounts")') &&
        !source.includes("trustedHubPreferences") &&
        !source.includes("learnerProfile: clientLearnerProfile") &&
        !source.includes(
          "trustedHubLearnerProfile.role ?? clientLearnerProfile.role",
        ),
      "Hub context must not fall back to account metadata or browser learner data",
    );
    assert(
      source.includes("const learnerContext = hubMode") &&
        source.includes(
          "displayName: boundedText(trustedHubLearnerProfile.display_name",
        ),
      "Hub learner context must come from the account-scoped member profile",
    );
  },
});

Deno.test({
  name: "Wolfie private responses disable shared caching",
  permissions: { read: true },
  async fn() {
    const source = await Deno.readTextFile(
      new URL("./index.ts", import.meta.url),
    );

    assert(
      source.includes('"Cache-Control": "private, no-store, max-age=0"'),
      "private responses must not be cached",
    );
    assert(
      source.includes('"Vary": "Authorization, Origin"'),
      "private responses must vary by authorization and origin",
    );
    assert(
      source.includes("corsHeaders: privateResponseHeaders"),
      "authorization failures must receive the same private cache headers",
    );
    assert(
      !source.includes(
        '{ ...corsHeaders, "Content-Type": "application/json" }',
      ),
      "JSON responses must not bypass the private response headers",
    );
  },
});
