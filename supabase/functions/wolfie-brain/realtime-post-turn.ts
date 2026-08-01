import {
  classifyGlobalMeetingLearnerIntent,
  GLOBAL_MEETING_RUBRIC_DIMENSIONS,
  type GlobalMeetingLearnerIntent,
  isGlobalMeetingExperience,
  passesGlobalMeetingReadiness as passesSharedGlobalMeetingReadiness,
  scoreGlobalMeetingRubric,
} from "../_shared/wolfie-global-meeting-policy.ts";
import {
  correctionPreservesFactualIntegrity,
  normalizeFactualText,
} from "./factual-integrity.ts";

export type RealtimePostTurnStage =
  | "discovery"
  | "briefing"
  | "guided_build"
  | "practice"
  | "feedback"
  | "retry"
  | "simulation"
  | "readaptation"
  | "improvisation"
  | "assessment"
  | "report"
  | "completed";

export type RealtimePostTurnScenarioStatus =
  | "active"
  | "completed"
  | "awaiting_retry"
  | "abandoned"
  | "failed";

export type RealtimePostTurnCorrectionMode =
  | "immediate"
  | "end"
  | "selective"
  | "examiner";

export interface RealtimePostTurnCorrection {
  original: string;
  corrected: string;
  natural_version: string;
  explanation: string;
  priority: "low" | "medium" | "high";
  category:
    | "grammar"
    | "vocabulary"
    | "fluency"
    | "clarity"
    | "structure"
    | "naturalness"
    | "general";
}

export interface RealtimeMeetingRubric {
  task_completion?: number;
  structure_and_facilitation?: number;
  interaction_and_turn_taking?: number;
  clarification_and_question_handling?: number;
  diplomacy_and_negotiation?: number;
  clarity_and_concision?: number;
  accuracy_and_naturalness?: number;
  decision_and_actionable_close?: number;
}

export interface RealtimePostTurnContext {
  learnerTranscript: string;
  experienceMode: string;
  correctionMode: RealtimePostTurnCorrectionMode;
  difficulty?: string;
  currentAdaptiveLevel?: number;
  currentCounterpart?: string | null;
  currentPendingQuestion?: string | null;
  currentPendingDecision?: string | null;
  currentStage: RealtimePostTurnStage;
  /** Immutable stage persisted on the learner turn when it was admitted. */
  evidenceStage?: RealtimePostTurnStage;
  currentScenarioStatus: RealtimePostTurnScenarioStatus;
  meetingAggregateRubric?: RealtimeMeetingRubric;
  meetingReadinessLatched?: boolean;
  hasPendingRetry: boolean;
  pendingRetryTarget?: {
    original?: string | null;
    corrected?: string | null;
    natural_version?: string | null;
    category?: string | null;
    scope?: "language_correction" | "meeting_competency";
    requiredRubricDimension?: keyof RealtimeMeetingRubric | null;
  } | null;
}

export interface RealtimePostTurnAnalysis {
  globalMeeting: boolean;
  evidenceStage: RealtimePostTurnStage;
  learnerIntent: GlobalMeetingLearnerIntent;
  proposedStage: RealtimePostTurnStage;
  nextStage: RealtimePostTurnStage;
  nextScenarioStatus: RealtimePostTurnScenarioStatus;
  corrections: RealtimePostTurnCorrection[];
  studentStrengths: string[];
  studentPriorities: string[];
  nextAction: string;
  sessionScore: number | null;
  observedRubric: RealtimeMeetingRubric;
  rubric: RealtimeMeetingRubric;
  adaptiveLevel: number | null;
  counterpart: string | null;
  pendingQuestion: string | null;
  pendingDecision: string | null;
  requiresRetry: boolean;
  retryCompleted: boolean;
  needsExternalVerification: boolean;
  verificationReason: string | null;
}

/** Only speech-derived Realtime transcripts can require ASR confirmation. */
export function isRealtimeSpeechDerivedInputMethod(value: unknown): boolean {
  const normalized = typeof value === "string"
    ? value.trim().toLocaleLowerCase("en-US")
    : "";
  return normalized === "audio_transcription" ||
    normalized === "realtime_audio" ||
    normalized === "voice" ||
    normalized === "speech";
}

/** Typed Realtime input is exact learner evidence and needs no ASR review. */
export function shouldRecordConfirmedRealtimeFacts(value: unknown): boolean {
  return !isRealtimeSpeechDerivedInputMethod(value);
}

export type RealtimeAnalysisCommitStatus =
  | "completed"
  | "retryable"
  | "unavailable";

