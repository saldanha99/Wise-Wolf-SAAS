/// <reference lib="deno.ns" />

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ClassicGlobalMeetingResponseProjection,
  integrateClassicGlobalMeetingTurn,
} from "./classic-global-meeting.ts";

const CYCLE_ID = "10000000-0000-4000-8000-000000000981";

function response(
  overrides: Partial<ClassicGlobalMeetingResponseProjection> = {},
): ClassicGlobalMeetingResponseProjection {
  return {
    current_stage: "simulation",
    scenario_status: "active",
    correction: null,
    corrections: [],
    student_strengths: [],
    student_priorities: [],
    next_action: "",
    profile_updates: {},
    session_score: null,
    requires_retry: false,
    retry_completed: false,
    ...overrides,
  };
}

const fullRubric = {
  task_completion: 80,
  structure_and_facilitation: 80,
  interaction_and_turn_taking: 80,
  clarification_and_question_handling: 80,
  diplomacy_and_negotiation: 80,
  clarity_and_concision: 80,
  accuracy_and_naturalness: 80,
  decision_and_actionable_close: 80,
};

Deno.test("Classic clarify_intent freezes projection, scoring, and continuity", () => {
  const learnerTranscript = "Can you explain that?";
  const result = integrateClassicGlobalMeetingTurn({
    providerPayload: {
      current_stage: "assessment",
      scenario_status: "completed",
      session_score: 99,
      rubric: fullRubric,
      corrections: [{
        original: learnerTranscript,
        corrected: "Could you explain that?",
        natural_version: "Could you explain that?",
        explanation: "Use could for a softer request.",
        priority: "high",
        category: "naturalness",
      }],
      requires_retry: true,
      retry_completed: true,
      adaptive_level: 6,
      continuity: {
        counterpart: "Injected stakeholder",
        pending_question: "Injected question",
        pending_decision: "Injected decision",
      },
    },
    response: response({
      current_stage: "assessment",
      scenario_status: "completed",
      requires_retry: true,
    }),
    context: {
      learnerTranscript,
      experienceMode: "global_meeting",
      correctionMode: "selective",
      difficulty: "adaptive",
      currentAdaptiveLevel: 3,
      currentCounterpart: "Regional VP",
      currentPendingQuestion: "Which risk should we accept?",
      currentPendingDecision: "Approve the recovery plan",
      currentStage: "simulation",
      currentScenarioStatus: "active",
      hasPendingRetry: false,
    },
    currentReport: {},
    cycleId: CYCLE_ID,
    clientTurnId: "20000000-0000-4000-8000-000000000981",
    recordedAt: "2026-08-01T12:00:00.000Z",
  });

  assertEquals(result.analysis?.learnerIntent, "clarify_intent");
  assertEquals(result.analysis?.observedRubric, {});
  assertEquals(result.response.current_stage, "simulation");
  assertEquals(result.response.scenario_status, "active");
  assertEquals(result.response.corrections, []);
  assertEquals(result.response.session_score, null);
  assertEquals(result.response.requires_retry, false);
  assertEquals(result.report.counterpart, "Regional VP");
  assertEquals(
    result.report.pendingQuestion,
    "Which risk should we accept?",
  );
  assertEquals(result.report.pendingDecision, "Approve the recovery plan");
});

Deno.test("Classic ASR awaiting confirmation cannot advance or assess", () => {
  const currentReport = {
    currentStage: "assessment",
    scenarioStatus: "active",
    sentinel: "unchanged",
  };
  const result = integrateClassicGlobalMeetingTurn({
    providerPayload: {
      current_stage: "completed",
      rubric: fullRubric,
      session_score: 100,
    },
    response: response({
      current_stage: "completed",
      scenario_status: "completed",
      corrections: [{
        original: "fifteen units",
        corrected: "fifty units",
        natural_version: "fifty units",
        explanation: "Provider-proposed correction.",
        priority: "high",
        category: "clarity",
      }],
      session_score: 100,
    }),
    context: {
      learnerTranscript: "We shipped fifteen units.",
      experienceMode: "global_meeting",
      correctionMode: "selective",
      currentStage: "assessment",
      currentScenarioStatus: "active",
      hasPendingRetry: false,
    },
    currentReport,
    cycleId: CYCLE_ID,
    clientTurnId: "20000000-0000-4000-8000-000000000982",
    recordedAt: "2026-08-01T12:01:00.000Z",
    awaitingTranscriptConfirmation: true,
  });

  assertEquals(result.analysis, null);
  assertEquals(result.assessment, null);
  assertEquals(result.turnIndex, null);
  assertEquals(result.response.current_stage, "assessment");
  assertEquals(result.response.scenario_status, "active");
  assertEquals(result.response.corrections, []);
  assertEquals(result.response.session_score, null);
  assertEquals(result.report, currentReport);
});

