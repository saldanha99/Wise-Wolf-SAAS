import {
  GLOBAL_MEETING_MEMORY_TAXONOMY,
  type GlobalMeetingMemoryKind,
  type GlobalMeetingRubricScores,
  passesGlobalMeetingReadiness,
  scoreGlobalMeetingRubric,
} from "../_shared/wolfie-global-meeting-policy.ts";

export const MEETING_RETRY_SCORE = 75;
export const MEETING_COMPETENCY_GATE = 60;
export const MEETING_RECALL_SCORE = 75;
export const MEETING_RECALL_BLOCK_GATE = 60;

export const MEETING_SECTION_KEYS = [
  "opening",
  "context",
  "data",
  "proposal",
  "next_steps",
  "closing",
] as const;

export type MeetingSectionKey = typeof MEETING_SECTION_KEYS[number];

const DURABLE_MEETING_ASSESSMENT_STEPS = [
  "final",
  "final_speech",
  "memorization_complete",
  "readaptation",
  "readaptation_speech",
] as const;

/** Guided construction blocks are feedback, not autonomous cross-session
 * evidence. Only complete assessment/recall/transfer attempts may become a
 * canonical meeting memory. */
export function isDurableMeetingAssessmentStep(value: unknown): boolean {
  return typeof value === "string" &&
    (DURABLE_MEETING_ASSESSMENT_STEPS as readonly string[]).includes(value);
}

export const MEETING_RUBRIC_KEYS = [
  "taskCompletion",
  "structureAndFacilitation",
  "interactionAndTurnTaking",
  "clarificationAndQuestionHandling",
  "diplomacyAndNegotiation",
  "clarityAndConcision",
  "accuracyAndNaturalness",
  "decisionAndActionableClose",
] as const;

export type MeetingRubricKey = typeof MEETING_RUBRIC_KEYS[number];

export type MeetingRubric = Record<MeetingRubricKey, number>;

export interface MeetingDeliveryScores {
  pronunciation: number;
  intonation: number;
}

export interface MeetingAssessment {
  score: number;
  contentScore: number;
  requiresRetry: boolean;
  failedGates: Array<
    | "taskCompletion"
    | "structureAndFacilitation"
    | "interactionAndTurnTaking"
    | "decisionAndActionableClose"
  >;
}

export interface MeetingRecallReferenceCandidate {
  requires_retry?: unknown;
  feedback_payload?: unknown;
}

export type MeetingEvaluationMemoryKind = GlobalMeetingMemoryKind;

export interface MeetingEvaluationMemoryEvidence {
  basis: "session_assessment";
  policyVersion: 1;
  attemptId: string;
  score: number;
  dimension: MeetingRubricKey;
  dimensionScore: number;
  rubric: MeetingRubric;
}

export interface MeetingEvaluationMemoryCandidate {
  kind: MeetingEvaluationMemoryKind;
  memoryKey: string;
  content: string;
  status: "active";
  confidence: number;
  occurrenceCount: 1;
  evidence: MeetingEvaluationMemoryEvidence;
  sensitive: false;
  sourceActivitySessionId: string;
}

export interface MeetingEvaluationMemoryInput {
  tenantId: string;
  studentId: string;
  sessionId: string;
  attemptId: string;
  score: number;
  rubric: unknown;
  requiresRetry: boolean;
}

export interface MeetingMemorizationProgress {
  hiddenSections: string[];
  rehearsalCount: number;
  recallReady: boolean;
  rehearsalRecorded: boolean;
}

export type MeetingRecallBlocks = Record<MeetingSectionKey, string>;
export type MeetingRecallBlockScores = Record<MeetingSectionKey, number>;