export interface RealtimeAnalysisCommitDisposition {
  status: RealtimeAnalysisCommitStatus;
  applyGuidance: boolean;
  finalizeCompleted: boolean;
}

/**
 * Guidance is safe only after the canonical session CAS succeeds. A transient
 * persistence failure stays claimable; only a genuinely terminal/ineligible
 * session is marked unavailable.
 */
export function resolveRealtimeAnalysisCommitDisposition(
  persisted: unknown,
  terminallyIneligible = false,
): RealtimeAnalysisCommitDisposition {
  if (persisted === true) {
    return {
      status: "completed",
      applyGuidance: true,
      finalizeCompleted: true,
    };
  }
  if (terminallyIneligible) {
    return {
      status: "unavailable",
      applyGuidance: false,
      finalizeCompleted: false,
    };
  }
  return {
    status: "retryable",
    applyGuidance: false,
    finalizeCompleted: false,
  };
}

export interface RealtimeAnalysisReportMeta {
  cycleId?: string;
  clientTurnId: string;
  studentTurnId: string;
  assistantTurnId: string;
  recordedAt: string;
  turnIndex?: number;
  model?: string;
}

const STAGES = new Set<RealtimePostTurnStage>([
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
]);

const STAGE_TRANSITIONS: Record<
  RealtimePostTurnStage,
  Set<RealtimePostTurnStage>
> = {
  discovery: new Set(["discovery", "briefing", "guided_build", "practice"]),
  briefing: new Set(["briefing", "guided_build", "practice"]),
  guided_build: new Set(["guided_build", "practice", "feedback"]),
  practice: new Set(["practice", "feedback", "retry", "simulation"]),
  feedback: new Set(["feedback", "retry", "simulation", "readaptation"]),
  retry: new Set(["retry", "practice", "simulation", "readaptation"]),
  simulation: new Set([
    "simulation",
    "feedback",
    "retry",
    "readaptation",
    "improvisation",
    "assessment",
  ]),
  readaptation: new Set([
    "readaptation",
    "feedback",
    "retry",
    "improvisation",
    "assessment",
  ]),
  improvisation: new Set([
    "improvisation",
    "feedback",
    "retry",
    "assessment",
  ]),
  assessment: new Set(["assessment", "feedback", "retry", "report"]),
  report: new Set(["report", "completed"]),
  completed: new Set(["completed"]),
};

const PAUSE_INTENTS = new Set<GlobalMeetingLearnerIntent>([
  "ask_doubt",
  "clarify_intent",
  "request_review",
  "request_model",
  "request_feedback",
]);

const GLOBAL_MEETING_INDEPENDENT_EVIDENCE_STAGES = new Set<
  RealtimePostTurnStage
>(["simulation", "readaptation", "improvisation", "assessment"]);

const CORRECTION_PRIORITIES = new Set(["low", "medium", "high"]);
const CORRECTION_CATEGORIES = new Set([
  "grammar",
  "vocabulary",
  "fluency",
  "clarity",
  "structure",
  "naturalness",
  "general",
]);
const RUBRIC_KEYS = GLOBAL_MEETING_RUBRIC_DIMENSIONS;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maxLength: number,
  fallback = "",
): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replaceAll("\u0000", "").trim().slice(
      0,
      maxLength,
    )
    : fallback;
}

function boundedStrings(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = boundedString(item, maxLength);
    const key = normalized.toLocaleLowerCase("en-US");
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

function boundedScore(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value)))
    : null;
}

function boundedAdaptiveLevel(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(6, value))
    : null;
}

export function resolveAdaptiveMeetingLevel(
  difficulty: unknown,
  currentLevel: unknown,
  proposedLevel: unknown,
): number | null {
  if (boundedString(difficulty, 40).toLocaleLowerCase("en-US") !== "adaptive") {
    return boundedAdaptiveLevel(currentLevel);
  }
  const current = boundedAdaptiveLevel(currentLevel) ?? 1;
  const proposed = boundedAdaptiveLevel(proposedLevel) ?? current;
  return Math.max(current - 1, Math.min(current + 1, proposed));
}

export function resolveRealtimeLearnerIntent(
  experienceMode: unknown,
  transcript: unknown,
): GlobalMeetingLearnerIntent {
  return isGlobalMeetingExperience(experienceMode)
    ? classifyGlobalMeetingLearnerIntent(transcript)
    : "perform";
}

