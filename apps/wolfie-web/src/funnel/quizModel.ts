import {
  getExperienceById,
  getUniverseForExperience,
  type ExperienceSkill,
  type LearningExperience,
} from "../../../../src/components/wolfie/experienceCatalog";
import { WOLFIE_QUIZ_RETENTION_DAYS } from "../privacy";

export const PUBLIC_QUIZ_VERSION = 2 as const;
export const PUBLIC_QUIZ_STORAGE_KEY =
  `wolfie.public-quiz.v${PUBLIC_QUIZ_VERSION}` as const;

export type QuizGoal =
  | "global_meeting"
  | "interview"
  | "presentation"
  | "travel"
  | "conversation";

export type QuizContext =
  | "business"
  | "technology"
  | "health"
  | "laboratory"
  | "beauty"
  | "retail"
  | "logistics"
  | "tourism"
  | "aviation"
  | "general";

export type QuizParticipation =
  | "understand"
  | "respond"
  | "lead"
  | "present";

export type QuizDeclaredAbility =
  | "starting"
  | "short_exchanges"
  | "routine_conversations"
  | "complex_conversations"
  | "nuanced_conversations";

export type QuizObstacle =
  | "thinking_time"
  | "listening"
  | "vocabulary"
  | "pronunciation"
  | "structure";

export type QuizModality = "voice" | "text" | "mixed";
export type QuizUrgency =
  | "next_7_days"
  | "next_30_days"
  | "next_90_days"
  | "ongoing";
export type QuizPracticeMinutes = "5" | "10" | "15";
export type QuizStartingLevel = "A1" | "A2" | "B1" | "B2" | "C1";

export interface QuizAnswerByStep {
  goal: QuizGoal;
  context: QuizContext;
  participation: QuizParticipation;
  declaredAbility: QuizDeclaredAbility;
  obstacle: QuizObstacle;
  modality: QuizModality;
  urgency: QuizUrgency;
  practiceMinutes: QuizPracticeMinutes;
}

export type QuizStepId = keyof QuizAnswerByStep;
export type QuizAnswers = Partial<QuizAnswerByStep>;
export type CompleteQuizAnswers = QuizAnswerByStep;

export interface QuizOption {
  value: string;
  label: string;
  description?: string;
}

export interface QuizStepDefinition {
  id: QuizStepId;
  eyebrow: string;
  title: string;
  supportingText: string;
  options: readonly QuizOption[];
}

/**
 * Questionário curto de intenção. Ele recolhe somente escolhas enumeradas e não
 * tenta deduzir personalidade, gênero, profissão ou proficiência do visitante.
 */
