export const WOLFIE_SUBJECTS = [
  "vocabulary",
  "grammar",
  "listening",
  "reading",
  "writing",
  "global_meetings",
] as const;

export type WolfieSubject = (typeof WOLFIE_SUBJECTS)[number];
export type QuizSubject = Exclude<WolfieSubject, "writing" | "global_meetings">;
export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";
export type ActivityPhase =
  | "standard"
  | "construction"
  | "memorization"
  | "readaptation";
export type ActivityModality = "text" | "voice" | "mixed";

export type WolfieExperienceMode =
  | "free_conversation"
  | "guided_lesson"
  | "roleplay"
  | "presentation"
  | "global_meeting"
  | "interview"
  | "exam"
  | "writing"
  | "pronunciation"
  | "vocabulary"
  | "storytelling"
  | "child_mission"
  | "teen_challenge"
  | "examiner"
  | "fluency"
  | "emergency";

export type WolfieCorrectionMode =
  | "immediate"
  | "end"
  | "selective"
  | "examiner";

export type WolfieLanguageMode =
  | "pt_support"
  | "bilingual"
  | "immersive"
  | "english_rescue";

export type WolfieDifficulty =
  | "supportive"
  | "balanced"
  | "challenging"
  | "adaptive";

export interface WolfieConversationBrief {
  topic: string;
  scenario: string;
  studentGoal: string;
  targetSkill: string;
  experienceId?: string;
  experienceUniverse?: string;
  experienceAudiences?: string[];
  experienceMode: WolfieExperienceMode;
  correctionMode: WolfieCorrectionMode;
  languageMode: WolfieLanguageMode;
  difficulty: WolfieDifficulty;
}

export interface VocabularyItem {
  term: string;
  translation: string;
  definitionPt: string;
  example: string;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
}

export interface MeetingScenario {
  title: string;
  role: string;
  company: string;
  objective: string;
  constraint: string;
  sector: string;
}

export type MeetingSectionKey =
  | "opening"
  | "context"
  | "data"
  | "proposal"
  | "next_steps"
  | "closing";

export interface MeetingSection {
  key: MeetingSectionKey;
  title: string;
  objective: string;
  coachTipPt: string;
  starter: string;
}

export interface WolfieActivityContent {
  title: string;
  readinessGoal: string;
  instructionsPt: string;
  targetVocabulary: VocabularyItem[];
  microLesson?: string;
  passage?: string;
  hasListeningAudio?: boolean;
  questions?: QuizQuestion[];
  context?: string;
  prompt?: string;
  checklist?: string[];
  scenario?: MeetingScenario;
  sections?: MeetingSection[];
  readaptationRules?: string[];
  experience?: {
    id: string;
    title: string;
    description?: string;
    universeId: string;
    experienceMode: WolfieExperienceMode;
    audiences: string[];
    realWorldGoal: string;
  };
}

export interface MemorizationState {
  hiddenSections: string[];
  rehearsalCount: number;
  confidence: number;
  recallEvidence?: MeetingRecallEvidence | null;
}

export type MeetingRecallBlocks = Record<MeetingSectionKey, string>;
export type MeetingRecallBlockScores = Record<MeetingSectionKey, number>;

export interface MeetingRecallEvidence {
  kind: "structured_six_block_recall";
  status: "validated";
  validationVersion: 1;
  validationId: string;
  requestKey: string;
  sourceSessionId: string;
  recordedAt: string;
  submissionDigest: string;
  score: number;
  blockScores: MeetingRecallBlockScores;
  passedBlocks: MeetingSectionKey[];
  referenceAttemptIds: Record<MeetingSectionKey, string>;
}

export interface MeetingRecallResult {
  score: number;
  blockScores: MeetingRecallBlockScores;
  failedBlocks: MeetingSectionKey[];
  validated: boolean;
  requiresRetry: boolean;
  strengths: string[];
  priorities: string[];
  explanationPt: string;
  readinessMessage: string;
  retryPrompt: string;
  validationId: string;
  recallEvidence?: MeetingRecallEvidence;
}

