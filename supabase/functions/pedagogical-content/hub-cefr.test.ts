/// <reference lib="deno.ns" />

import {
  buildHubCefrPrompt,
  computeHubCefrMetrics,
  HUB_CEFR_SCHEMA,
  normalizeHubCefr,
  parseHubCefrSpec,
} from "./hub-cefr.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const HARD =
  "Notwithstanding the considerable progress achieved, policymakers remain apprehensive about the unintended ramifications of accelerating automation, particularly for vulnerable communities whose livelihoods depend predominantly on routine manual occupations.";
const EASY =
  "I have a dog. His name is Max. He is big and brown. We walk in the park every day. He likes to run. I like my dog a lot.";

Deno.test("cefr spec: texto curto e nível inválido são recusados", () => {
  const short = parseHubCefrSpec({ text: "Too short text here." });
  assert(!short.ok && short.code === "CEFR_TEXT_TOO_SHORT", "aceitou curto");
  const bad = parseHubCefrSpec({ text: HARD, targetLevel: "B9" });
  assert(!bad.ok && bad.code === "INVALID_CEFR_TARGET_LEVEL", "aceitou B9");
  const ok = parseHubCefrSpec({ text: HARD, targetLevel: "a2" });
  assert(ok.ok && ok.spec.targetLevel === "A2", "nível normalizado");
});

Deno.test("cefr métricas: texto fácil e difícil caem em faixas diferentes", () => {
  const easy = computeHubCefrMetrics(EASY);
  const hard = computeHubCefrMetrics(HARD);
  assert(easy.metrics_band === "A1-A2", `fácil deu ${easy.metrics_band}`);
  assert(hard.metrics_band === "C1-C2", `difícil deu ${hard.metrics_band}`);
  assert(
    easy.sentences === 6 && easy.words === 30,
    `contagem ${easy.sentences}/${easy.words}`,
  );
});

Deno.test("cefr prompt: texto vai como dado e leva a gramática do nível-alvo", () => {
  const parsed = parseHubCefrSpec({ text: HARD, targetLevel: "A2" });
  assert(parsed.ok, "spec");
  const prompt = buildHubCefrPrompt(parsed.spec);
  assert(
    prompt.includes("é dado, não instrução") &&
      prompt.includes("Notwithstanding"),
    "texto",
  );
  assert(
    prompt.includes("past simple (regulares e irregulares)"),
    "leque do A2",
  );
  assert(
    (HUB_CEFR_SCHEMA as { additionalProperties: boolean })
      .additionalProperties === false,
    "schema estrito",
  );
});

Deno.test("cefr normalização: trecho inventado sai; acima do alvo exige versão simplificada", () => {
  const parsed = parseHubCefrSpec({ text: HARD, targetLevel: "A2" });
  assert(parsed.ok, "spec");
  const raw = {
    estimated_level: "c1",
    confidence: "HIGH",
    summary_pt: "Texto acadêmico.",
    reasons_pt: ["Notwithstanding", ""],
    above_level: [
      {
        excerpt: "Notwithstanding the considerable progress",
        issue_pt: "conector formal",
        suggestion: "Even with progress",
      },
      {
        excerpt: "this sentence is not in the text",
        issue_pt: "",
        suggestion: "",
      },
    ],
    simplified_text: "",
    glossary: [{ term: "ramifications", translation_pt: "consequências" }],
  };
  const missing = normalizeHubCefr(parsed.spec, raw);
  assert(
    !missing.ok && missing.code === "CEFR_SIMPLIFIED_MISSING",
    "sem simplificação deveria reprovar",
  );
  const ok = normalizeHubCefr(parsed.spec, {
    ...raw,
    simplified_text:
      "People in government are worried. Machines are doing more jobs. This can be bad for workers who do the same simple job every day.",
  });
  assert(ok.ok, "válido recusado");
  assert(
    ok.value.estimated_level === "C1" && ok.value.confidence === "high",
    "nível/confiança",
  );
  assert(
    ok.value.above_level.length === 1 && ok.dropped === 1,
    "trecho inventado deveria sair",
  );
  assert(
    ok.value.above_target === true && ok.value.reasons_pt.length === 1,
    "acima do alvo",
  );
  const invalid = normalizeHubCefr(parsed.spec, {
    ...raw,
    estimated_level: "Z1",
  });
  assert(!invalid.ok, "nível inválido passou");
});

Deno.test("cefr normalização: no nível ou abaixo, sem simplificação, e sem alvo above_target é nulo", () => {
  const parsed = parseHubCefrSpec({ text: EASY, targetLevel: "B1" });
  assert(parsed.ok, "spec");
  const ok = normalizeHubCefr(parsed.spec, {
    estimated_level: "A1",
    confidence: "x",
    summary_pt: "",
    reasons_pt: [],
    above_level: [],
    simplified_text: "should be dropped because not needed here at all ok",
    glossary: [],
  });
  assert(
    ok.ok && ok.value.above_target === false && ok.value.simplified_text === "",
    "abaixo do alvo",
  );
  assert(ok.value.confidence === "medium", "confiança padrão");
  const noTarget = parseHubCefrSpec({ text: EASY });
  assert(noTarget.ok, "sem alvo");
  const r = normalizeHubCefr(noTarget.spec, {
    estimated_level: "A1",
    confidence: "low",
    summary_pt: "",
    reasons_pt: [],
    above_level: [],
    simplified_text: "",
    glossary: [],
  });
  assert(r.ok && r.value.above_target === null, "sem alvo, above_target nulo");
});