export const PUBLIC_QUIZ_STEPS: readonly QuizStepDefinition[] = [
  {
    id: "goal",
    eyebrow: "Seu objetivo",
    title: "Qual situação você quer destravar primeiro?",
    supportingText: "Escolha a situação que faria mais diferença agora.",
    options: [
      { value: "global_meeting", label: "Participar de uma reunião global" },
      { value: "interview", label: "Fazer uma entrevista em inglês" },
      { value: "presentation", label: "Apresentar uma ideia ou projeto" },
      { value: "travel", label: "Viajar com mais autonomia" },
      { value: "conversation", label: "Conversar com mais espontaneidade" },
    ],
  },
  {
    id: "context",
    eyebrow: "Seu contexto",
    title: "Em qual ambiente essa prática precisa funcionar?",
    supportingText:
      "Isso aproxima os exemplos e o vocabulário do cenário que você escolheu.",
    options: [
      { value: "business", label: "Negócios e projetos" },
      { value: "technology", label: "Tecnologia e produto" },
      { value: "health", label: "Saúde e medicina" },
      { value: "laboratory", label: "Laboratórios e pesquisa" },
      { value: "beauty", label: "Beleza e cosméticos" },
      { value: "retail", label: "Varejo e comércio" },
      { value: "logistics", label: "Logística e operações" },
      { value: "tourism", label: "Turismo e hospitalidade" },
      { value: "aviation", label: "Aviação" },
      { value: "general", label: "Um contexto geral" },
    ],
  },
  {
    id: "participation",
    eyebrow: "Na prática",
    title: "O que você mais precisa fazer nessa situação?",
    supportingText: "Pense no comportamento que você quer ensaiar com o Wolfie.",
    options: [
      { value: "understand", label: "Entender o que as pessoas dizem" },
      { value: "respond", label: "Responder sem travar" },
      { value: "lead", label: "Conduzir e alinhar próximos passos" },
      { value: "present", label: "Explicar ou apresentar uma ideia" },
    ],
  },
  {
    id: "declaredAbility",
    eyebrow: "Ponto de partida",
    title: "Qual frase descreve melhor seu inglês hoje?",
    supportingText:
      "É uma autodeclaração para ajustar a prática, não um teste de nível.",
    options: [
      { value: "starting", label: "Estou começando e uso palavras soltas" },
      { value: "short_exchanges", label: "Consigo fazer trocas curtas" },
      {
        value: "routine_conversations",
        label: "Converso sobre temas conhecidos, mas ainda travo",
      },
      {
        value: "complex_conversations",
        label: "Sustento conversas e explico ideias com detalhes",
      },
      {
        value: "nuanced_conversations",
        label: "Lido com argumentos, nuances e imprevistos",
      },
    ],
  },
  {
    id: "obstacle",
    eyebrow: "Foco do treino",
    title: "O que mais atrapalha você nessa hora?",
    supportingText: "Escolha uma prioridade; outras habilidades também aparecerão.",
    options: [
      { value: "thinking_time", label: "Demoro para montar a resposta" },
      { value: "listening", label: "Não acompanho tudo o que ouço" },
      { value: "vocabulary", label: "Faltam palavras e expressões" },
      { value: "pronunciation", label: "Não me sinto claro ao falar" },
      { value: "structure", label: "Tenho ideias, mas falta estrutura" },
    ],
  },
  {
    id: "modality",
    eyebrow: "Formato",
    title: "Como você prefere começar a praticar?",
    supportingText: "Você poderá mudar o formato dentro do tutor.",
    options: [
      { value: "voice", label: "Falando em voz alta" },
      { value: "text", label: "Escrevendo primeiro" },
      { value: "mixed", label: "Misturando voz e texto" },
    ],
  },
  {
    id: "urgency",
    eyebrow: "Ritmo",
    title: "Quando você quer usar esse inglês?",
    supportingText: "A resposta ajusta somente a frequência sugerida de prática.",
    options: [
      { value: "next_7_days", label: "Nos próximos 7 dias" },
      { value: "next_30_days", label: "No próximo mês" },
      { value: "next_90_days", label: "Nos próximos 3 meses" },
      { value: "ongoing", label: "Quero evoluir sem uma data específica" },
    ],
  },
  {
    id: "practiceMinutes",
    eyebrow: "Sua rotina",
    title: "Quanto tempo cabe em uma prática por vez?",
    supportingText: "Sessões curtas e frequentes também contam.",
    options: [
      { value: "5", label: "5 minutos" },
      { value: "10", label: "10 minutos" },
      { value: "15", label: "15 minutos" },
    ],
  },
] as const;

export const PUBLIC_QUIZ_STEP_IDS = PUBLIC_QUIZ_STEPS.map(
  (step) => step.id,
) as readonly QuizStepId[];

export interface PublicQuizSnapshotV2 {
  version: typeof PUBLIC_QUIZ_VERSION;
  currentStep: QuizStepId;
  expiresAt: number;
  answers: QuizAnswers;
}

export interface RecommendedExperience {
  experienceId: string;
  universeId: string;
  title: string;
  matchScore: number;
}