export interface MeetingSectionState {
  original: string;
  corrected: string;
  naturalVersion: string;
  score: number;
  attemptId?: string;
  requiresRetry?: boolean;
  retryCompleted?: boolean;
  parentAttemptId?: string | null;
  savedAt?: string;
}

export interface WolfieLearnerState {
  sections?: Partial<Record<MeetingSection["key"], MeetingSectionState>>;
  memorization?: MemorizationState;
  quizAnswers?: Record<
    string,
    AnswerFeedback & {
      savedAt?: string;
      score?: number;
    }
  >;
  [key: string]: unknown;
}

export interface WolfieActivityAttemptSnapshot {
  attemptId?: string | null;
  attemptNumber?: number;
  stepKey?: string;
  modality?: ActivityModality;
  score?: number;
  requiresRetry?: boolean;
  retryCompleted?: boolean;
  parentAttemptId?: string | null;
  responsePayload?: Record<string, unknown>;
  feedbackPayload?: Record<string, unknown>;
  recordedAt?: string;
}

export interface WolfieActivityReport {
  latestAttempt?: WolfieActivityAttemptSnapshot;
  [key: string]: unknown;
}

export interface WolfieActivitySession {
  id: string;
  tenant_id: string;
  student_id: string;
  subject: WolfieSubject;
  cefr_level: CefrLevel;
  sector: string | null;
  phase: ActivityPhase;
  modality: ActivityModality;
  status:
    | "IN_PROGRESS"
    | "EVALUATING"
    | "AWAITING_RETRY"
    | "COMPLETED"
    | "ABANDONED"
    | "FAILED";
  source_session_id: string | null;
  activity_content: WolfieActivityContent;
  learner_state: WolfieLearnerState;
  current_stage?: string;
  report_json?: WolfieActivityReport;
  required_retry_count?: number;
  completed_retry_count?: number;
  reused_terms: string[];
  introduced_terms: string[];
  score: number | null;
  xp_earned: number;
  duration_seconds: number;
  attempt_count: number;
  test_fixture: boolean;
  started_at: string;
  completed_at: string | null;
}

export interface AttemptMeta {
  alreadyCompleted?: boolean;
  attemptNumber?: number;
  attemptId?: string;
  parentAttemptId?: string | null;
  requiresRetry?: boolean;
  retryCompleted?: boolean;
  retryPrompt?: string;
  xpEarned?: number;
  leveledUp?: boolean;
  newLevel?: number;
}

export interface AnswerFeedback {
  questionId: string;
  selectedIndex: number;
  correctIndex: number;
  correct: boolean;
  explanationPt: string;
  term?: string;
  translation?: string;
  definitionPt?: string;
  example?: string;
  locked?: boolean;
  attemptId?: string;
  attemptNumber?: number;
  requiresRetry?: boolean;
  retryCompleted?: boolean;
  parentAttemptId?: string | null;
}

export interface QuizResultDetail {
  id: string;
  selectedIndex: number;
  initialSelectedIndex?: number;
  correctIndex: number;
  /** Whether the learner answered correctly on the first attempt. */
  correct: boolean;
  /** Whether the learner ultimately answered correctly, including retries. */
  mastered?: boolean;
  masteredAfterRetry?: boolean;
  attemptCount?: number;
  explanationPt: string;
  term?: string;
  translation?: string;
  definitionPt?: string;
  example?: string;
}

export interface QuizResult extends AttemptMeta {
  /** Score based only on first attempts, so retries never inflate the grade. */
  score: number;
  correctCount: number;
  masteryCount?: number;
  total: number;
  details: QuizResultDetail[];
  readinessMessage: string;
  transcript?: string;
}

