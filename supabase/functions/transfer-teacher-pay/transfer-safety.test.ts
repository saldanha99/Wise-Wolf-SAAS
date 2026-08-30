import {
  findTransferForAttempt,
  normalizePixKey,
  providerTransferOutcome,
  redactTransferResponse,
  resolveTransferForAttempt,
  transferDestinationFingerprint,
  transferLookupIdentity,
  transferSubmissionFromClaim,
  transferSubmissionIsEnabled,
} from "./transfer-safety.ts";

Deno.test(
  "ambiguous transfer is found by exact external reference before retry",
  () => {
    const found = findTransferForAttempt(
      [
        { id: "tr_1", externalReference: "other", status: "DONE" },
        {
          id: "tr_2",
          externalReference: "wisewolf-teacher-closing:abc",
          status: "PENDING",
        },
      ],
      "wisewolf-teacher-closing:abc",
    );
    if (found?.id !== "tr_2") throw new Error("transfer was not reconciled");
  },
);

Deno.test(
  "unknown provider state remains UNKNOWN and cannot be treated as retryable",
  () => {
    if (providerTransferOutcome("SOMETHING_NEW") !== "UNKNOWN") {
      throw new Error("unknown provider state was guessed");
    }
    if (providerTransferOutcome("DONE") !== "COMPLETED") {
      throw new Error("DONE was not completed");
    }
  },
);

Deno.test("duplicate external references remain ambiguous", () => {
  const found = findTransferForAttempt(
    [
      {
        id: "tr_1",
        externalReference: "wisewolf-teacher-closing:abc",
      },
      {
        id: "tr_2",
        externalReference: "wisewolf-teacher-closing:abc",
      },
    ],
    "wisewolf-teacher-closing:abc",
  );
  if (found !== null) throw new Error("ambiguous transfer was guessed");
});

Deno.test(
  "persisted provider id disables externalReference fallback",
  () => {
    const lookup = transferLookupIdentity(
      "wisewolf-teacher-closing:abc",
      "tr_known",
    );
    if (
      lookup.kind !== "PROVIDER_ID" ||
      lookup.providerTransferId !== "tr_known"
    ) {
      throw new Error("known provider id did not become the sole lookup key");
    }

    const found = findTransferForAttempt(
      [
        {
          id: "tr_different",
          externalReference: "wisewolf-teacher-closing:abc",
        },
      ],
      "wisewolf-teacher-closing:abc",
      "tr_known",
    );
    if (found !== null) {
      throw new Error("externalReference replaced a persisted provider id");
    }
  },
);

Deno.test("persisted provider id accepts only the exact provider entity", () => {
  const found = findTransferForAttempt(
    [
      {
        id: "tr_known",
        externalReference: "provider-rewrote-reference",
        status: "DONE",
      },
      {
        id: "tr_different",
        externalReference: "wisewolf-teacher-closing:abc",
        status: "DONE",
      },
    ],
    "wisewolf-teacher-closing:abc",
    "tr_known",
  );
  if (found?.id !== "tr_known") {
    throw new Error("exact provider id was not authoritative");
  }
});

Deno.test("provider id never bypasses reference and amount identity", async () => {
  const resolution = await resolveTransferForAttempt(
    [{
      id: "tr_known",
      externalReference: "provider-rewrote-reference",
      value: 250.75,
    }],
    "wisewolf-teacher-closing:abc",
    250.75,
    "a".repeat(64),
    "tr_known",
  );
  if (
    resolution.kind !== "CONFLICT" ||
    resolution.reason !== "external_reference_mismatch"
  ) {
    throw new Error("provider id bypassed the durable reference");
  }
});

