/// <reference lib="deno.ns" />

import {
  classifyWolfieLearnerTurn,
  inferWolfieSocialTurnLanguage,
  isPedagogicallySubstantiveTurn,
  suppressWolfiePedagogicalEvidence,
  type WolfieLearnerTurnKind,
} from "./turn-policy.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function assertKind(
  expected: WolfieLearnerTurnKind,
  values: unknown[],
): void {
  for (const value of values) {
    assertEquals(
      classifyWolfieLearnerTurn(value),
      expected,
      `unexpected classification for ${JSON.stringify(value)}`,
    );
  }
}

Deno.test("empty input distinguishes an opening from captured audio noise", () => {
  assertEquals(
    classifyWolfieLearnerTurn(""),
    "opening",
    "an empty non-audio request is the automatic opening",
  );
  assertEquals(
    classifyWolfieLearnerTurn("   ", true),
    "noise",
    "empty captured audio is noise",
  );
  assertEquals(
    classifyWolfieLearnerTurn(null),
    "opening",
    "a missing non-audio message is the automatic opening",
  );
});

Deno.test("punctuation, fillers and explicit ASR markers are noise", () => {
  assertKind("noise", [
    "...",
    "?!",
    "uh",
    "um",
    "hmm",
    "hm",
    "ah",
    "er",
    "err",
    "uh... hmm",
    "[noise]",
    "(inaudible)",
    "[NOISE] ... (INAUDIBLE)",
  ]);
});

Deno.test("isolated English and Portuguese greetings stay social", () => {
  assertKind("greeting", [
    "hello",
    "Hi!",
    "hey",
    "hello Wolfie",
    "Wolfie, hello",
    "good morning",
    "Good afternoon, Wolfie!",
    "good evening",
    "how are you?",
    "hi, how are you doing?",
    "how's it going?",
    "what's up?",
    "hello there",
    "hey there",
    "uh, hello",
    "hello, um",
    "hi teacher",
    "hello hello",
    "oi",
    "olá",
    "opa!",
    "e aí?",
    "bom dia",
    "boa tarde",
    "boa noite",
    "tudo bem?",
    "oi, tudo bem com você?",
    "como você está?",
    "como vai?",
    "olá, bom dia",
  ]);
});

Deno.test("social greeting language is inferred independently from client hints", () => {
  for (
    const greeting of [
      "oi",
      "olá",
      "opa",
      "bom dia",
      "boa tarde",
      "boa noite",
      "tudo bem?",
      "oi, tudo bem com você?",
    ]
  ) {
    assertEquals(
      inferWolfieSocialTurnLanguage(greeting),
      "pt",
      `expected a Portuguese greeting: ${greeting}`,
    );
  }
  for (
    const greeting of [
      "hello",
      "hi there",
      "good morning",
      "how are you doing?",
      "what's up?",
    ]
  ) {
    assertEquals(
      inferWolfieSocialTurnLanguage(greeting),
      "en",
      `expected an English greeting: ${greeting}`,
    );
  }
});

Deno.test("unicode normalization preserves greeting intent", () => {
  assertEquals(
    classifyWolfieLearnerTurn("ＯＬÁ，ＢＯＭ　ＤＩＡ！"),
    "greeting",
    "full-width characters and accents must normalize",
  );
  assertEquals(
    classifyWolfieLearnerTurn("HOW’S IT GOING？"),
    "greeting",
    "curly apostrophes and Unicode punctuation must normalize",
  );
});

Deno.test("content beyond a greeting is substantive", () => {
  assertKind("substantive", [
    "Hello, the backup is pending.",
    "Hi Wolfie, it is still in progress.",
    "Oi, eu moro em Nova Iguaçu.",
    "Olá, preciso de ajuda.",
    "Good morning, the answer is 42.",
    "um, the backup is complete",
  ]);
});

Deno.test("short task answers are substantive rather than noise", () => {
  assertKind("substantive", [
    "pending",
    "42",
    42,
    "yes",
    "no",
    "complete",
    "ready",
  ]);
});

