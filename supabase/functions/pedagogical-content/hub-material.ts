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

export const HUB_MATERIAL_PROMPT_VERSION = "hub-material-2026-09-18.v2";

export const HUB_MATERIAL_KINDS = [
  "worksheet",
  "quiz",
  "vocab_cards",
  "grammar_drill",
  "reading",
  "conversation",
  "journey",
] as const;

// A jornada tem sempre 12 semanas (90 dias): é o horizonte em que o aluno
// autônomo costuma desistir, e o plano existe para atravessá-lo.
export const HUB_JOURNEY_WEEKS = 12;
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

export const HUB_MATERIAL_AUDIENCES = ["kids", "teens", "adults"] as const;
export type HubMaterialAudience = typeof HUB_MATERIAL_AUDIENCES[number];

export interface HubMaterialSpec {
  kind: HubMaterialKind;
  niche: HubMaterialNiche;
  level: HubMaterialLevel;
  topic: string;
  // Objetivo do aluno em texto livre ("logística numa multinacional",
  // "intercâmbio no Canadá", "virar influencer"): é o que personaliza o
  // material e faz o aluno enxergar o inglês dentro da oportunidade dele.
  goal: string;
  audience: HubMaterialAudience;
  count: number;
  bilingual: boolean;
  extra: string;
}

// Leque gramatical por nível (CEFR): o modelo escolhe UM ponto daqui para o
// foco gramatical e não pode usar estrutura acima do nível. É o "guia
// gramatical de acordo com o nivelamento" que abre todo material.
export const CEFR_GRAMMAR_MAP: Record<HubMaterialLevel, string> = {
  A1:
    "verbo to be; present simple (afirmativa, negativa, perguntas com do/does); artigos a/an/the; plural; pronomes pessoais e possessivos; there is/there are; can/can't; preposições de lugar e tempo básicas; perguntas com WH; imperativo simples",
  A2:
    "past simple (regulares e irregulares); present continuous; going to e will; comparativos e superlativos; countable/uncountable com some/any/much/many; advérbios de frequência; should e have to; like/love + -ing; preposições de movimento",
  B1:
    "present perfect x past simple; first conditional; modais de dedução (must/might/can't); used to; relative clauses com who/which/that; passive básica; phrasal verbs comuns; question tags; too/enough; future com present continuous",
  B2:
    "second e third conditional; reported speech; passive completa; relative clauses definidas e não definidas; wish/if only; modais no passado (should have, could have); linking words de contraste e causa; gerúndio x infinitivo; ênfase com so/such",
  C1:
    "mixed conditionals; inversão (Not only…, Rarely…); cleft sentences (What I need is…); hedging e linguagem diplomática; discourse markers; registro formal x informal; collocations e expressões idiomáticas; substantivação",
  C2:
    "precisão idiomática e estilo; gramática do discurso; ênfase, elipse e substituição; nuance de modalidade; tudo liberado, com atenção a naturalidade e registro",
};

