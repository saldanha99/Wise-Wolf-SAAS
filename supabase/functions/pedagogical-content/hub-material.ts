// Gerador de material do Wise Wolf Hub — a parte PURA (sem I/O).
//
// O professor autônomo escolhe tipo × nicho × nível × tema e recebe um
// material pronto para imprimir/usar com o aluno dele. Aqui vivem: a leitura da
// especificação, o prompt, o schema estrito por tipo (structured output) e a
// normalização da resposta — incluindo a auditoria do gabarito das questões de
// múltipla escolha, a mesma do `wolfie-activity` (a IA propõe, o código veta).
//
// Sem nada de Supabase ou fetch aqui de propósito: é o que permite testar cada
// regra em `hub-material.test.ts` sem provedor.

import { auditQuestionKey } from "../wolfie-activity/answer-key-audit.ts";

export const HUB_MATERIAL_PROMPT_VERSION = "hub-material-2026-09-18";

export const HUB_MATERIAL_KINDS = [
  "worksheet",
  "quiz",
  "vocab_cards",
  "grammar_drill",
  "reading",
  "conversation",
] as const;
export type HubMaterialKind = typeof HUB_MATERIAL_KINDS[number];

export const HUB_MATERIAL_NICHES = [
  "GENERAL",
  "BUSINESS",
  "TECH",
  "TRAVEL",
  "MEDICINE",
  "KIDS",
  "TOEFL_IELTS",
  "CONVERSATION",
] as const;
export type HubMaterialNiche = typeof HUB_MATERIAL_NICHES[number];

export const HUB_MATERIAL_LEVELS = [
  "A1",
  "A2",
  "B1",
  "B2",
  "C1",
  "C2",
] as const;
export type HubMaterialLevel = typeof HUB_MATERIAL_LEVELS[number];

export const HUB_MATERIAL_MIN_ITEMS = 4;
export const HUB_MATERIAL_MAX_ITEMS = 15;
export const HUB_MATERIAL_MAX_TOPIC = 200;
export const HUB_MATERIAL_MAX_EXTRA = 600;

export interface HubMaterialSpec {
  kind: HubMaterialKind;
  niche: HubMaterialNiche;
  level: HubMaterialLevel;
  topic: string;
  count: number;
  bilingual: boolean;
  extra: string;
}

export type HubMaterialSpecParse =
  | { ok: true; spec: HubMaterialSpec }
  | { ok: false; code: string };

type JsonObject = Record<string, unknown>;

const NICHE_LABEL: Record<HubMaterialNiche, string> = {
  GENERAL: "inglês geral (situações do dia a dia)",
  BUSINESS: "inglês para negócios e trabalho corporativo",
  TECH: "inglês para profissionais de tecnologia e TI",
  TRAVEL: "inglês para viagens",
  MEDICINE: "inglês para profissionais de saúde",
  KIDS: "inglês para crianças (lúdico, frases curtas, muita repetição)",
  TOEFL_IELTS:
    "preparação para TOEFL/IELTS (formato de prova, registro acadêmico)",
  CONVERSATION: "conversação e fluência",
};

const KIND_LABEL: Record<HubMaterialKind, string> = {
  worksheet: "worksheet (folha de exercícios mista)",
  quiz: "quiz de múltipla escolha",
  vocab_cards: "cards de vocabulário",
  grammar_drill: "drill de gramática",
  reading: "leitura com compreensão",
  conversation: "roteiro de conversação / role-play",
};

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

// Texto vindo do professor entra no prompt como dado; tira o que poderia ser
// lido como instrução de sistema e limita o tamanho.
const sanitizeFreeText = (value: unknown, maxLength: number): string => {
  if (typeof value !== "string") return "";
  return collapse(value.replace(/[<>{}]/g, " ")).slice(0, maxLength);
};

