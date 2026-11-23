/// <reference lib="deno.ns" />

import {
  americanizeSpelling,
  buildHubVerifyPrompt,
  focusBelowLevel,
  hubMaterialQualityIssues,
  hubVerifySchema,
  isNotARealError,
} from "./hub-quality.ts";
import {
  buildHubMaterialPrompt,
  hubMaterialResponseSchema,
  normalizeHubMaterial,
  parseHubMaterialSpec,
} from "./hub-material.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const spec = (kind: string, level = "A2") => {
  const parsed = parseHubMaterialSpec({
    kind,
    level,
    topic: "Daily routines",
    niche: "CONVERSATION",
    count: 4,
  });
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.spec;
};

const focus = (watch_out: unknown[]) => ({
  point: "Comparatives",
  why_pt: "x",
  patterns: [{ en: "The afternoon is busier.", pt: "A tarde é mais cheia." }],
  watch_out,
});

Deno.test("cuidado que não é erro: igual ao certo ou só grafia US x UK (achados do Revisor)", () => {
  assert(
    isNotARealError("I realised it was late.", "I realized it was late."),
    "realised x realized",
  );
  assert(isNotARealError("a cosy room", "a cozy room"), "cosy x cozy");
  assert(
    isNotARealError("I am always tired", "I am always tired"),
    "frase certa listada como erro",
  );
  assert(
    !isNotARealError("I have 30 years.", "I am 30 years old."),
    "erro real descartado",
  );
  assert(isNotARealError("", "x"), "lado vazio");
});

Deno.test("normalização descarta o cuidado falso e monta o texto Errado → Certo", () => {
  const result = normalizeHubMaterial(spec("quiz"), {
    title: "Q",
    instructions_pt: "",
    grammar_focus: focus([
      { wrong_en: "I realised", right_en: "I realized", why_pt: "grafia" },
      {
        wrong_en: "more busy",
        right_en: "busier",
        why_pt: "adjetivo curto ganha -er",
      },
    ]),
    opportunity_pt: "",
    ai_homework: [],
    questions: [0, 1, 2].map((i) => ({
      prompt: `The ${i} is ___ than mine.`,
      options: ["bigger", "more big", "biggest", "big"],
      correct: 0,
      explanation_pt: "bigger",
    })),
  });
  assert(result.ok, "material válido recusado");
  const gf = result.value.material.grammar_focus as Record<string, unknown>;
  const watch = gf.watch_out as unknown[];
  assert(watch.length === 1, "cuidado falso deveria sair");
  assert(
    (gf.watch_out_pt as string[])[0] ===
      'Errado: "more busy" → Certo: "busier". adjetivo curto ganha -er',
    "texto do cuidado",
  );
});

Deno.test("checagens automáticas: áudio, comparativo errado e grafia britânica (lote 1)", () => {
  const material = {
    grammar_focus: focus([{
      wrong_en: "The afternoon is more busy.",
      right_en: "The afternoon is busier.",
      why_pt: "x",
    }]),
    dialogue: [{ speaker: "Ana", line: "The afternoon is more busy for me." }],
    shadowing: {
      lines: ["My favourite time is the morning."],
      focus_pt: "entonação",
    },
    teacher_notes_pt: "Use o áudio do diálogo para a escuta.",
    homework_pt: "Ouça a gravação e repita.",
    glossary: [{ term: "crise", translation_pt: "crise" }],
  };
  const issues = hubMaterialQualityIssues(material);
  const codes = issues.map((issue) => `${issue.code}@${issue.path}`);
  assert(
    codes.includes("WRONG_COMPARATIVE@dialogue[0].line"),
    `comparativo: ${codes}`,
  );
  assert(
    !codes.some((code) => code.includes("watch_out[0].wrong_en")),
    "o lado errado do cuidado pode ter o erro",
  );
  assert(codes.includes("BRITISH_SPELLING@shadowing.lines[0]"), "favourite");
  assert(
    codes.includes("AUDIO_MENTION@teacher_notes_pt") &&
      codes.includes("AUDIO_MENTION@homework_pt"),
    "áudio",
  );
  assert(
    !codes.some((code) => code.startsWith("BRITISH_SPELLING@glossary")),
    "palavra em pt não é grafia inglesa",
  );
});

Deno.test("grafia americana automática, sem mexer em pt nem no lado errado", () => {
  const fixed = americanizeSpelling({
    text: "My favourite Colour is grey. I realised the centre was closed.",
    explanation_pt: "favourite em pt fica",
    grammar_focus: {
      watch_out: [{
        wrong_en: "I realised",
        right_en: "I realized",
        why_pt: "",
      }],
    },
  });
  assert(
    fixed.text ===
      "My favorite Color is gray. I realized the center was closed.",
    fixed.text,
  );
  assert(fixed.explanation_pt === "favourite em pt fica", "campo pt alterado");
  assert(
    fixed.grammar_focus.watch_out[0].wrong_en === "I realised",
    "lado errado alterado",
  );
  // Palavras iguais nos EUA não mudam.
  assert(
    americanizeSpelling("advise, exercise, surprise") ===
      "advise, exercise, surprise",
    "-ise legítimo alterado",
  );
});