export interface QuizRecommendation {
  version: typeof PUBLIC_QUIZ_VERSION;
  goal: QuizGoal;
  startingLevel: QuizStartingLevel;
  title: string;
  summary: string;
  primary: RecommendedExperience;
  alternatives: readonly RecommendedExperience[];
  practicePlan: {
    minutesPerSession: number;
    sessionsPerWeek: number;
    focus: string;
  };
  disclaimer: string;
}

const MEETING_EXPERIENCE_BY_CONTEXT: Readonly<Record<QuizContext, string>> = {
  business: "meetings-business",
  technology: "meetings-technology",
  health: "meetings-medicine",
  laboratory: "meetings-laboratories",
  beauty: "meetings-beauty",
  retail: "meetings-retail",
  logistics: "meetings-logistics",
  tourism: "meetings-tourism",
  aviation: "meetings-aviation",
  general: "meetings-business",
};

const GOAL_COPY: Readonly<
  Record<QuizGoal, { title: string; summary: string }>
> = {
  global_meeting: {
    title: "Seu ponto de partida é uma reunião global realista",
    summary:
      "Você vai praticar como entrar na conversa, construir sua mensagem e confirmar próximos passos.",
  },
  interview: {
    title: "Seu ponto de partida é uma entrevista guiada",
    summary:
      "Você vai organizar exemplos concretos, responder perguntas e tentar novamente com orientação.",
  },
  presentation: {
    title: "Seu ponto de partida é um ensaio de apresentação",
    summary:
      "Você vai estruturar a mensagem, ensaiar a entrega e lidar com uma pergunta inesperada.",
  },
  travel: {
    title: "Seu ponto de partida é resolver situações de viagem",
    summary:
      "Você vai pedir, confirmar e esclarecer informações em interações curtas do dia a dia.",
  },
  conversation: {
    title: "Seu ponto de partida é sustentar uma conversa",
    summary:
      "Você vai responder com uma ideia, uma razão e um exemplo, recebendo espaço para reformular.",
  },
};

const STARTING_LEVEL_BY_ABILITY: Readonly<
  Record<QuizDeclaredAbility, QuizStartingLevel>
> = {
  starting: "A1",
  short_exchanges: "A2",
  routine_conversations: "B1",
  complex_conversations: "B2",
  nuanced_conversations: "C1",
};

const FOCUS_BY_OBSTACLE: Readonly<Record<QuizObstacle, string>> = {
  thinking_time: "ganhar tempo e construir respostas em blocos",
  listening: "identificar a mensagem principal e confirmar entendimento",
  vocabulary: "recuperar expressões úteis dentro da situação",
  pronunciation: "falar com clareza e testar a mensagem novamente",
  structure: "organizar começo, desenvolvimento e fechamento",
};

const SKILLS_BY_OBSTACLE: Readonly<
  Record<QuizObstacle, readonly ExperienceSkill[]>
> = {
  thinking_time: ["speaking"],
  listening: ["listening"],
  vocabulary: ["vocabulary"],
  pronunciation: ["pronunciation"],
  structure: ["presentation", "writing"],
};

const SKILLS_BY_PARTICIPATION: Readonly<
  Record<QuizParticipation, readonly ExperienceSkill[]>
> = {
  understand: ["listening"],
  respond: ["speaking"],
  lead: ["speaking", "presentation"],
  present: ["presentation"],
};