Deno.test("only substantive learner turns are pedagogical evidence", () => {
  for (
    const kind of ["opening", "greeting", "noise"] as const
  ) {
    assertEquals(
      isPedagogicallySubstantiveTurn(kind),
      false,
      `${kind} must not be pedagogical evidence`,
    );
  }
  assertEquals(
    isPedagogicallySubstantiveTurn("substantive"),
    true,
    "a substantive turn is pedagogical evidence",
  );
});

Deno.test("a greeting counts only when the active task explicitly practices greetings", () => {
  assertEquals(
    isPedagogicallySubstantiveTurn(
      "greeting",
      "Target skill: greet a client naturally",
    ),
    true,
    "an explicit greeting exercise must accept the learner's greeting",
  );
  assertEquals(
    isPedagogicallySubstantiveTurn(
      "greeting",
      "Target skill: give a database backup status update",
    ),
    false,
    "an unrelated professional task must keep hello social",
  );
  assertEquals(
    isPedagogicallySubstantiveTurn(
      "greeting",
      "The manager greets you and asks for a status update.",
    ),
    false,
    "a narrative greeting by another character is not a greeting exercise",
  );
});

Deno.test("non-evidence projection rejects an adversarial pedagogical payload", () => {
  const projected = suppressWolfiePedagogicalEvidence(
    {
      current_stage: "feedback",
      scenario_status: "completed",
      correction: { original: "hello", corrected: "status update" },
      corrections: [{ original: "hello", corrected: "status update" }],
      pronunciation: { score: 100 },
      translation: "Tradução da abertura.",
      vocabulary: { keyTerms: ["status update"] },
      quiz: { question: "What is pending?" },
      new_vocabulary: [{ item: "status update" }],
      student_strengths: ["Responded immediately"],
      student_priorities: ["Use in progress"],
      next_action: "Give a database backup update.",
      profile_updates: { recurring_vocabulary_gaps: ["status update"] },
      session_score: 92,
      needs_external_verification: true,
      verification_reason: "invented",
      requires_retry: true,
      retry_completed: true,
    },
    {
      currentStage: "briefing",
      scenarioStatus: "active",
      pendingRetry: false,
      preserveTranslation: true,
    },
  );

  assertEquals(
    JSON.stringify(projected),
    JSON.stringify({
      current_stage: "briefing",
      scenario_status: "active",
      correction: null,
      corrections: [],
      pronunciation: null,
      translation: "Tradução da abertura.",
      vocabulary: null,
      quiz: null,
      new_vocabulary: [],
      student_strengths: [],
      student_priorities: [],
      next_action: "",
      profile_updates: {},
      session_score: null,
      needs_external_verification: false,
      verification_reason: null,
      requires_retry: false,
      retry_completed: false,
    }),
    "non-evidence turns must not expose or persist model-invented pedagogy",
  );
});

Deno.test("non-evidence projection cannot complete a pending retry", () => {
  const projected = suppressWolfiePedagogicalEvidence(
    {
      current_stage: "assessment",
      scenario_status: "completed",
      correction: null,
      corrections: [],
      pronunciation: null,
      translation: null,
      vocabulary: null,
      quiz: null,
      new_vocabulary: [],
      student_strengths: ["Mastered"],
      student_priorities: [],
      next_action: "Finish.",
      profile_updates: {},
      session_score: 100,
      needs_external_verification: false,
      verification_reason: null,
      requires_retry: false,
      retry_completed: true,
    },
    {
      currentStage: "retry",
      scenarioStatus: "awaiting_retry",
      pendingRetry: true,
    },
  );

  assertEquals(
    projected.current_stage,
    "retry",
    "a social/noise turn must remain in retry",
  );
  assertEquals(
    projected.scenario_status,
    "awaiting_retry",
    "a pending retry must remain pending",
  );
  assertEquals(
    projected.requires_retry,
    true,
    "the retry lock must remain active",
  );
  assertEquals(
    projected.retry_completed,
    false,
    "non-evidence can never complete a retry",
  );
});
