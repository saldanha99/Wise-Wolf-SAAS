import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  gradeClosed,
  mergeOpenFeedback,
  normalizeGap,
  parseAnswers,
} from "./grade.ts";

const material = {
  questions: [
    {
      prompt: "I ___ a ticket.",
      options: ["have", "has"],
      correct: 0,
      explanation_pt: "I pede have.",
    },
    {
      prompt: "She ___ late.",
      options: ["are", "is"],
      correct: 1,
      explanation_pt: "She pede is.",
    },
  ],
  fill_blanks: [{
    prompt: "We ___ at 9.",
    answer: "arrive / arrived",
    hint_pt: "",
  }],
  open_questions: [{
    prompt: "Describe your trip.",
    model_answer: "I went to Rio.",
  }],
};

Deno.test("respostas inválidas recusadas e limitadas", () => {
  assertEquals(parseAnswers("x"), null);
  assertEquals(parseAnswers({ questions: Array(60).fill(0) }), null);
  assertEquals(parseAnswers({ questions: [0, "1", 99] }), {
    questions: [0, null, null],
  });
});

Deno.test("fechadas por código; gabarito só no modo after_submit", () => {
  const answers = parseAnswers({
    questions: [0, 0],
    fill_blanks: ["Arrived."],
    open_questions: ["I go to Rio last year"],
  })!;
  const after = gradeClosed(material, answers, "after_submit");
  assertEquals([after.right, after.total], [2, 3]);
  assertEquals(after.items[1].expected, "is");
  assertEquals(after.open.length, 1);
  const never = gradeClosed(material, answers, "never");
  assert(
    never.items.every((it) =>
      it.expected === undefined && it.explanation_pt === undefined
    ),
  );
});

Deno.test("lacuna aceita alternativas e ignora caixa/pontuação", () => {
  assertEquals(normalizeGap("  Arrived! "), "arrived");
  const r = gradeClosed(material, { fill_blanks: ["ARRIVE"] }, "never");
  assert(r.items.find((it) => it.kind === "gap")?.correct === true);
});

Deno.test("retorno da IA entra só nas abertas; correção escondida no modo never", () => {
  const base = gradeClosed(
    material,
    { open_questions: ["I go to Rio last year"] },
    "never",
  ).items;
  const merged = mergeOpenFeedback(base, {
    items: [{
      index: 0,
      verdict: "partial",
      feedback_pt: "Use o passado: went.",
      corrected_en: "I went to Rio last year.",
    }],
  }, "never");
  const open = merged.find((it) => it.kind === "open")!;
  assertEquals([open.verdict, open.feedback_pt, open.corrected_en], [
    "partial",
    "Use o passado: went.",
    undefined,
  ]);
});