export interface MeetingRecallAssessment {
  score: number;
  blockScores: MeetingRecallBlockScores;
  failedBlocks: MeetingSectionKey[];
  validated: boolean;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function hasMeetingRecallEvidence(
  evidence: unknown,
  sourceSessionId: string,
): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return false;
  }
  const record = evidence as Record<string, unknown>;
  if (
    record.kind !== "structured_six_block_recall" ||
    record.status !== "validated" ||
    record.validationVersion !== 1 ||
    record.sourceSessionId !== sourceSessionId ||
    typeof record.validationId !== "string" ||
    !UUID_PATTERN.test(record.validationId) ||
    typeof record.requestKey !== "string" ||
    !UUID_PATTERN.test(record.requestKey) ||
    typeof record.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(record.recordedAt)) ||
    typeof record.submissionDigest !== "string" ||
    !/^[a-f0-9]{64}$/i.test(record.submissionDigest)
  ) {
    return false;
  }

  const assessment = assessMeetingRecallScores(record.blockScores);
  if (!assessment?.validated || assessment.score !== record.score) {
    return false;
  }
  const passedBlocks = record.passedBlocks;
  if (
    !Array.isArray(passedBlocks) ||
    passedBlocks.length !== MEETING_SECTION_KEYS.length ||
    !MEETING_SECTION_KEYS.every((key) => passedBlocks.includes(key))
  ) {
    return false;
  }
  if (
    !record.referenceAttemptIds ||
    typeof record.referenceAttemptIds !== "object" ||
    Array.isArray(record.referenceAttemptIds)
  ) {
    return false;
  }
  const referenceAttemptIds = record.referenceAttemptIds as Record<
    string,
    unknown
  >;
  const ids = MEETING_SECTION_KEYS.map((key) => referenceAttemptIds[key]);
  return ids.every((id) => typeof id === "string" && UUID_PATTERN.test(id)) &&
    new Set(ids).size === MEETING_SECTION_KEYS.length;
}

/** A validated server record is monotonic and cannot be erased by stale UI. */
export function mergeMeetingRecallEvidence(
  existing: unknown,
  candidate: unknown,
  sourceSessionId: string,
): unknown | null {
  if (hasMeetingRecallEvidence(existing, sourceSessionId)) return existing;
  return hasMeetingRecallEvidence(candidate, sourceSessionId)
    ? candidate
    : null;
}

export interface MeetingScenarioSnapshot {
  title?: string;
  role?: string;
  objective?: string;
  constraint?: string;
}

export const MEETING_READAPTATION_VARIABLES = [
  "audience_seniority",
  "time_limit",
  "stakeholder_position",
  "evidence_availability",
  "deadline",
  "decision_scope",
] as const;

export interface MeetingReadaptationContract {
  scenario: MeetingScenarioSnapshot;
  changedVariables: string[];
}

export function toGlobalMeetingRubric(
  rubric: MeetingRubric,
): GlobalMeetingRubricScores {
  return {
    task_completion: rubric.taskCompletion,
    structure_and_facilitation: rubric.structureAndFacilitation,
    interaction_and_turn_taking: rubric.interactionAndTurnTaking,
    clarification_and_question_handling:
      rubric.clarificationAndQuestionHandling,
    diplomacy_and_negotiation: rubric.diplomacyAndNegotiation,
    clarity_and_concision: rubric.clarityAndConcision,
    accuracy_and_naturalness: rubric.accuracyAndNaturalness,
    decision_and_actionable_close: rubric.decisionAndActionableClose,
  };
}

const clampScore = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(value)));

const clampCount = (value: number): number =>
  Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));

const comparableWords = (value: string): string[] =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const wordSetSimilarity = (left: string, right: string): number => {
  const leftWords = new Set(comparableWords(left));
  const rightWords = new Set(comparableWords(right));
  if (!leftWords.size || !rightWords.size) return 0;
  const intersection = [...leftWords].filter((word) => rightWords.has(word));
  return intersection.length / new Set([...leftWords, ...rightWords]).size;
};

export function changedMeetingScenarioFields(
  source: MeetingScenarioSnapshot,
  candidate: MeetingScenarioSnapshot,
): string[] {
  return (["role", "objective", "constraint"] as const).filter((field) => {
    const previous = source[field]?.trim() ?? "";
    const next = candidate[field]?.trim() ?? "";
    return Boolean(previous && next) &&
      comparableWords(previous).join(" ") !== comparableWords(next).join(" ") &&
      wordSetSimilarity(previous, next) < 0.85;
  });
}