export function verifyRealtimeCorrections(
  value: unknown,
  learnerTranscript: string,
  maxItems = 5,
): RealtimePostTurnCorrection[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter(isObject)
    .map((item): RealtimePostTurnCorrection | null => {
      const original = boundedString(item.original, 1_000);
      const corrected = boundedString(item.corrected, 1_000);
      const naturalVersion = boundedString(
        item.natural_version ?? item.naturalVersion,
        1_000,
        corrected,
      );
      const explanation = boundedString(
        item.explanation ?? item.explanation_pt,
        1_000,
      );
      if (!original || !corrected || !naturalVersion || !explanation) {
        return null;
      }

      // A correction is evidence only when the model copied the learner's
      // exact words. Fuzzy or case-insensitive matching would allow invented
      // errors to enter durable reports and memory.
      if (!learnerTranscript.includes(original)) return null;

      const correctedIntegrity = correctionPreservesFactualIntegrity(
        learnerTranscript,
        original,
        corrected,
      );
      const naturalIntegrity = correctionPreservesFactualIntegrity(
        learnerTranscript,
        original,
        naturalVersion,
      );
      if (!correctedIntegrity.safe || !naturalIntegrity.safe) return null;

      const rawPriority = boundedString(item.priority, 20);
      const rawCategory = boundedString(item.category, 30);
      return {
        original,
        corrected,
        natural_version: naturalVersion,
        explanation,
        priority: CORRECTION_PRIORITIES.has(rawPriority)
          ? rawPriority as RealtimePostTurnCorrection["priority"]
          : "medium",
        category: CORRECTION_CATEGORIES.has(rawCategory)
          ? rawCategory as RealtimePostTurnCorrection["category"]
          : "general",
      };
    })
    .filter((item): item is RealtimePostTurnCorrection => item !== null)
    .slice(0, Math.max(0, Math.min(5, maxItems)));
}

function normalizeRubric(value: unknown): RealtimeMeetingRubric {
  if (!isObject(value)) return {};
  const result: RealtimeMeetingRubric = {};
  for (const key of RUBRIC_KEYS) {
    const score = boundedScore(value[key]);
    if (score !== null) result[key] = score;
  }
  return result;
}

function averageRubric(rubric: RealtimeMeetingRubric): number | null {
  const values = RUBRIC_KEYS
    .map((key) => rubric[key])
    .filter((value): value is number => typeof value === "number");
  if (!values.length) return null;
  return Math.round(
    values.reduce((sum, value) => sum + value, 0) / values.length,
  );
}

function hasCompleteGlobalMeetingRubric(
  rubric: RealtimeMeetingRubric,
): boolean {
  return scoreGlobalMeetingRubric(rubric) !== null;
}

function passesGlobalMeetingRetryGates(
  rubric: RealtimeMeetingRubric,
): boolean {
  return passesSharedGlobalMeetingReadiness(rubric, 0, 60);
}

function passesGlobalMeetingReadiness(
  rubric: RealtimeMeetingRubric,
  score: number | null,
): boolean {
  return score !== null && score >= 75 &&
    passesSharedGlobalMeetingReadiness(rubric, 75, 60);
}

export function retryTranscriptMatchesTarget(
  transcript: string,
  target: RealtimePostTurnContext["pendingRetryTarget"],
): boolean {
  if (!target) return false;
  const normalizedTranscript = normalizeFactualText(transcript);
  if (!normalizedTranscript) return false;
  return [target.corrected, target.natural_version]
    .map((candidate) => normalizeFactualText(boundedString(candidate, 1_000)))
    .some((candidate) =>
      candidate.length >= 4 &&
      (` ${normalizedTranscript} `).includes(` ${candidate} `)
    );
}

export function meetingRetryDimensionPasses(
  rubric: RealtimeMeetingRubric,
  target: RealtimePostTurnContext["pendingRetryTarget"],
): boolean {
  if (target?.scope !== "meeting_competency") return false;
  const dimension = target.requiredRubricDimension;
  if (!dimension || !RUBRIC_KEYS.includes(dimension)) return false;
  return (rubric[dimension] ?? 0) >= 75;
}

export function resolveRealtimePostTurnStage(input: {
  currentStage: RealtimePostTurnStage;
  proposedStage: RealtimePostTurnStage;
  learnerIntent: GlobalMeetingLearnerIntent;
  globalMeeting: boolean;
  requiresRetry: boolean;
  retryCompleted: boolean;
  hasPendingRetry: boolean;
}): RealtimePostTurnStage {
  if (input.globalMeeting && PAUSE_INTENTS.has(input.learnerIntent)) {
    return input.currentStage;
  }
  if (input.requiresRetry) return "retry";
  if (
    input.currentStage === "retry" && input.hasPendingRetry &&
    !input.retryCompleted
  ) {
    return "retry";
  }
  if (
    input.currentStage === "retry" && input.retryCompleted &&
    input.proposedStage === "retry"
  ) {
    return "simulation";
  }
  return STAGE_TRANSITIONS[input.currentStage].has(input.proposedStage)
    ? input.proposedStage
    : input.currentStage;
}

