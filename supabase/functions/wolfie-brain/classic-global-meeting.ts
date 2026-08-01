import {
  mergeRealtimeMeetingAssessment,
  normalizeRealtimePostTurnAnalysis,
  realtimeMeetingAssessmentContext,
  type RealtimeMeetingAssessmentState,
  type RealtimePostTurnAnalysis,
  type RealtimePostTurnContext,
  type RealtimePostTurnCorrection,
  type RealtimePostTurnScenarioStatus,
  type RealtimePostTurnStage,
} from "./realtime-post-turn.ts";

export interface ClassicGlobalMeetingResponseProjection {
  current_stage: RealtimePostTurnStage;
  scenario_status: RealtimePostTurnScenarioStatus;
  correction: {
    original: string;
    corrected: string;
    explanation_pt: string;
  } | null;
  corrections: RealtimePostTurnCorrection[];
  student_strengths: string[];
  student_priorities: string[];
  next_action: string;
  profile_updates: unknown;
  session_score: number | null;
  requires_retry: boolean;
  retry_completed: boolean;
}

export interface ClassicGlobalMeetingTurnInput<
  TResponse extends ClassicGlobalMeetingResponseProjection,
> {
  providerPayload: unknown;
  response: TResponse;
  context: RealtimePostTurnContext;
  currentReport: unknown;
  cycleId: string;
  clientTurnId: string;
  recordedAt: string;
  model?: string;
  turnIndex?: number;
  awaitingTranscriptConfirmation?: boolean;
}

export interface ClassicGlobalMeetingTurnResult<
  TResponse extends ClassicGlobalMeetingResponseProjection,
> {
  analysis: RealtimePostTurnAnalysis | null;
  response: TResponse;
  nextStage: RealtimePostTurnStage;
  nextScenarioStatus: RealtimePostTurnScenarioStatus;
  assessment: RealtimeMeetingAssessmentState | null;
  report: Record<string, unknown>;
  turnIndex: number | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nextClassicMeetingTurnIndex(
  report: Record<string, unknown>,
  proposed: number | undefined,
): number {
  if (typeof proposed === "number" && Number.isInteger(proposed)) {
    return Math.max(0, proposed);
  }
  const prior = typeof report.lastClassicMeetingTurnIndex === "number" &&
      Number.isInteger(report.lastClassicMeetingTurnIndex)
    ? Math.max(-1, report.lastClassicMeetingTurnIndex)
    : -1;
  return prior + 1;
}

/**
 * Applies the canonical meeting evaluator to a normalized Classic response.
 * This is intentionally pure: provider claims are projected into the response
 * and report only after the deterministic stage, retry, and readiness gates.
 */
export function integrateClassicGlobalMeetingTurn<
  TResponse extends ClassicGlobalMeetingResponseProjection,
>(
  input: ClassicGlobalMeetingTurnInput<TResponse>,
): ClassicGlobalMeetingTurnResult<TResponse> {
  const currentReport = isObject(input.currentReport)
    ? input.currentReport
    : {};

  if (input.awaitingTranscriptConfirmation) {
    const response = {
      ...input.response,
      current_stage: input.context.currentStage,
      scenario_status: input.context.currentScenarioStatus,
      correction: null,
      corrections: [],
      student_strengths: [],
      student_priorities: [],
      profile_updates: {},
      session_score: null,
      requires_retry: input.context.hasPendingRetry,
      retry_completed: false,
    } as TResponse;
    return {
      analysis: null,
      response,
      nextStage: input.context.currentStage,
      nextScenarioStatus: input.context.currentScenarioStatus,
      assessment: null,
      report: currentReport,
      turnIndex: null,
    };
  }

  const currentCounterpart = input.context.currentCounterpart ??
    nonEmptyString(currentReport.counterpart);
  const currentPendingQuestion = input.context.currentPendingQuestion ??
    nonEmptyString(currentReport.pendingQuestion);
  const currentPendingDecision = input.context.currentPendingDecision ??
    nonEmptyString(currentReport.pendingDecision);
  const assessmentContext = realtimeMeetingAssessmentContext(
    currentReport,
    input.cycleId,
  );
  const normalized = normalizeRealtimePostTurnAnalysis(
    input.providerPayload,
    {
      ...input.context,
      currentCounterpart,
      currentPendingQuestion,
      currentPendingDecision,
      ...assessmentContext,
    },
  );
  // Empty continuity fields from the provider never erase the live roleplay
  // checkpoint. Pause intents are already frozen by the normalizer itself.
  const analysis: RealtimePostTurnAnalysis = {
    ...normalized,
    counterpart: normalized.counterpart ?? currentCounterpart ?? null,
    pendingQuestion: normalized.pendingQuestion ?? currentPendingQuestion ??
      null,
    pendingDecision: normalized.pendingDecision ?? currentPendingDecision ??
      null,
  };
  const firstCorrection = analysis.corrections[0];
  const response = {
    ...input.response,
    current_stage: analysis.nextStage,
    scenario_status: analysis.nextScenarioStatus,
    corrections: analysis.corrections,
    correction: firstCorrection
      ? {
        original: firstCorrection.original,
        corrected: firstCorrection.corrected,
        explanation_pt: firstCorrection.explanation,
      }
      : null,
    student_strengths: analysis.studentStrengths,
    student_priorities: analysis.studentPriorities,
    next_action: analysis.nextAction,
    profile_updates: {},
    session_score: analysis.sessionScore,
    requires_retry: analysis.requiresRetry,
    retry_completed: analysis.retryCompleted,
  } as TResponse;
  const turnIndex = nextClassicMeetingTurnIndex(
    currentReport,
    input.turnIndex,
  );
  const assessment = mergeRealtimeMeetingAssessment(
    currentReport,
    analysis,
    {
      cycleId: input.cycleId,
      clientTurnId: input.clientTurnId,
      studentTurnId: input.clientTurnId,
      assistantTurnId: input.clientTurnId,
      recordedAt: input.recordedAt,
      turnIndex,
      model: input.model,
    },
  );
  const report: Record<string, unknown> = {
    ...currentReport,
    currentStage: analysis.nextStage,
    scenarioStatus: analysis.nextScenarioStatus,
    ...(assessment
      ? {
        realtimeMeetingAssessment: assessment,
        lastClassicMeetingTurnIndex: turnIndex,
        adaptiveLevel: analysis.adaptiveLevel,
        counterpart: analysis.counterpart,
        pendingQuestion: analysis.pendingQuestion,
        pendingDecision: analysis.pendingDecision,
      }
      : {}),
  };

  return {
    analysis,
    response,
    nextStage: analysis.nextStage,
    nextScenarioStatus: analysis.nextScenarioStatus,
    assessment,
    report,
    turnIndex,
  };
}
