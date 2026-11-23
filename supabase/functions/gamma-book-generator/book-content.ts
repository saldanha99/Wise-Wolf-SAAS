// Conteúdo do livro gerado e validado por nós (23/11/2026). O Gamma só diagrama.
//
// O livro é escrito em blocos (capa/abertura, cada unidade, extras, revisão+projeto). Cada
// bloco volta do modelo como JSON estrito com os exercícios estruturados (itens numerados e
// resposta por item); o validador comum confere por código, o modelo confere de novo contra
// uma checklist, e o gabarito é montado aqui a partir das respostas. Este arquivo é puro (sem IO).

import {
  answerLine,
  type Exercise,
  EXERCISE_TYPES,
  type ExerciseType,
  normalizeExercise,
  toUsSpelling,
  validateExercise,
  validateText,
  type ValidationError,
} from "../_shared/exercise-validator.ts";
import {
  audienceLabel,
  bookOutline,
  LEVEL_GRAMMAR,
  type OutlinePage,
  type SchoolBookSpec,
} from "./book-spec.ts";

export const BOOK_CONTENT_VERSION = "book-content-v1";

export interface ContentPage {
  page: number;
  title: string;
  body: string;
  exercises: Exercise[];
}

export interface ContentChunk {
  key: string;
  pages: number[];
  state: "todo" | "generated" | "done";
  attempts: number;
  /** Problemas da tentativa anterior (código ou 2ª verificação), devolvidos ao modelo. */
  feedback: string[];
  content: ContentPage[] | null;
  /** Última saída do modelo (JSON), para a correção pontual na tentativa seguinte. */
  draft?: unknown;
}

export interface BookContentState {
  version: string;
  imageStyle: string | null;
  units: number;
  chunks: ContentChunk[];
}

export const MAX_CHUNK_ATTEMPTS = 6;

/** Blocos de escrita: abertura, cada unidade, extras e revisão+projeto. O gabarito não é escrito pelo modelo. */
export function planChunks(outline: OutlinePage[]): ContentChunk[] {
  const groups = new Map<string, number[]>();
  for (const p of outline) {
    if (p.kind === "answers") continue;
    const key = p.kind === "unit"
      ? `unit-${p.unit}`
      : p.kind === "review" || p.kind === "project"
      ? "review"
      : p.kind;
    groups.set(key, [...(groups.get(key) ?? []), p.page]);
  }
  return [...groups.entries()].map(([key, pages]) => ({
    key,
    pages,
    state: "todo",
    attempts: 0,
    feedback: [],
    content: null,
    draft: null,
  }));
}

export function initialContentState(
  spec: SchoolBookSpec,
  imageStyle: string | null,
): BookContentState {
  const outline = bookOutline(spec);
  return {
    version: BOOK_CONTENT_VERSION,
    imageStyle,
    units: unitCount(outline),
    chunks: planChunks(outline),
  };
}

export const unitCount = (outline: OutlinePage[]) =>
  Math.max(0, ...outline.map((p) => p.unit ?? 0));

const EXERCISES_BY_KIND: Record<string, string> = {
  front: "No exercises on these pages.",
  unit:
    "Unit opener: 1 exercise (type open, 3 warm-up questions with model answers). Vocabulary: 2 exercises (match and gap with a word bank). Grammar: 2 exercises (mcq and transform or correct_error). Reading and listening: the body holds the original reading text and a labelled 'Listening script' to be read aloud by the teacher or a partner; 2 exercises (tf with both true and false items, then mcq). Practice lab: 3 exercises (gap, reorder, mcq) with 8–12 items in total. Speak and write: 1–2 exercises (open) with model answers.",
  extra:
    "Each page: 2 exercises of different closed types (gap, mcq, match, reorder, tf) with 5–8 items each.",
  review:
    "Review pages: 4 exercises of different closed types that recycle the language of the whole book, 5–8 items each. Project pages: 1 open exercise with a model answer; no closed items.",
};

