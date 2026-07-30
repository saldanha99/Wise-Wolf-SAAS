/// <reference lib="deno.ns" />

import {
  containsPersonalFactClaim,
  shouldConfirmVoiceTranscript,
  transcriptSimilarity,
  uniqueTranscriptAlternatives,
} from "../../lib/wolfieVoiceSafety.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("detecta fatos pessoais em inglês e português", () => {
  assert(
    containsPersonalFactClaim("I live in Nova Iguaçu."),
    "residência em inglês precisa de confirmação",
  );
  assert(
    containsPersonalFactClaim("Eu moro no estado da Bahia."),
    "residência em português precisa de confirmação",
  );
  assert(
    containsPersonalFactClaim("I am from Bahia, but I live in Nova Iguaçu."),
    "origem precisa permanecer distinta de residência",
  );
  assert(
    !containsPersonalFactClaim("Nova Iguaçu is a city in Brazil."),
    "conhecimento geral não é um autorrelato pessoal",
  );
});

Deno.test("fato pessoal sempre abre revisão mesmo com confiança alta", () => {
  assert(
    shouldConfirmVoiceTranscript({
      transcript: "I live in Nova Iguaçu.",
      confidence: 0.99,
    }),
    "confiança acústica não deve confirmar um fato pessoal",
  );
});

Deno.test("baixa confiança ou alternativas divergentes abrem revisão", () => {
  assert(
    shouldConfirmVoiceTranscript({
      transcript: "I ordered a coffee.",
      confidence: 0.55,
    }),
    "baixa confiança precisa de revisão",
  );
  assert(
    shouldConfirmVoiceTranscript({
      transcript: "I ordered a coffee.",
      confidence: 0.94,
      alternatives: ["I boarded a ferry."],
    }),
    "alternativas semanticamente divergentes precisam de revisão",
  );
});

Deno.test("alternativas repetidas são normalizadas sem apagar acentos visuais", () => {
  const alternatives = uniqueTranscriptAlternatives(
    "Nova Iguaçu",
    ["nova iguacu", "Nova Iguaçu", "Nova Friburgo", "Nova Friburgo"],
  );
  assert(
    JSON.stringify(alternatives) === JSON.stringify(["Nova Friburgo"]),
    "somente alternativas realmente distintas devem aparecer",
  );
  assert(
    transcriptSimilarity("Nova Iguaçu", "nova iguacu") === 1,
    "comparação deve ser tolerante a caixa e acentos",
  );
});
