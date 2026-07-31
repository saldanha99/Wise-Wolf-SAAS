/// <reference lib="deno.ns" />

import {
  detectWolfieLearnerLanguage,
  resolveWolfieLearnerLanguage,
  resolveWolfieTurnLanguagePolicy,
  WOLFIE_ADAPTIVE_LANGUAGE_POLICY,
} from "./adaptive-language-policy.ts";

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

Deno.test("detects short Portuguese and English turns without a microphone hint", () => {
  for (
    const sample of [
      "oi",
      "OLÁ",
      "sim",
      "não",
      "bom dia",
      "boa tarde",
      "pode repetir?",
      "repete",
      "valeu",
      "beleza",
      "tá",
      "claro",
      "certo",
      "Eu moro em Nova Iguaçu.",
    ]
  ) {
    assertEquals(
      resolveWolfieLearnerLanguage(sample),
      "pt",
      `Portuguese sample ${sample}`,
    );
  }

  for (
    const sample of [
      "hello",
      "yes",
      "no",
      "good morning",
      "I live in Bahia.",
      "I’m ready.",
    ]
  ) {
    assertEquals(
      resolveWolfieLearnerLanguage(sample),
      "en",
      `English sample ${sample}`,
    );
  }
});

Deno.test("short Portuguese follow-ups override an established English fallback", () => {
  for (
    const sample of [
      "pode repetir?",
      "repete",
      "valeu",
      "beleza",
      "tá",
      "claro",
      "certo",
    ]
  ) {
    assertEquals(
      resolveWolfieLearnerLanguage(sample, "en"),
      "pt",
      `Portuguese follow-up ${sample}`,
    );
  }
});

Deno.test("Portuguese framing wins for code-switched coaching requests", () => {
  assertEquals(
    detectWolfieLearnerLanguage(
      'Como eu digo "the backup is pending" em inglês?',
    ),
    "mixed",
    "code-switched request should remain visible as mixed",
  );
  assertEquals(
    resolveWolfieLearnerLanguage(
      'Como eu digo "the backup is pending" em inglês?',
    ),
    "pt",
    "Portuguese framing should drive the response",
  );
  assertEquals(
    resolveWolfieLearnerLanguage(
      "Eu quero dizer: the backup is pending.",
    ),
    "pt",
    "Portuguese coaching request should be PT-first",
  );
});

Deno.test("proper nouns and numbers keep the established language", () => {
  assertEquals(
    detectWolfieLearnerLanguage("Nova Iguaçu"),
    "unknown",
    "a place alone is not a language signal",
  );
  assertEquals(
    resolveWolfieLearnerLanguage("Nova Iguaçu", "pt"),
    "pt",
    "unknown text should keep the established language",
  );
  assertEquals(
    resolveWolfieLearnerLanguage("42", "en"),
    "en",
    "numbers should keep the established language",
  );
});

Deno.test("spoken Portuguese takes precedence over immersive interface mode", () => {
  const policy = resolveWolfieTurnLanguagePolicy("pt", "immersive");
  assertEquals(
    policy.assistantLanguage,
    "pt-BR",
    "Portuguese speech should receive a Portuguese response first",
  );
  assertEquals(
    policy.needsEnglishBridge,
    true,
    "Portuguese recovery should bridge immediately into English",
  );
  assertEquals(
    policy.immersiveEnglishOnly,
    false,
    "immersive mode must not conflict with per-turn speech evidence",
  );
});

Deno.test("adaptive prompt contains the PT-first and EN-first contract", () => {
  for (
    const requiredRule of [
      "Detect the language of every learner turn independently",
      "reply first in concise natural PT-BR",
      "separate translation field",
      "If the learner speaks English",
      "quoted English phrase inside a Portuguese question",
      "must be preserved exactly",
    ]
  ) {
    if (!WOLFIE_ADAPTIVE_LANGUAGE_POLICY.includes(requiredRule)) {
      throw new Error(`missing adaptive-language rule: ${requiredRule}`);
    }
  }
});
