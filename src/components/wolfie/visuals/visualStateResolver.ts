import type {
  GlobalMeetingLearnerIntent,
  GlobalMeetingPolicyStage,
} from "../../../../supabase/functions/_shared/wolfie-global-meeting-policy";

export const MEETING_STAGE_ORDER = [
  "discovery",
  "briefing",
  "guided_build",
  "practice",
  "feedback",
  "retry",
  "simulation",
  "readaptation",
  "improvisation",
  "assessment",
  "report",
  "completed",
] as const satisfies readonly GlobalMeetingPolicyStage[];

export type MeetingScenarioStatus =
  | "active"
  | "paused"
  | "awaiting_retry"
  | "completed";

export type MeetingVisualMode =
  | "roleplay"
  | "coach"
  | "retry"
  | "debrief";

export type MeetingVisualTone = "cyan" | "violet" | "amber" | "emerald";

export interface MeetingCheckpoint {
  counterpart: string | null;
  pendingQuestion: string | null;
  pendingDecision: string | null;
}

export interface MeetingStageMeta {
  label: string;
  eyebrow: string;
  description: string;
}

export const MEETING_STAGE_META: Record<
  GlobalMeetingPolicyStage,
  MeetingStageMeta
> = {
  discovery: {
    label: "Descoberta",
    eyebrow: "Entender a situação",
    description:
      "Identifique o único detalhe que realmente muda a dinâmica da reunião.",
  },
  briefing: {
    label: "Briefing",
    eyebrow: "Definir o contrato",
    description:
      "Confirme papéis, objetivo, decisão esperada, restrições e fechamento.",
  },
  guided_build: {
    label: "Construção guiada",
    eyebrow: "Preparar contribuições",
    description:
      "Construa blocos concisos sem transformar a prática em um roteiro decorado.",
  },
  practice: {
    label: "Prática",
    eyebrow: "Produzir com apoio",
    description:
      "Responda ao contexto e pratique uma competência profissional por vez.",
  },
  feedback: {
    label: "Feedback",
    eyebrow: "Observar evidências",
    description:
      "Revise a produção com exemplos concretos e versões que preservam o sentido.",
  },
  retry: {
    label: "Nova tentativa",
    eyebrow: "Aplicar o feedback",
    description:
      "Mantenha interlocutor, pergunta e decisão enquanto reformula a resposta.",
  },
  simulation: {
    label: "Simulação",
    eyebrow: "Reunião em andamento",
    description:
      "Interaja, esclareça, negocie e avance a decisão sem depender de monólogo.",
  },
  readaptation: {
    label: "Readaptação",
    eyebrow: "Transferir a competência",
    description:
      "Use a competência em um cenário que muda pelo menos duas variáveis materiais.",
  },
  improvisation: {
    label: "Improvisação",
    eyebrow: "Responder ao inesperado",
    description:
      "Lide com uma complicação realista sem perder o objetivo da reunião.",
  },
  assessment: {
    label: "Avaliação",
    eyebrow: "Demonstrar autonomia",
    description:
      "Conclua a resposta sem coaching; o feedback aparece somente ao final.",
  },
  report: {
    label: "Relatório",
    eyebrow: "Consolidar evidências",
    description:
      "Veja força demonstrada, prioridades, linguagem reutilizável e próximo desafio.",
  },
  completed: {
    label: "Concluído",
    eyebrow: "Prontidão registrada",
    description:
      "O treino foi encerrado e já pode alimentar uma nova missão relacionada.",
  },
};

export interface ResolveMeetingVisualStateInput {
  stage?: unknown;
  scenarioStatus?: unknown;
  learnerIntent?: unknown;
  requiresRetry?: boolean;
  counterpart?: unknown;
  pendingQuestion?: unknown;
  pendingDecision?: unknown;
}

export interface MeetingVisualState extends MeetingCheckpoint {
  stage: GlobalMeetingPolicyStage;
  stageRecognized: boolean;
  stageMeta: MeetingStageMeta;
  stageIndex: number;
  stageCount: number;
  progressValue: number;
  scenarioStatus: MeetingScenarioStatus;
  learnerIntent: GlobalMeetingLearnerIntent;
  mode: MeetingVisualMode;
  tone: MeetingVisualTone;
  statusLabel: string;
  statusDescription: string;
  freezesProgression: boolean;
  preservesCheckpoint: boolean;
  showCoachSheet: boolean;
  isTerminal: boolean;
}

const LEARNER_INTENTS = new Set<GlobalMeetingLearnerIntent>([
  "perform",
  "ask_doubt",
  "clarify_intent",
  "request_review",
  "request_model",
  "request_feedback",
]);