export function parseHubMaterialSpec(body: JsonObject): HubMaterialSpecParse {
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  if (!(HUB_MATERIAL_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, code: "INVALID_MATERIAL_KIND" };
  }
  const niche = typeof body.niche === "string"
    ? body.niche.trim().toUpperCase()
    : "GENERAL";
  if (!(HUB_MATERIAL_NICHES as readonly string[]).includes(niche)) {
    return { ok: false, code: "INVALID_MATERIAL_NICHE" };
  }
  const level = typeof body.level === "string"
    ? body.level.trim().toUpperCase()
    : "";
  if (!(HUB_MATERIAL_LEVELS as readonly string[]).includes(level)) {
    return { ok: false, code: "INVALID_MATERIAL_LEVEL" };
  }
  const topic = sanitizeFreeText(body.topic, HUB_MATERIAL_MAX_TOPIC);
  if (topic.length < 3) return { ok: false, code: "MATERIAL_TOPIC_REQUIRED" };
  const rawCount = body.count === undefined || body.count === null
    ? 8
    : Number(body.count);
  if (
    !Number.isInteger(rawCount) || rawCount < HUB_MATERIAL_MIN_ITEMS ||
    rawCount > HUB_MATERIAL_MAX_ITEMS
  ) {
    return { ok: false, code: "INVALID_MATERIAL_COUNT" };
  }
  return {
    ok: true,
    spec: {
      kind: kind as HubMaterialKind,
      niche: niche as HubMaterialNiche,
      level: level as HubMaterialLevel,
      topic,
      count: rawCount,
      bilingual: body.bilingual !== false,
      extra: sanitizeFreeText(body.extra, HUB_MATERIAL_MAX_EXTRA),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Schemas estritos (structured output): todo objeto lista todas as chaves em
// `required` e fecha `additionalProperties` — é o que o modo strict exige.
// Sem minItems/maxItems (não suportados no strict); a quantidade vai no prompt.
// ─────────────────────────────────────────────────────────────

const str = { type: "string" } as const;
const int = { type: "integer" } as const;
const arr = (items: unknown) => ({ type: "array", items });
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});

const MC_QUESTION = obj({
  prompt: str,
  options: arr(str),
  correct: int,
  explanation_pt: str,
});

const HUB_MATERIAL_SCHEMAS: Record<HubMaterialKind, JsonObject> = {
  quiz: obj({
    title: str,
    instructions_pt: str,
    questions: arr(MC_QUESTION),
  }),
  vocab_cards: obj({
    title: str,
    instructions_pt: str,
    cards: arr(obj({
      term: str,
      translation_pt: str,
      definition_en: str,
      example: str,
      example_pt: str,
    })),
  }),
  grammar_drill: obj({
    title: str,
    rule_pt: str,
    examples: arr(obj({ en: str, pt: str })),
    exercises: arr(MC_QUESTION),
  }),
  reading: obj({
    title: str,
    text: str,
    glossary: arr(obj({ term: str, translation_pt: str })),
    questions: arr(MC_QUESTION),
    discussion: arr(str),
  }),
  worksheet: obj({
    title: str,
    objective_pt: str,
    warm_up: arr(str),
    fill_blanks: arr(obj({ prompt: str, answer: str, hint_pt: str })),
    multiple_choice: arr(MC_QUESTION),
    open_questions: arr(obj({ prompt: str, model_answer: str })),
    homework_pt: str,
  }),
  conversation: obj({
    title: str,
    situation_pt: str,
    roles: arr(obj({ name: str, description_pt: str })),
    useful_phrases: arr(obj({ en: str, pt: str })),
    dialogue: arr(obj({ speaker: str, line: str })),
    practice_questions: arr(str),
    teacher_notes_pt: str,
  }),
};

export function hubMaterialResponseSchema(kind: HubMaterialKind): JsonObject {
  return HUB_MATERIAL_SCHEMAS[kind];
}

// ─────────────────────────────────────────────────────────────
// Prompt
// ─────────────────────────────────────────────────────────────

const countGuidance = (spec: HubMaterialSpec): string => {
  const n = spec.count;
  switch (spec.kind) {
    case "quiz":
      return `Gere exatamente ${n} perguntas de múltipla escolha, 4 alternativas cada, uma única correta (campo "correct" é o índice 0–3).`;
    case "vocab_cards":
      return `Gere exatamente ${n} cards. Cada card: termo em inglês, tradução pt-BR, definição curta em inglês, frase de exemplo em inglês e a tradução da frase.`;
    case "grammar_drill":
      return `Explique a regra em pt-BR (rule_pt, 2–4 frases), dê 3 exemplos (en + pt) e gere exatamente ${n} exercícios de lacuna ("___" na frase) com 3 alternativas cada e uma única correta.`;
    case "reading":
      return `Escreva um texto em inglês de ${
        spec.level === "A1" || spec.level === "A2"
          ? "80–130"
          : spec.level === "B1" || spec.level === "B2"
          ? "150–220"
          : "220–320"
      } palavras sobre o tema, um glossário de 6 termos, exatamente ${n} perguntas de compreensão (4 alternativas, uma correta) e 3 perguntas de discussão oral.`;
    case "worksheet":
      return `Monte uma folha de exercícios com: 3 perguntas de aquecimento oral (warm_up), ${
        Math.max(3, Math.round(n / 2))
      } lacunas (fill_blanks, "___" na frase, resposta e dica em pt-BR), ${
        Math.max(3, Math.round(n / 2))
      } questões de múltipla escolha (4 alternativas, uma correta), 3 perguntas abertas com resposta-modelo e uma tarefa de casa curta (homework_pt).`;
    case "conversation":
      return `Descreva a situação em pt-BR, defina 2 papéis, liste ${n} frases úteis (en + pt), escreva um diálogo-modelo de 10–16 falas alternando os papéis, 4 perguntas para praticar sem roteiro e notas para o professor (teacher_notes_pt).`;
  }
};

export function buildHubMaterialPrompt(spec: HubMaterialSpec): string {
  const bilingual = spec.bilingual
    ? "Traduções e explicações em português do Brasil, conteúdo de prática em inglês."
    : "Explicações em português do Brasil curtas; o máximo possível do material em inglês (professor prefere imersão).";
  return [
    `Você está criando material de aula para um professor de inglês autônomo usar com o aluno dele.`,
    ``,
    `TIPO DE MATERIAL: ${KIND_LABEL[spec.kind]}`,
    `NICHO / CONTEXTO: ${NICHE_LABEL[spec.niche]}`,
    `NÍVEL CEFR: ${spec.level}`,
    `TEMA PEDIDO PELO PROFESSOR: ${spec.topic}`,
    spec.extra ? `INSTRUÇÕES EXTRAS DO PROFESSOR: ${spec.extra}` : "",
    ``,
    countGuidance(spec),
    ``,
    `Regras:`,
    `- Vocabulário e gramática 100% dentro do nível ${spec.level}; situações reais do nicho, nada genérico.`,
    `- ${bilingual}`,
    `- Cada questão de múltipla escolha tem UMA resposta correta e as outras alternativas são plausíveis mas erradas; "correct" é o índice da correta; a explicação em pt-BR cita a resposta certa.`,
    `- Sem markdown, asteriscos ou bullets dentro dos valores. Título curto em inglês.`,
    `- Retorne somente o JSON no schema pedido.`,
  ].filter((line) => line !== null).join("\n");
}

// ─────────────────────────────────────────────────────────────
// Normalização + auditoria
// ─────────────────────────────────────────────────────────────

export interface NormalizedHubMaterial {
  material: JsonObject;
  title: string;
  dropped: number;
}

export type HubMaterialNormalization =
  | { ok: true; value: NormalizedHubMaterial }
  | { ok: false; code: string; detail?: string };

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown, max = 2_000): string =>
  typeof value === "string" ? collapse(value).slice(0, max) : "";