Deno.test("Classic competency retry requires its persisted rubric dimension", () => {
  const requiredAnswer =
    "I recommend option A because it lowers delivery risk.";
  const baseInput = {
    response: response({
      current_stage: "retry" as const,
      scenario_status: "awaiting_retry" as const,
      requires_retry: true,
    }),
    context: {
      learnerTranscript: requiredAnswer,
      experienceMode: "global_meeting",
      correctionMode: "selective" as const,
      currentStage: "retry" as const,
      currentScenarioStatus: "awaiting_retry" as const,
      hasPendingRetry: true,
      pendingRetryTarget: {
        corrected: requiredAnswer,
        natural_version: requiredAnswer,
        scope: "meeting_competency" as const,
        requiredRubricDimension: "diplomacy_and_negotiation" as const,
      },
    },
    currentReport: {},
    cycleId: CYCLE_ID,
    recordedAt: "2026-08-01T12:02:00.000Z",
  };
  const belowGate = integrateClassicGlobalMeetingTurn({
    ...baseInput,
    providerPayload: {
      current_stage: "retry",
      retry_completed: true,
      rubric: { diplomacy_and_negotiation: 74 },
    },
    clientTurnId: "20000000-0000-4000-8000-000000000983",
  });
  const passed = integrateClassicGlobalMeetingTurn({
    ...baseInput,
    providerPayload: {
      current_stage: "retry",
      retry_completed: true,
      rubric: { diplomacy_and_negotiation: 82 },
    },
    clientTurnId: "20000000-0000-4000-8000-000000000984",
  });

  assertEquals(belowGate.response.retry_completed, false);
  assertEquals(belowGate.response.requires_retry, true);
  assertEquals(belowGate.response.current_stage, "retry");
  assertEquals(belowGate.response.scenario_status, "awaiting_retry");
  assertEquals(passed.analysis?.observedRubric.diplomacy_and_negotiation, 82);
  assertEquals(passed.response.retry_completed, true);
  assertEquals(passed.response.requires_retry, false);
  assertEquals(passed.response.current_stage, "simulation");
  assertEquals(passed.response.scenario_status, "active");
});

Deno.test("Classic readiness is latched in report before completion", () => {
  const assessed = integrateClassicGlobalMeetingTurn({
    providerPayload: {
      current_stage: "report",
      session_score: 0,
      rubric: fullRubric,
      adaptive_level: 4,
      continuity: {
        counterpart: "Executive sponsor",
        pending_question: "What is the mitigation?",
        pending_decision: "Approve option A",
      },
    },
    response: response({ current_stage: "assessment" }),
    context: {
      learnerTranscript:
        "I recommend option A, with Ana owning the mitigation by Friday.",
      experienceMode: "global_meeting",
      correctionMode: "end",
      difficulty: "adaptive",
      currentAdaptiveLevel: 3,
      currentStage: "assessment",
      currentScenarioStatus: "active",
      hasPendingRetry: false,
    },
    currentReport: {},
    cycleId: CYCLE_ID,
    clientTurnId: "20000000-0000-4000-8000-000000000985",
    recordedAt: "2026-08-01T12:03:00.000Z",
    model: "meeting-test-model",
  });
  const assessment = assessed.report.realtimeMeetingAssessment as Record<
    string,
    unknown
  >;

  assertEquals(assessed.response.current_stage, "report");
  assertEquals(assessed.response.scenario_status, "active");
  assertEquals(assessed.response.session_score, 80);
  assertEquals(assessment.score, 80);
  assertEquals(assessment.readinessLatched, true);
  assertEquals(assessed.report.lastClassicMeetingTurnIndex, 0);

  const completed = integrateClassicGlobalMeetingTurn({
    providerPayload: { current_stage: "completed" },
    response: response({ current_stage: "report" }),
    context: {
      learnerTranscript: "Thank you. We have a decision and clear owners.",
      experienceMode: "global_meeting",
      correctionMode: "end",
      currentStage: "report",
      currentScenarioStatus: "active",
      hasPendingRetry: false,
    },
    currentReport: assessed.report,
    cycleId: CYCLE_ID,
    clientTurnId: "20000000-0000-4000-8000-000000000986",
    recordedAt: "2026-08-01T12:04:00.000Z",
  });

  assertEquals(completed.response.current_stage, "completed");
  assertEquals(completed.response.scenario_status, "completed");
  assertEquals(completed.report.currentStage, "completed");
  assertEquals(completed.report.scenarioStatus, "completed");
  assertEquals(completed.report.lastClassicMeetingTurnIndex, 1);
  assertEquals(completed.report.counterpart, "Executive sponsor");
  assertEquals(completed.report.pendingQuestion, "What is the mitigation?");
  assertEquals(completed.report.pendingDecision, "Approve option A");
});
