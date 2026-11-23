// Validador comum de exercícios (livros do Gamma e gerador do Hub). Puro, sem IO.
//
// Regra de ouro: o gabarito NUNCA é texto livre do modelo. Cada item traz a resposta
// estruturada, este módulo confere o que dá para conferir por código e `answerLine`
// monta a linha do gabarito a partir do próprio item (mesmo número, frase completa).
// O que só o modelo confere (uma única alternativa aceitável, nível CEFR do foco)
// fica para a 2ª verificação do chamador.

export type ExerciseType =
  | "mcq"
  | "gap"
  | "reorder"
  | "match"
  | "tf"
  | "transform"
  | "correct_error"
  | "open";

export const EXERCISE_TYPES: readonly ExerciseType[] = [
  "mcq",
  "gap",
  "reorder",
  "match",
  "tf",
  "transform",
  "correct_error",
  "open",
];

export interface ExerciseItem {
  n: number;
  /** Enunciado do item. gap: exatamente um "___". correct_error: a frase com erro. transform: a frase de origem. */
  prompt: string;
  /** mcq: alternativas (2–5). */
  options?: string[];
  /** mcq: índice (0-based) da única correta. */
  answerIndex?: number;
  /** gap/reorder/transform/correct_error/open: resposta (frase ou palavra). tf: "true" | "false". match: o termo da direita. */
  answer?: string;
  /** reorder: as palavras embaralhadas, exatamente as da resposta. */
  words?: string[];
}

export interface Exercise {
  type: ExerciseType;
  instruction: string;
  items: ExerciseItem[];
}

export interface ValidationContext {
  /** Quantas unidades o livro tem (referência a "Unit N" acima disso reprova). */
  units?: number;
}

export interface ValidationError {
  n: number | null;
  code: string;
  detail?: string;
}

const GAP = /_{3,}/g;

/** Grafia britânica → americana (lista fechada; sem regra genérica de -ise). */
export const US_SPELLING: Record<string, string> = {
  realise: "realize",
  realised: "realized",
  realising: "realizing",
  organise: "organize",
  organised: "organized",
  organising: "organizing",
  recognise: "recognize",
  recognised: "recognized",
  apologise: "apologize",
  apologised: "apologized",
  colour: "color",
  colours: "colors",
  colourful: "colorful",
  favourite: "favorite",
  favourites: "favorites",
  behaviour: "behavior",
  neighbour: "neighbor",
  neighbours: "neighbors",
  flavour: "flavor",
  humour: "humor",
  labour: "labor",
  centre: "center",
  centres: "centers",
  theatre: "theater",
  metre: "meter",
  metres: "meters",
  litre: "liter",
  travelling: "traveling",
  travelled: "traveled",
  traveller: "traveler",
  travellers: "travelers",
  cancelled: "canceled",
  cancelling: "canceling",
  cosy: "cozy",
  programme: "program",
  programmes: "programs",
  catalogue: "catalog",
  dialogue: "dialog",
  grey: "gray",
  jewellery: "jewelry",
  mum: "mom",
  aeroplane: "airplane",
  defence: "defense",
  practise: "practice",
  analyse: "analyze",
};

const WRONG_COMPARATIVE =
  /\bmore\s+(?:busy|good|better|bad|worse|big|bigger|small|smaller|happy|easy|early|late|fast|cheap|hot|cold|long|short|young|old|tall|nice|big)\b/i;

/** Referência a coisa que o livro não tem (imagem, áudio, QR, página). */
const B = "(?<![\\p{L}\\d])";
const E = "(?![\\p{L}\\d])";
// Áudio, gravação, QR e faixa: sempre. Imagem/foto: só quando o texto APONTA para uma imagem
// ("look at the picture", "the photo above", "na imagem") — "the big picture" é idioma e passa.
const MISSING_MEDIA = new RegExp(
  [
    `${B}(?:audio|recording|qr ?code|play the track|track \\d+|áudio|gravação|faixa \\d+)${E}`,
    `${B}(?:look at|see|in|on|describe|use|study|check) (?:the|this|that|each|these|those|your|a) (?:pictures?|images?|photos?|photographs?|illustrations?|drawings?)${E}`,
    `${B}(?:the )?(?:pictures?|images?|photos?|illustrations?) (?:above|below|on the (?:left|right)|on this page|shows?)${E}`,
    `${B}(?:veja|observe|olhe|descreva|use) (?:a|as|o|os|esta|estas) (?:imagem|imagens|figuras?|fotos?|ilustraç(?:ão|ões))${E}`,
    `${B}(?:na|nas|no|nos|da|das) (?:imagem|imagens|figuras?|fotos?|ilustraç(?:ão|ões))${E}`,
  ].join("|"),
  "iu",
);
const PAGE_REF = new RegExp(`${B}(?:page|p\\.|página|pág\\.)\\s*\\d+`, "iu");
const UNIT_REF = new RegExp(
  `${B}(?:unit|unidade)s?\\s*(\\d+)(?:\\s*[–-]\\s*(\\d+))?`,
  "giu",
);