const textList = (value: unknown, max = 20): string[] =>
  Array.isArray(value)
    ? value.map((item) => text(item, 400)).filter(Boolean).slice(0, max)
    : [];

interface McQuestion {
  prompt: string;
  options: string[];
  correct: number;
  explanation_pt: string;
}

// Devolve só as questões que passam na auditoria de gabarito. Índice fora das
// alternativas ou alternativa vazia derrubam a questão antes da auditoria.
const normalizeMcQuestions = (
  value: unknown,
  max: number,
): { kept: McQuestion[]; dropped: number } => {
  if (!Array.isArray(value)) return { kept: [], dropped: 0 };
  const kept: McQuestion[] = [];
  let dropped = 0;
  for (const raw of value.slice(0, max + 5)) {
    if (!isObject(raw)) {
      dropped += 1;
      continue;
    }
    const prompt = text(raw.prompt, 600);
    const options = Array.isArray(raw.options)
      ? raw.options.map((option) => text(option, 200))
      : [];
    const correct = Number(raw.correct);
    if (
      !prompt || options.length < 2 || options.some((option) => !option) ||
      !Number.isInteger(correct) || correct < 0 || correct >= options.length ||
      new Set(options.map((option) => option.toLowerCase())).size !==
        options.length
    ) {
      dropped += 1;
      continue;
    }
    const explanation_pt = text(raw.explanation_pt, 600);
    const audit = auditQuestionKey({
      prompt,
      options,
      correctIndex: correct,
      explanationPt: explanation_pt || undefined,
    });
    if (audit.status === "rejected") {
      dropped += 1;
      continue;
    }
    kept.push({ prompt, options, correct, explanation_pt });
    if (kept.length >= max) break;
  }
  return { kept, dropped };
};

const pairList = (value: unknown, a: string, b: string, max = 20) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
      if (!isObject(item)) return [];
      const first = text(item[a], 400);
      const second = text(item[b], 400);
      return first && second ? [{ [a]: first, [b]: second }] : [];
    }).slice(0, max)
    : [];