const SESSIONS_PER_WEEK_BY_URGENCY: Readonly<Record<QuizUrgency, number>> = {
  next_7_days: 5,
  next_30_days: 4,
  next_90_days: 3,
  ongoing: 2,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isQuizStepId = (value: unknown): value is QuizStepId =>
  typeof value === "string" &&
  PUBLIC_QUIZ_STEP_IDS.some((stepId) => stepId === value);

const stepAcceptsValue = (stepId: QuizStepId, value: unknown): boolean => {
  if (typeof value !== "string") return false;
  const step = PUBLIC_QUIZ_STEPS.find((item) => item.id === stepId);
  return step?.options.some((option) => option.value === value) ?? false;
};

export const sanitizeQuizAnswers = (input: unknown): QuizAnswers => {
  if (!isRecord(input)) return {};

  const answers: QuizAnswers = {};
  for (const step of PUBLIC_QUIZ_STEPS) {
    const value = input[step.id];
    if (stepAcceptsValue(step.id, value)) {
      Object.assign(answers, { [step.id]: value });
    }
  }
  return answers;
};

export const isQuizComplete = (
  answers: QuizAnswers,
): answers is CompleteQuizAnswers =>
  PUBLIC_QUIZ_STEPS.every((step) =>
    stepAcceptsValue(step.id, answers[step.id]),
  );

export const firstUnansweredQuizStep = (
  answers: QuizAnswers,
): QuizStepId =>
  PUBLIC_QUIZ_STEPS.find(
    (step) => !stepAcceptsValue(step.id, answers[step.id]),
  )?.id ?? PUBLIC_QUIZ_STEPS[PUBLIC_QUIZ_STEPS.length - 1].id;

export const answerQuizStep = <Step extends QuizStepId>(
  answers: QuizAnswers,
  stepId: Step,
  value: QuizAnswerByStep[Step],
): QuizAnswers => {
  if (!stepAcceptsValue(stepId, value)) {
    throw new Error(`Resposta inválida para a etapa "${stepId}".`);
  }
  return { ...answers, [stepId]: value };
};

export const createQuizSnapshot = (
  answers: QuizAnswers,
  currentStep?: QuizStepId,
  expiresAt = Date.now() + WOLFIE_QUIZ_RETENTION_DAYS * 24 * 60 * 60 * 1000,
): PublicQuizSnapshotV2 => {
  const sanitizedAnswers = sanitizeQuizAnswers(answers);
  return {
    version: PUBLIC_QUIZ_VERSION,
    currentStep:
      currentStep && isQuizStepId(currentStep)
        ? currentStep
        : firstUnansweredQuizStep(sanitizedAnswers),
    expiresAt,
    answers: sanitizedAnswers,
  };
};

export const serializeQuizSnapshot = (
  snapshot: PublicQuizSnapshotV2,
): string =>
  JSON.stringify(
    createQuizSnapshot(
      snapshot.answers,
      snapshot.currentStep,
      snapshot.expiresAt,
    ),
  );

export const parseQuizSnapshot = (
  serialized: string | null | undefined,
): PublicQuizSnapshotV2 | null => {
  if (!serialized) return null;

  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== PUBLIC_QUIZ_VERSION) {
      return null;
    }
    if (
      typeof parsed.expiresAt !== "number" ||
      !Number.isFinite(parsed.expiresAt) ||
      parsed.expiresAt <= Date.now()
    ) return null;

    const answers = sanitizeQuizAnswers(parsed.answers);
    const currentStep = isQuizStepId(parsed.currentStep)
      ? parsed.currentStep
      : firstUnansweredQuizStep(answers);
    return createQuizSnapshot(answers, currentStep, parsed.expiresAt);
  } catch {
    return null;
  }
};

const resolveRecommendationIds = (
  answers: CompleteQuizAnswers,
): readonly [string, string, string] => {
  switch (answers.goal) {
    case "global_meeting":
      return [
        MEETING_EXPERIENCE_BY_CONTEXT[answers.context],
        "multinationals",
        "presentation-lab",
      ];
    case "interview":
      return answers.declaredAbility === "starting" ||
        answers.declaredAbility === "short_exchanges"
        ? ["job-interviews", "first-job", "introduce-yourself"]
        : ["job-interviews", "career-change", "promotion"];
    case "presentation":
      return answers.context === "health" || answers.context === "laboratory"
        ? ["presentation-lab", "poster-presentation", "talks"]
        : ["presentation-lab", "talks", "panels"];
    case "travel":
      return ["services", "shopping", "health-symptoms"];
    case "conversation":
      return ["give-your-opinion", "speak-for-a-minute", "tell-a-story"];
  }
};