export function normalizeRealtimePostTurnAnalysis(
  value: unknown,
  context: RealtimePostTurnContext,
): RealtimePostTurnAnalysis {
  const payload = isObject(value) ? value : {};
  const learnerIntent = resolveRealtimeLearnerIntent(
    context.experienceMode,
    context.learnerTranscript,
  );
  const proposedStage = typeof payload.current_stage === "string" &&
      STAGES.has(payload.current_stage as RealtimePostTurnStage)
    ? payload.current_stage as RealtimePostTurnStage
    : context.currentStage;
  const globalMeeting = isGlobalMeetingExperience(context.experienceMode);
  const pauseIntent = globalMeeting && PAUSE_INTENTS.has(learnerIntent);
  // A metapedagogical pause is not a fresh learner performance. Corrections
  // and scores proposed against the wording of the doubt itself must not open
  // a new retry or become assessment evidence.
  const corrections = pauseIntent ? [] : verifyRealtimeCorrections(
    payload.corrections,
    context.learnerTranscript,
    context.correctionMode === "end" || context.correctionMode === "examiner"
      ? 5
      : 1,
  );
  const observedRubric = pauseIntent
    ? {}
    : normalizeRubric(payload.rubric ?? payload.meeting_rubric);
  const evidenceStage = context.evidenceStage ?? context.currentStage;
  const independentMeetingEvidence = globalMeeting &&
    learnerIntent === "perform" &&
    GLOBAL_MEETING_INDEPENDENT_EVIDENCE_STAGES.has(evidenceStage);
  const priorAggregateRubric = normalizeRubric(
    context.meetingAggregateRubric,
  );
  const rubric = globalMeeting
    ? independentMeetingEvidence
      ? { ...priorAggregateRubric, ...observedRubric }
      : priorAggregateRubric
    : observedRubric;
  // A scalar supplied by the model is not independent meeting evidence.
  // Global-meeting scores are derived only from the weighted aggregate.
  const sessionScore = globalMeeting
    ? scoreGlobalMeetingRubric(rubric)
    : boundedScore(payload.session_score) ?? averageRubric(rubric);
  const significantCorrection = corrections.some((correction) =>
    correction.priority === "medium" || correction.priority === "high"
  );
  const retryTargetMatched = retryTranscriptMatchesTarget(
    context.learnerTranscript,
    context.pendingRetryTarget,
  );
  const languageMicroRetry = globalMeeting &&
    context.pendingRetryTarget?.scope === "language_correction";
  const retryEvidencePassed = languageMicroRetry
    ? (observedRubric.accuracy_and_naturalness ?? 0) >= 75
    : globalMeeting
    ? meetingRetryDimensionPasses(
      observedRubric,
      context.pendingRetryTarget,
    )
    : sessionScore !== null && sessionScore >= 75;
  const retryCompleted = learnerIntent === "perform" &&
    context.hasPendingRetry && payload.retry_completed === true &&
    !significantCorrection && retryTargetMatched && retryEvidencePassed;
  const pendingRetryStillOpen = context.hasPendingRetry && !retryCompleted;
  const correctionCreatesRetry = significantCorrection &&
    (context.correctionMode === "immediate" ||
      context.correctionMode === "selective");
  const requiresRetry = pendingRetryStillOpen || correctionCreatesRetry;
  let nextStage = resolveRealtimePostTurnStage({
    currentStage: context.currentStage,
    proposedStage,
    learnerIntent,
    globalMeeting,
    requiresRetry,
    retryCompleted,
    hasPendingRetry: context.hasPendingRetry,
  });
  const aggregateReadinessPassed = context.meetingReadinessLatched === true ||
    passesGlobalMeetingReadiness(rubric, sessionScore);
  if (
    globalMeeting && nextStage === "report" && !aggregateReadinessPassed
  ) {
    nextStage = context.currentStage;
  }
  if (
    globalMeeting && nextStage === "completed" &&
    !(context.currentStage === "report" &&
      context.meetingReadinessLatched === true)
  ) {
    nextStage = context.currentStage;
  }
  const nextScenarioStatus: RealtimePostTurnScenarioStatus = requiresRetry
    ? "awaiting_retry"
    : nextStage === "completed"
    ? "completed"
    : context.currentScenarioStatus === "awaiting_retry" && retryCompleted
    ? "active"
    : globalMeeting &&
        PAUSE_INTENTS.has(learnerIntent)
    ? context.currentScenarioStatus
    : "active";

  const verificationReason = boundedString(
    payload.verification_reason ?? payload.verificationReason,
    1_000,
  );
  const continuity = isObject(payload.continuity) ? payload.continuity : {};
  const proposedAdaptiveLevel = resolveAdaptiveMeetingLevel(
    context.difficulty,
    context.currentAdaptiveLevel,
    payload.adaptive_level ?? payload.difficulty_level,
  );
  const proposedCounterpart = boundedString(
    continuity.counterpart ?? payload.counterpart,
    300,
  ) || null;
  const proposedPendingQuestion = boundedString(
    continuity.pending_question ??
      continuity.pendingQuestion ??
      payload.pending_question,
    1_000,
  ) || null;
  const proposedPendingDecision = boundedString(
    continuity.pending_decision ??
      continuity.pendingDecision ??
      payload.pending_decision,
    1_000,
  ) || null;
  return {
    globalMeeting,
    evidenceStage,
    learnerIntent,
    proposedStage,
    nextStage,
    nextScenarioStatus,
    corrections,
    studentStrengths: boundedStrings(
      payload.student_strengths ?? payload.studentStrengths,
      5,
      500,
    ),
    studentPriorities: boundedStrings(
      payload.student_priorities ?? payload.studentPriorities,
      5,
      500,
    ),
    nextAction: boundedString(payload.next_action ?? payload.nextAction, 1_000),
    sessionScore,
    observedRubric,
    rubric,
    adaptiveLevel: globalMeeting
      ? pauseIntent
        ? boundedAdaptiveLevel(context.currentAdaptiveLevel) ?? 1
        : proposedAdaptiveLevel
      : null,
    counterpart: pauseIntent
      ? boundedString(context.currentCounterpart, 300) || null
      : proposedCounterpart,
    pendingQuestion: pauseIntent
      ? boundedString(context.currentPendingQuestion, 1_000) || null
      : proposedPendingQuestion,
    pendingDecision: pauseIntent
      ? boundedString(context.currentPendingDecision, 1_000) || null
      : proposedPendingDecision,
    requiresRetry,
    retryCompleted,
    needsExternalVerification: payload.needs_external_verification === true ||
      payload.needsExternalVerification === true,
    verificationReason: verificationReason || null,
  };
}

