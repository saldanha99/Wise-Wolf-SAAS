/// <reference lib="deno.ns" />

import {
  buildGlobalMeetingPolicyBlock,
  classifyGlobalMeetingLearnerIntent,
  GLOBAL_MEETING_COMPETENCIES,
  GLOBAL_MEETING_DEPARTMENTS,
  GLOBAL_MEETING_RUBRIC_DIMENSIONS,
  GLOBAL_MEETING_STUDENT_GOAL_PROVENANCE,
  GLOBAL_MEETING_TYPES,
  globalMeetingStageGuidance,
  isGlobalMeetingExperience,
  persistedSessionStudentGoal,
  withGlobalMeetingStudentGoalProvenance,
} from "../../supabase/functions/_shared/wolfie-global-meeting-policy.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("global meeting taxonomy covers reusable meeting and department libraries", () => {
  assert(
    GLOBAL_MEETING_TYPES.length >= 20,
    "meeting type library is incomplete",
  );
  assert(
    GLOBAL_MEETING_DEPARTMENTS.length >= 20,
    "department library is incomplete",
  );
  assert(
    GLOBAL_MEETING_COMPETENCIES.includes("turn_taking"),
    "turn-taking competency is missing",
  );
  assert(
    GLOBAL_MEETING_COMPETENCIES.includes("question_handling"),
    "question-handling competency is missing",
  );
  assert(
    GLOBAL_MEETING_RUBRIC_DIMENSIONS.includes("decision_and_actionable_close"),
    "actionable close must be assessed",
  );
});

Deno.test("experience detection accepts only the global meeting modes", () => {
  for (const value of ["global_meeting", "global meetings", "GLOBAL-MEETING"]) {
    assert(
      isGlobalMeetingExperience(value),
      `expected global meeting: ${value}`,
    );
  }
  for (const value of ["presentation", "roleplay", "meeting notes", ""]) {
    assert(
      !isGlobalMeetingExperience(value),
      `unexpected global meeting: ${value}`,
    );
  }
});

Deno.test("learner intent supports doubt review model feedback and normal performance", () => {
  const cases = [
    ["What does trade-off mean?", "ask_doubt"],
    ["Quero revisar meu erro anterior", "request_review"],
    ["Como eu poderia dizer isso?", "request_model"],
    ["Can you give me feedback?", "request_feedback"],
    ["Can we go over what I said before?", "request_review"],
    ["Could you give feedback on that?", "request_feedback"],
    ["What should I say here?", "request_model"],
    ["Could you show me a model answer?", "request_model"],
    ["How would you phrase this?", "request_model"],
    ["Could you check my last answer?", "request_review"],
    ["I have a question about the grammar.", "ask_doubt"],
    ["Can I ask about this phrase?", "ask_doubt"],
    ["Tenho uma pergunta sobre o inglês.", "ask_doubt"],
    ["Can we pause for a grammar question?", "ask_doubt"],
    ["Can you explain that?", "clarify_intent"],
    ["Você pode explicar isso?", "clarify_intent"],
    ["The main risk is the supplier deadline.", "perform"],
  ] as const;
  for (const [input, expected] of cases) {
    assert(
      classifyGlobalMeetingLearnerIntent(input) === expected,
      `unexpected intent for ${JSON.stringify(input)}`,
    );
  }
});

Deno.test("in-role clarification questions remain meeting performance", () => {
  for (
    const input of [
      "Can you explain the delivery risk?",
      "What is the difference between option A and option B?",
      "Why is the supplier asking for another week?",
      "Let's review the Q3 KPIs before we decide.",
      "Could I get your feedback on the proposal?",
    ]
  ) {
    assert(
      classifyGlobalMeetingLearnerIntent(input) === "perform",
      `in-role question was incorrectly paused: ${JSON.stringify(input)}`,
    );
  }
  for (
    const input of [
      "Can you explain this grammar correction?",
      "Tenho uma dúvida: qual a diferença entre deadline e due date?",
    ]
  ) {
    assert(
      classifyGlobalMeetingLearnerIntent(input) === "ask_doubt",
      `meta-pedagogical doubt was not paused: ${JSON.stringify(input)}`,
    );
  }
});

Deno.test("global-meeting goals require server provenance and exact agreement", () => {
  const explicitGoal = "Secure approval for option A.";
  const snapshot = withGlobalMeetingStudentGoalProvenance({
    experienceMode: "global_meeting",
    studentGoal: explicitGoal,
    studentGoalProvenance: "client_spoof",
  });
  assert(
    snapshot.studentGoalProvenance ===
      GLOBAL_MEETING_STUDENT_GOAL_PROVENANCE,
    "the persistence boundary must mint the server marker",
  );
  assert(
    persistedSessionStudentGoal({
      experience_mode: "global_meeting",
      student_goal: explicitGoal,
      config_snapshot: snapshot,
    }) === explicitGoal,
    "matching explicit session goal should be reusable",
  );
  assert(
    persistedSessionStudentGoal({
      experience_mode: "global_meeting",
      student_goal: "Legacy profile goal",
      config_snapshot: { studentGoal: "Legacy profile goal" },
    }) === "",
    "legacy goal without provenance must be removed",
  );
});

Deno.test("in-role review and feedback language remains meeting evidence", () => {
  for (
    const input of [
      "Let's review the Q3 KPIs before we decide.",
      "Could I get your feedback on the proposal?",
      "Please review the recovery plan with Finance.",
      "I will give feedback to the supplier tomorrow.",
    ]
  ) {
    assert(
      classifyGlobalMeetingLearnerIntent(input) === "perform",
      `in-role business language was incorrectly paused: ${
        JSON.stringify(input)
      }`,
    );
  }
  for (
    const input of [
      "Can you give me feedback?",
      "Could you give me feedback on my English?",
      "Can we review the previous correction?",
      "Quero revisar meu erro anterior.",
    ]
  ) {
    assert(
      classifyGlobalMeetingLearnerIntent(input) !== "perform",
      `meta-pedagogical request was not paused: ${JSON.stringify(input)}`,
    );
  }
});

Deno.test("policy requires interactive meeting progression and resumable doubts", () => {
  const policy = buildGlobalMeetingPolicyBlock({
    stage: "simulation",
    difficulty: "adaptive",
    correctionMode: "selective",
    scenario: "Quarterly review with a regional director.",
    goal: "Secure a decision on the recovery plan.",
    targetSkill: "diplomatic disagreement",
  });
  for (
    const required of [
      "interactive professional meeting",
      "Good, Better, and Executive",
      "pause the roleplay without advancing the stage",
      "ask one neutral disambiguation question",
      "resume the same counterpart, pending question, and decision",
      "Never award readiness from fluency alone",
      "Level 6",
      "decision/actionable close",
    ]
  ) {
    assert(policy.includes(required), `missing policy rule: ${required}`);
  }
  assert(
    policy.includes("Quarterly review with a regional director."),
    "bounded scenario should be represented as learning data",
  );
});

Deno.test("stage guidance keeps retry and readaptation behavior deterministic", () => {
  assert(
    globalMeetingStageGuidance("retry").includes("same counterpart"),
    "retry must preserve the active meeting state",
  );
  assert(
    globalMeetingStageGuidance("readaptation").includes(
      "at least two material variables",
    ),
    "readaptation must be materially different",
  );
});