export function normalizeHubMaterial(
  spec: HubMaterialSpec,
  raw: unknown,
): HubMaterialNormalization {
  if (!isObject(raw)) return { ok: false, code: "MATERIAL_NOT_OBJECT" };
  const minimum = Math.min(3, spec.count);
  let dropped = 0;
  const title = text(raw.title, 140) || `${spec.topic} — ${spec.level}`;

  switch (spec.kind) {
    case "quiz": {
      const questions = normalizeMcQuestions(raw.questions, spec.count);
      dropped += questions.dropped;
      if (questions.kept.length < minimum) {
        return {
          ok: false,
          code: "MATERIAL_TOO_FEW_VALID_QUESTIONS",
          detail: `${questions.kept.length} válidas`,
        };
      }
      return {
        ok: true,
        value: {
          title,
          dropped,
          material: {
            title,
            instructions_pt: text(raw.instructions_pt, 600),
            questions: questions.kept,
          },
        },
      };
    }
    case "vocab_cards": {
      const cards = Array.isArray(raw.cards)
        ? raw.cards.flatMap((card) => {
          if (!isObject(card)) return [];
          const term = text(card.term, 120);
          if (!term) return [];
          return [{
            term,
            translation_pt: text(card.translation_pt, 200),
            definition_en: text(card.definition_en, 300),
            example: text(card.example, 300),
            example_pt: text(card.example_pt, 300),
          }];
        }).slice(0, spec.count)
        : [];
      if (cards.length < minimum) {
        return { ok: false, code: "MATERIAL_TOO_FEW_ITEMS" };
      }
      return {
        ok: true,
        value: {
          title,
          dropped,
          material: {
            title,
            instructions_pt: text(raw.instructions_pt, 600),
            cards,
          },
        },
      };
    }
    case "grammar_drill": {
      const exercises = normalizeMcQuestions(raw.exercises, spec.count);
      dropped += exercises.dropped;
      const rule_pt = text(raw.rule_pt, 1_200);
      if (!rule_pt || exercises.kept.length < minimum) {
        return {
          ok: false,
          code: "MATERIAL_TOO_FEW_VALID_QUESTIONS",
          detail: `${exercises.kept.length} válidos`,
        };
      }
      return {
        ok: true,
        value: {
          title,
          dropped,
          material: {
            title,
            rule_pt,
            examples: pairList(raw.examples, "en", "pt", 6),
            exercises: exercises.kept,
          },
        },
      };
    }
    case "reading": {
      const body = text(raw.text, 4_000);
      const questions = normalizeMcQuestions(raw.questions, spec.count);
      dropped += questions.dropped;
      if (body.split(/\s+/).length < 40 || questions.kept.length < minimum) {
        return {
          ok: false,
          code: "MATERIAL_TOO_FEW_VALID_QUESTIONS",
          detail: `${questions.kept.length} válidas`,
        };
      }
      return {
        ok: true,
        value: {
          title,
          dropped,
          material: {
            title,
            text: body,
            glossary: pairList(raw.glossary, "term", "translation_pt", 12),
            questions: questions.kept,
            discussion: textList(raw.discussion, 6),
          },
        },
      };
    }
    case "worksheet": {
      const multiple = normalizeMcQuestions(
        raw.multiple_choice,
        Math.max(3, Math.round(spec.count / 2)),
      );
      dropped += multiple.dropped;
      const fill_blanks = Array.isArray(raw.fill_blanks)
        ? raw.fill_blanks.flatMap((item) => {
          if (!isObject(item)) return [];
          const prompt = text(item.prompt, 400);
          const answer = text(item.answer, 120);
          return prompt.includes("___") && answer
            ? [{ prompt, answer, hint_pt: text(item.hint_pt, 200) }]
            : [];
        }).slice(0, HUB_MATERIAL_MAX_ITEMS)
        : [];
      const open_questions = pairList(
        raw.open_questions,
        "prompt",
        "model_answer",
        8,
      );
      if (
        fill_blanks.length + multiple.kept.length + open_questions.length <
          minimum
      ) {
        return { ok: false, code: "MATERIAL_TOO_FEW_ITEMS" };
      }
      return {
        ok: true,
        value: {
          title,
          dropped,
          material: {
            title,
            objective_pt: text(raw.objective_pt, 600),
            warm_up: textList(raw.warm_up, 6),
            fill_blanks,
            multiple_choice: multiple.kept,
            open_questions,
            homework_pt: text(raw.homework_pt, 600),
          },
        },
      };
    }
    case "conversation": {
      const dialogue = pairList(raw.dialogue, "speaker", "line", 30);
      const useful_phrases = pairList(
        raw.useful_phrases,
        "en",
        "pt",
        HUB_MATERIAL_MAX_ITEMS,
      );
      if (dialogue.length < 4 || useful_phrases.length < minimum) {
        return { ok: false, code: "MATERIAL_TOO_FEW_ITEMS" };
      }
      return {
        ok: true,
        value: {
          title,
          dropped,
          material: {
            title,
            situation_pt: text(raw.situation_pt, 800),
            roles: pairList(raw.roles, "name", "description_pt", 4),
            useful_phrases,
            dialogue,
            practice_questions: textList(raw.practice_questions, 8),
            teacher_notes_pt: text(raw.teacher_notes_pt, 800),
          },
        },
      };
    }
  }
}