const AUDIENCE_GUIDANCE: Record<HubMaterialAudience, string> = {
  kids:
    "criança: linguagem lúdica, frases curtas, muita repetição, personagens e jogo; nada de contexto corporativo",
  teens:
    "adolescente: escola, amigos, redes sociais, intercâmbio, host family; tom leve, exemplos que um teen reconhece",
  adults:
    "adulto: situações reais de trabalho ou vida pessoal conforme o objetivo; tom direto e respeitoso",
};

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
  journey:
    "jornada de 90 dias (plano de 12 semanas, uma por linha, com progressão gramatical dentro do nível)",
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
  const rawCount = kind === "journey"
    ? HUB_JOURNEY_WEEKS
    : body.count === undefined || body.count === null
    ? 8
    : Number(body.count);
  if (
    !Number.isInteger(rawCount) || rawCount < HUB_MATERIAL_MIN_ITEMS ||
    rawCount > HUB_MATERIAL_MAX_ITEMS
  ) {
    return { ok: false, code: "INVALID_MATERIAL_COUNT" };
  }
  const audience = typeof body.audience === "string"
    ? body.audience.trim().toLowerCase()
    : "adults";
  if (!(HUB_MATERIAL_AUDIENCES as readonly string[]).includes(audience)) {
    return { ok: false, code: "INVALID_MATERIAL_AUDIENCE" };
  }
  return {
    ok: true,
    spec: {
      kind: kind as HubMaterialKind,
      niche: niche as HubMaterialNiche,
      level: level as HubMaterialLevel,
      topic,
      goal: sanitizeFreeText(body.goal, HUB_MATERIAL_MAX_TOPIC),
      audience: audience as HubMaterialAudience,
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

// Blocos que TODO material carrega: foco gramatical do nível, a "porta que
// abre" (o inglês dentro da oportunidade do aluno) e homework com IA (o aluno
// aprende a se virar com a inteligência artificial entre as aulas).
const COMMON_BLOCKS = {
  grammar_focus: obj({
    point: str,
    why_pt: str,
    patterns: arr(obj({ en: str, pt: str })),
    watch_out_pt: arr(str),
  }),
  opportunity_pt: str,
  ai_homework: arr(obj({ task_pt: str, prompt_en: str, tip_pt: str })),
};

const READING_STRATEGIES = obj({
  skimming: obj({ instruction_pt: str, question: str, time_seconds: int }),
  scanning: arr(obj({ question: str, answer: str })),
  chunks: arr(obj({ chunk: str, pt: str })),
  shadowing: obj({ passage: str, focus_pt: str }),
});

const SHADOWING = obj({ lines: arr(str), focus_pt: str });

const HUB_MATERIAL_SCHEMAS: Record<HubMaterialKind, JsonObject> = {
  quiz: obj({
    title: str,
    instructions_pt: str,
    ...COMMON_BLOCKS,
    questions: arr(MC_QUESTION),
  }),
  vocab_cards: obj({
    title: str,
    instructions_pt: str,
    ...COMMON_BLOCKS,
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
    ...COMMON_BLOCKS,
    examples: arr(obj({ en: str, pt: str })),
    exercises: arr(MC_QUESTION),
  }),
  reading: obj({
    title: str,
    text: str,
    ...COMMON_BLOCKS,
    glossary: arr(obj({ term: str, translation_pt: str })),
    strategies: READING_STRATEGIES,
    questions: arr(MC_QUESTION),
    discussion: arr(str),
  }),
  worksheet: obj({
    title: str,
    objective_pt: str,
    ...COMMON_BLOCKS,
    warm_up: arr(str),
    fill_blanks: arr(obj({ prompt: str, answer: str, hint_pt: str })),
    multiple_choice: arr(MC_QUESTION),
    open_questions: arr(obj({ prompt: str, model_answer: str })),
    homework_pt: str,
  }),
  journey: obj({
    title: str,
    objective_pt: str,
    promise_pt: str,
    weeks: arr(obj({
      week: int,
      theme: str,
      grammar_point: str,
      material_kind: str,
      outcome_pt: str,
      class_plan_pt: arr(str),
      homework_pt: str,
    })),
    milestones: arr(obj({ week: int, checkpoint_pt: str })),
    retention_moves_pt: arr(obj({ week: int, move_pt: str })),
  }),
  conversation: obj({
    title: str,
    situation_pt: str,
    ...COMMON_BLOCKS,
    roles: arr(obj({ name: str, description_pt: str })),
    useful_phrases: arr(obj({ en: str, pt: str })),
    dialogue: arr(obj({ speaker: str, line: str })),
    shadowing: SHADOWING,
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
      } palavras sobre o tema, um glossário de 6 termos, exatamente ${n} perguntas de compreensão (4 alternativas, uma correta) e 3 perguntas de discussão oral. Em "strategies": skimming (instrução em pt-BR, UMA pergunta de ideia geral e um limite de tempo em segundos entre 30 e 90), scanning (3 perguntas de dado específico com a resposta exata do texto), chunks (o texto dividido em 6–10 blocos de sentido, cada um com a tradução) e shadowing (um trecho de 2–3 frases do texto para o aluno repetir em voz alta junto com o áudio, com o foco de pronúncia/ritmo em pt-BR).`;
    case "worksheet":
      return `Monte uma folha de exercícios com: 3 perguntas de aquecimento oral (warm_up), ${
        Math.max(3, Math.round(n / 2))
      } lacunas (fill_blanks, "___" na frase, resposta e dica em pt-BR), ${
        Math.max(3, Math.round(n / 2))
      } questões de múltipla escolha (4 alternativas, uma correta), 3 perguntas abertas com resposta-modelo e uma tarefa de casa curta (homework_pt).`;
    case "journey":
      return `Monte a JORNADA DE 90 DIAS do aluno: exatamente ${HUB_JOURNEY_WEEKS} semanas em "weeks" (week de 1 a ${HUB_JOURNEY_WEEKS}), cada uma com: "theme" (situação real do objetivo do aluno, em inglês), "grammar_point" (UM ponto do leque gramatical do nível, em ordem progressiva — comece pelo mais básico e não repita sem propósito), "material_kind" (um de: worksheet, quiz, vocab_cards, grammar_drill, reading, conversation — varie ao longo das semanas), "outcome_pt" (o que o aluno consegue fazer ao fim da semana, em pt-BR, ligado ao objetivo), "class_plan_pt" (3 passos da aula de 30 minutos, em pt-BR) e "homework_pt" (tarefa curta para a semana). "promise_pt": 1–2 frases dizendo onde o aluno vai estar no dia 90. "milestones": checkpoints nas semanas 4, 8 e 12 (o que avaliar e como o aluno percebe o progresso). "retention_moves_pt": 4 ações do professor para segurar o aluno nas semanas 1, 3, 6 e 10 (mensagem de boas-vindas com o plano, mostrar o progresso, renegociar rotina, preparar a renovação).`;
    case "conversation":
      return `Descreva a situação em pt-BR, defina 2 papéis, liste ${n} frases úteis (en + pt), escreva um diálogo-modelo de 10–16 falas alternando os papéis, "shadowing" com 4–6 falas do diálogo para o aluno repetir em voz alta (lines) e o foco de entonação em pt-BR (focus_pt), 4 perguntas para praticar sem roteiro e notas para o professor (teacher_notes_pt).`;
  }
};

export function buildHubMaterialPrompt(spec: HubMaterialSpec): string {
  const bilingual = spec.bilingual
    ? "Traduções e explicações em português do Brasil, conteúdo de prática em inglês."
    : "Explicações em português do Brasil curtas; o máximo possível do material em inglês (professor prefere imersão).";
  const goal = spec.goal || `usar inglês em ${NICHE_LABEL[spec.niche]}`;
  return [
    `Você está criando material de aula para um professor de inglês autônomo usar com o aluno dele. O material inteiro é PERSONALIZADO ao objetivo do aluno: ele precisa enxergar o inglês dentro da oportunidade dele, não em situações genéricas.`,
    ``,
    `TIPO DE MATERIAL: ${KIND_LABEL[spec.kind]}`,
    `NICHO / CONTEXTO: ${NICHE_LABEL[spec.niche]}`,
    `OBJETIVO DO ALUNO: ${goal}`,
    `FAIXA ETÁRIA: ${AUDIENCE_GUIDANCE[spec.audience]}`,
    `NÍVEL CEFR: ${spec.level}`,
    `TEMA PEDIDO PELO PROFESSOR: ${spec.topic}`,
    spec.extra ? `INSTRUÇÕES EXTRAS DO PROFESSOR: ${spec.extra}` : "",
    ``,
    `GRAMÁTICA PERMITIDA NO NÍVEL ${spec.level}: ${
      CEFR_GRAMMAR_MAP[spec.level]
    }.`,
    spec.kind === "journey"
      ? "Na jornada, cada semana usa UM ponto desse leque, em progressão; nada acima do nível."
      : `Em "grammar_focus" escolha UM ponto desse leque que sirva ao objetivo e ao tema: "point" em inglês (ex.: "Present simple for routines"), "why_pt" explica em 1–2 frases por que esse ponto abre porta para o objetivo do aluno, "patterns" traz 3 padrões de frase (en + pt) no contexto do aluno, "watch_out_pt" lista 2 erros comuns de brasileiro nesse ponto. Nada de estrutura acima do nível em nenhuma parte do material.`,
    ``,
    countGuidance(spec),
    ``,
    spec.kind === "journey"
      ? ""
      : `"opportunity_pt": 1–2 frases em pt-BR dizendo o que o aluno passa a conseguir fazer no objetivo dele com este material (ex.: "Com isso você consegue apresentar o status de um embarque na reunião semanal").`,
    spec.kind === "journey"
      ? ""
      : `"ai_homework": exatamente 2 tarefas de casa em que o aluno usa uma inteligência artificial (ChatGPT ou o Wolfie) para praticar sozinho: "task_pt" explica a tarefa em pt-BR, "prompt_en" é o prompt PRONTO em inglês que o aluno cola na IA (peça para a IA corrigir, dar feedback ou simular a situação do objetivo, sempre no nível ${spec.level}), "tip_pt" ensina como continuar a conversa com a IA (pedir versão mais natural, mais exemplos, corrigir de novo).`,
    ``,
    `Regras:`,
    `- Vocabulário e gramática 100% dentro do nível ${spec.level}; situações reais do nicho e do objetivo, nada genérico.`,
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

// Blocos comuns. O foco gramatical é obrigatório (é o "guia gramatical por
// nivelamento" que abre o material); os outros degradam para vazio.
const normalizeGrammarFocus = (
  value: unknown,
): JsonObject | null => {
  if (!isObject(value)) return null;
  const point = text(value.point, 160);
  const patterns = pairList(value.patterns, "en", "pt", 6);
  if (!point || patterns.length < 1) return null;
  return {
    point,
    why_pt: text(value.why_pt, 600),
    patterns,
    watch_out_pt: textList(value.watch_out_pt, 4),
  };
};

const normalizeAiHomework = (value: unknown): JsonObject[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
      if (!isObject(item)) return [];
      const task_pt = text(item.task_pt, 500);
      const prompt_en = text(item.prompt_en, 900);
      return task_pt && prompt_en
        ? [{ task_pt, prompt_en, tip_pt: text(item.tip_pt, 400) }]
        : [];
    }).slice(0, 3)
    : [];

const normalizeCommonBlocks = (
  raw: JsonObject,
): { ok: true; blocks: JsonObject } | { ok: false; code: string } => {
  const grammar_focus = normalizeGrammarFocus(raw.grammar_focus);
  if (!grammar_focus) {
    return { ok: false, code: "MATERIAL_GRAMMAR_FOCUS_MISSING" };
  }
  return {
    ok: true,
    blocks: {
      grammar_focus,
      opportunity_pt: text(raw.opportunity_pt, 500),
      ai_homework: normalizeAiHomework(raw.ai_homework),
    },
  };
};

const normalizeReadingStrategies = (value: unknown): JsonObject => {
  const source = isObject(value) ? value : {};
  const skimming = isObject(source.skimming) ? source.skimming : {};
  const shadowing = isObject(source.shadowing) ? source.shadowing : {};
  const seconds = Number(skimming.time_seconds);
  return {
    skimming: {
      instruction_pt: text(skimming.instruction_pt, 400),
      question: text(skimming.question, 300),
      time_seconds: Number.isInteger(seconds) && seconds >= 15 && seconds <= 180
        ? seconds
        : 60,
    },
    scanning: pairList(source.scanning, "question", "answer", 6),
    chunks: pairList(source.chunks, "chunk", "pt", 14),
    shadowing: {
      passage: text(shadowing.passage, 600),
      focus_pt: text(shadowing.focus_pt, 300),
    },
  };
};

const normalizeShadowing = (value: unknown): JsonObject => {
  const source = isObject(value) ? value : {};
  return {
    lines: textList(source.lines, 8),
    focus_pt: text(source.focus_pt, 300),
  };
};

// Jornada de 90 dias: 12 semanas numeradas 1..12 sem buraco, cada uma com tema,
// ponto gramatical, tipo de material válido e resultado. Semana faltando ou
// tipo inventado reprova — o professor vai clicar em "gerar material desta
// semana" e o tipo precisa existir.
const MATERIAL_KINDS_FOR_WEEKS = new Set<string>(
  HUB_MATERIAL_KINDS.filter((kind) => kind !== "journey"),
);

const normalizeJourney = (
  spec: HubMaterialSpec,
  raw: JsonObject,
  title: string,
): HubMaterialNormalization => {
  const byWeek = new Map<number, JsonObject>();
  if (Array.isArray(raw.weeks)) {
    for (const item of raw.weeks) {
      if (!isObject(item)) continue;
      const week = Number(item.week);
      const theme = text(item.theme, 200);
      const grammar_point = text(item.grammar_point, 160);
      const material_kind = text(item.material_kind, 40).toLowerCase();
      if (
        !Number.isInteger(week) || week < 1 || week > HUB_JOURNEY_WEEKS ||
        !theme || !grammar_point ||
        !MATERIAL_KINDS_FOR_WEEKS.has(material_kind) ||
        byWeek.has(week)
      ) continue;
      byWeek.set(week, {
        week,
        theme,
        grammar_point,
        material_kind,
        outcome_pt: text(item.outcome_pt, 400),
        class_plan_pt: textList(item.class_plan_pt, 5),
        homework_pt: text(item.homework_pt, 400),
      });
    }
  }
  const weeks = Array.from(
    { length: HUB_JOURNEY_WEEKS },
    (_, index) => byWeek.get(index + 1),
  );
  if (weeks.some((week) => !week)) {
    return {
      ok: false,
      code: "MATERIAL_JOURNEY_INCOMPLETE",
      detail: `${byWeek.size} de ${HUB_JOURNEY_WEEKS} semanas válidas`,
    };
  }
  const milestones = Array.isArray(raw.milestones)
    ? raw.milestones.flatMap((item) => {
      if (!isObject(item)) return [];
      const week = Number(item.week);
      const checkpoint_pt = text(item.checkpoint_pt, 400);
      return Number.isInteger(week) && week >= 1 && week <= HUB_JOURNEY_WEEKS &&
          checkpoint_pt
        ? [{ week, checkpoint_pt }]
        : [];
    }).slice(0, 4)
    : [];
  const retention_moves_pt = Array.isArray(raw.retention_moves_pt)
    ? raw.retention_moves_pt.flatMap((item) => {
      if (!isObject(item)) return [];
      const week = Number(item.week);
      const move_pt = text(item.move_pt, 400);
      return Number.isInteger(week) && week >= 1 && week <= HUB_JOURNEY_WEEKS &&
          move_pt
        ? [{ week, move_pt }]
        : [];
    }).slice(0, 6)
    : [];
  return {
    ok: true,
    value: {
      title,
      dropped: 0,
      material: {
        title,
        objective_pt: text(raw.objective_pt, 600) || spec.goal,
        promise_pt: text(raw.promise_pt, 500),
        weeks: weeks as JsonObject[],
        milestones,
        retention_moves_pt,
      },
    },
  };
};

export function normalizeHubMaterial(
  spec: HubMaterialSpec,
  raw: unknown,
): HubMaterialNormalization {
  if (!isObject(raw)) return { ok: false, code: "MATERIAL_NOT_OBJECT" };
  const minimum = Math.min(3, spec.count);
  let dropped = 0;
  const title = text(raw.title, 140) || `${spec.topic} — ${spec.level}`;
  if (spec.kind === "journey") return normalizeJourney(spec, raw, title);
  const common = normalizeCommonBlocks(raw);
  if (!common.ok) return { ok: false, code: common.code };
  const blocks = common.blocks;

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
            ...blocks,
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
            ...blocks,
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
            ...blocks,
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
            ...blocks,
            text: body,
            glossary: pairList(raw.glossary, "term", "translation_pt", 12),
            strategies: normalizeReadingStrategies(raw.strategies),
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
            ...blocks,
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
            ...blocks,
            situation_pt: text(raw.situation_pt, 800),
            roles: pairList(raw.roles, "name", "description_pt", 4),
            useful_phrases,
            dialogue,
            shadowing: normalizeShadowing(raw.shadowing),
            practice_questions: textList(raw.practice_questions, 8),
            teacher_notes_pt: text(raw.teacher_notes_pt, 800),
          },
        },
      };
    }
  }
}
