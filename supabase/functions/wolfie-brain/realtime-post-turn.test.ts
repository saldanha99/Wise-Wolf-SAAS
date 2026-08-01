/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRealtimeRetryRecoverySnapshot,
  findRealtimeAnalysisByTurn,
  isRealtimeSpeechDerivedInputMethod,
  latestRealtimeAnalysis,
  mergeRealtimePostTurnMemory,
  mergeRealtimePostTurnReport,
  normalizeRealtimePostTurnAnalysis,
  realtimeMaterializedAssessment,
  realtimeMeetingAssessmentContext,
  resolveAdaptiveMeetingLevel,
  resolveRealtimeAnalysisCommitDisposition,
  resolveRealtimeLearnerIntent,
  shouldRecordConfirmedRealtimeFacts,
  verifyRealtimeCorrections,
} from "./realtime-post-turn.ts";

Deno.test("ASR confirmation applies only to speech-derived Realtime input", () => {
  assertEquals(isRealtimeSpeechDerivedInputMethod("audio_transcription"), true);
  assertEquals(isRealtimeSpeechDerivedInputMethod("realtime_audio"), true);
  assertEquals(isRealtimeSpeechDerivedInputMethod("text"), false);
  assertEquals(isRealtimeSpeechDerivedInputMethod(undefined), false);
  assertEquals(shouldRecordConfirmedRealtimeFacts("text"), true);
  assertEquals(
    shouldRecordConfirmedRealtimeFacts("audio_transcription"),
    false,
  );
});

Deno.test("failed session CAS never completes analysis or exposes guidance", () => {
  assertEquals(resolveRealtimeAnalysisCommitDisposition(false), {
    status: "retryable",
    applyGuidance: false,
    finalizeCompleted: false,
  });
  assertEquals(resolveRealtimeAnalysisCommitDisposition(false, true), {
    status: "unavailable",
    applyGuidance: false,
    finalizeCompleted: false,
  });
  assertEquals(resolveRealtimeAnalysisCommitDisposition(true), {
    status: "completed",
    applyGuidance: true,
    finalizeCompleted: true,
  });
});

Deno.test("classifies global-meeting pauses with the shared learner-intent policy", () => {
  assertEquals(
    resolveRealtimeLearnerIntent(
      "global_meeting",
      "Tenho uma dúvida: qual a diferença entre deadline e due date?",
    ),
    "ask_doubt",
  );
  assertEquals(
    resolveRealtimeLearnerIntent("free_conversation", "Can you explain this?"),
    "perform",
  );
  assertEquals(
    resolveRealtimeLearnerIntent("global_meeting", "Can you explain that?"),
    "clarify_intent",
  );
});

Deno.test("global-meeting doubt and review preserve the active stage", () => {
  for (
    const learnerTranscript of [
      "I don't understand this expression.",
      "Can we review the previous correction?",
      "Give me an example of how I should say it.",
      "How did I do? Give me feedback.",
    ]
  ) {
    const analysis = normalizeRealtimePostTurnAnalysis(
      { current_stage: "assessment", session_score: 90 },
      {
        learnerTranscript,
        experienceMode: "global_meeting",
        correctionMode: "selective",
        currentStage: "simulation",
        currentScenarioStatus: "active",
        hasPendingRetry: false,
      },
    );
    assertEquals(analysis.nextStage, "simulation");
    assertEquals(analysis.nextScenarioStatus, "active");
  }
});

Deno.test("a metapedagogical pause cannot score or open a new retry", () => {
  const learnerTranscript = "Can you explain that?";
  const analysis = normalizeRealtimePostTurnAnalysis({
    current_stage: "assessment",
    rubric: {
      task_completion: 95,
      structure_and_facilitation: 95,
    },
    corrections: [{
      original: learnerTranscript,
      corrected: "Could you explain that?",
      natural_version: "Could you explain that?",
      explanation: "Use could for a softer request.",
      priority: "high",
      category: "naturalness",
    }],
    requires_retry: true,
    adaptive_level: 6,
    continuity: {
      counterpart: "A different stakeholder",
      pending_question: "A different question",
      pending_decision: "A different decision",
    },
  }, {
    learnerTranscript,
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "simulation",
    currentScenarioStatus: "active",
    difficulty: "adaptive",
    currentAdaptiveLevel: 3,
    currentCounterpart: "Regional VP",
    currentPendingQuestion: "Which risk should we accept?",
    currentPendingDecision: "Approve the recovery plan",
    hasPendingRetry: false,
  });

  assertEquals(analysis.learnerIntent, "clarify_intent");
  assertEquals(analysis.corrections, []);
  assertEquals(analysis.observedRubric, {});
  assertEquals(analysis.sessionScore, null);
  assertEquals(analysis.requiresRetry, false);
  assertEquals(analysis.nextStage, "simulation");
  assertEquals(analysis.nextScenarioStatus, "active");
  assertEquals(analysis.adaptiveLevel, 3);
  assertEquals(analysis.counterpart, "Regional VP");
  assertEquals(analysis.pendingQuestion, "Which risk should we accept?");
  assertEquals(analysis.pendingDecision, "Approve the recovery plan");
});