export function buildRealtimeRetryRecoverySnapshot(
  analysis: RealtimePostTurnAnalysis,
): Record<string, unknown> {
  return {
    version: 1,
    current_stage: analysis.nextStage,
    evidence_stage: analysis.evidenceStage,
    rubric: analysis.observedRubric,
    retry_completed: analysis.retryCompleted,
    student_strengths: analysis.studentStrengths,
    student_priorities: analysis.studentPriorities,
    next_action: analysis.nextAction,
    adaptive_level: analysis.adaptiveLevel,
    continuity: {
      counterpart: analysis.counterpart,
      pending_question: analysis.pendingQuestion,
      pending_decision: analysis.pendingDecision,
    },
    needs_external_verification: analysis.needsExternalVerification,
    verification_reason: analysis.verificationReason,
  };
}

function mergeUnique(
  existing: unknown,
  additions: string[],
  maxItems: number,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (
    const item of [
      ...additions,
      ...boundedStrings(existing, maxItems, 500),
    ]
  ) {
    const key = item.toLocaleLowerCase("en-US");
    if (!item || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= maxItems) break;
  }
  return result;
}

export interface RealtimeMeetingDimensionEvidence {
  score: number;
  evidenceTurnId: string;
  turnIndex: number;
  recordedAt: string;
}

export interface RealtimeMeetingAssessmentState {
  version: 1;
  cycleId: string;
  evidence: Partial<
    Record<keyof RealtimeMeetingRubric, RealtimeMeetingDimensionEvidence>
  >;
  rubric: RealtimeMeetingRubric;
  score: number | null;
  readinessLatched: boolean;
  latchedAt: string | null;
  latchedByTurnId: string | null;
}

export function realtimeMeetingAssessmentContext(
  report: unknown,
  cycleId: string,
): {
  meetingAggregateRubric: RealtimeMeetingRubric;
  meetingReadinessLatched: boolean;
} {
  if (!isObject(report) || !isObject(report.realtimeMeetingAssessment)) {
    return { meetingAggregateRubric: {}, meetingReadinessLatched: false };
  }
  const assessment = report.realtimeMeetingAssessment;
  if (
    assessment.version !== 1 ||
    boundedString(assessment.cycleId, 100) !== boundedString(cycleId, 100)
  ) {
    return { meetingAggregateRubric: {}, meetingReadinessLatched: false };
  }
  return {
    meetingAggregateRubric: normalizeRubric(assessment.rubric),
    meetingReadinessLatched: assessment.readinessLatched === true,
  };
}