export function applyMeetingReadaptationContract(
  source: MeetingScenarioSnapshot,
  candidate: MeetingScenarioSnapshot,
): MeetingReadaptationContract {
  const sourceText = comparableWords(
    `${source.title ?? ""} ${source.role ?? ""} ${source.objective ?? ""} ${
      source.constraint ?? ""
    }`,
  ).join(" ");
  const variants = [
    {
      marker: "meeting time was cut in half",
      objective:
        "Adapt the recommendation for a newly joined regional decision-maker and secure an explicit decision.",
      constraint:
        "A regional decision-maker joined at short notice, the meeting time was cut in half, and the original option now requires a documented trade-off.",
      changedVariables: [
        "audience_seniority",
        "time_limit",
        "stakeholder_position",
      ],
    },
    {
      marker: "critical evidence is temporarily unavailable",
      objective:
        "Reframe the recommendation for a cross-functional escalation and agree a contingency owner and decision deadline.",
      constraint:
        "Critical evidence is temporarily unavailable, the customer deadline moved forward, and a finance stakeholder rejects the original sequence.",
      changedVariables: [
        "evidence_availability",
        "deadline",
        "stakeholder_position",
      ],
    },
    {
      marker: "decision scope was narrowed",
      objective:
        "Present a reduced-scope option to a more senior audience and close a decision within the meeting.",
      constraint:
        "The decision scope was narrowed, only one contingency can be funded, and the executive sponsor requires an owner before the meeting ends.",
      changedVariables: [
        "decision_scope",
        "audience_seniority",
        "time_limit",
      ],
    },
  ] as const;
  const variant =
    variants.find((item) =>
      !sourceText.includes(comparableWords(item.marker).join(" "))
    ) ?? variants[variants.length - 1];
  const baseTitle = candidate.title || source.title ||
    "Global meeting challenge";
  const baseObjective = candidate.objective || source.objective ||
    "Align the team on a practical decision.";
  return {
    scenario: {
      ...candidate,
      title: `${baseTitle} — changed decision conditions`,
      role: candidate.role || source.role || "Meeting owner",
      objective: `${baseObjective} ${variant.objective}`,
      constraint: variant.constraint,
    },
    changedVariables: [...variant.changedVariables],
  };
}

export function validMeetingReadaptationVariables(value: unknown): string[] {
  const allowed = new Set<string>(MEETING_READAPTATION_VARIABLES);
  return Array.isArray(value)
    ? [
      ...new Set(value.filter((item): item is string =>
        typeof item === "string" && allowed.has(item)
      )),
    ].slice(0, 6)
    : [];
}

const wordNgrams = (value: string, size: number): Set<string> => {
  const words = comparableWords(value);
  const grams = new Set<string>();
  for (let index = 0; index <= words.length - size; index += 1) {
    grams.add(words.slice(index, index + size).join(" "));
  }
  return grams;
};

/** Measures copied phrasing, not merely reuse of the six-part structure. */
export function meetingScriptSimilarity(
  source: string,
  candidate: string,
): number {
  const sourceGrams = wordNgrams(source, 3);
  const candidateGrams = wordNgrams(candidate, 3);
  if (sourceGrams.size < 8 || candidateGrams.size < 8) return 0;
  const intersection = [...sourceGrams]
    .filter((gram) => candidateGrams.has(gram)).length;
  const jaccard = intersection /
    new Set([...sourceGrams, ...candidateGrams]).size;
  // Jaccard alone can be diluted by appending a long new paragraph after a
  // verbatim source script. Source coverage keeps full or substantial reuse
  // visible even when the candidate is much longer than the original.
  const sourceCoverage = intersection / sourceGrams.size;
  return Math.max(jaccard, sourceCoverage);
}

export function meetingScriptAppearsCopied(
  source: string,
  candidate: string,
): boolean {
  return meetingScriptSimilarity(source, candidate) >= 0.65;
}

export function normalizeMeetingRecallBlocks(
  value: unknown,
): MeetingRecallBlocks | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const entries = MEETING_SECTION_KEYS.map((key) => {
    const raw = record[key];
    if (typeof raw !== "string") return [key, ""] as const;
    return [key, raw.trim().slice(0, 2_000)] as const;
  });
  const blocks = Object.fromEntries(entries) as MeetingRecallBlocks;
  const substantive = MEETING_SECTION_KEYS.every((key) => {
    const words = comparableWords(blocks[key]);
    return blocks[key].length >= 12 && words.length >= 4;
  });
  return substantive ? blocks : null;
}

export function assessMeetingRecallScores(
  value: unknown,
): MeetingRecallAssessment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const entries: Array<[MeetingSectionKey, number]> = [];
  for (const key of MEETING_SECTION_KEYS) {
    const raw = record[key];
    const candidate = typeof raw === "number"
      ? raw
      : raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).score
      : null;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      return null;
    }
    entries.push([key, clampScore(candidate)]);
  }
  const blockScores = Object.fromEntries(entries) as MeetingRecallBlockScores;
  const score = Math.round(
    entries.reduce((total, [, blockScore]) => total + blockScore, 0) /
      MEETING_SECTION_KEYS.length,
  );
  const failedBlocks = MEETING_SECTION_KEYS.filter((key) =>
    blockScores[key] < MEETING_RECALL_BLOCK_GATE
  );
  return {
    score,
    blockScores,
    failedBlocks,
    validated: score >= MEETING_RECALL_SCORE && failedBlocks.length === 0,
  };
}

