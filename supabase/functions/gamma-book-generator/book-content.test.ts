/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import {
  buildChunkPrompt,
  buildFinalInput,
  checkFeedback,
  initialContentState,
  normalizeChunk,
  renderAnswerPages,
  renderPage,
} from "./book-content.ts";
import { bookOutline, parseSchoolBookSpec } from "./book-spec.ts";

const parsed = parseSchoolBookSpec({
  title: "Travel English A2",
  level: "A2",
  niche: "travel",
  audience: "adults",
  language: "english",
  pageCount: 12,
  objective: "Handle airport and hotel situations with confidence.",
  topics: ["At the airport"],
});
if (!parsed.ok) throw new Error("spec");
const spec = parsed.spec;

const item = (n: number, extra: Record<string, unknown>) => ({
  n,
  prompt: "",
  options: [],
  answer_index: -1,
  answer: "",
  words: [],
  ...extra,
});

const goodPage = (page: number) => ({
  page,
  title: `Page ${page}`,
  body:
    "You check in at the airport. The agent asks for your passport and your booking number before boarding.",
  exercises: [
    {
      title: "Choose",
      type: "mcq",
      instruction: "Choose the correct option.",
      items: [
        item(1, {
          prompt: "I ___ my passport.",
          options: ["have", "has", "having"],
          answer_index: 0,
        }),
      ],
    },
    {
      title: "Order",
      type: "reorder",
      instruction: "Put the words in order.",
      items: [
        item(1, {
          prompt: "Make a sentence.",
          words: ["is", "the", "gate", "where"],
          answer: "Where is the gate?",
        }),
      ],
    },
  ],
});

Deno.test("plano: abertura, unidade e revisão; gabarito fora da escrita do modelo", () => {
  const state = initialContentState(spec, null);
  assertEquals(state.units, 1);
  assertEquals(state.chunks.map((c) => c.key), ["front", "unit-1", "review"]);
  const answers = bookOutline(spec).filter((p) => p.kind === "answers").map((
    p,
  ) => p.page);
  assert(state.chunks.every((c) => c.pages.every((p) => !answers.includes(p))));
});

Deno.test("prompt leva as regras e o feedback da tentativa anterior", () => {
  const state = initialContentState(spec, null);
  const chunk = {
    ...state.chunks[1],
    feedback: ["Page 5 exercise 1 item 2: MCQ_ANSWER_NOT_IN_OPTIONS."],
  };
  const prompt = buildChunkPrompt(spec, chunk, 1);
  assert(prompt.includes("exactly 1 unit(s)"));
  assert(prompt.includes("answer_index = the ONLY correct option"));
  assert(prompt.includes("MCQ_ANSWER_NOT_IN_OPTIONS"));
});

Deno.test("normaliza, valida e devolve feedback quando o gabarito não bate", () => {
  const chunk = {
    key: "x",
    pages: [4],
    state: "todo" as const,
    attempts: 1,
    feedback: [],
    content: null,
  };
  const ok = normalizeChunk({ pages: [goodPage(4)] }, chunk, 1);
  assert(ok.ok);
  const bad = goodPage(4);
  bad.exercises[0].items[0].answer_index = 5;
  bad.exercises[1].items[0].answer = "Where is gate?";
  bad.body += " Look at the picture on page 2.";
  const res = normalizeChunk({ pages: [bad] }, chunk, 1);
  assert(!res.ok);
  const text = (res as { feedback: string[] }).feedback.join("\n");
  assert(text.includes("MCQ_ANSWER_NOT_IN_OPTIONS"));
  assert(text.includes("REORDER_WORDS_MISMATCH"));
  assert(text.includes("REFERENCE_TO_MISSING_MEDIA"));
  assert(text.includes("REFERENCE_TO_PAGE"));
  assert(!normalizeChunk({ pages: [] }, chunk, 1).ok);
});

Deno.test("página e gabarito: mesma numeração e frase completa", () => {
  const chunk = {
    key: "x",
    pages: [4],
    state: "todo" as const,
    attempts: 1,
    feedback: [],
    content: null,
  };
  const res = normalizeChunk({ pages: [goodPage(4)] }, chunk, 1);
  if (!res.ok) throw new Error("normalize");
  const page = renderPage(res.pages[0]);
  assert(page.includes("## Exercise 1 — Choose"));
  assert(page.includes("1. I ___ my passport."));
  assert(page.includes("a) have   b) has   c) having"));
  assert(page.includes("1. is / the / gate / where"));
  const [key] = renderAnswerPages(
    res.pages,
    bookOutline(spec).filter((p) => p.kind === "answers"),
  );
  assert(key.includes("**Page 4 · Exercise 1 — Choose**"));
  assert(key.includes("1. a) have — I have my passport."));
  assert(key.includes("1. Where is the gate?"));
});

Deno.test("texto final só sai com todas as páginas escritas", () => {
  const state = initialContentState(spec, null);
  let failed = false;
  try {
    buildFinalInput(spec, state);
  } catch (e) {
    failed = (e as Error).message === "BOOK_CONTENT_INCOMPLETE";
  }
  assert(failed);
  for (const c of state.chunks) {
    c.state = "done";
    c.content = c.pages.map((
      p,
    ) => ({ ...goodPage(p), exercises: [] } as never));
  }
  const text = buildFinalInput(spec, state);
  assertEquals(text.split("\n---\n").length, spec.pageCount);
});

Deno.test("2ª verificação: lista de problemas vira feedback; resposta inválida é transitória", () => {
  assertEquals(checkFeedback({ problems: [] }), []);
  assertEquals(
    checkFeedback({
      problems: [{ page: 5, exercise: 2, n: 3, problem: "two options fit" }],
    }),
    [
      "Page 5 exercise 2 item 3: two options fit",
    ],
  );
  assertEquals(checkFeedback({ nope: 1 }), null);
});