export function mergeRealtimeMeetingAssessment(
  report: unknown,
  analysis: RealtimePostTurnAnalysis,
  meta: RealtimeAnalysisReportMeta,
): RealtimeMeetingAssessmentState | null {
  if (!analysis.globalMeeting) return null;
  const current = isObject(report) ? report : {};
  const cycleId = boundedString(meta.cycleId, 100, "legacy_realtime_cycle");
  const existing = isObject(current.realtimeMeetingAssessment) &&
      current.realtimeMeetingAssessment.version === 1 &&
      boundedString(current.realtimeMeetingAssessment.cycleId, 100) === cycleId
    ? current.realtimeMeetingAssessment
    : {};
  const priorEvidence = isObject(existing.evidence) ? existing.evidence : {};
  const evidence: RealtimeMeetingAssessmentState["evidence"] = {};
  for (const dimension of RUBRIC_KEYS) {
    const candidate = priorEvidence[dimension];
    if (!isObject(candidate)) continue;
    const score = boundedScore(candidate.score);
    const evidenceTurnId = boundedString(candidate.evidenceTurnId, 100);
    const turnIndex = typeof candidate.turnIndex === "number" &&
        Number.isInteger(candidate.turnIndex)
      ? candidate.turnIndex
      : null;
    const recordedAt = boundedString(candidate.recordedAt, 80);
    if (
      score === null || !evidenceTurnId || turnIndex === null ||
      !Number.isFinite(Date.parse(recordedAt))
    ) continue;
    evidence[dimension] = { score, evidenceTurnId, turnIndex, recordedAt };
  }

  const eligibleEvidence = analysis.learnerIntent === "perform" &&
    GLOBAL_MEETING_INDEPENDENT_EVIDENCE_STAGES.has(analysis.evidenceStage);
  if (eligibleEvidence) {
    const turnIndex = typeof meta.turnIndex === "number" &&
        Number.isInteger(meta.turnIndex)
      ? meta.turnIndex
      : -1;
    for (const dimension of RUBRIC_KEYS) {
      const score = boundedScore(analysis.observedRubric[dimension]);
      if (score === null) continue;
      const prior = evidence[dimension];
      if (prior && prior.turnIndex > turnIndex) continue;
      evidence[dimension] = {
        score,
        evidenceTurnId: meta.studentTurnId,
        turnIndex,
        recordedAt: meta.recordedAt,
      };
    }
  }

  const rubric: RealtimeMeetingRubric = {};
  for (const dimension of RUBRIC_KEYS) {
    const dimensionEvidence = evidence[dimension];
    if (dimensionEvidence) rubric[dimension] = dimensionEvidence.score;
  }
  const score = scoreGlobalMeetingRubric(rubric);
  const priorLatched = existing.readinessLatched === true;
  const readinessLatched = priorLatched ||
    passesSharedGlobalMeetingReadiness(rubric, 75, 60);
  return {
    version: 1,
    cycleId,
    evidence,
    rubric,
    score,
    readinessLatched,
    latchedAt: priorLatched
      ? boundedString(existing.latchedAt, 80) || null
      : readinessLatched
      ? meta.recordedAt
      : null,
    latchedByTurnId: priorLatched
      ? boundedString(existing.latchedByTurnId, 100) || null
      : readinessLatched
      ? meta.studentTurnId
      : null,
  };
}

export function findRealtimeAnalysisByTurn(
  report: unknown,
  studentTurnId: string,
): Record<string, unknown> | null {
  if (!isObject(report) || !Array.isArray(report.realtimeAnalyses)) return null;
  return report.realtimeAnalyses
    .filter(isObject)
    .find((item) => item.studentTurnId === studentTurnId) ?? null;
}