/**
 * Hiding blocks is presentation state only. The client cannot create recall
 * evidence or increment the server-owned validation count through save_state.
 */
export function normalizeMeetingMemorizationProgress(
  hiddenSections: readonly string[],
  expectedSections: readonly string[],
  previousCount: number,
): MeetingMemorizationProgress {
  const expected = new Set(expectedSections);
  const normalizedHidden = [...new Set(hiddenSections)]
    .filter((section) => expected.has(section));
  const recallReady = expected.size > 0 &&
    [...expected].every((section) => normalizedHidden.includes(section));
  const rehearsalCount = clampCount(previousCount);

  return {
    hiddenSections: normalizedHidden,
    rehearsalCount,
    recallReady,
    rehearsalRecorded: false,
  };
}

/**
 * Applies one content rubric to text and voice meeting attempts. Voice adds a
 * small delivery component, but delivery can never override the core
 * competency gates that prove the learner actually completed the scenario.
 */
export function assessMeetingAttempt(
  sourceRubric: MeetingRubric,
  delivery?: MeetingDeliveryScores,
): MeetingAssessment {
  const rubric = Object.fromEntries(
    MEETING_RUBRIC_KEYS.map((key) => [key, clampScore(sourceRubric[key])]),
  ) as unknown as MeetingRubric;
  const sharedRubric = toGlobalMeetingRubric(rubric);
  const contentScore = scoreGlobalMeetingRubric(sharedRubric) ?? 0;
  const score = delivery
    ? Math.round(
      contentScore * 0.8 +
        clampScore(delivery.pronunciation) * 0.12 +
        clampScore(delivery.intonation) * 0.08,
    )
    : contentScore;
  const failedGates = ([
    "taskCompletion",
    "structureAndFacilitation",
    "interactionAndTurnTaking",
    "decisionAndActionableClose",
  ] as const).filter((key) => rubric[key] < MEETING_COMPETENCY_GATE);

  return {
    score,
    contentScore,
    requiresRetry: !passesGlobalMeetingReadiness(
      sharedRubric,
      MEETING_RETRY_SCORE,
      MEETING_COMPETENCY_GATE,
    ) || score < MEETING_RETRY_SCORE || failedGates.length > 0,
    failedGates,
  };
}

/**
 * A construction block is not a full meeting, so later-stage competencies are
 * not hard gates here. It still must fulfill the objective of its own block;
 * high language scores can never compensate for an off-target response.
 */
export function assessMeetingSectionAttempt(
  sourceRubric: MeetingRubric,
): MeetingAssessment {
  const rubric = Object.fromEntries(
    MEETING_RUBRIC_KEYS.map((key) => [key, clampScore(sourceRubric[key])]),
  ) as unknown as MeetingRubric;
  const contentScore = Math.round(
    MEETING_RUBRIC_KEYS.reduce((total, key) => total + rubric[key], 0) /
      MEETING_RUBRIC_KEYS.length,
  );
  const failedGates: MeetingAssessment["failedGates"] =
    rubric.taskCompletion < MEETING_COMPETENCY_GATE ? ["taskCompletion"] : [];
  return {
    score: contentScore,
    contentScore,
    requiresRetry: contentScore < MEETING_RETRY_SCORE ||
      failedGates.length > 0,
    failedGates,
  };
}

export function meetingAttemptMayComplete(
  requestedComplete: boolean,
  requiresRetry: boolean,
): boolean {
  return requestedComplete && !requiresRetry;
}

/**
 * Recall must be grounded only in a section that passed both persistence and
 * the deterministic task-completion gate. This also rejects legacy or
 * malformed feedback that cannot prove the block was on target.
 */