/** Brief do bloco para o modelo. `feedback` = problemas da tentativa anterior. */
export function buildChunkPrompt(
  spec: SchoolBookSpec,
  chunk: ContentChunk,
  units: number,
): string {
  const outline = bookOutline(spec).filter((p) => chunk.pages.includes(p.page));
  const kind = outline[0]?.kind ?? "front";
  const language = spec.language === "bilingual"
    ? "Learning texts, examples and every exercise item are in natural American English. Explanations and exercise instructions are in Brazilian Portuguese."
    : "Everything is in natural American English, including explanations and instructions.";
  const lines = [
    `Book: "${spec.title}". CEFR ${spec.level}. Audience: ${
      audienceLabel(spec.audience)
    }. Niche: ${spec.niche}.`,
    `Objective: ${spec.objective}`,
    `Grammar range allowed for this level: ${
      LEVEL_GRAMMAR[spec.level]
    }. Never use structures above ${spec.level} in items.`,
    `The book has exactly ${units} unit(s).`,
    language,
    "",
    "Write the FINAL text of these pages (it will be printed exactly as you write it):",
    ...outline.map((p) => `- Page ${p.page} — ${p.title}: ${p.brief}`),
    "",
    `Exercises: ${
      EXERCISES_BY_KIND[kind === "project" ? "review" : kind] ??
        EXERCISES_BY_KIND.extra
    }`,
    "",
    "Rules (all mandatory):",
    "1. body = the page text in Markdown (explanations, examples, reading text, listening script), 120–350 words, no exercise items, no answers, no teacher notes, no level-1 heading (the title is printed separately).",
    "2. Every exercise lives only in exercises[]. Items are numbered 1..N inside each exercise, with no gaps.",
    "3. mcq: 3 or 4 options, answer_index = the ONLY correct option; every distractor must be clearly wrong in standard English (also in informal speech). If the prompt has a blank (___), each option must fit the blank grammatically as a single choice; never offer a contraction of words that are already in the sentence.",
    "4. gap: exactly one ___ per item; answer = the exact words that fill it. A word bank is optional; when used, put the SAME complete bank in options of EVERY item of that exercise (all the answers plus at most 2 extra words), with no duplicates, and the answer is in the bank. The printed page shows one shared bank.",
    "5. reorder: words = the shuffled words of the answer, exactly the same words (no extra, none missing); answer = the correct sentence.",
    "6. match: prompt = left term, answer = its match; one to one, no repeated terms.",
    '7. tf: answer = "true" or "false"; include both true and false items; the statement must be checkable from the body text of the same page.',
    "8. transform / correct_error: prompt = the original sentence; answer = the full rewritten or corrected sentence, different from the prompt. In correct_error the original must contain a REAL error — never mark a valid English construction (e.g. a correct third conditional, 'Did you ever…?') as wrong.",
    "9. open: prompt = the task or question; answer = a short model answer.",
    "10. Never mention pictures, images, photos, illustrations, audio files, recordings, QR codes, page numbers, 'the previous page', or units that do not exist. A listening task uses the 'Listening script' printed in the body.",
    "11. Address the learner as 'you'. Never address or mention teachers as the readers (no 'for teachers', 'para professores', 'teacher's reference'); the only allowed mention is a listening script 'read aloud by the teacher or a partner'. If the objective above is written for teachers, rewrite it for the learner. American spelling.",
    '12. Use empty arrays, -1 or "" for fields that do not apply to an item.',
  ];
  if (chunk.feedback.length) {
    lines.push(
      "",
      "The previous attempt was rejected. Fix ALL of these problems:",
      ...chunk.feedback.slice(0, 40).map((f) => `- ${f}`),
    );
  }
  return lines.join("\n");
}

/** Correção pontual: devolve o JSON anterior e os problemas; o resto fica igual. */
export function buildFixPrompt(
  spec: SchoolBookSpec,
  chunk: ContentChunk,
  units: number,
): string {
  return [
    buildChunkPrompt(spec, { ...chunk, feedback: [] }, units),
    "",
    "Below is your previous JSON for these pages. A reviewer found the problems listed after it.",
    "Return the COMPLETE JSON again (same schema, same pages) with ONLY the necessary changes: fix every listed problem (rewrite or replace the affected items or exercises; never leave a known problem), keep everything else exactly as it is, and keep the numbering 1..N in each exercise.",
    "",
    "<previous_json>",
    JSON.stringify(chunk.draft),
    "</previous_json>",
    "",
    "Problems to fix:",
    ...chunk.feedback.slice(0, 40).map((f) => `- ${f}`),
  ].join("\n");
}

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["n", "prompt", "options", "answer_index", "answer", "words"],
  properties: {
    n: { type: "integer" },
    prompt: { type: "string" },
    options: { type: "array", items: { type: "string" } },
    answer_index: { type: "integer" },
    answer: { type: "string" },
    words: { type: "array", items: { type: "string" } },
  },
};