const normalizeToken = (value: unknown): string =>
  typeof value === "string"
    ? value
      .normalize("NFKC")
      .trim()
      .toLocaleLowerCase("en-US")
      .replace(/[\s-]+/g, "_")
    : "";

const boundedText = (value: unknown, limit: number): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .replaceAll("\u0000", "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
  return normalized || null;
};

const normalizeStage = (
  value: unknown,
): { stage: GlobalMeetingPolicyStage; recognized: boolean } => {
  const token = normalizeToken(value);
  const aliases: Record<string, GlobalMeetingPolicyStage> = {
    construction: "guided_build",
    memorization: "practice",
    complete: "completed",
    done: "completed",
  };
  const candidate = aliases[token] ?? token;
  const recognized = MEETING_STAGE_ORDER.includes(
    candidate as GlobalMeetingPolicyStage,
  );
  return {
    stage: recognized
      ? candidate as GlobalMeetingPolicyStage
      : "simulation",
    recognized,
  };
};

const normalizeIntent = (value: unknown): GlobalMeetingLearnerIntent => {
  const token = normalizeToken(value) as GlobalMeetingLearnerIntent;
  return LEARNER_INTENTS.has(token) ? token : "perform";
};

const normalizeScenarioStatus = (value: unknown): MeetingScenarioStatus => {
  const token = normalizeToken(value);
  if (["completed", "complete", "finished", "closed"].includes(token)) {
    return "completed";
  }
  if (["awaiting_retry", "retry", "requires_retry"].includes(token)) {
    return "awaiting_retry";
  }
  if (["paused", "pause", "coaching", "coach"].includes(token)) {
    return "paused";
  }
  return "active";
};

const statusPresentation = (
  status: MeetingScenarioStatus,
): Pick<
  MeetingVisualState,
  "mode" | "tone" | "statusLabel" | "statusDescription"
> => {
  switch (status) {
    case "paused":
      return {
        mode: "coach",
        tone: "violet",
        statusLabel: "Reunião pausada para coaching",
        statusDescription:
          "O checkpoint está preservado. Depois do apoio, a reunião volta ao mesmo ponto.",
      };
    case "awaiting_retry":
      return {
        mode: "retry",
        tone: "amber",
        statusLabel: "Nova tentativa necessária",
        statusDescription:
          "Aplique o feedback sem trocar o interlocutor, a pergunta ou a decisão.",
      };
    case "completed":
      return {
        mode: "debrief",
        tone: "emerald",
        statusLabel: "Treino concluído",
        statusDescription:
          "A evidência desta reunião está pronta para o relatório e o próximo desafio.",
      };
    default:
      return {
        mode: "roleplay",
        tone: "cyan",
        statusLabel: "Reunião em andamento",
        statusDescription:
          "Responda à pergunta ativa e ajude a decisão a avançar.",
      };
  }
};

export function resolveMeetingVisualState(
  input: ResolveMeetingVisualStateInput = {},
): MeetingVisualState {
  const normalizedStage = normalizeStage(input.stage);
  const learnerIntent = normalizeIntent(input.learnerIntent);
  const suppliedStatus = normalizeScenarioStatus(input.scenarioStatus);

  const scenarioStatus: MeetingScenarioStatus =
    normalizedStage.stage === "completed" || suppliedStatus === "completed"
      ? "completed"
      : input.requiresRetry || suppliedStatus === "awaiting_retry" ||
          normalizedStage.stage === "retry"
      ? "awaiting_retry"
      : suppliedStatus === "paused" || learnerIntent !== "perform"
      ? "paused"
      : "active";

  const stageIndex = MEETING_STAGE_ORDER.indexOf(normalizedStage.stage);
  const presentation = statusPresentation(scenarioStatus);

  return {
    stage: normalizedStage.stage,
    stageRecognized: normalizedStage.recognized,
    stageMeta: MEETING_STAGE_META[normalizedStage.stage],
    stageIndex,
    stageCount: MEETING_STAGE_ORDER.length,
    progressValue: scenarioStatus === "completed"
      ? 100
      : Math.round(((stageIndex + 1) / MEETING_STAGE_ORDER.length) * 100),
    scenarioStatus,
    learnerIntent,
    ...presentation,
    counterpart: boundedText(input.counterpart, 160),
    pendingQuestion: boundedText(input.pendingQuestion, 500),
    pendingDecision: boundedText(input.pendingDecision, 500),
    freezesProgression: scenarioStatus !== "active",
    preservesCheckpoint:
      scenarioStatus === "paused" || scenarioStatus === "awaiting_retry",
    showCoachSheet: scenarioStatus === "paused",
    isTerminal: scenarioStatus === "completed",
  };
}