export interface EvaluationRubric {
  taskCompletion?: number;
  structureAndFacilitation?: number;
  interactionAndTurnTaking?: number;
  clarificationAndQuestionHandling?: number;
  diplomacyAndNegotiation?: number;
  clarityAndConcision?: number;
  accuracyAndNaturalness?: number;
  decisionAndActionableClose?: number;
  /** Legacy non-meeting writing dimensions. */
  structure?: number;
  clarity?: number;
  accuracy?: number;
  naturalness?: number;
  levelFit?: number;
  scenarioFit?: number;
}

export interface TextEvaluationResult extends AttemptMeta {
  score: number;
  correctedText: string;
  naturalVersion: string;
  explanationPt: string;
  strengths: string[];
  priorities: string[];
  readinessMessage: string;
  rubric: EvaluationRubric;
}

export interface SpeechMetric {
  score: number;
  observations: string[];
  tipPt: string;
}

export interface SpeechEvaluationResult extends AttemptMeta {
  score: number;
  transcript: string;
  correctedTranscript: string;
  pronunciation: SpeechMetric;
  intonation: SpeechMetric;
  naturalness: SpeechMetric;
  rubric?: EvaluationRubric;
  contentScore?: number;
  failedGates?: string[];
  strengths?: string[];
  priorities?: string[];
  explanationPt?: string;
  readinessMessage: string;
}

export type WolfieActivityResult =
  | QuizResult
  | TextEvaluationResult
  | SpeechEvaluationResult;

export interface SubjectProgress {
  subject: WolfieSubject | "conversation";
  completed: number;
  averageScore: number | null;
}

export interface WolfieRecentSession {
  id: string;
  subject: WolfieSubject | "conversation";
  cefr_level: CefrLevel;
  sector: string | null;
  phase: ActivityPhase | "conversation";
  status: WolfieActivitySession["status"];
  score: number | null;
  xp_earned: number;
  attempt_count: number;
  started_at: string;
  completed_at: string | null;
}

export interface RepertoireItem {
  id: string;
  term: string;
  translation: string;
  definition_pt: string;
  example_sentence: string;
  cefr_level: CefrLevel;
  source_subject: WolfieSubject | "conversation";
  sector: string | null;
  mastery_score: number;
  next_review_at: string | null;
  last_seen_at: string | null;
}

export interface WolfieOverview {
  totalSessions: number;
  completedSessions: number;
  averageScore: number | null;
  repertoireCount: number;
  readyTerms: number;
  subjectProgress: SubjectProgress[];
  recentSessions: WolfieRecentSession[];
  resumableSessions: WolfieActivitySession[];
  repertoire: RepertoireItem[];
}

export interface WolfieSelection {
  subject: WolfieSubject;
  level: CefrLevel;
  sector?: string;
  experienceId?: string;
  experienceTitle?: string;
  experienceContext?: string;
  experienceDescription?: string;
  experienceUniverse?: string;
  experienceAudiences?: string[];
  realWorldGoal?: string;
  experienceMode?: WolfieExperienceMode;
}

export interface WolfieUserSummary {
  id?: string;
  name?: string;
  full_name?: string;
  module?: string;
  occupation?: string;
  studentCategory?: string;
  student_category?: string;
  isKids?: boolean;
  is_kids?: boolean;
  interests?: string[];
  preferredTopics?: string[];
  preferred_topics?: string[];
  wolfieSettings?: {
    goal?: string;
    level?: CefrLevel;
    correctionStrictness?: 1 | 2 | 3;
    preferredCorrectionMode?: WolfieCorrectionMode;
    preferredLanguageMode?: WolfieLanguageMode;
  };
  wolfie_settings?: WolfieUserSummary["wolfieSettings"];
  englishFor?: string;
  english_for?: string;
  shortTermGoal?: string;
  short_term_goal?: string;
}

export const isQuizResult = (
  result: WolfieActivityResult,
): result is QuizResult => "correctCount" in result;

export const isSpeechResult = (
  result: WolfieActivityResult,
): result is SpeechEvaluationResult => "pronunciation" in result;