const requireCatalogExperience = (experienceId: string): LearningExperience => {
  const experience = getExperienceById(experienceId);
  if (!experience) {
    throw new Error(
      `A experiência canônica "${experienceId}" não existe no catálogo do Wolfie.`,
    );
  }
  return experience;
};

const sharesAnySkill = (
  experience: LearningExperience,
  expected: readonly ExperienceSkill[],
): boolean => expected.some((skill) => experience.skills.includes(skill));

const scoreExperienceMatch = (
  experience: LearningExperience,
  answers: CompleteQuizAnswers,
  preferenceRank: number,
): number => {
  const goalRelevanceByRank = [10, 6, 3] as const;
  let score = 60 + (goalRelevanceByRank[preferenceRank] ?? 0);

  if (
    answers.goal === "global_meeting" &&
    experience.id === MEETING_EXPERIENCE_BY_CONTEXT[answers.context]
  ) {
    score += answers.context === "general" ? 2 : 4;
  }

  if (experience.modalities.includes(answers.modality)) score += 6;
  if (experience.durations.includes(Number(answers.practiceMinutes))) score += 5;
  if (sharesAnySkill(experience, SKILLS_BY_OBSTACLE[answers.obstacle])) score += 4;
  if (
    sharesAnySkill(experience, SKILLS_BY_PARTICIPATION[answers.participation])
  ) {
    score += 4;
  }

  return Math.min(100, score);
};

const toRecommendedExperience = (
  experienceId: string,
  answers: CompleteQuizAnswers,
  preferenceRank: number,
): RecommendedExperience => {
  const experience = requireCatalogExperience(experienceId);
  const universe = getUniverseForExperience(experienceId);
  if (!universe) {
    throw new Error(
      `A experiência canônica "${experienceId}" não pertence a um universo do Wolfie.`,
    );
  }

  return {
    experienceId,
    universeId: universe.id,
    title: experience.title,
    matchScore: scoreExperienceMatch(experience, answers, preferenceRank),
  };
};

export const recommendQuizExperience = (
  answers: QuizAnswers,
): QuizRecommendation => {
  const sanitizedAnswers = sanitizeQuizAnswers(answers);
  if (!isQuizComplete(sanitizedAnswers)) {
    throw new Error("Complete as oito etapas antes de gerar a recomendação.");
  }

  const rankedExperiences = resolveRecommendationIds(sanitizedAnswers)
    .map((experienceId, preferenceRank) => ({
      preferenceRank,
      recommendation: toRecommendedExperience(
        experienceId,
        sanitizedAnswers,
        preferenceRank,
      ),
    }))
    .sort((left, right) =>
      right.recommendation.matchScore - left.recommendation.matchScore ||
      left.preferenceRank - right.preferenceRank,
    )
    .map(({ recommendation }) => recommendation);
  const [primary, ...alternatives] = rankedExperiences;
  const copy = GOAL_COPY[sanitizedAnswers.goal];

  return {
    version: PUBLIC_QUIZ_VERSION,
    goal: sanitizedAnswers.goal,
    startingLevel:
      STARTING_LEVEL_BY_ABILITY[sanitizedAnswers.declaredAbility],
    title: copy.title,
    summary: copy.summary,
    primary,
    alternatives,
    practicePlan: {
      minutesPerSession: Number(sanitizedAnswers.practiceMinutes),
      sessionsPerWeek:
        SESSIONS_PER_WEEK_BY_URGENCY[sanitizedAnswers.urgency],
      focus: FOCUS_BY_OBSTACLE[sanitizedAnswers.obstacle],
    },
    disclaimer:
      "Esta recomendação organiza a prática a partir das escolhas declaradas. O índice mostra aderência ao objetivo; não é teste de proficiência nem diagnóstico.",
  };
};
