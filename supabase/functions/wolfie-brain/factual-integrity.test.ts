/// <reference lib="deno.ns" />

import {
  correctionLocksRetry,
  correctionPreservesFactualIntegrity,
  extractLearnerFacts,
  factsConflict,
  selectCanonicalRetryIndex,
  selectRelevantMemoryItems,
  transcriptionNeedsFactConfirmation,
} from "./factual-integrity.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("extracts accented learner locations without merging distinct slots", () => {
  const facts = extractLearnerFacts(
    "Eu moro em Nova Iguaçu, sou da Bahia e nasci em Salvador.",
  );
  assertEquals(
    facts.map((fact) => [
      fact.factType,
      fact.value,
      fact.normalizedValue,
    ]),
    [
      ["resides_in", "Nova Iguaçu", "nova iguacu"],
      ["is_from", "Bahia", "bahia"],
      ["born_in", "Salvador", "salvador"],
    ],
  );
});

Deno.test("a current residence assertion conflicts only with the same slot", () => {
  const [novaIguacu] = extractLearnerFacts("I live in Nova Iguaçu.");
  const [bahia] = extractLearnerFacts("I live in Bahia.");
  const [origin] = extractLearnerFacts("I am from Bahia.");

  assert(factsConflict(novaIguacu, bahia), "residence values must conflict");
  assert(
    !factsConflict(novaIguacu, origin),
    "residence and origin can both be true",
  );
});

Deno.test("corrections preserve learner names, places, numbers and negation", () => {
  const safe = correctionPreservesFactualIntegrity(
    "Yesterday I live in Nova Iguaçu.",
    "I live in Nova Iguaçu",
    "I lived in Nova Iguaçu",
  );
  assert(safe.safe, `expected safe correction, got ${safe.reasons.join(",")}`);

  const changedPlace = correctionPreservesFactualIntegrity(
    "I live in Nova Iguaçu.",
    "I live in Nova Iguaçu",
    "I live in Bahia",
  );
  assert(!changedPlace.safe, "a correction must never rewrite the place");
  assert(
    changedPlace.reasons.some((reason) => reason.startsWith("entity_changed")),
    "the changed entity must be auditable",
  );

  const changedNegation = correctionPreservesFactualIntegrity(
    "I do not live in Bahia.",
    "I do not live in Bahia",
    "I live in Bahia",
  );
  assert(!changedNegation.safe, "a correction must never remove negation");
});

Deno.test("speech-derived personal facts always require explicit confirmation", () => {
  assert(
    transcriptionNeedsFactConfirmation(
      "I live in Nova Iguaçu.",
      0.99,
      [],
    ),
    "high ASR confidence is not factual confirmation",
  );
  assert(
    transcriptionNeedsFactConfirmation(
      "My name is Vinicius.",
      0.51,
      ["My name is Vinícius."],
    ),
    "uncertain protected entities must be reviewed",
  );
  assert(
    !transcriptionNeedsFactConfirmation("I like this exercise.", 0.95, []),
    "ordinary high-confidence speech should continue",
  );
});

Deno.test("only an active incomplete correction can lock retry", () => {
  assert(correctionLocksRetry("active", true, false));
  assert(!correctionLocksRetry("disputed", true, false));
  assert(!correctionLocksRetry("active", true, true));
  assert(!correctionLocksRetry("active", false, false));
});

Deno.test("only one canonical high-priority correction opens a retry", () => {
  const corrections = [
    { priority: "medium" },
    { priority: "high" },
    { priority: "high" },
  ];
  assertEquals(
    selectCanonicalRetryIndex(corrections, true, "immediate"),
    1,
    "the first high-priority correction must win over medium",
  );
  assertEquals(
    selectCanonicalRetryIndex(corrections, false, "immediate"),
    -1,
    "an existing pending retry must block a new retry",
  );
  assertEquals(
    selectCanonicalRetryIndex(corrections, true, "end"),
    -1,
    "end-of-session feedback must not create an immediate retry",
  );
});

Deno.test("memory retrieval excludes dismissed and unconsented sensitive items", () => {
  const selected = selectRelevantMemoryItems(
    [
      {
        kind: "goal",
        content: "Improve English for travel",
        status: "active",
        confidence: 0.9,
      },
      {
        kind: "structure_mastered",
        content: "present perfect",
        status: "mastered",
        confidence: 0.8,
      },
      {
        kind: "grammar_error",
        content: "travel past tense",
        status: "dismissed",
        confidence: 1,
      },
      {
        kind: "preferred_topic",
        content: "travel and medical diagnosis",
        status: "active",
        confidence: 1,
        sensitive: true,
        consented_at: null,
      },
      {
        kind: "personal_story",
        content: "travel location from an old hallucinated transcript",
        status: "active",
        confidence: 1,
      },
      {
        kind: "pronunciation_issue",
        content: "present perfect travel pronunciation",
        status: "active",
        confidence: 1,
      },
    ],
    "travel present perfect",
    10,
  );

  assertEquals(
    selected.map((item) => item.kind).sort(),
    ["goal", "structure_mastered"],
  );
});