Deno.test("reference recovery requires exact cents and PIX destination", async () => {
  const expectedDestination = await transferDestinationFingerprint(
    "CPF",
    "12345678901",
  );
  const exact = await resolveTransferForAttempt(
    [{
      id: "tr_exact",
      externalReference: "wisewolf-teacher-closing:abc",
      value: 250.75,
      operationType: "PIX",
      pixAddressKeyType: "CPF",
      pixAddressKey: "123.456.789-01",
    }],
    "wisewolf-teacher-closing:abc",
    250.75,
    expectedDestination,
  );
  if (exact.kind !== "EXACT" || exact.transfer.id !== "tr_exact") {
    throw new Error("exact transfer was not recovered");
  }

  const wrongAmount = await resolveTransferForAttempt(
    [{
      id: "tr_wrong",
      externalReference: "wisewolf-teacher-closing:abc",
      value: 250.74,
    }],
    "wisewolf-teacher-closing:abc",
    250.75,
    expectedDestination,
  );
  if (
    wrongAmount.kind !== "CONFLICT" ||
    wrongAmount.reason !== "amount_mismatch"
  ) {
    throw new Error("different transfer amount was adopted");
  }

  const duplicate = await resolveTransferForAttempt(
    [
      {
        id: "tr_1",
        externalReference: "wisewolf-teacher-closing:abc",
        value: 250.75,
      },
      {
        id: "tr_2",
        externalReference: "wisewolf-teacher-closing:abc",
        value: 250.75,
      },
    ],
    "wisewolf-teacher-closing:abc",
    250.75,
    expectedDestination,
  );
  if (
    duplicate.kind !== "CONFLICT" ||
    duplicate.reason !== "duplicate_external_reference"
  ) {
    throw new Error("duplicate provider reference was guessed");
  }
});

Deno.test("provider transfer without recipient proof is blocked", async () => {
  const expectedDestination = await transferDestinationFingerprint(
    "EMAIL",
    "teacher@example.invalid",
  );
  const resolution = await resolveTransferForAttempt(
    [{
      id: "tr_missing_destination",
      externalReference: "wisewolf-teacher-closing:abc",
      value: 250.75,
      status: "DONE",
    }],
    "wisewolf-teacher-closing:abc",
    250.75,
    expectedDestination,
  );
  if (
    resolution.kind !== "CONFLICT" ||
    resolution.reason !== "destination_missing"
  ) {
    throw new Error("transfer without provider recipient proof was adopted");
  }
});

Deno.test("provider transfer with a different PIX recipient is blocked", async () => {
  const expectedDestination = await transferDestinationFingerprint(
    "EMAIL",
    "teacher@example.invalid",
  );
  for (
    const divergent of [
      {
        operationType: "PIX",
        pixAddressKeyType: "EMAIL",
        pixAddressKey: "other@example.invalid",
      },
      {
        operationType: "PIX",
        pixAddressKeyType: "PHONE",
        pixAddressKey: "5511999999999",
      },
      {
        operationType: "TED",
        pixAddressKeyType: "EMAIL",
        pixAddressKey: "teacher@example.invalid",
      },
      {
        operationType: "PIX",
        bankAccount: { account: "not-safe-to-persist" },
      },
    ]
  ) {
    const resolution = await resolveTransferForAttempt(
      [{
        id: "tr_wrong_destination",
        externalReference: "wisewolf-teacher-closing:abc",
        value: 250.75,
        status: "DONE",
        ...divergent,
      }],
      "wisewolf-teacher-closing:abc",
      250.75,
      expectedDestination,
    );
    if (
      resolution.kind !== "CONFLICT" ||
      resolution.reason !== "destination_mismatch"
    ) {
      throw new Error("different provider recipient was adopted");
    }
  }
});

Deno.test("provider response redaction never persists recipient data", () => {
  const redacted = redactTransferResponse({
    id: "tr_private",
    status: "DONE",
    externalReference: "wisewolf-teacher-closing:abc",
    value: 250.75,
    operationType: "PIX",
    pixAddressKeyType: "EMAIL",
    pixAddressKey: "teacher@example.invalid",
    bankAccount: { account: "sensitive-bank-account" },
  });
  const persisted = JSON.stringify(redacted);
  if (
    persisted.includes("teacher@example.invalid") ||
    persisted.includes("sensitive-bank-account") ||
    "pixAddressKey" in redacted ||
    "bankAccount" in redacted
  ) {
    throw new Error("provider recipient PII escaped redaction");
  }
});