function words(s: string): string[] {
  return s.toLowerCase().replace(/[“”"’']/g, "'").match(/[a-z0-9']+/g) ?? [];
}

function normalized(s: string): string {
  return words(s).join(" ");
}

function bag(list: string[]): string {
  return [...list].sort().join("|");
}

/** Troca a grafia britânica da lista pela americana, preservando a caixa da 1ª letra. */
export function toUsSpelling(text: string): string {
  return text.replace(/\b[A-Za-z]+\b/g, (w) => {
    const us = US_SPELLING[w.toLowerCase()];
    if (!us) return w;
    return w[0] === w[0].toUpperCase() ? us[0].toUpperCase() + us.slice(1) : us;
  });
}

function textFields(ex: Exercise): string[] {
  const out = [ex.instruction];
  for (const it of ex.items) {
    out.push(it.prompt);
    if (it.answer) out.push(it.answer);
    for (const o of it.options ?? []) out.push(o);
  }
  return out;
}

/** Erros de texto que valem para qualquer bloco (exercício, explicação, leitura). */
export function validateText(
  text: string,
  ctx: ValidationContext = {},
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (MISSING_MEDIA.test(text)) {
    errors.push({
      n: null,
      code: "REFERENCE_TO_MISSING_MEDIA",
      detail: text.match(MISSING_MEDIA)?.[0],
    });
  }
  if (PAGE_REF.test(text)) {
    errors.push({
      n: null,
      code: "REFERENCE_TO_PAGE",
      detail: text.match(PAGE_REF)?.[0],
    });
  }
  for (const m of text.matchAll(UNIT_REF)) {
    const top = Number(m[2] ?? m[1]);
    if (ctx.units !== undefined && top > ctx.units) {
      errors.push({ n: null, code: "REFERENCE_TO_MISSING_UNIT", detail: m[0] });
    }
  }
  return errors;
}