Deno.test("prompt v4: regras de qualidade para todo tipo e nada de áudio", () => {
  for (
    const kind of [
      "reading",
      "conversation",
      "worksheet",
      "vocab_cards",
      "journey",
      "matching",
    ]
  ) {
    const prompt = buildHubMaterialPrompt(spec(kind, "B1"));
    assert(prompt.includes("REGRAS DE QUALIDADE"), `${kind} sem regras`);
    assert(prompt.includes("Não existe áudio"), `${kind} sem a regra de áudio`);
    assert(prompt.includes("Nível B1 ESTRITO"), `${kind} sem trava de nível`);
    assert(!/junto com o áudio/.test(prompt), `${kind} ainda promete áudio`);
  }
});

Deno.test("2ª passada: schema estrito com issues + material e prompt com a checklist e os achados automáticos", () => {
  const schema = hubVerifySchema(
    hubMaterialResponseSchema("conversation"),
  ) as Record<string, unknown>;
  assert(
    schema.additionalProperties === false &&
      JSON.stringify(schema.required) === '["issues","material"]',
    "schema",
  );
  const prompt = buildHubVerifyPrompt(spec("conversation"), { title: "x" }, [{
    path: "dialogue[1].line",
    code: "WRONG_COMPARATIVE",
    detail: "more busy",
  }]);
  assert(
    prompt.includes("REVISOR PEDAGÓGICO") &&
      prompt.includes("dialogue[1].line: WRONG_COMPARATIVE"),
    "achado automático no prompt",
  );
  assert(prompt.includes("UMA posição coerente"), "coerência de personagem");
});

Deno.test("erro de propósito não reprova: correção de erros, distrator e dever com IA; alternativa certa errada reprova", () => {
  const ok = hubMaterialQualityIssues({
    sentences: [{
      sentence: "The bus is more cheap.",
      answer: "The bus is cheaper.",
      explanation_pt: "",
    }],
    questions: [{
      prompt: "The train is ___.",
      options: ["faster", "more fast"],
      correct: 0,
      explanation_pt: "",
    }],
    ai_homework: [{
      task_pt: "x",
      prompt_en: "Correct my sentences: The event is more big.",
      tip_pt: "",
    }],
  });
  assert(
    !ok.some((issue) => issue.code === "WRONG_COMPARATIVE"),
    `falso positivo: ${JSON.stringify(ok)}`,
  );
  const bad = hubMaterialQualityIssues({
    questions: [{
      prompt: "The train is ___.",
      options: ["faster", "more fast"],
      correct: 1,
      explanation_pt: "",
    }],
    cards: [{ term: "better", definition_en: "more good than something else" }],
  });
  const paths = bad.filter((issue) => issue.code === "WRONG_COMPARATIVE").map((
    issue,
  ) => issue.path);
  assert(
    paths.includes("questions[0].options[1]") &&
      paths.includes("cards[0].definition_en"),
    JSON.stringify(paths),
  );
});

Deno.test("2ª passada: foco de nível abaixo não vale e distrator aceitável na fala informal é trocado", () => {
  const b1 = buildHubVerifyPrompt(spec("vocab_cards", "B1"), {}, []);
  assert(
    b1.includes("NÃO valem como foco de B1") && b1.includes("A2: past simple"),
    "lista dos níveis abaixo",
  );
  assert(b1.includes("You think it is good?"), "distrator informal");
  assert(
    !buildHubVerifyPrompt(spec("quiz", "A1"), {}, []).includes(
      "NÃO valem como foco",
    ),
    "A1 não tem nível abaixo",
  );
});

Deno.test("foco abaixo do nível: past simple sozinho em B1 sim; contraste com present perfect não", () => {
  assert(
    focusBelowLevel("B1", "Past simple for finished events in stories"),
    "past simple em B1",
  );
  assert(
    !focusBelowLevel(
      "B1",
      "Present perfect vs. past simple for life experiences",
    ),
    "contraste é B1",
  );
  assert(
    !focusBelowLevel("A2", "Past simple for finished events"),
    "past simple é A2",
  );
  assert(
    focusBelowLevel("C1", "Second conditional for advice"),
    "2º condicional em C1",
  );
  assert(
    !focusBelowLevel("C1", "Cleft sentences with What I need is"),
    "cleft é C1",
  );
  const issues = hubMaterialQualityIssues({
    grammar_focus: { point: "Past simple for stories" },
  }, "B1");
  assert(
    issues.some((issue) => issue.code === "FOCUS_BELOW_LEVEL"),
    "checagem com nível",
  );
});
