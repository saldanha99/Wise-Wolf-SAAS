import React, {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock3,
  MessageCircleMore,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from 'lucide-react';

export type ComplementaryActivityType = 'reading' | 'grammar' | 'quiz' | 'conversation';

export interface ComplementaryActivity {
  id: string;
  type: ComplementaryActivityType;
  title: string;
  description?: string | null;
  content: unknown;
  estimated_minutes?: number | null;
}

export interface ComplementaryQuestionResult {
  questionId: string;
  selectedIndex: number;
  correct: boolean;
  correctIndex?: number;
  explanation?: string;
}

export interface ComplementaryActivityEvidence {
  activityId: string;
  activityType: ComplementaryActivityType;
  contentMode: 'legacy' | 'structured';
  checklistCompleted?: string[];
  reflection?: string;
  answers?: number[];
  questionIds?: string[];
  completedAt: string;
}

export interface ComplementaryActivitySubmissionResult {
  activityId: string;
  status: 'PENDING' | 'COMPLETED';
  passed: boolean;
  scorePercentage?: number | null;
  questionResults?: ComplementaryQuestionResult[];
  completedAt?: string | null;
  alreadyApplied?: boolean;
  canonicalResultAvailable?: boolean;
}

export interface ComplementaryActivityPlayerProps {
  activity: ComplementaryActivity;
  onClose: () => void;
  onSubmit: (evidence: ComplementaryActivityEvidence) => Promise<ComplementaryActivitySubmissionResult>;
}

interface NormalizedQuestion {
  id: string;
  prompt: string;
  options: string[];
}

interface NormalizedContent {
  mode: 'legacy' | 'structured';
  intro: string;
  passage: string;
  steps: string[];
  reflectionPrompt: string;
  questions: NormalizedQuestion[];
}

type JsonRecord = Record<string, unknown>;

const MIN_REFLECTION_LENGTH = 20;
const MAX_REFLECTION_LENGTH = 1_200;
const DEFAULT_ESTIMATED_MINUTES: Record<ComplementaryActivityType, number> = {
  reading: 8,
  grammar: 6,
  quiz: 5,
  conversation: 10,
};
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const TYPE_COPY: Record<ComplementaryActivityType, {
  eyebrow: string;
  icon: typeof BookOpen;
  accent: string;
  soft: string;
}> = {
  reading: {
    eyebrow: 'Leitura guiada',
    icon: BookOpen,
    accent: 'text-sky-700 dark:text-sky-300',
    soft: 'bg-sky-50 dark:bg-sky-950/30',
  },
  grammar: {
    eyebrow: 'Gramática em prática',
    icon: Sparkles,
    accent: 'text-emerald-700 dark:text-emerald-300',
    soft: 'bg-emerald-50 dark:bg-emerald-950/30',
  },
  quiz: {
    eyebrow: 'Desafio de múltipla escolha',
    icon: CheckCircle2,
    accent: 'text-amber-700 dark:text-amber-300',
    soft: 'bg-amber-50 dark:bg-amber-950/30',
  },
  conversation: {
    eyebrow: 'Conversação consciente',
    icon: MessageCircleMore,
    accent: 'text-violet-700 dark:text-violet-300',
    soft: 'bg-violet-50 dark:bg-violet-950/30',
  },
};

const DEFAULT_STEPS: Record<'reading' | 'conversation' | 'generic', string[]> = {
  reading: [
    'Li o conteúdo com atenção, sem apenas passar os olhos.',
    'Identifiquei a ideia principal e pelo menos um detalhe importante.',
    'Revisei as palavras ou trechos em que tive dúvida.',
  ],
  conversation: [
    'Entendi o cenário e defini o que quero comunicar.',
    'Separei palavras ou frases úteis antes de praticar.',
    'Pratiquei minha resposta em voz alta pelo menos uma vez.',
  ],
  generic: [
    'Li todas as instruções da atividade.',
    'Executei a prática proposta com atenção.',
    'Revisei o que foi mais fácil e o que ainda preciso praticar.',
  ],
};

const isRecord = (value: unknown): value is JsonRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const cleanText = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const firstText = (record: JsonRecord, keys: string[]): string => {
  for (const key of keys) {
    const value = cleanText(record[key]);
    if (value) return value;
  }
  return '';
};

const textList = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.map(cleanText).filter(Boolean).slice(0, 12)
    : []
);