export function latestRealtimeAnalysis(
  report: unknown,
): Record<string, unknown> | null {
  if (!isObject(report) || !Array.isArray(report.realtimeAnalyses)) return null;
  return report.realtimeAnalyses.filter(isObject).reduce<
    Record<string, unknown> | null
  >((latest, candidate) => {
    if (!latest) return candidate;
    const latestIndex = typeof latest.turnIndex === "number" &&
        Number.isInteger(latest.turnIndex)
      ? latest.turnIndex
      : -1;
    const candidateIndex = typeof candidate.turnIndex === "number" &&
        Number.isInteger(candidate.turnIndex)
      ? candidate.turnIndex
      : -1;
    if (candidateIndex !== latestIndex) {
      return candidateIndex > latestIndex ? candidate : latest;
    }
    const latestAt = typeof latest.recordedAt === "string"
      ? Date.parse(latest.recordedAt)
      : Number.NaN;
    const candidateAt = typeof candidate.recordedAt === "string"
      ? Date.parse(candidate.recordedAt)
      : Number.NaN;
    return Number.isFinite(candidateAt) &&
        (!Number.isFinite(latestAt) || candidateAt >= latestAt)
      ? candidate
      : latest;
  }, null);
}

export interface RealtimeMaterializedAssessment {
  score: number | null;
  rubric: RealtimeMeetingRubric;
  readinessLatched: boolean;
}

/**
 * A durable session report represents the whole meeting cycle. Prefer the
 * canonical multi-turn assessment over the latest (often partial) utterance.
 */
export function realtimeMaterializedAssessment(
  report: unknown,
  latestAnalysis: unknown,
): RealtimeMaterializedAssessment {
  const current = isObject(report) ? report : {};
  const assessment = isObject(current.realtimeMeetingAssessment)
    ? current.realtimeMeetingAssessment
    : null;
  if (
    assessment?.version === 1 &&
    boundedString(assessment.cycleId, 100)
  ) {
    const rubric = normalizeRubric(assessment.rubric);
    return {
      score: scoreGlobalMeetingRubric(rubric),
      rubric,
      readinessLatched: assessment.readinessLatched === true,
    };
  }

  const latest = isObject(latestAnalysis) ? latestAnalysis : {};
  return {
    score: boundedScore(latest.score),
    rubric: normalizeRubric(latest.rubric),
    readinessLatched: false,
  };
}

export function mergeRealtimePostTurnReport(
  report: unknown,
  analysis: RealtimePostTurnAnalysis,
  meta: RealtimeAnalysisReportMeta,
): Record<string, unknown> {
  const current = isObject(report) ? report : {};
  if (findRealtimeAnalysisByTurn(current, meta.studentTurnId)) return current;

  const priorCorrections = Array.isArray(current.corrections)
    ? current.corrections.filter(isObject)
    : [];
  const priorScores = Array.isArray(current.scores)
    ? current.scores.filter(isObject)
    : [];
  const priorAnalyses = Array.isArray(current.realtimeAnalyses)
    ? current.realtimeAnalyses.filter(isObject)
    : [];
  const priorTurnIndex = typeof current.lastRealtimeTurnIndex === "number" &&
      Number.isInteger(current.lastRealtimeTurnIndex)
    ? current.lastRealtimeTurnIndex
    : -1;
  const currentTurnIndex = typeof meta.turnIndex === "number" &&
      Number.isInteger(meta.turnIndex)
    ? meta.turnIndex
    : priorTurnIndex + 1;
  const advancesCheckpoint = currentTurnIndex >= priorTurnIndex;
  const scoreEntry = analysis.sessionScore === null ? [] : [{
    score: analysis.sessionScore,
    rubric: analysis.rubric,
    stage: analysis.nextStage,
    source: "openai_realtime_post_turn",
    studentTurnId: meta.studentTurnId,
    recordedAt: meta.recordedAt,
  }];
  const meetingAssessment = mergeRealtimeMeetingAssessment(
    current,
    analysis,
    meta,
  );

  return {
    ...current,
    ...(meetingAssessment
      ? { realtimeMeetingAssessment: meetingAssessment }
      : {}),
    ...(advancesCheckpoint
      ? {
        currentStage: analysis.nextStage,
        scenarioStatus: analysis.nextScenarioStatus,
      }
      : {}),
    strengths: mergeUnique(current.strengths, analysis.studentStrengths, 12),
    priorities: mergeUnique(current.priorities, analysis.studentPriorities, 12),
    corrections: [
      ...priorCorrections,
      ...analysis.corrections.map((correction) => ({
        ...correction,
        source: "openai_realtime_post_turn",
        studentTurnId: meta.studentTurnId,
        recordedAt: meta.recordedAt,
      })),
    ].slice(-20),
    scores: [...priorScores, ...scoreEntry].slice(-20),
    nextStep: advancesCheckpoint
      ? analysis.nextAction
      : current.nextStep ?? null,
    adaptiveLevel: advancesCheckpoint
      ? analysis.adaptiveLevel ?? current.adaptiveLevel ?? null
      : current.adaptiveLevel ?? null,
    counterpart: advancesCheckpoint
      ? analysis.counterpart ?? current.counterpart ?? null
      : current.counterpart ?? null,
    pendingQuestion: advancesCheckpoint
      ? analysis.pendingQuestion ?? current.pendingQuestion ?? null
      : current.pendingQuestion ?? null,
    pendingDecision: advancesCheckpoint
      ? analysis.pendingDecision ?? current.pendingDecision ?? null
      : current.pendingDecision ?? null,
    needsExternalVerification: current.needsExternalVerification === true ||
      analysis.needsExternalVerification,
    verificationReason: advancesCheckpoint &&
        analysis.needsExternalVerification && analysis.verificationReason
      ? analysis.verificationReason
      : current.verificationReason ??
        (analysis.needsExternalVerification
          ? analysis.verificationReason
          : null),
    realtimeAnalyses: [
      ...priorAnalyses,
      {
        version: 1,
        source: "server_post_turn",
        configurationSource: "persisted_session",
        clientTurnId: meta.clientTurnId,
        studentTurnId: meta.studentTurnId,
        assistantTurnId: meta.assistantTurnId,
        learnerIntent: analysis.learnerIntent,
        evidenceStage: analysis.evidenceStage,
        stage: analysis.nextStage,
        scenarioStatus: analysis.nextScenarioStatus,
        score: analysis.sessionScore,
        observedRubric: analysis.observedRubric,
        rubric: analysis.rubric,
        adaptiveLevel: analysis.adaptiveLevel,
        requiresRetry: analysis.requiresRetry,
        retryCompleted: analysis.retryCompleted,
        nextAction: analysis.nextAction,
        studentStrengths: analysis.studentStrengths,
        studentPriorities: analysis.studentPriorities,
        correctionItems: analysis.corrections,
        counterpart: analysis.counterpart,
        pendingQuestion: analysis.pendingQuestion,
        pendingDecision: analysis.pendingDecision,
        needsExternalVerification: analysis.needsExternalVerification,
        verificationReason: analysis.verificationReason,
        corrections: analysis.corrections.length,
        recordedAt: meta.recordedAt,
        turnIndex: currentTurnIndex,
        model: meta.model ?? null,
      },
    ].slice(-50),
    lastRealtimeTurnIndex: Math.max(priorTurnIndex, currentTurnIndex),
    updatedAt: advancesCheckpoint ? meta.recordedAt : current.updatedAt ?? null,
  };
}