Deno.test("real PIX submission remains fail-closed until homologated", () => {
  const base = {
    enabled: true,
    homologated: true,
    productionApproved: false,
    baseUrl: "https://api.asaas.com/v3",
    apiKey: "configured-secret",
  };
  if (transferSubmissionIsEnabled(base)) {
    throw new Error("production transfer bypassed explicit approval");
  }
  if (
    !transferSubmissionIsEnabled({ ...base, productionApproved: true })
  ) {
    throw new Error("fully approved production transfer stayed blocked");
  }
  if (
    transferSubmissionIsEnabled({
      ...base,
      baseUrl: "https://api-sandbox.asaas.com/v3",
      homologated: false,
    })
  ) {
    throw new Error("non-homologated sandbox transfer was enabled");
  }
});

Deno.test(
  "Pix key sanitization does not alter email and strips CPF punctuation",
  () => {
    if (normalizePixKey("123.456.789-00", "CPF") !== "12345678900") {
      throw new Error("CPF was not sanitized");
    }
    if (
      normalizePixKey(" person@example.com ", "EMAIL") !== "person@example.com"
    ) {
      throw new Error("email Pix key was corrupted");
    }
  },
);

Deno.test("submission payload is built only from the durable claim snapshot", () => {
  const claim: Record<string, unknown> = {
    action: "SUBMIT_ONCE",
    attempt_id: "00000000-0000-4000-8000-000000000001",
    tenant_id: "school-wise-wolf",
    external_reference:
      "wisewolf-teacher-closing:00000000-0000-4000-8000-000000000002",
    expected_amount: 250.75,
    destination_pix_key: "12345678901",
    destination_pix_key_type: "CPF",
    destination_fingerprint: "a".repeat(64),
    transfer_description: "Pagamento Professor - Docente - Ref: 2026-08",
  };
  const snapshot = transferSubmissionFromClaim(claim);

  // A mutable closing/profile read after the claim must have no influence on
  // the already-built provider request.
  claim.expected_amount = 9_999;
  claim.destination_pix_key = "11111111111";
  if (
    snapshot.payload.value !== 250.75 ||
    snapshot.payload.pixAddressKey !== "12345678901" ||
    snapshot.payload.description !==
      "Pagamento Professor - Docente - Ref: 2026-08"
  ) {
    throw new Error("provider payload did not preserve the claim snapshot");
  }
});

Deno.test("invalid durable destination snapshot is rejected before POST", () => {
  let rejected = false;
  try {
    transferSubmissionFromClaim({
      action: "SUBMIT_ONCE",
      attempt_id: "attempt",
      tenant_id: "school-wise-wolf",
      external_reference: "wisewolf-teacher-closing:closing",
      expected_amount: 100,
      destination_pix_key: "not-a-cpf",
      destination_pix_key_type: "CPF",
      destination_fingerprint: "b".repeat(64),
      transfer_description: "Pagamento Professor",
    });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("invalid claim destination reached POST");
});

Deno.test("destination fingerprint binds Pix type and value", async () => {
  const original = await transferDestinationFingerprint("CPF", "12345678901");
  const changedKey = await transferDestinationFingerprint(
    "CPF",
    "12345678902",
  );
  const changedType = await transferDestinationFingerprint(
    "PHONE",
    "12345678901",
  );
  if (!/^[a-f0-9]{64}$/.test(original)) {
    throw new Error("destination fingerprint is not SHA-256 hex");
  }
  if (original === changedKey || original === changedType) {
    throw new Error("destination snapshot mutation preserved fingerprint");
  }
});