Deno.test("in-role review and feedback phrases still count as meeting evidence", () => {
  for (
    const learnerTranscript of [
      "Let's review the Q3 KPIs before we decide.",
      "Could I get your feedback on the proposal?",
    ]
  ) {
    const analysis = normalizeRealtimePostTurnAnalysis({
      current_stage: "simulation",
      rubric: { interaction_and_turn_taking: 82 },
    }, {
      learnerTranscript,
      experienceMode: "global_meeting",
      correctionMode: "end",
      currentStage: "simulation",
      currentScenarioStatus: "active",
      hasPendingRetry: false,
    });
    assertEquals(analysis.learnerIntent, "perform");
    assertEquals(analysis.observedRubric.interaction_and_turn_taking, 82);
    assertEquals(analysis.rubric.interaction_and_turn_taking, 82);
  }
});

Deno.test("keeps only literal transcript corrections that preserve facts", () => {
  const transcript = "I live in Recife and shipped 15 units yesterday.";
  const corrections = verifyRealtimeCorrections([
    {
      original: "I live in Recife",
      corrected: "I currently live in Recife",
      natural_version: "I currently live in Recife",
      explanation: "Add currently only when that timing is intended.",
      priority: "medium",
      category: "clarity",
    },
    {
      original: "I Live in Recife",
      corrected: "I live in Recife",
      natural_version: "I live in Recife",
      explanation: "This quote changes the learner's capitalization.",
      priority: "low",
      category: "grammar",
    },
    {
      original: "shipped 15 units",
      corrected: "shipped 50 units",
      natural_version: "delivered 50 units",
      explanation: "This changes the learner's number.",
      priority: "high",
      category: "clarity",
    },
  ], transcript);

  assertEquals(corrections.length, 1);
  assertEquals(corrections[0].original, "I live in Recife");
});

