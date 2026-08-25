import {
  HUB_CORE_PRIVACY_SHA256,
  HUB_CORE_PRIVACY_VERSION,
  HUB_CORE_TERMS_SHA256,
  HUB_CORE_TERMS_VERSION,
} from "./legal-documents.ts";

export {
  HUB_CORE_PRIVACY_SHA256,
  HUB_CORE_PRIVACY_SNAPSHOT,
  HUB_CORE_PRIVACY_VERSION,
  HUB_CORE_TERMS_SHA256,
  HUB_CORE_TERMS_SNAPSHOT,
  HUB_CORE_TERMS_VERSION,
  hubCoreLegalSnapshotsMatchExpectedHashes,
} from "./legal-documents.ts";

type HubCoreLegalAcceptanceInput = {
  acceptedTerms: unknown;
  acceptedPrivacy: unknown;
  termsVersion: string;
  privacyVersion: string;
  termsSha256: string;
  privacySha256: string;
};

export const hasCurrentHubCoreLegalDocumentHashes = (
  input: Pick<
    HubCoreLegalAcceptanceInput,
    "termsSha256" | "privacySha256"
  >,
) =>
  input.termsSha256 === HUB_CORE_TERMS_SHA256 &&
  input.privacySha256 === HUB_CORE_PRIVACY_SHA256;

export const hasCurrentHubCoreLegalAcceptance = (
  input: HubCoreLegalAcceptanceInput,
) =>
  input.acceptedTerms === true &&
  input.acceptedPrivacy === true &&
  input.termsVersion === HUB_CORE_TERMS_VERSION &&
  input.privacyVersion === HUB_CORE_PRIVACY_VERSION &&
  hasCurrentHubCoreLegalDocumentHashes(input);