export const CHUNK_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pages"],
  properties: {
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "title", "body", "exercises"],
        properties: {
          page: { type: "integer" },
          title: { type: "string" },
          body: { type: "string" },
          exercises: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["title", "type", "instruction", "items"],
              properties: {
                title: { type: "string" },
                type: { type: "string", enum: [...EXERCISE_TYPES] },
                instruction: { type: "string" },
                items: { type: "array", items: ITEM_SCHEMA },
              },
            },
          },
        },
      },
    },
  },
};

export const CHECK_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["problems"],
  properties: {
    problems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "exercise", "n", "severity", "problem"],
        properties: {
          page: { type: "integer" },
          exercise: { type: "integer" },
          n: { type: "integer" },
          severity: { type: "string", enum: ["blocker", "minor"] },
          problem: { type: "string" },
        },
      },
    },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4000) =>
  typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, max) : "";

const ANSWER_LEAK = /\b(?:answer key|answers?:|gabarito|respostas?:|key:)/i;
const TEACHER_ADDRESS =
  /\b(?:teacher'?s? (?:notes?|reference|guide|use)|for (?:the )?teachers?\b|notas? do professor|você é (?:o|a)?\s*professor|professor\(a\)|para (?:o |os |a |as )?professor(?:es|as|a)?\b|professores de inglês)/i;

/** Converte a saída do modelo e valida por código. Erros viram feedback para a próxima tentativa. */
export function normalizeChunk(
  raw: unknown,
  chunk: ContentChunk,
  units: number,
): { ok: true; pages: ContentPage[] } | { ok: false; feedback: string[] } {
  const feedback: string[] = [];
  const list = isObj(raw) && Array.isArray(raw.pages) ? raw.pages : null;
  if (!list) {
    return { ok: false, feedback: ["Return an object with a pages array."] };
  }
  const pages: ContentPage[] = [];
  for (const expected of chunk.pages) {
    const p = list.find((x) => isObj(x) && x.page === expected);
    if (!isObj(p)) {
      feedback.push(`Page ${expected} is missing.`);
      continue;
    }
    // O título sai à parte: um "# Título" repetido no começo do corpo é removido.
    const body = toUsSpelling(str(p.body, 6000)).replace(/^#\s+[^\n]*\n+/, "");
    if (body.length < 60) feedback.push(`Page ${expected}: body is too short.`);
    for (const e of validateText(body, { units })) {
      feedback.push(
        `Page ${expected} body: ${e.code} (${e.detail ?? ""}). Remove it.`,
      );
    }
    if (ANSWER_LEAK.test(body)) {
      feedback.push(
        `Page ${expected} body: remove answers/answer keys from the body.`,
      );
    }
    if (TEACHER_ADDRESS.test(body)) {
      feedback.push(
        `Page ${expected} body: address the learner, never the teacher.`,
      );
    }
    const exercises: Exercise[] = [];
    const rawEx = Array.isArray(p.exercises) ? p.exercises : [];
    rawEx.forEach((ex, k) => {
      if (!isObj(ex)) return;
      const type = str(ex.type, 30) as ExerciseType;
      const items = (Array.isArray(ex.items) ? ex.items : []).filter(isObj).map(
        (it) => {
          const options = Array.isArray(it.options)
            ? it.options.map((o) => str(o, 300)).filter(Boolean)
            : [];
          const words = Array.isArray(it.words)
            ? it.words.map((w) => str(w, 60)).filter(Boolean)
            : [];
          return {
            n: typeof it.n === "number" ? it.n : -1,
            prompt: str(it.prompt, 600),
            ...(type === "mcq" || (type === "gap" && options.length)
              ? { options }
              : {}),
            ...(type === "mcq"
              ? {
                answerIndex: typeof it.answer_index === "number"
                  ? it.answer_index
                  : -1,
              }
              : {}),
            ...(type !== "mcq" ? { answer: str(it.answer, 600) } : {}),
            // Reordenação: as palavras saem da resposta (a fonte da verdade), embaralhadas por código.
            ...(type === "reorder"
              ? { words: scramble(str(it.answer, 600)) || words }
              : {}),
          };
        },
      );
      // Banco de palavras do "gap": um só, com tudo o que foi oferecido + todas as respostas.
      if (
        type === "gap" &&
        items.some((it) => (it as { options?: string[] }).options?.length)
      ) {
        const seen = new Map<string, string>();
        for (
          const it of items as Array<{ options?: string[]; answer?: string }>
        ) {
          for (const w of [...(it.options ?? []), it.answer ?? ""]) {
            const k = w.trim().toLowerCase();
            if (k && !seen.has(k)) seen.set(k, w.trim());
          }
        }
        const bank = [...seen.values()];
        for (const it of items as Array<{ options?: string[] }>) {
          it.options = bank;
        }
      }
      const exercise = normalizeExercise({
        type,
        instruction: str(ex.instruction, 600),
        items,
      });
      const title = str(ex.title, 120) || `Exercise ${k + 1}`;
      const result = validateExercise(exercise, { units });
      for (const err of result.errors) {
        feedback.push(describe(expected, k + 1, err, exercise));
      }
      if (TEACHER_ADDRESS.test(exercise.instruction)) {
        feedback.push(
          `Page ${expected} exercise ${
            k + 1
          }: address the learner, never the teacher.`,
        );
      }
      exercises.push({ ...exercise, title } as Exercise & { title: string });
    });
    pages.push({
      page: expected,
      title: str(p.title, 160) || `Page ${expected}`,
      body,
      exercises,
    });
  }
  return feedback.length ? { ok: false, feedback } : { ok: true, pages };
}

const HINTS: Record<string, string> = {
  MCQ_DUPLICATE_OPTIONS:
    "two options are the same; make every option different",
  MCQ_OPTIONS_COUNT: "give 3 or 4 options",
  MCQ_ANSWER_NOT_IN_OPTIONS:
    "answer_index must point to the one correct option",
  WRONG_COMPARATIVE_AS_ANSWER:
    "'more + short adjective' is wrong; use the -er form",
  GAP_COUNT: "the prompt must contain exactly one ___",
  GAP_ANSWER_NOT_IN_BANK: "the answer must be in the word bank",
  NUMBERING_GAP: "number the items 1..N with no gaps",
  EMPTY_PROMPT: "write the item",
  MISSING_ANSWER: "give the answer",
  MISSING_MODEL_ANSWER: "give a short model answer",
  MATCH_DUPLICATE_LEFT: "every left term must be different",
  MATCH_NOT_ONE_TO_ONE: "every answer must be different (one to one)",
  TF_ANSWER_INVALID: 'answer must be "true" or "false"',
  TF_NEEDS_BOTH: "include both true and false statements",
  ANSWER_SAME_AS_PROMPT:
    "the answer must be a different (rewritten or corrected) sentence",
  REORDER_EMPTY: "give the correct sentence as the answer",
  REFERENCE_TO_MISSING_MEDIA:
    "remove the reference to pictures, audio or recordings",
  REFERENCE_TO_PAGE: "remove the page reference",
  REFERENCE_TO_MISSING_UNIT:
    "remove the reference to a unit that does not exist",
};

function describe(
  page: number,
  k: number,
  e: ValidationError,
  ex?: Exercise,
): string {
  const item = e.n ? ex?.items.find((it) => it.n === e.n) : undefined;
  const shown = item
    ? ` — current item: "${item.prompt}"${
      item.options?.length
        ? ` options: ${item.options.map((o) => `"${o}"`).join(", ")}`
        : ""
    }${item.answer ? ` answer: "${item.answer}"` : ""}`
    : "";
  const hint = `${HINTS[e.code] ?? e.code} [${e.code}]`;
  return `Page ${page} exercise ${k}${e.n ? ` item ${e.n}` : ""}: ${hint}${
    e.detail ? ` (${e.detail})` : ""
  }${shown}.`;
}

/** Palavras da resposta embaralhadas de forma determinística (nunca na ordem certa). */
export function scramble(answer: string): string[] {
  const tokens = answer.replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean)
    .map((
      w,
      i,
    ) => (i === 0 && w !== "I" && !/^[A-Z]{2,}/.test(w)
      ? w[0].toLowerCase() + w.slice(1)
      : w)
    );
  if (tokens.length < 2) return tokens;
  const out = [
    ...tokens.filter((_, i) => i % 2 === 1),
    ...tokens.filter((_, i) => i % 2 === 0),
  ];
  return out.join(" ") === tokens.join(" ") ? [...tokens].reverse() : out;
}

const LETTERS = "abcdefghij";

/** Ordem determinística dos termos da direita no "match" (nunca a mesma da esquerda). */
function matchOrder(n: number): number[] {
  const idx = [...Array(n).keys()];
  return n > 1 ? [...idx.slice(1), idx[0]] : idx;
}

function exerciseTitle(ex: Exercise): string {
  return (ex as Exercise & { title?: string }).title ?? "";
}

/** Página em Markdown, exatamente como vai ao Gamma (modo preserve). */
export function renderPage(p: ContentPage): string {
  const out = [`# ${p.title}`, "", p.body.trim()];
  p.exercises.forEach((ex, k) => {
    out.push(
      "",
      `## Exercise ${k + 1} — ${exerciseTitle(ex)}`,
      `*${ex.instruction}*`,
      "",
    );
    if (ex.type === "match") {
      const order = matchOrder(ex.items.length);
      ex.items.forEach((it) => out.push(`${it.n}. ${it.prompt}`));
      out.push(
        "",
        order.map((i, pos) => `${LETTERS[pos]}) ${ex.items[i].answer}`).join(
          "   ",
        ),
      );
      return;
    }
    for (const it of ex.items) {
      if (ex.type === "mcq") {
        out.push(
          `${it.n}. ${it.prompt}`,
          `   ${
            (it.options ?? []).map((o, i) => `${LETTERS[i]}) ${o}`).join("   ")
          }`,
        );
      } else if (ex.type === "reorder") {
        out.push(`${it.n}. ${(it.words ?? []).join(" / ")}`);
      } else if (ex.type === "tf") {
        out.push(`${it.n}. ${it.prompt} (True / False)`);
      } else {
        out.push(`${it.n}. ${it.prompt}`);
      }
    }
    if (ex.type === "gap" && ex.items.some((it) => it.options?.length)) {
      const bank = [...new Set(ex.items.flatMap((it) => it.options ?? []))];
      out.push("", `Word bank: ${bank.join(" · ")}`);
    }
  });
  return out.join("\n");
}