const firstTextList = (record: JsonRecord, keys: string[]): string[] => {
  for (const key of keys) {
    const values = textList(record[key]);
    if (values.length > 0) return values;
  }
  return [];
};

const legacySteps = (content: string): string[] => {
  const lines = content
    .split(/\n+/)
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);
  if (lines.length > 1) return lines.slice(0, 10);

  const sentences = content
    .match(/[^.!?\n]+[.!?]?/g)
    ?.map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 8) ?? [];
  return sentences.length > 1 ? sentences.slice(0, 8) : [];
};

const normalizeQuestion = (
  value: unknown,
  index: number,
): NormalizedQuestion | null => {
  if (!isRecord(value)) return null;
  const prompt = firstText(value, ['q', 'question', 'question_text', 'sentence', 'prompt']);
  const options = textList(value.options);
  if (!prompt || options.length < 2) {
    return null;
  }

  return {
    id: cleanText(value.id) || `question-${index + 1}`,
    prompt,
    options,
  };
};

const parseStructuredContent = (content: unknown): JsonRecord | null => {
  if (isRecord(content)) return content;
  if (typeof content !== 'string') return null;
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeContent = (
  activity: ComplementaryActivity,
): NormalizedContent => {
  const structured = parseStructuredContent(activity.content);
  if (!structured) {
    const raw = cleanText(activity.content) || cleanText(activity.description);
    const parsedSteps = legacySteps(raw);
    const defaults = activity.type === 'reading'
      ? DEFAULT_STEPS.reading
      : activity.type === 'conversation'
        ? DEFAULT_STEPS.conversation
        : DEFAULT_STEPS.generic;
    return {
      mode: 'legacy',
      intro: raw,
      passage: '',
      steps: parsedSteps.length > 1 ? parsedSteps : defaults,
      reflectionPrompt: activity.type === 'conversation'
        ? 'O que você conseguiu comunicar e o que quer dizer com mais naturalidade na próxima tentativa?'
        : 'O que você aprendeu nesta prática e qual ponto ainda precisa revisar?',
      questions: [],
    };
  }

  const questionSource = Array.isArray(structured.questions)
    ? structured.questions
    : Array.isArray(structured.exercises)
      ? structured.exercises
      : [];
  const questions = questionSource
    .map(normalizeQuestion)
    .filter((question): question is NormalizedQuestion => question !== null)
    .slice(0, 20);
  const configuredSteps = firstTextList(structured, ['checklist', 'steps', 'preparation']);
  const defaults = activity.type === 'reading'
    ? DEFAULT_STEPS.reading
    : activity.type === 'conversation'
      ? DEFAULT_STEPS.conversation
      : DEFAULT_STEPS.generic;

  return {
    mode: 'structured',
    intro: firstText(structured, [
      'instructions_pt',
      'instructions',
      'rule_pt',
      'scenario',
      'introduction',
    ]),
    passage: firstText(structured, ['text', 'passage', 'reading_text']),
    steps: configuredSteps.length > 0 ? configuredSteps : defaults,
    reflectionPrompt: firstText(structured, ['reflection_prompt', 'reflectionPrompt']) || (
      activity.type === 'conversation'
        ? 'Depois de praticar em voz alta, o que saiu bem e o que você quer melhorar?'
        : 'Explique com suas palavras o que você entendeu e o que ainda precisa revisar.'
    ),
    questions,
  };
};

const focusableElements = (container: HTMLElement): HTMLElement[] => (
  Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(element => (
    element.tabIndex >= 0 &&
    !element.matches(':disabled') &&
    element.getAttribute('aria-hidden') !== 'true'
  ))
);

const ComplementaryActivityPlayer: React.FC<ComplementaryActivityPlayerProps> = ({
  activity,
  onClose,
  onSubmit,
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const checklistId = useId();
  const reflectionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const successTitleRef = useRef<HTMLHeadingElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  const submittingRef = useRef(false);
  const normalized = useMemo(
    () => normalizeContent(activity),
    [activity],
  );
  const objectiveMode = (
    (activity.type === 'quiz' || activity.type === 'grammar') &&
    normalized.questions.length > 0
  );

  const [answers, setAnswers] = useState<(number | null)[]>(
    () => normalized.questions.map(() => null),
  );
  const [submissionResult, setSubmissionResult] = useState<ComplementaryActivitySubmissionResult | null>(null);
  const [checklist, setChecklist] = useState<boolean[]>(
    () => normalized.steps.map(() => false),
  );
  const [reflection, setReflection] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    setAnswers(normalized.questions.map(() => null));
    setSubmissionResult(null);
    setChecklist(normalized.steps.map(() => false));
    setReflection('');
    setSubmitting(false);
    setSubmitError('');
    setSubmitted(false);
    submittingRef.current = false;
  }, [activity.id]); // normalized content belongs to the activity id

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    titleRef.current?.focus({ preventScroll: true });

    const focusFirst = () => {
      if (!dialogRef.current) return;
      const first = focusableElements(dialogRef.current)[0];
      (first ?? titleRef.current)?.focus({ preventScroll: true });
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!dialogRef.current || dialogRef.current.contains(event.target as Node)) return;
      focusFirst();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (submittingRef.current) return;
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const candidates = focusableElements(dialogRef.current);
      if (candidates.length === 0) {
        event.preventDefault();
        titleRef.current?.focus({ preventScroll: true });
        return;
      }
      const activeIndex = document.activeElement instanceof HTMLElement
        ? candidates.indexOf(document.activeElement)
        : -1;
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (activeIndex === -1) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeIndex === 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeIndex === candidates.length - 1) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus({ preventScroll: true });
      }
    };
  }, []);

  useEffect(() => {
    if (submitted) successTitleRef.current?.focus({ preventScroll: true });
  }, [submitted]);

  const answeredCount = answers.filter(answer => answer !== null).length;
  const reviewed = objectiveMode && submissionResult !== null;
  const objectivePassed = submissionResult?.passed === true
    && submissionResult.status === 'COMPLETED';
  const checkedCount = checklist.filter(Boolean).length;
  const reflectionReady = reflection.trim().length >= MIN_REFLECTION_LENGTH;
  const allAnswersReady = normalized.questions.length > 0 && (
    answeredCount === normalized.questions.length
  );
  const evidenceReady = checklist.length > 0 && (
    checkedCount === checklist.length && reflectionReady
  );
  const progress = objectiveMode
    ? reviewed
      ? 100
      : Math.round((answeredCount / Math.max(1, normalized.questions.length)) * 85)
    : Math.round(
      ((checkedCount + (reflectionReady ? 1 : 0)) / Math.max(1, checklist.length + 1)) * 100,
    );

  const questionFeedback = new Map<string, ComplementaryQuestionResult>(
    (submissionResult?.questionResults || []).map(result => [result.questionId, result]),
  );
  const correctCount = (submissionResult?.questionResults || []).filter(result => result.correct).length;

  const buildEvidence = (): ComplementaryActivityEvidence => {
    const base = {
      activityId: activity.id,
      activityType: activity.type,
      contentMode: normalized.mode,
      completedAt: new Date().toISOString(),
    };
    if (objectiveMode) {
      return {
        ...base,
        answers: answers.map(answer => answer ?? -1),
        questionIds: normalized.questions.map(question => question.id),
      };
    }
    return {
      ...base,
      checklistCompleted: normalized.steps.filter((_, index) => checklist[index]),
      reflection: reflection.trim(),
    };
  };

  const submitEvidence = async () => {
    if (submittingRef.current || submitted) return;
    if (objectiveMode && !allAnswersReady) return;
    if (!objectiveMode && !evidenceReady) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError('');
    try {
      const authoritativeResult = await onSubmit(buildEvidence());
      if (objectiveMode) {
        setSubmissionResult(authoritativeResult);
        if (
          authoritativeResult.passed
          && authoritativeResult.status === 'COMPLETED'
          && authoritativeResult.canonicalResultAvailable === false
        ) {
          // Registros muito antigos podem não ter a correção detalhada
          // persistida. Vá direto ao encerramento honesto, sem renderizar uma
          // revisão vazia como se o aluno tivesse tirado 0%.
          setSubmitted(true);
        }
      } else if (authoritativeResult.passed && authoritativeResult.status === 'COMPLETED') {
        setSubmitted(true);
      } else {
        setSubmitError('A evidência ainda não foi aceita. Revise as etapas e tente novamente.');
      }
    } catch {
      setSubmitError('Não foi possível registrar sua atividade. Suas respostas continuam aqui; tente novamente.');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const typeCopy = TYPE_COPY[activity.type];
  const TypeIcon = typeCopy.icon;
  const estimatedMinutes = Number(activity.estimated_minutes) > 0
    ? Number(activity.estimated_minutes)
    : DEFAULT_ESTIMATED_MINUTES[activity.type];
  const content = (
    <div className="fixed inset-0 z-[240] flex items-end justify-center bg-slate-950/70 p-0 backdrop-blur-sm sm:items-center sm:p-5">
      <div className="absolute inset-0" aria-hidden="true" />
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={submitting}
        className="relative flex max-h-dvh w-full flex-col overflow-hidden rounded-t-[2rem] border border-white/10 bg-white shadow-[0_-24px_80px_rgba(2,6,23,.35)] dark:bg-slate-950 sm:max-h-[92dvh] sm:max-w-3xl sm:rounded-[2rem]"
      >
        <header className="shrink-0 border-b border-slate-200 bg-white/95 px-4 pb-4 pt-3 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:px-6 sm:pt-5">
          <div className="mx-auto mb-3 h-1.5 w-12 rounded-full bg-slate-200 dark:bg-slate-700 sm:hidden" aria-hidden="true" />
          <div className="flex items-start gap-3">
            <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${typeCopy.soft} ${typeCopy.accent}`}>
              <TypeIcon size={21} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className={`text-[10px] font-black uppercase tracking-[0.18em] ${typeCopy.accent}`}>
                {typeCopy.eyebrow}
              </p>
              <h2
                ref={titleRef}
                id={titleId}
                tabIndex={-1}
                className="mt-0.5 text-lg font-black tracking-tight text-slate-900 outline-none dark:text-white sm:text-xl"
              >
                {activity.title}
              </h2>
              <p id={descriptionId} className="mt-1 text-xs font-medium leading-5 text-slate-500 dark:text-slate-400">
                {activity.description || 'Siga as etapas e registre sua própria evidência de aprendizagem.'}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              aria-label="Fechar atividade"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-slate-800"
            >
              <X size={19} aria-hidden="true" />
            </button>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
              role="progressbar"
              aria-label="Progresso da atividade"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="min-w-9 text-right text-[10px] font-black text-slate-500 dark:text-slate-400">
              {progress}%
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-slate-500 dark:text-slate-400">
              <Clock3 size={12} aria-hidden="true" />
              ~{estimatedMinutes} min
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6">
          {submitted ? (
            <div className="mx-auto flex min-h-80 max-w-md flex-col items-center justify-center py-8 text-center" role="status" aria-live="polite">
              <span className="grid h-20 w-20 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
                <CheckCircle2 size={38} aria-hidden="true" />
              </span>
              <h3
                ref={successTitleRef}
                tabIndex={-1}
                className="mt-5 text-2xl font-black text-slate-900 outline-none dark:text-white"
              >
                Atividade concluída
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
                  {objectiveMode
                  ? submissionResult?.canonicalResultAvailable === false
                    ? 'Esta atividade já havia sido concluída. O registro foi preservado, mas a correção detalhada dessa atividade antiga não está disponível.'
                    : `Você consolidou este desafio com ${Number(submissionResult?.scorePercentage ?? 0)}%. A correção foi validada com segurança pelo servidor.`
                  : 'Sua evidência foi salva. Ela mostra o que você fez e refletiu, sem inventar uma avaliação automática.'}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-5 py-3.5 text-sm font-black text-white transition-colors hover:bg-violet-700"
              >
                Voltar às atividades <ChevronRight size={16} aria-hidden="true" />
              </button>
            </div>
          ) : objectiveMode ? (
            <div className="space-y-5">
              {(normalized.intro || normalized.passage) && (
                <section className={`rounded-2xl border border-slate-200 p-4 dark:border-slate-800 ${typeCopy.soft}`}>
                  <h3 className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                    Antes de responder
                  </h3>
                  {normalized.intro && (
                    <p className="mt-2 whitespace-pre-line text-sm font-medium leading-6 text-slate-700 dark:text-slate-200">
                      {normalized.intro}
                    </p>
                  )}
                  {normalized.passage && (
                    <p className="mt-3 whitespace-pre-line rounded-xl bg-white/70 p-4 text-sm leading-7 text-slate-800 dark:bg-slate-900/60 dark:text-slate-100">
                      {normalized.passage}
                    </p>
                  )}
                </section>
              )}

              {normalized.questions.map((question, questionIndex) => (
                <fieldset
                  key={question.id}
                  className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800 sm:p-5"
                >
                  <legend className="max-w-full px-1 text-sm font-black leading-6 text-slate-900 dark:text-white">
                    <span className="mr-2 text-violet-600 dark:text-violet-300">{questionIndex + 1}.</span>
                    {question.prompt}
                  </legend>
                  <div className="mt-3 space-y-2">
                    {question.options.map((option, optionIndex) => {
                      const selected = answers[questionIndex] === optionIndex;
                      const feedback = questionFeedback.get(question.id);
                      const wrongSelection = reviewed && selected && feedback?.correct === false;
                      const correctAnswer = reviewed && feedback?.correctIndex === optionIndex;
                      return (
                        <label
                          key={`${question.id}-${optionIndex}`}
                          className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3 text-sm font-semibold transition-colors ${
                            correctAnswer
                              ? 'border-emerald-400 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100'
                              : wrongSelection
                                ? 'border-rose-400 bg-rose-50 text-rose-900 dark:bg-rose-950/30 dark:text-rose-100'
                                : selected
                                  ? 'border-violet-500 bg-violet-50 text-violet-900 dark:bg-violet-950/30 dark:text-violet-100'
                                  : 'border-slate-200 text-slate-700 hover:border-violet-300 dark:border-slate-700 dark:text-slate-200'
                          } ${reviewed ? 'cursor-default' : ''}`}
                        >
                          <input
                            type="radio"
                            name={`question-${questionIndex}-${activity.id}`}
                            value={optionIndex}
                            checked={selected}
                            disabled={reviewed || submitting}
                            onChange={() => {
                              setAnswers(current => current.map((answer, index) => (
                                index === questionIndex ? optionIndex : answer
                              )));
                              setSubmitError('');
                            }}
                            className="mt-0.5 h-4 w-4 shrink-0 accent-violet-600"
                          />
                          <span className="min-w-0 flex-1">
                            <span>{String.fromCharCode(65 + optionIndex)}. {option}</span>
                            {correctAnswer && (
                              <span className="mt-1 block text-[10px] font-black uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                                Resposta correta
                              </span>
                            )}
                            {wrongSelection && (
                              <span className="mt-1 block text-[10px] font-black uppercase tracking-wider text-rose-700 dark:text-rose-300">
                                Sua escolha
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {reviewed && questionFeedback.get(question.id) && (
                    <div className={`mt-3 rounded-xl p-3 text-xs leading-5 ${
                      questionFeedback.get(question.id)?.correct
                        ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100'
                        : 'bg-amber-50 text-amber-900 dark:bg-amber-950/30 dark:text-amber-100'
                    }`}>
                      <p className="font-black">
                        {questionFeedback.get(question.id)?.correct
                          ? 'Você acertou este ponto.'
                          : 'Revise este ponto antes de seguir.'}
                      </p>
                      <p className="mt-1">
                        {questionFeedback.get(question.id)?.explanation || 'Compare sua escolha com a resposta correta destacada acima.'}
                      </p>
                    </div>
                  )}
                </fieldset>
              ))}

              {reviewed && (
                <div className={`rounded-2xl border p-4 ${objectivePassed ? 'border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-100' : 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100'}`} role="status" aria-live="polite">
                  <p className="font-black">
                    {objectivePassed ? 'Aprendizado consolidado!' : 'Você está quase lá.'}
                    {' '}Você acertou {correctCount} de {normalized.questions.length} ({Number(submissionResult?.scorePercentage ?? 0)}%).
                  </p>
                  <p className="mt-1 text-xs leading-5">
                    {objectivePassed
                      ? 'Leia o feedback de cada questão antes de finalizar a atividade.'
                      : 'Leia as explicações e refaça o desafio. A atividade permanece pendente até você atingir 60%.'}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-5">
              <section className={`rounded-2xl border border-slate-200 p-4 dark:border-slate-800 ${typeCopy.soft}`}>
                <h3 className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">
                  Sua prática
                </h3>
                {(normalized.passage || normalized.intro) ? (
                  <p className="mt-2 whitespace-pre-line text-sm font-medium leading-7 text-slate-800 dark:text-slate-100">
                    {normalized.passage || normalized.intro}
                  </p>
                ) : (
                  <p className="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-200">
                    Siga cada etapa abaixo e registre o que você percebeu ao praticar.
                  </p>
                )}
              </section>

              {activity.type === 'conversation' && (
                <div className="rounded-2xl border border-violet-200 bg-violet-50 p-4 text-xs font-medium leading-5 text-violet-950 dark:border-violet-900/50 dark:bg-violet-950/30 dark:text-violet-100">
                  Esta atividade registra sua preparação e sua reflexão. Ela não grava nem avalia áudio, fluência ou pronúncia automaticamente.
                </div>
              )}

              <fieldset className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800 sm:p-5" aria-describedby={checklistId}>
                <legend className="px-1 text-sm font-black text-slate-900 dark:text-white">
                  Etapas da atividade
                </legend>
                <p id={checklistId} className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  Marque somente depois de realmente concluir cada etapa.
                </p>
                <div className="mt-4 space-y-2">
                  {normalized.steps.map((step, index) => (
                    <label
                      key={`${step}-${index}`}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm font-semibold transition-colors ${
                        checklist[index]
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100'
                          : 'border-slate-200 text-slate-700 hover:border-violet-300 dark:border-slate-700 dark:text-slate-200'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checklist[index] ?? false}
                        disabled={submitting}
                        onChange={() => {
                          setChecklist(current => current.map((checked, itemIndex) => (
                            itemIndex === index ? !checked : checked
                          )));
                          setSubmitError('');
                        }}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded accent-emerald-600"
                      />
                      <span className="min-w-0 flex-1">{step}</span>
                      {checklist[index] && <Check size={16} className="shrink-0 text-emerald-600" aria-hidden="true" />}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800 sm:p-5">
                <label htmlFor={reflectionId} className="text-sm font-black text-slate-900 dark:text-white">
                  Sua reflexão
                </label>
                <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
                  {normalized.reflectionPrompt}
                </p>
                <textarea
                  id={reflectionId}
                  value={reflection}
                  disabled={submitting}
                  maxLength={MAX_REFLECTION_LENGTH}
                  rows={5}
                  onChange={event => {
                    setReflection(event.target.value);
                    setSubmitError('');
                  }}
                  aria-describedby={`${reflectionId}-counter`}
                  className="mt-3 w-full resize-y rounded-xl border border-slate-300 bg-white p-3 text-sm leading-6 text-slate-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20 disabled:cursor-wait disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                  placeholder="Escreva com suas palavras..."
                />
                <p
                  id={`${reflectionId}-counter`}
                  className={`mt-1 text-right text-[10px] font-bold ${reflectionReady ? 'text-emerald-600' : 'text-slate-400'}`}
                >
                  {reflection.trim().length}/{MIN_REFLECTION_LENGTH} caracteres mínimos
                </p>
              </div>
            </div>
          )}
        </main>

        {!submitted && (
          <footer className="safe-bottom shrink-0 border-t border-slate-200 bg-white/95 p-4 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95 sm:px-6">
            {submitError && (
              <div className="mb-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-bold leading-5 text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200" role="alert">
                {submitError}
              </div>
            )}
            {objectiveMode && !reviewed ? (
              <button
                type="button"
                disabled={!allAnswersReady || submitting}
                onClick={() => void submitEvidence()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-5 py-3.5 text-sm font-black text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {submitting
                  ? 'Corrigindo com segurança...'
                  : <><CheckCircle2 size={16} aria-hidden="true" /> Conferir respostas</>}
              </button>
            ) : objectiveMode ? (
              <button
                type="button"
                onClick={() => {
                  if (objectivePassed) {
                    setSubmitted(true);
                    return;
                  }
                  setSubmissionResult(null);
                  setAnswers(normalized.questions.map(() => null));
                  setSubmitError('');
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-5 py-3.5 text-sm font-black text-white transition-colors hover:bg-violet-700"
              >
                {objectivePassed
                  ? <><CheckCircle2 size={16} aria-hidden="true" /> Finalizar atividade</>
                  : <><RotateCcw size={15} aria-hidden="true" /> Tentar novamente</>}
              </button>
            ) : (
              <button
                type="button"
                disabled={submitting || (!objectiveMode && !evidenceReady)}
                onClick={() => void submitEvidence()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-5 py-3.5 text-sm font-black text-white transition-colors hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {submitting ? (
                  <>Registrando atividade...</>
                ) : submitError ? (
                  <><RotateCcw size={15} aria-hidden="true" /> Tentar novamente</>
                ) : (
                  <><Send size={15} aria-hidden="true" /> Concluir atividade</>
                )}
              </button>
            )}
          </footer>
        )}
      </section>
    </div>
  );

  return typeof document === 'undefined' ? null : createPortal(content, document.body);
};

export default ComplementaryActivityPlayer;