Deno.test("a verified selective correction creates one retry and an unsafe one cannot", () => {
  const unsafe = normalizeRealtimePostTurnAnalysis({
    current_stage: "feedback",
    corrections: [{
      original: "I shipped 15 units",
      corrected: "I shipped 50 units",
      natural_version: "I shipped 50 units",
      explanation: "Changed number.",
      priority: "high",
      category: "clarity",
    }],
  }, {
    learnerTranscript: "I shipped 15 units",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  assertEquals(unsafe.corrections.length, 0);
  assertEquals(unsafe.requiresRetry, false);
  assertEquals(unsafe.nextStage, "feedback");

  const verified = normalizeRealtimePostTurnAnalysis({
    current_stage: "feedback",
    corrections: [{
      original: "We need discuss the deadline",
      corrected: "We need to discuss the deadline",
      natural_version: "We need to discuss the deadline",
      explanation: "Use need to plus the base verb.",
      priority: "high",
      category: "grammar",
    }],
  }, {
    learnerTranscript: "We need discuss the deadline",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  assertEquals(verified.corrections.length, 1);
  assertEquals(verified.requiresRetry, true);
  assertEquals(verified.nextStage, "retry");
  assertEquals(verified.nextScenarioStatus, "awaiting_retry");
});

Deno.test("a pending retry completes only on a scored clean performance turn", () => {
  const pause = normalizeRealtimePostTurnAnalysis({
    retry_completed: true,
    session_score: 92,
  }, {
    learnerTranscript: "Can you explain the correction?",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "retry",
    currentScenarioStatus: "awaiting_retry",
    hasPendingRetry: true,
    pendingRetryTarget: {
      corrected: "We need to discuss the deadline.",
      natural_version: "We need to discuss the deadline.",
      scope: "language_correction",
    },
  });
  assertEquals(pause.retryCompleted, false);
  assertEquals(pause.requiresRetry, true);
  assertEquals(pause.nextStage, "retry");

  const performance = normalizeRealtimePostTurnAnalysis({
    retry_completed: true,
    session_score: 82,
    current_stage: "retry",
  }, {
    learnerTranscript: "We need to discuss the deadline.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "retry",
    currentScenarioStatus: "awaiting_retry",
    hasPendingRetry: true,
    pendingRetryTarget: {
      corrected: "We need to discuss the deadline.",
      natural_version: "We need to discuss the deadline.",
      scope: "language_correction",
    },
  });
  // A global-meeting retry cannot pass on a scalar/overall score alone.
  assertEquals(performance.retryCompleted, false);
  assertEquals(performance.requiresRetry, true);

  const evidencedPerformance = normalizeRealtimePostTurnAnalysis({
    retry_completed: true,
    session_score: 82,
    current_stage: "retry",
    rubric: { accuracy_and_naturalness: 80 },
  }, {
    learnerTranscript: "We need to discuss the deadline.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "retry",
    currentScenarioStatus: "awaiting_retry",
    hasPendingRetry: true,
    pendingRetryTarget: {
      corrected: "We need to discuss the deadline.",
      natural_version: "We need to discuss the deadline.",
      scope: "language_correction",
    },
  });
  assertEquals(evidencedPerformance.retryCompleted, true);
  assertEquals(evidencedPerformance.requiresRetry, false);
  assertEquals(evidencedPerformance.nextStage, "simulation");
  assertEquals(evidencedPerformance.nextScenarioStatus, "active");
});

Deno.test("partial rubric and off-target speech cannot close a global-meeting retry", () => {
  const baseContext = {
    experienceMode: "global_meeting",
    correctionMode: "selective" as const,
    currentStage: "retry" as const,
    currentScenarioStatus: "awaiting_retry" as const,
    hasPendingRetry: true,
    pendingRetryTarget: {
      corrected: "We need to discuss the deadline.",
      natural_version: "We need to discuss the deadline.",
      scope: "meeting_competency",
      requiredRubricDimension: "structure_and_facilitation",
    },
  } as const;
  const partial = normalizeRealtimePostTurnAnalysis({
    retry_completed: true,
    rubric: { clarity_and_concision: 90 },
  }, {
    ...baseContext,
    learnerTranscript: "We need to discuss the deadline.",
  });
  assertEquals(partial.sessionScore, null);
  assertEquals(partial.retryCompleted, false);

  const offTarget = normalizeRealtimePostTurnAnalysis({
    retry_completed: true,
    session_score: 95,
    rubric: {
      task_completion: 95,
      structure_and_facilitation: 95,
      interaction_and_turn_taking: 95,
      clarification_and_question_handling: 95,
      diplomacy_and_negotiation: 95,
      clarity_and_concision: 95,
      accuracy_and_naturalness: 95,
      decision_and_actionable_close: 95,
    },
  }, {
    ...baseContext,
    learnerTranscript: "The weather is nice today.",
  });
  assertEquals(offTarget.retryCompleted, false);
  assertEquals(offTarget.requiresRetry, true);

  const relevantPartial = normalizeRealtimePostTurnAnalysis({
    retry_completed: true,
    current_stage: "simulation",
    rubric: { structure_and_facilitation: 82 },
  }, {
    ...baseContext,
    learnerTranscript: "We need to discuss the deadline.",
  });
  assertEquals(relevantPartial.retryCompleted, true);
  assertEquals(relevantPartial.requiresRetry, false);
  assertEquals(relevantPartial.nextStage, "simulation");
});

Deno.test("global-meeting scalar score alone cannot create readiness or finish", () => {
  const analysis = normalizeRealtimePostTurnAnalysis({
    session_score: 99,
    current_stage: "report",
  }, {
    learnerTranscript: "I recommend option A.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "assessment",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  assertEquals(analysis.sessionScore, null);
  assertEquals(analysis.nextStage, "assessment");
});

Deno.test("report merge is idempotent by persisted student turn", () => {
  const analysis = normalizeRealtimePostTurnAnalysis({
    session_score: 84,
    student_strengths: ["Clear recommendation"],
    student_priorities: ["Close with an owner"],
    next_action: "Retry the close with an owner and deadline.",
  }, {
    learnerTranscript: "I recommend option A.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  const meta = {
    clientTurnId: "client-turn",
    studentTurnId: "student-turn",
    assistantTurnId: "assistant-turn",
    recordedAt: "2026-08-01T12:00:00.000Z",
  };
  const first = mergeRealtimePostTurnReport({}, analysis, meta);
  const second = mergeRealtimePostTurnReport(first, analysis, meta);

  assertEquals(second, first);
  assertEquals(
    findRealtimeAnalysisByTurn(second, "student-turn")?.configurationSource,
    "persisted_session",
  );
});

Deno.test("retry recovery snapshot preserves the full evaluated checkpoint", () => {
  const context = {
    learnerTranscript: "I recommend option A and Maria owns it by Friday.",
    experienceMode: "global_meeting",
    correctionMode: "end" as const,
    currentStage: "simulation" as const,
    currentScenarioStatus: "active" as const,
    hasPendingRetry: false,
  };
  const original = normalizeRealtimePostTurnAnalysis({
    current_stage: "assessment",
    rubric: {
      task_completion: 84,
      decision_and_actionable_close: 88,
    },
    student_strengths: ["Named an owner and deadline"],
    student_priorities: ["Invite stakeholder questions"],
    next_action: "Run the final executive objection.",
    adaptive_level: 4,
    continuity: {
      counterpart: "Regional VP",
      pending_question: "What is the fallback?",
      pending_decision: "Approve option A",
    },
    needs_external_verification: true,
    verification_reason: "Verify the current deadline.",
  }, context);
  const recovered = normalizeRealtimePostTurnAnalysis(
    buildRealtimeRetryRecoverySnapshot(original),
    context,
  );

  assertEquals(recovered.nextStage, original.nextStage);
  assertEquals(recovered.observedRubric, original.observedRubric);
  assertEquals(recovered.studentStrengths, original.studentStrengths);
  assertEquals(recovered.studentPriorities, original.studentPriorities);
  assertEquals(recovered.nextAction, original.nextAction);
  assertEquals(recovered.counterpart, original.counterpart);
  assertEquals(recovered.pendingQuestion, original.pendingQuestion);
  assertEquals(recovered.pendingDecision, original.pendingDecision);
  assertEquals(
    recovered.needsExternalVerification,
    original.needsExternalVerification,
  );
});

Deno.test("distributed independent turns latch global-meeting readiness for report completion", () => {
  const cycleId = "10000000-0000-4000-8000-000000000901";
  const dimensions = [
    "task_completion",
    "structure_and_facilitation",
    "interaction_and_turn_taking",
    "clarification_and_question_handling",
    "diplomacy_and_negotiation",
    "clarity_and_concision",
    "accuracy_and_naturalness",
    "decision_and_actionable_close",
  ] as const;
  let report: Record<string, unknown> = {};
  let lastAnalysis = null as
    | ReturnType<
      typeof normalizeRealtimePostTurnAnalysis
    >
    | null;

  dimensions.forEach((dimension, index) => {
    const finalEvidenceTurn = index === dimensions.length - 1;
    const currentStage = finalEvidenceTurn ? "assessment" : "simulation";
    const context = realtimeMeetingAssessmentContext(report, cycleId);
    const analysis = normalizeRealtimePostTurnAnalysis({
      current_stage: finalEvidenceTurn ? "report" : currentStage,
      rubric: { [dimension]: 80 },
    }, {
      learnerTranscript: `Independent meeting evidence ${index + 1}`,
      experienceMode: "global_meeting",
      correctionMode: "end",
      currentStage,
      currentScenarioStatus: "active",
      hasPendingRetry: false,
      ...context,
    });
    report = mergeRealtimePostTurnReport(report, analysis, {
      cycleId,
      clientTurnId: `client-${index}`,
      studentTurnId: `student-${index}`,
      assistantTurnId: `assistant-${index}`,
      turnIndex: index,
      recordedAt: `2026-08-01T12:00:0${index}.000Z`,
    });
    lastAnalysis = analysis;
  });

  const assessment = report.realtimeMeetingAssessment as Record<
    string,
    unknown
  >;
  const evidence = assessment.evidence as Record<string, unknown>;
  assertEquals(Object.keys(evidence).sort(), [...dimensions].sort());
  assertEquals(assessment.score, 80);
  assertEquals(assessment.readinessLatched, true);
  assertEquals(lastAnalysis?.nextStage, "report");

  const latchedContext = realtimeMeetingAssessmentContext(report, cycleId);
  const closing = normalizeRealtimePostTurnAnalysis({
    current_stage: "completed",
  }, {
    learnerTranscript: "Thanks, that is clear.",
    experienceMode: "global_meeting",
    correctionMode: "end",
    currentStage: "report",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
    ...latchedContext,
  });
  assertEquals(closing.nextStage, "completed");
  assertEquals(closing.nextScenarioStatus, "completed");
});

Deno.test("meeting evidence is scoped by cycle and ignores coached stages", () => {
  const oldCycle = "10000000-0000-4000-8000-000000000902";
  const newCycle = "10000000-0000-4000-8000-000000000903";
  const fullRubric = {
    task_completion: 95,
    structure_and_facilitation: 95,
    interaction_and_turn_taking: 95,
    clarification_and_question_handling: 95,
    diplomacy_and_negotiation: 95,
    clarity_and_concision: 95,
    accuracy_and_naturalness: 95,
    decision_and_actionable_close: 95,
  };
  const coached = normalizeRealtimePostTurnAnalysis({
    current_stage: "practice",
    rubric: fullRubric,
  }, {
    learnerTranscript: "A coached practice answer.",
    experienceMode: "global_meeting",
    correctionMode: "end",
    currentStage: "practice",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  const report = mergeRealtimePostTurnReport({}, coached, {
    cycleId: oldCycle,
    clientTurnId: "client-coached",
    studentTurnId: "student-coached",
    assistantTurnId: "assistant-coached",
    turnIndex: 1,
    recordedAt: "2026-08-01T12:01:00.000Z",
  });
  assertEquals(realtimeMeetingAssessmentContext(report, oldCycle), {
    meetingAggregateRubric: {},
    meetingReadinessLatched: false,
  });
  assertEquals(realtimeMeetingAssessmentContext(report, newCycle), {
    meetingAggregateRubric: {},
    meetingReadinessLatched: false,
  });
});

Deno.test("a delayed coached turn cannot become autonomous meeting evidence", () => {
  const analysis = normalizeRealtimePostTurnAnalysis({
    current_stage: "simulation",
    rubric: {
      task_completion: 95,
      structure_and_facilitation: 95,
    },
  }, {
    learnerTranscript: "A coached answer admitted during practice.",
    experienceMode: "global_meeting",
    correctionMode: "end",
    currentStage: "simulation",
    evidenceStage: "practice",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  const report = mergeRealtimePostTurnReport({}, analysis, {
    cycleId: "10000000-0000-4000-8000-000000000904",
    clientTurnId: "client-delayed-practice",
    studentTurnId: "student-delayed-practice",
    assistantTurnId: "assistant-delayed-practice",
    turnIndex: 4,
    recordedAt: "2026-08-01T12:04:00.000Z",
  });

  assertEquals(analysis.evidenceStage, "practice");
  assertEquals(analysis.rubric, {});
  assertEquals(
    (report.realtimeMeetingAssessment as Record<string, unknown>).rubric,
    {},
  );
});

Deno.test("materialized report uses the multi-turn assessment, not the latest partial turn", () => {
  const report = {
    realtimeMeetingAssessment: {
      version: 1,
      cycleId: "10000000-0000-4000-8000-000000000905",
      rubric: {
        task_completion: 80,
        structure_and_facilitation: 80,
        interaction_and_turn_taking: 80,
        clarification_and_question_handling: 80,
        diplomacy_and_negotiation: 80,
        clarity_and_concision: 80,
        accuracy_and_naturalness: 80,
        decision_and_actionable_close: 80,
      },
      readinessLatched: true,
    },
  };
  const materialized = realtimeMaterializedAssessment(report, {
    score: null,
    rubric: { decision_and_actionable_close: 80 },
  });

  assertEquals(materialized.score, 80);
  assertEquals(Object.keys(materialized.rubric).length, 8);
  assertEquals(materialized.readinessLatched, true);
});

Deno.test("adaptive global-meeting difficulty changes by at most one level", () => {
  assertEquals(resolveAdaptiveMeetingLevel("adaptive", 3, 6), 4);
  assertEquals(resolveAdaptiveMeetingLevel("adaptive", 3, 1), 2);
  assertEquals(resolveAdaptiveMeetingLevel("adaptive", 6, 1), 5);
  assertEquals(resolveAdaptiveMeetingLevel("balanced", 4, 6), 4);
});

Deno.test("report and memory retain the meeting checkpoint when analyzer omits it", () => {
  const analysis = normalizeRealtimePostTurnAnalysis({
    session_score: 78,
    adaptive_level: 6,
    continuity: {
      counterpart: "Regional operations director",
      pending_question: "Which risk should we accept?",
      pending_decision: "Choose option A or B",
    },
  }, {
    learnerTranscript: "I recommend option A.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    difficulty: "adaptive",
    currentAdaptiveLevel: 2,
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  assertEquals(analysis.adaptiveLevel, 3);

  const memory = mergeRealtimePostTurnMemory(
    {},
    analysis,
    "2026-08-01T12:00:00Z",
  );
  const following = normalizeRealtimePostTurnAnalysis({}, {
    learnerTranscript: "I recommend option A.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    difficulty: "adaptive",
    currentAdaptiveLevel: 3,
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  const retained = mergeRealtimePostTurnMemory(
    memory,
    following,
    "2026-08-01T12:01:00Z",
  );
  assertEquals(retained.counterpart, "Regional operations director");
  assertEquals(retained.pendingQuestion, "Which risk should we accept?");
  assertEquals(retained.pendingDecision, "Choose option A or B");
});

Deno.test("pause intent cannot overwrite adaptive level or roleplay checkpoint", () => {
  const analysis = normalizeRealtimePostTurnAnalysis({
    adaptive_level: 6,
    continuity: {
      counterpart: "Injected counterpart",
      pending_question: "Injected question",
      pending_decision: "Injected decision",
    },
  }, {
    learnerTranscript: "I don't understand this expression.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    difficulty: "adaptive",
    currentAdaptiveLevel: 3,
    currentCounterpart: "Operations director",
    currentPendingQuestion: "What is the mitigation?",
    currentPendingDecision: "Approve the recovery plan",
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  assertEquals(analysis.adaptiveLevel, 3);
  assertEquals(analysis.counterpart, "Operations director");
  assertEquals(analysis.pendingQuestion, "What is the mitigation?");
  assertEquals(analysis.pendingDecision, "Approve the recovery plan");
});

Deno.test("an older concurrent analysis cannot regress the latest checkpoint", () => {
  const newer = normalizeRealtimePostTurnAnalysis({
    current_stage: "assessment",
    continuity: { counterpart: "Executive sponsor" },
  }, {
    learnerTranscript: "I recommend option A.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  const older = normalizeRealtimePostTurnAnalysis({
    current_stage: "feedback",
    continuity: { counterpart: "Old counterpart" },
  }, {
    learnerTranscript: "My first answer.",
    experienceMode: "global_meeting",
    correctionMode: "selective",
    currentStage: "simulation",
    currentScenarioStatus: "active",
    hasPendingRetry: false,
  });
  const current = mergeRealtimePostTurnReport({}, newer, {
    clientTurnId: "new-client",
    studentTurnId: "new-student",
    assistantTurnId: "new-assistant",
    turnIndex: 10,
    recordedAt: "2026-08-01T12:01:00Z",
    model: "new-model",
  });
  current.needsExternalVerification = true;
  current.verificationReason = "Verify the current official source.";
  const merged = mergeRealtimePostTurnReport(current, older, {
    clientTurnId: "old-client",
    studentTurnId: "old-student",
    assistantTurnId: "old-assistant",
    turnIndex: 4,
    recordedAt: "2026-08-01T12:02:00Z",
    model: "old-model",
  });
  assertEquals(merged.currentStage, "assessment");
  assertEquals(merged.counterpart, "Executive sponsor");
  assertEquals(merged.lastRealtimeTurnIndex, 10);
  assertEquals(merged.updatedAt, "2026-08-01T12:01:00Z");
  assertEquals(merged.needsExternalVerification, true);
  assertEquals(
    merged.verificationReason,
    "Verify the current official source.",
  );
  assertEquals(latestRealtimeAnalysis(merged)?.model, "new-model");
  assertEquals((merged.realtimeAnalyses as unknown[]).length, 2);
});