export function mergeRealtimePostTurnMemory(
  memory: unknown,
  analysis: RealtimePostTurnAnalysis,
  recordedAt: string,
  turnIndex?: number,
): Record<string, unknown> {
  const current = isObject(memory) ? memory : {};
  const priorTurnIndex = typeof current.lastRealtimeTurnIndex === "number" &&
      Number.isInteger(current.lastRealtimeTurnIndex)
    ? current.lastRealtimeTurnIndex
    : -1;
  const currentTurnIndex = typeof turnIndex === "number" &&
      Number.isInteger(turnIndex)
    ? turnIndex
    : priorTurnIndex + 1;
  const advancesCheckpoint = currentTurnIndex >= priorTurnIndex;
  return {
    ...current,
    currentStage: advancesCheckpoint
      ? analysis.nextStage
      : current.currentStage ?? null,
    adaptiveLevel: advancesCheckpoint
      ? analysis.adaptiveLevel ?? current.adaptiveLevel ?? null
      : current.adaptiveLevel ?? null,
    strengths: mergeUnique(current.strengths, analysis.studentStrengths, 10),
    priorities: mergeUnique(current.priorities, analysis.studentPriorities, 10),
    structuresInProgress: mergeUnique(
      current.structuresInProgress,
      analysis.corrections.map((correction) => correction.category),
      12,
    ),
    recommendedNextStep: advancesCheckpoint
      ? analysis.nextAction || boundedString(current.recommendedNextStep, 1_000)
      : boundedString(current.recommendedNextStep, 1_000),
    // Empty provider fields never erase the active roleplay checkpoint.
    counterpart: advancesCheckpoint
      ? analysis.counterpart ?? current.counterpart ?? null
      : current.counterpart ?? null,
    pendingQuestion: advancesCheckpoint
      ? analysis.pendingQuestion ?? current.pendingQuestion ?? null
      : current.pendingQuestion ?? null,
    pendingDecision: advancesCheckpoint
      ? analysis.pendingDecision ?? current.pendingDecision ?? null
      : current.pendingDecision ?? null,
    lastRealtimeTurnIndex: Math.max(priorTurnIndex, currentTurnIndex),
    updatedAt: recordedAt,
  };
}
