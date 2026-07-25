export const WOLFIE_SUBJECTS = [
  'vocabulary',
  'grammar',
  'listening',
  'reading',
  'writing',
  'global_meetings',
] as const;

export type WolfieSubject = (typeof WOLFIE_SUBJECTS)[number];
export type QuizSubject = Exclude<WolfieSubject, 'writing' | 'global_meetings'>;
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
export type ActivityPhase =
  | 'standard'
  | 'construction'
  | 'memorization'
  | 'readaptation';
export type ActivityModality = 'text' | 'voice' | 'mixed';

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

export interface MeetingSection {
  key:
    | 'opening'
    | 'context'
    | 'data'
    | 'proposal'
    | 'next_steps'
    | 'closing';
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
}

export interface MemorizationState {
  hiddenSections: string[];
  rehearsalCount: number;
  confidence: number;
}

export interface MeetingSectionState {
  original: string;
  corrected: string;
  naturalVersion: string;
  score: number;
  savedAt?: string;
}

export interface WolfieLearnerState {
  sections?: Partial<Record<MeetingSection['key'], MeetingSectionState>>;
  memorization?: MemorizationState;
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
    | 'IN_PROGRESS'
    | 'EVALUATING'
    | 'COMPLETED'
    | 'ABANDONED'
    | 'FAILED';
  source_session_id: string | null;
  activity_content: WolfieActivityContent;
  learner_state: WolfieLearnerState;
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
}

export interface QuizResultDetail {
  id: string;
  selectedIndex: number;
  correctIndex: number;
  correct: boolean;
  explanationPt: string;
  term?: string;
  translation?: string;
  definitionPt?: string;
  example?: string;
}

export interface QuizResult extends AttemptMeta {
  score: number;
  correctCount: number;
  total: number;
  details: QuizResultDetail[];
  readinessMessage: string;
  transcript?: string;
}

export interface EvaluationRubric {
  taskCompletion?: number;
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
  readinessMessage: string;
}

export type WolfieActivityResult =
  | QuizResult
  | TextEvaluationResult
  | SpeechEvaluationResult;

export interface SubjectProgress {
  subject: WolfieSubject | 'conversation';
  completed: number;
  averageScore: number | null;
}

export interface WolfieRecentSession {
  id: string;
  subject: WolfieSubject | 'conversation';
  cefr_level: CefrLevel;
  sector: string | null;
  phase: ActivityPhase | 'conversation';
  status: WolfieActivitySession['status'];
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
  source_subject: WolfieSubject | 'conversation';
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
}

export interface WolfieUserSummary {
  id?: string;
  name?: string;
  module?: string;
  wolfieSettings?: {
    goal?: string;
    level?: CefrLevel;
  };
  englishFor?: string;
  shortTermGoal?: string;
}

export const isQuizResult = (
  result: WolfieActivityResult,
): result is QuizResult => 'correctCount' in result;

export const isSpeechResult = (
  result: WolfieActivityResult,
): result is SpeechEvaluationResult => 'pronunciation' in result;