export function meetingSectionIsRecallReferenceEligible(
  candidate: MeetingRecallReferenceCandidate,
): boolean {
  if (candidate.requires_retry === true) return false;
  const feedback = candidate.feedback_payload;
  if (!feedback || typeof feedback !== "object" || Array.isArray(feedback)) {
    return false;
  }
  const rubric = (feedback as Record<string, unknown>).rubric;
  if (!rubric || typeof rubric !== "object" || Array.isArray(rubric)) {
    return false;
  }
  const taskCompletion = (rubric as Record<string, unknown>).taskCompletion;
  return typeof taskCompletion === "number" &&
    Number.isFinite(taskCompletion) &&
    clampScore(taskCompletion) >= MEETING_COMPETENCY_GATE;
}

/**
 * Maps only server-scored rubric dimensions to a fixed pedagogical taxonomy.
 * Free-form model feedback and learner text are not accepted by this boundary.
 */
export function mapMeetingEvaluationMemories(
  input: MeetingEvaluationMemoryInput,
): MeetingEvaluationMemoryCandidate[] {
  if (
    typeof input.tenantId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(input.tenantId) ||
    !UUID_PATTERN.test(input.studentId) ||
    !UUID_PATTERN.test(input.sessionId) ||
    !UUID_PATTERN.test(input.attemptId) ||
    !Number.isFinite(input.score) ||
    !input.rubric ||
    typeof input.rubric !== "object" ||
    Array.isArray(input.rubric)
  ) {
    return [];
  }
  const rubricSource = input.rubric as Record<string, unknown>;
  if (
    !MEETING_RUBRIC_KEYS.every((key) =>
      typeof rubricSource[key] === "number" &&
      Number.isFinite(rubricSource[key])
    )
  ) {
    return [];
  }
  const rubric = Object.fromEntries(
    MEETING_RUBRIC_KEYS.map((key) => [
      key,
      clampScore(rubricSource[key] as number),
    ]),
  ) as unknown as MeetingRubric;
  const priorityKind: MeetingEvaluationMemoryKind = input.requiresRetry
    ? "structure_in_progress"
    : "recommended_strategy";
  const scored = MEETING_RUBRIC_KEYS.map((dimension, order) => ({
    dimension,
    order,
    score: rubric[dimension],
  }));
  const priorities = scored
    .filter((item) => item.score < MEETING_RETRY_SCORE)
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, 3)
    .map((item) => ({ ...item, kind: priorityKind, confidence: 0.85 }));
  const strengths = scored
    .filter((item) => item.score >= MEETING_RETRY_SCORE)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, 2)
    .map((item) => ({
      ...item,
      kind: "strength" as const,
      confidence: 0.8,
    }));

  return [...priorities, ...strengths].map((item) => ({
    kind: item.kind,
    // tenant_id is the outer part of the database uniqueness tuple; keeping
    // student/dimension/kind here makes the semantic key stable across attempts.
    memoryKey: `meeting:${input.studentId}:${item.dimension}:${item.kind}`,
    content: item.kind === "strength"
      ? GLOBAL_MEETING_MEMORY_TAXONOMY[item.dimension].strength
      : GLOBAL_MEETING_MEMORY_TAXONOMY[item.dimension].target,
    status: "active" as const,
    confidence: item.confidence,
    occurrenceCount: 1 as const,
    evidence: {
      basis: "session_assessment" as const,
      policyVersion: 1 as const,
      attemptId: input.attemptId,
      score: clampScore(input.score),
      dimension: item.dimension,
      dimensionScore: item.score,
      rubric,
    },
    sensitive: false as const,
    sourceActivitySessionId: input.sessionId,
  }));
}

export function meetingRetryInstruction(
  failedGates: MeetingAssessment["failedGates"],
  modality: "text" | "voice",
): string {
  const action = modality === "voice" ? "Grave" : "Envie";
  if (failedGates.includes("taskCompletion")) {
    return `${action} uma nova tentativa que cumpra o objetivo principal da reunião e apresente uma decisão ou pedido claro.`;
  }
  if (failedGates.includes("interactionAndTurnTaking")) {
    return `${action} uma nova tentativa que convide contribuições, organize os turnos e trate perguntas de forma explícita.`;
  }
  if (failedGates.includes("structureAndFacilitation")) {
    return `${action} uma nova tentativa com os seis marcos: abertura, contexto, dados, proposta, próximos passos e encerramento.`;
  }
  if (failedGates.includes("decisionAndActionableClose")) {
    return `${action} uma nova tentativa que feche a decisão com responsável, prazo e próximo passo verificável.`;
  }
  return `${action} uma nova tentativa aplicando as prioridades do feedback antes de avançar.`;
}
