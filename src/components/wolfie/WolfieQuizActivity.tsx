import React, {
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Check,
  CheckCircle2,
  ChevronRight,
  Headphones,
  Loader2,
  X,
  XCircle,
} from 'lucide-react';
import {
  checkWolfieAnswer,
  createWolfieRequestKey,
  getWolfieListeningAudio,
  submitWolfieQuiz,
} from '../../services/wolfieActivityService';
import type {
  AnswerFeedback,
  QuizResult,
  VocabularyItem,
  WolfieActivitySession,
} from './types';
import {
  ActivityHeader,
  BusyLabel,
  focusRing,
  InlineError,
  primaryButton,
  ReadinessCard,
  VocabularyCard,
} from './WolfieActivityUI';
import { getSubjectOption } from './catalog';

interface WolfieQuizActivityProps {
  session: WolfieActivitySession;
  onComplete: (result: QuizResult) => void;
  onExit: () => void;
  onConversation: () => void;
}

function ListeningPlayer({
  sessionId,
  onListened,
}: {
  sessionId: string;
  onListened: () => void;
}) {
  const [audioUrl, setAudioUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const audioUrlRef = useRef('');
  const loadIdRef = useRef(0);

  const loadAudio = async () => {
    const loadId = ++loadIdRef.current;
    setLoading(true);
    setError('');
    try {
      const audio = await getWolfieListeningAudio(sessionId);
      if (loadId !== loadIdRef.current) return;
      const binary = window.atob(audio.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      const nextUrl = URL.createObjectURL(
        new Blob([bytes], { type: audio.mimeType }),
      );
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = nextUrl;
      setAudioUrl(nextUrl);
    } catch (cause) {
      if (loadId !== loadIdRef.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível preparar o áudio.',
      );
    } finally {
      if (loadId === loadIdRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void loadAudio();
    return () => {
      loadIdRef.current += 1;
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = '';
    };
  }, [sessionId]);

  return (
    <section className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-accent text-white">
            <Headphones size={21} aria-hidden="true" />
          </span>
          <div>
            <h2 className="font-bold text-brand-text">Ouça a situação</h2>
            <p className="mt-1 text-sm text-brand-muted">
              Foque na intenção, nos detalhes e no próximo passo.
            </p>
          </div>
        </div>
        <div className="min-w-0 sm:w-72">
          {loading ? (
            <div
              className="flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-bg px-4 text-sm font-bold text-brand-muted"
              role="status"
            >
              <Loader2 size={17} className="animate-spin" aria-hidden="true" />
              Preparando áudio…
            </div>
          ) : audioUrl ? (
            <audio
              className="w-full"
              src={audioUrl}
              controls
              preload="metadata"
              onPlay={onListened}
              aria-label="Áudio da atividade de listening"
            >
              Seu navegador não consegue reproduzir este áudio.
            </audio>
          ) : null}
        </div>
      </div>
      {error ? (
        <div className="mt-4">
          <InlineError message={error} onRetry={() => void loadAudio()} />
        </div>
      ) : null}
    </section>
  );
}

export function WolfieQuizActivity({
  session,
  onComplete,
  onExit,
  onConversation,
}: WolfieQuizActivityProps) {
  const questions = session.activity_content.questions ?? [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<number[]>(() =>
    Array(questions.length).fill(-1),
  );
  const [feedback, setFeedback] = useState<
    Partial<Record<number, AnswerFeedback>>
  >({});
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [hasListened, setHasListened] = useState(
    session.subject !== 'listening',
  );
  const [error, setError] = useState('');
  const startedAt = useRef(Date.now());
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);
  const answerRequestKeys = useRef<Record<string, string>>({});
  const submitRequestKey = useRef('');

  const question = questions[currentIndex];
  const currentFeedback = feedback[currentIndex];
  const currentAnswer = answers[currentIndex] ?? -1;
  const subject = getSubjectOption(session.subject);
  const progress = questions.length
    ? `${Math.min(currentIndex + 1, questions.length)} de ${questions.length}`
    : '';
  const revealedVocabulary = (
    Object.values(feedback) as Array<AnswerFeedback | undefined>
  ).reduce<VocabularyItem[]>(
    (items, itemFeedback) => {
      if (
        !itemFeedback?.term ||
        !itemFeedback.example ||
        items.some(
          (item) =>
            item.term.toLowerCase() === itemFeedback.term?.toLowerCase(),
        )
      ) {
        return items;
      }
      items.push({
        term: itemFeedback.term,
        translation: itemFeedback.translation ?? '',
        definitionPt: itemFeedback.definitionPt ?? '',
        example: itemFeedback.example,
      });
      return items;
    },
    [],
  );

  useEffect(() => {
    questionHeadingRef.current?.focus();
  }, [currentIndex]);

  const durationSeconds = () =>
    Math.max(1, Math.round((Date.now() - startedAt.current) / 1_000));

  const checkAnswer = async (selectedIndex: number) => {
    if (!question || checking || currentFeedback) return;
    const nextAnswers = [...answers];
    nextAnswers[currentIndex] = selectedIndex;
    setAnswers(nextAnswers);
    setChecking(true);
    setError('');
    try {
      const result = await checkWolfieAnswer(
        session.id,
        question.id,
        selectedIndex,
        answerRequestKeys.current[question.id] ||
          (answerRequestKeys.current[question.id] =
            createWolfieRequestKey()),
      );
      nextAnswers[currentIndex] = result.selectedIndex;
      setAnswers(nextAnswers);
      setFeedback((current) => ({ ...current, [currentIndex]: result }));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível conferir sua resposta.',
      );
    } finally {
      setChecking(false);
    }
  };

  const finishQuiz = async () => {
    if (answers.some((answer) => answer < 0) || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await submitWolfieQuiz(
        session.id,
        durationSeconds(),
        submitRequestKey.current ||
          (submitRequestKey.current = createWolfieRequestKey()),
      );
      onComplete(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível finalizar o quiz.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const continueQuiz = () => {
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((index) => index + 1);
      setError('');
      return;
    }
    void finishQuiz();
  };

  if (!question) {
    return (
      <div className="min-h-[60vh] bg-brand-bg">
        <ActivityHeader
          session={session}
          kicker={subject.shortTitle}
          onBack={onExit}
          onConversation={onConversation}
        />
        <div className="mx-auto max-w-3xl px-4 py-10">
          <InlineError
            message="Esta atividade chegou sem perguntas. Volte e gere uma nova prática."
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[70vh] bg-brand-bg">
      <ActivityHeader
        session={session}
        kicker={subject.shortTitle}
        progress={progress}
        onBack={onExit}
        onConversation={onConversation}
      />

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-7 lg:grid-cols-[minmax(0,1fr)_19rem] lg:py-8">
        <div className="min-w-0 space-y-5">
          {session.subject === 'listening' &&
          session.activity_content.hasListeningAudio ? (
            <ListeningPlayer
              sessionId={session.id}
              onListened={() => setHasListened(true)}
            />
          ) : null}

          {session.subject === 'reading' &&
          session.activity_content.passage ? (
            <section className="rounded-2xl border border-brand-border bg-brand-surface-2 p-5 sm:p-6">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
                Texto-base
              </p>
              <p className="mt-3 whitespace-pre-wrap text-base leading-8 text-brand-text">
                {session.activity_content.passage}
              </p>
            </section>
          ) : null}

          {session.subject === 'grammar' &&
          session.activity_content.microLesson ? (
            <section className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
                Pista do Wolfie
              </p>
              <p className="mt-2 text-sm leading-6 text-brand-text">
                {session.activity_content.microLesson}
              </p>
            </section>
          ) : null}

          <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-7">
            <div className="h-2 overflow-hidden rounded-full bg-brand-surface-2">
              <div
                className="h-full rounded-full bg-brand-accent transition-[width]"
                style={{
                  width: `${((currentIndex + (currentFeedback ? 1 : 0)) / questions.length) * 100}%`,
                }}
                aria-hidden="true"
              />
            </div>

            <h2
              ref={questionHeadingRef}
              tabIndex={-1}
              className="mt-6 text-xl font-black leading-8 text-brand-text outline-none sm:text-2xl"
            >
              {question.prompt}
            </h2>

            <div
              className="mt-6 grid gap-3"
              role="group"
              aria-label={`Alternativas da pergunta ${currentIndex + 1}`}
            >
              {question.options.map((option, optionIndex) => {
                const selected = currentAnswer === optionIndex;
                const isCorrect =
                  Boolean(currentFeedback) &&
                  currentFeedback?.correctIndex === optionIndex;
                const isWrongSelection =
                  Boolean(currentFeedback) &&
                  selected &&
                  !currentFeedback?.correct;

                let stateClass =
                  'border-brand-border bg-brand-bg text-brand-text hover:border-brand-accent';
                if (isCorrect) {
                  stateClass =
                    'border-green-500 bg-green-50 text-green-900 dark:bg-green-950/30 dark:text-green-100';
                } else if (isWrongSelection) {
                  stateClass =
                    'border-red-500 bg-red-50 text-red-900 dark:bg-red-950/30 dark:text-red-100';
                } else if (selected) {
                  stateClass =
                    'border-brand-accent bg-brand-surface-2 text-brand-text';
                }

                return (
                  <button
                    key={`${question.id}-${optionIndex}`}
                    type="button"
                    onClick={() => void checkAnswer(optionIndex)}
                    disabled={
                      checking ||
                      Boolean(currentFeedback) ||
                      !hasListened ||
                      currentAnswer >= 0
                    }
                    aria-pressed={selected}
                    className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border p-4 text-left text-sm font-semibold transition disabled:cursor-default disabled:opacity-100 ${stateClass} ${focusRing}`}
                  >
                    <span
                      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-black ${
                        isCorrect
                          ? 'border-green-500 bg-green-500 text-white'
                          : isWrongSelection
                            ? 'border-red-500 bg-red-500 text-white'
                            : selected
                              ? 'border-brand-accent bg-brand-accent text-white'
                              : 'border-brand-border bg-brand-surface text-brand-muted'
                      }`}
                    >
                      {isCorrect ? (
                        <Check size={16} aria-hidden="true" />
                      ) : isWrongSelection ? (
                        <X size={16} aria-hidden="true" />
                      ) : (
                        String.fromCharCode(65 + optionIndex)
                      )}
                    </span>
                    <span className="flex-1">{option}</span>
                    {checking && selected ? (
                      <Loader2
                        size={18}
                        className="animate-spin text-brand-accent"
                        aria-label="Conferindo resposta"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>

            {!hasListened ? (
              <p className="mt-3 text-sm font-bold text-brand-muted" role="status">
                Ouça o áudio acima para liberar as alternativas.
              </p>
            ) : null}

            <div aria-live="polite" aria-atomic="true">
              {currentFeedback ? (
                <div
                  className={`mt-6 rounded-2xl border p-4 ${
                    currentFeedback.correct
                      ? 'border-green-300 bg-green-50 dark:border-green-900/60 dark:bg-green-950/30'
                      : 'border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30'
                  }`}
                >
                  <div className="flex items-center gap-2 font-black text-brand-text">
                    {currentFeedback.correct ? (
                      <CheckCircle2
                        size={20}
                        className="text-green-600 dark:text-green-400"
                        aria-hidden="true"
                      />
                    ) : (
                      <XCircle
                        size={20}
                        className="text-amber-600 dark:text-amber-400"
                        aria-hidden="true"
                      />
                    )}
                    {currentFeedback.correct
                      ? 'Isso mesmo.'
                      : 'Boa tentativa — veja o ajuste.'}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-brand-muted">
                    {currentFeedback.explanationPt}
                  </p>
                </div>
              ) : null}
            </div>

            {error ? (
              <div className="mt-5">
                <InlineError
                  message={error}
                  onRetry={
                    currentAnswer >= 0
                      ? () => void checkAnswer(currentAnswer)
                      : undefined
                  }
                />
              </div>
            ) : null}

            {currentFeedback ? (
              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={continueQuiz}
                  disabled={submitting}
                  className={primaryButton}
                >
                  {submitting ? (
                    <BusyLabel>Calculando sua prontidão…</BusyLabel>
                  ) : currentIndex === questions.length - 1 ? (
                    <>
                      Ver meu resultado
                      <CheckCircle2 size={18} aria-hidden="true" />
                    </>
                  ) : (
                    <>
                      Próxima situação
                      <ChevronRight size={18} aria-hidden="true" />
                    </>
                  )}
                </button>
              </div>
            ) : null}
          </section>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
          <ReadinessCard goal={session.activity_content.readinessGoal} />
          {revealedVocabulary.length ? (
            <VocabularyCard items={revealedVocabulary} />
          ) : (
            <div className="rounded-2xl border border-brand-border bg-brand-surface p-4 text-sm leading-6 text-brand-muted">
              <strong className="block text-brand-text">
                Repertório sem pistas
              </strong>
              As expressões aparecem aqui somente depois que você responde.
            </div>
          )}
          <div className="rounded-2xl border border-brand-border bg-brand-surface p-4 text-sm leading-6 text-brand-muted">
            <strong className="block text-brand-text">
              Sem medo de errar
            </strong>
            O feedback aparece depois de cada escolha. Use a explicação para
            ajustar seu raciocínio antes da próxima situação.
          </div>
        </aside>
      </main>
    </div>
  );
}
