/// <reference lib="deno.ns" />

import {
  hasCurrentHubCoreLegalAcceptance,
  HUB_CORE_PRIVACY_SHA256,
  HUB_CORE_PRIVACY_VERSION,
  HUB_CORE_TERMS_SHA256,
  HUB_CORE_TERMS_VERSION,
  hubCoreLegalSnapshotsMatchExpectedHashes,
} from "./legal.ts";

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};

Deno.test("Hub Core accepts only explicit current legal snapshots", async () => {
  assert(
    await hubCoreLegalSnapshotsMatchExpectedHashes(),
    "canonical legal snapshots must match their committed SHA-256 hashes",
  );
  assert(
    hasCurrentHubCoreLegalAcceptance({
      acceptedTerms: true,
      acceptedPrivacy: true,
      termsVersion: HUB_CORE_TERMS_VERSION,
      privacyVersion: HUB_CORE_PRIVACY_VERSION,
      termsSha256: HUB_CORE_TERMS_SHA256,
      privacySha256: HUB_CORE_PRIVACY_SHA256,
    }),
    "current explicit acceptance should pass",
  );

  for (
    const invalid of [
      { acceptedTerms: false },
      { acceptedTerms: "true" },
      { acceptedPrivacy: false },
      { acceptedPrivacy: 1 },
      { termsVersion: "2026-08-23" },
      { privacyVersion: "2026-08-23" },
      { termsSha256: "0".repeat(64) },
      { privacySha256: "0".repeat(64) },
    ]
  ) {
    assert(
      !hasCurrentHubCoreLegalAcceptance({
        acceptedTerms: true,
        acceptedPrivacy: true,
        termsVersion: HUB_CORE_TERMS_VERSION,
        privacyVersion: HUB_CORE_PRIVACY_VERSION,
        termsSha256: HUB_CORE_TERMS_SHA256,
        privacySha256: HUB_CORE_PRIVACY_SHA256,
        ...invalid,
      }),
      `invalid acceptance passed: ${JSON.stringify(invalid)}`,
    );
  }
});