function keyLine(ex: Exercise, it: Exercise["items"][number]): string {
  if (ex.type === "match") {
    const order = matchOrder(ex.items.length);
    const pos = order.indexOf(ex.items.indexOf(it));
    return `${it.n}. ${it.prompt} → ${LETTERS[pos]}) ${it.answer ?? ""}`;
  }
  return answerLine(ex.type, it);
}

/** Páginas de gabarito montadas por código a partir das respostas estruturadas. */
export function renderAnswerPages(
  pages: ContentPage[],
  answerPages: OutlinePage[],
): string[] {
  const sections: string[][] = [];
  for (const p of [...pages].sort((a, b) => a.page - b.page)) {
    p.exercises.forEach((ex, k) => {
      sections.push([
        `**Page ${p.page} · Exercise ${k + 1} — ${exerciseTitle(ex)}**`,
        ...ex.items.map((it) => keyLine(ex, it)),
      ]);
    });
  }
  const total = sections.reduce((n, s) => n + s.length, 0);
  const per = Math.ceil(total / Math.max(1, answerPages.length));
  const out: string[] = [];
  let current: string[] = [];
  let lines = 0;
  for (const s of sections) {
    if (
      lines > 0 && lines + s.length > per && out.length < answerPages.length - 1
    ) {
      out.push(current.join("\n"));
      current = [];
      lines = 0;
    }
    current.push(s.join("\n"), "");
    lines += s.length;
  }
  out.push(current.join("\n"));
  return answerPages.map((ap, i) =>
    [
      `# ${
        answerPages.length === 1
          ? "Answer key and model answers"
          : `Answer key — part ${i + 1}`
      }`,
      "",
      (out[i] ?? "").trim(),
    ].join("\n")
  );
}