export function validateExercise(
  ex: Exercise,
  ctx: ValidationContext = {},
): { ok: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  if (!EXERCISE_TYPES.includes(ex.type)) {
    return {
      ok: false,
      errors: [{ n: null, code: "UNKNOWN_TYPE", detail: String(ex.type) }],
    };
  }
  if (!ex.instruction?.trim()) {
    errors.push({ n: null, code: "MISSING_INSTRUCTION" });
  }
  if (!Array.isArray(ex.items) || ex.items.length === 0) {
    return { ok: false, errors: [...errors, { n: null, code: "NO_ITEMS" }] };
  }
  ex.items.forEach((it, i) => {
    if (it.n !== i + 1) {
      errors.push({
        n: it.n ?? null,
        code: "NUMBERING_GAP",
        detail: `esperado ${i + 1}`,
      });
    }
    if (!it.prompt?.trim()) errors.push({ n: it.n, code: "EMPTY_PROMPT" });
  });

  for (const text of textFields(ex)) {
    for (const e of validateText(text, ctx)) errors.push(e);
  }

  if (ex.type === "mcq") {
    for (const it of ex.items) {
      const opts = it.options ?? [];
      if (opts.length < 2 || opts.length > 5) {
        errors.push({ n: it.n, code: "MCQ_OPTIONS_COUNT" });
      }
      if (new Set(opts.map(normalized)).size !== opts.length) {
        errors.push({ n: it.n, code: "MCQ_DUPLICATE_OPTIONS" });
      }
      if (
        !Number.isInteger(it.answerIndex) || it.answerIndex! < 0 ||
        it.answerIndex! >= opts.length
      ) {
        errors.push({ n: it.n, code: "MCQ_ANSWER_NOT_IN_OPTIONS" });
      }
      if (WRONG_COMPARATIVE.test(opts[it.answerIndex ?? -1] ?? "")) {
        errors.push({ n: it.n, code: "WRONG_COMPARATIVE_AS_ANSWER" });
      }
    }
  }

  if (ex.type === "gap") {
    for (const it of ex.items) {
      const gaps = it.prompt.match(GAP)?.length ?? 0;
      if (gaps !== 1) {
        errors.push({ n: it.n, code: "GAP_COUNT", detail: String(gaps) });
      }
      if (!it.answer?.trim()) errors.push({ n: it.n, code: "MISSING_ANSWER" });
      if (it.options?.length) {
        // Banco de palavras: a resposta tem de estar nele.
        if (!it.options.map(normalized).includes(normalized(it.answer ?? ""))) {
          errors.push({ n: it.n, code: "GAP_ANSWER_NOT_IN_BANK" });
        }
      }
    }
  }

  if (ex.type === "reorder") {
    for (const it of ex.items) {
      const given = (it.words ?? []).flatMap(words);
      const answer = words(it.answer ?? "");
      if (!given.length || !answer.length) {
        errors.push({ n: it.n, code: "REORDER_EMPTY" });
      } else if (bag(given) !== bag(answer)) {
        errors.push({ n: it.n, code: "REORDER_WORDS_MISMATCH" });
      }
    }
  }

  if (ex.type === "match") {
    const lefts = ex.items.map((it) => normalized(it.prompt));
    const rights = ex.items.map((it) => normalized(it.answer ?? ""));
    if (new Set(lefts).size !== lefts.length) {
      errors.push({ n: null, code: "MATCH_DUPLICATE_LEFT" });
    }
    if (new Set(rights).size !== rights.length || rights.includes("")) {
      errors.push({ n: null, code: "MATCH_NOT_ONE_TO_ONE" });
    }
  }

  if (ex.type === "tf") {
    const answers = ex.items.map((it) =>
      (it.answer ?? "").trim().toLowerCase()
    );
    if (answers.some((a) => a !== "true" && a !== "false")) {
      errors.push({ n: null, code: "TF_ANSWER_INVALID" });
    }
    if (
      ex.items.length >= 2 &&
      (!answers.includes("true") || !answers.includes("false"))
    ) {
      errors.push({ n: null, code: "TF_NEEDS_BOTH" });
    }
  }

  if (ex.type === "transform" || ex.type === "correct_error") {
    for (const it of ex.items) {
      if (!it.answer?.trim()) {
        errors.push({ n: it.n, code: "MISSING_ANSWER" });
        continue;
      }
      const a = normalized(toUsSpelling(it.prompt));
      const b = normalized(toUsSpelling(it.answer));
      if (a === b) errors.push({ n: it.n, code: "ANSWER_SAME_AS_PROMPT" });
      if (WRONG_COMPARATIVE.test(it.answer)) {
        errors.push({ n: it.n, code: "WRONG_COMPARATIVE_AS_ANSWER" });
      }
    }
  }

  if (ex.type === "open") {
    for (const it of ex.items) {
      if (!it.answer?.trim()) {
        errors.push({ n: it.n, code: "MISSING_MODEL_ANSWER" });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Aplica a grafia americana em todos os textos do exercício (correção, não reprovação). */
export function normalizeExercise(ex: Exercise): Exercise {
  return {
    ...ex,
    instruction: toUsSpelling(ex.instruction),
    items: ex.items.map((it) => ({
      ...it,
      prompt: toUsSpelling(it.prompt),
      ...(it.answer !== undefined ? { answer: toUsSpelling(it.answer) } : {}),
      ...(it.options ? { options: it.options.map(toUsSpelling) } : {}),
      ...(it.words ? { words: it.words.map(toUsSpelling) } : {}),
    })),
  };
}

const LETTERS = "abcde";

/** Linha do gabarito montada a partir do item: mesmo número, frase completa com a resposta. */
export function answerLine(type: ExerciseType, it: ExerciseItem): string {
  switch (type) {
    case "mcq": {
      const i = it.answerIndex ?? -1;
      const opt = it.options?.[i] ?? "";
      const filled = /_{3,}/.test(it.prompt)
        ? it.prompt.replace(GAP, opt)
        : null;
      return `${it.n}. ${LETTERS[i] ?? "?"}) ${opt}${
        filled ? ` — ${filled}` : ""
      }`;
    }
    case "gap":
      return `${it.n}. ${it.prompt.replace(GAP, `**${it.answer ?? ""}**`)}`;
    case "tf":
      return `${it.n}. ${
        (it.answer ?? "").toLowerCase() === "true" ? "True" : "False"
      } — ${it.prompt}`;
    case "match":
      return `${it.n}. ${it.prompt} → ${it.answer ?? ""}`;
    case "open":
      return `${it.n}. Model answer: ${it.answer ?? ""}`;
    default:
      return `${it.n}. ${it.answer ?? ""}`;
  }
}
