import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  answerLine,
  type Exercise,
  normalizeExercise,
  toUsSpelling,
  validateExercise,
  validateText,
} from "./exercise-validator.ts";

const codes = (ex: Exercise, units?: number) =>
  validateExercise(ex, { units }).errors.map((e) => e.code);

Deno.test("mcq: resposta dentro das opções, opções sem repetição", () => {
  const ok: Exercise = {
    type: "mcq",
    instruction: "Choose the correct option.",
    items: [{
      n: 1,
      prompt: "She ___ finished yet.",
      options: ["hasn't", "didn't"],
      answerIndex: 0,
    }],
  };
  assertEquals(codes(ok), []);
  assertEquals(codes({ ...ok, items: [{ ...ok.items[0], answerIndex: 2 }] }), [
    "MCQ_ANSWER_NOT_IN_OPTIONS",
  ]);
  assertEquals(
    codes({
      ...ok,
      items: [{ ...ok.items[0], options: ["hasn't", "Hasn't"] }],
    }),
    ["MCQ_DUPLICATE_OPTIONS"],
  );
  assertEquals(
    answerLine("mcq", ok.items[0]),
    "1. a) hasn't — She hasn't finished yet.",
  );
});

Deno.test("gap: exatamente uma lacuna e resposta no banco de palavras", () => {
  const ex: Exercise = {
    type: "gap",
    instruction: "Complete.",
    items: [
      {
        n: 1,
        prompt: "I lost the ___ of the conversation.",
        answer: "thread",
        options: ["thread", "gist"],
      },
      { n: 2, prompt: "No gap here.", answer: "x" },
      { n: 3, prompt: "Two ___ and ___.", answer: "x" },
      {
        n: 4,
        prompt: "It is the ___.",
        answer: "point",
        options: ["thread", "gist"],
      },
    ],
  };
  assertEquals(codes(ex), ["GAP_COUNT", "GAP_COUNT", "GAP_ANSWER_NOT_IN_BANK"]);
  assertEquals(
    answerLine("gap", ex.items[0]),
    "1. I lost the **thread** of the conversation.",
  );
});

Deno.test("reorder: mesmas palavras, nem sobra nem falta", () => {
  const base = {
    n: 1,
    prompt: "Put the words in order.",
    words: ["I", "want", "to", "go"],
    answer: "I want to go.",
  };
  assertEquals(
    codes({ type: "reorder", instruction: "Order.", items: [base] }),
    [],
  );
  assertEquals(
    codes({
      type: "reorder",
      instruction: "Order.",
      items: [{ ...base, answer: "I want go." }],
    }),
    ["REORDER_WORDS_MISMATCH"],
  );
});

Deno.test("numeração começa em 1 e não pula", () => {
  const ex: Exercise = {
    type: "open",
    instruction: "Write.",
    items: [{ n: 5, prompt: "Describe your day.", answer: "I wake up at 7." }],
  };
  assertEquals(codes(ex), ["NUMBERING_GAP"]);
});

Deno.test("tf exige V e F; match 1 para 1", () => {
  assertEquals(
    codes({
      type: "tf",
      instruction: "True or false?",
      items: [{ n: 1, prompt: "A", answer: "true" }, {
        n: 2,
        prompt: "B",
        answer: "true",
      }],
    }),
    ["TF_NEEDS_BOTH"],
  );
  assertEquals(
    codes({
      type: "match",
      instruction: "Match.",
      items: [{ n: 1, prompt: "big", answer: "large" }, {
        n: 2,
        prompt: "huge",
        answer: "large",
      }],
    }),
    ["MATCH_NOT_ONE_TO_ONE"],
  );
});

Deno.test("correção: igual ao original (ou só grafia UK/US) reprova; comparativo errado reprova", () => {
  const ex = (prompt: string, answer: string): Exercise => ({
    type: "correct_error",
    instruction: "Correct the mistake.",
    items: [{ n: 1, prompt, answer }],
  });
  assertEquals(codes(ex("I realise it.", "I realize it.")), [
    "ANSWER_SAME_AS_PROMPT",
  ]);
  assertEquals(codes(ex("She is more busy.", "She is more busy than me.")), [
    "WRONG_COMPARATIVE_AS_ANSWER",
  ]);
  assertEquals(codes(ex("She is more busy.", "She is busier.")), []);
});

Deno.test("referências a mídia, página e unidade inexistentes reprovam", () => {
  assertEquals(
    validateText("Look at the picture on page 4.").map((e) => e.code),
    [
      "REFERENCE_TO_MISSING_MEDIA",
      "REFERENCE_TO_PAGE",
    ],
  );
  assertEquals(
    validateText("Review Units 2–4.", { units: 1 }).map((e) => e.code),
    ["REFERENCE_TO_MISSING_UNIT"],
  );
  assertEquals(validateText("In this unit you practice.", { units: 1 }), []);
  assertEquals(validateText("Escute o áudio.").map((e) => e.code), [
    "REFERENCE_TO_MISSING_MEDIA",
  ]);
  assertEquals(
    validateText(
      "Look at the figures: the picture is less clear-cut. See the big picture.",
    ),
    [],
  );
  assertEquals(
    validateText("Observe a imagem e responda.").map((e) => e.code),
    ["REFERENCE_TO_MISSING_MEDIA"],
  );
  assertEquals(
    validateText("The photo above shows a market.").map((e) => e.code),
    ["REFERENCE_TO_MISSING_MEDIA"],
  );
});

Deno.test("grafia americana por lista fechada", () => {
  assertEquals(
    toUsSpelling("My favourite colour is grey; I realised it."),
    "My favorite color is gray; I realised it.".replace("realised", "realized"),
  );
  assertEquals(
    toUsSpelling("Advertise and promise stay."),
    "Advertise and promise stay.",
  );
  const n = normalizeExercise({
    type: "open",
    instruction: "Describe your favourite centre.",
    items: [{ n: 1, prompt: "Travelling?", answer: "I love travelling." }],
  });
  assertEquals(n.instruction, "Describe your favorite center.");
  assertEquals(n.items[0].answer, "I love traveling.");
});