/** Texto final do livro para o Gamma (páginas separadas por ---). */
export function buildFinalInput(
  spec: SchoolBookSpec,
  state: BookContentState,
): string {
  const outline = bookOutline(spec);
  const written = state.chunks.flatMap((c) => c.content ?? []);
  const byPage = new Map(written.map((p) => [p.page, p]));
  const answerOutline = outline.filter((p) => p.kind === "answers");
  const answers = renderAnswerPages(written, answerOutline);
  return outline.map((p) => {
    if (p.kind === "answers") return answers[answerOutline.indexOf(p)];
    const page = byPage.get(p.page);
    if (!page) throw new Error("BOOK_CONTENT_INCOMPLETE");
    return renderPage(page);
  }).join("\n---\n");
}

/** Brief da 2ª verificação (o modelo confere cada item contra a checklist). */
export function buildCheckPrompt(
  spec: SchoolBookSpec,
  pages: ContentPage[],
): string {
  const blocks = pages.map((p) => {
    const keys = p.exercises.map((ex, k) =>
      [
        `Exercise ${k + 1} KEY:`,
        ...ex.items.map((it) => `  ${keyLine(ex, it)}`),
      ].join("\n")
    ).join("\n");
    return `=== PAGE ${p.page} AS PRINTED ===\n${
      renderPage(p)
    }\n=== ANSWER KEY FOR PAGE ${p.page} ===\n${keys}`;
  });
  return [
    `You are a strict CEFR ${spec.level} English materials reviewer. Check every exercise item below against its KEY.`,
    "Report a problem for an item when: the key is wrong; more than one option is acceptable (also in informal speech); the key does not fit the blank grammatically; the sentence with the key inserted is ungrammatical; the item is ambiguous or does not match its instruction; a valid English construction is presented as an error; the item uses language clearly above the level; a true/false statement cannot be checked from the page text; the text refers to pictures, audio, pages or units that do not exist; the text addresses the teacher instead of the learner.",
    "Only judge what is shown. The other pages of this book (cover, other units, review, answer key) are written separately: references to other parts of THIS book are fine, unless they mention pictures, audio, page numbers or units that do not exist.",
    "severity = blocker only for a real error a teacher would catch in class: wrong or missing key, two acceptable answers, ungrammatical sentence with the key, instruction that does not match the task, valid English marked as wrong, a reference to something that does not exist. Everything else is minor.",
    "Think each item through BEFORE writing the list. Include an item only when you are certain there is a problem; if you conclude an item is fine, leave it out. Write one short sentence per problem, naming the fix.",
    "Do not report style preferences. If everything is correct, return an empty problems array. For page-level problems use exercise 0 and n 0.",
    "",
    ...blocks,
  ].join("\n");
}

export function checkFeedback(raw: unknown): string[] | null {
  if (!isObj(raw) || !Array.isArray(raw.problems)) return null;
  return raw.problems.filter(isObj).filter((p) => p.severity !== "minor").map((
    p,
  ) =>
    `Page ${p.page}${p.exercise ? ` exercise ${p.exercise}` : ""}${
      p.n ? ` item ${p.n}` : ""
    }: ${str(p.problem, 400)}`
  ).slice(0, 40);
}

/** Instruções ao Gamma no modo preserve: diagramar, nunca reescrever. */
export function buildPreserveInstructions(
  brandRules: string[],
  imageStyle: string | null,
): string {
  return [
    "Lay out the provided text exactly as written: one card per section separated by ---. Do not add, remove, reorder, summarize or rewrite any text, exercise, item, number, option or answer.",
    "Keep every numbered item and option on the same card as its exercise. Keep the answer key cards exactly as given.",
    "Use clean, printable A4 layouts with comfortable margins and no overflow. Images may decorate pages but must never contain legible text, books, logos or identifiable minors.",
    ...brandRules,
    ...(imageStyle
      ? [`Image guidance for every picture you choose: ${imageStyle}.`]
      : []),
  ].join(" ");
}
