import React, { useMemo, useRef, useState } from 'react';
import {
  Check,
  CheckCircle2,
  PenLine,
  RefreshCw,
  Send,
  Sparkles,
  Target,
} from 'lucide-react';
import {
  createWolfieRequestKey,
  submitWolfieText,
} from '../../services/wolfieActivityService';
import type {
  EvaluationRubric,
  TextEvaluationResult,
  WolfieActivitySession,
} from './types';
import {
  ActivityHeader,
  BusyLabel,
  Checklist,
  InlineError,
  inputClass,
  primaryButton,
  ReadinessCard,
  VocabularyCard,
} from './WolfieActivityUI';

interface WolfieWritingActivityProps {
  session: WolfieActivitySession;
  onComplete: (result: TextEvaluationResult) => void;
  onExit: () => void;
  onConversation: () => void;
}

const normalizeAttemptText = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');

const restoreRubric = (value: unknown): EvaluationRubric => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const source = value as Record<string, unknown>;
  const rubric: EvaluationRubric = {};
  const keys: (keyof EvaluationRubric)[] = [
    'taskCompletion',
    'structure',
    'clarity',
    'accuracy',
    'naturalness',
    'levelFit',
    'scenarioFit',
  ];
  keys.forEach((key) => {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) {
      rubric[key] = source[key];
    }
  });
  return rubric;
};

const resumedWritingAttempt = (
  session: WolfieActivitySession,
): { text: string; evaluation: TextEvaluationResult } | null => {
  const snapshot = session.report_json?.latestAttempt;
  const feedback = snapshot?.feedbackPayload;
  const response = snapshot?.responsePayload;
  if (
    session.status !== 'AWAITING_RETRY' ||
    snapshot?.stepKey !== 'writing' ||
    snapshot.requiresRetry !== true ||
    !snapshot.attemptId ||
    !feedback ||
    !response
  ) {
    return null;
  }

  const text = typeof response.text === 'string' ? response.text.trim() : '';
  const correctedText =
    typeof feedback.correctedText === 'string'
      ? feedback.correctedText
      : text;
  const naturalVersion =
    typeof feedback.naturalVersion === 'string'
      ? feedback.naturalVersion
      : correctedText;
  const explanationPt =
    typeof feedback.explanationPt === 'string' ? feedback.explanationPt : '';
  const strengths = Array.isArray(feedback.strengths)
    ? feedback.strengths.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const priorities = Array.isArray(feedback.priorities)
    ? feedback.priorities.filter(
        (item): item is string => typeof item === 'string',
      )
    : [];
  const rubric = restoreRubric(feedback.rubric);

  return {
    text,
    evaluation: {
      score: snapshot.score ?? 0,
      correctedText,
      naturalVersion,
      explanationPt,
      strengths,
      priorities,
      readinessMessage:
        typeof feedback.readinessMessage === 'string'
          ? feedback.readinessMessage
          : '',
      retryPrompt:
        typeof feedback.retryPrompt === 'string' ? feedback.retryPrompt : '',
      rubric,
      attemptId: snapshot.attemptId,
      attemptNumber: snapshot.attemptNumber,
      parentAttemptId: snapshot.parentAttemptId,
      requiresRetry: true,
      retryCompleted: snapshot.retryCompleted,
    },
  };
};

export function WolfieWritingActivity({
  session,
  onComplete,
  onExit,
  onConversation,
}: WolfieWritingActivityProps) {
  const resumedAttempt = resumedWritingAttempt(session);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [firstAttemptText, setFirstAttemptText] = useState(
    resumedAttempt?.text ?? '',
  );
  const [firstEvaluation, setFirstEvaluation] =
    useState<TextEvaluationResult | null>(resumedAttempt?.evaluation ?? null);
  const [roundNumber, setRoundNumber] = useState(resumedAttempt ? 2 : 1);
  const startedAt = useRef(Date.now());
  const request = useRef<{
    round: number;
    text: string;
    requestKey: string;
  } | null>(null);
  const content = session.activity_content;
  const isRetryRound = Boolean(firstEvaluation);

  const wordCount = useMemo(
    () => text.trim().split(/\s+/).filter(Boolean).length,
    [text],
  );
  const repeatsFirstAttempt =
    isRetryRound &&
    normalizeAttemptText(text) === normalizeAttemptText(firstAttemptText);

  const submit = async () => {
    if (text.trim().length < 3 || submitting) return;
    const submittedText = text.trim();
    if (
      isRetryRound &&
      normalizeAttemptText(submittedText) ===
        normalizeAttemptText(firstAttemptText)
    ) {
      setError(
        'Sua nova versão precisa reformular o texto. Faça ao menos um ajuste real com base no feedback.',
      );
      return;
    }
    if (
      request.current?.text !== submittedText ||
      request.current.round !== roundNumber
    ) {
      request.current = {
        round: roundNumber,
        text: submittedText,
        requestKey: createWolfieRequestKey(),
      };
    }
    setSubmitting(true);
    setError('');
    try {
      const result = await submitWolfieText({
        sessionId: session.id,
        text: submittedText,
        durationSeconds: Math.max(
          1,
          Math.round((Date.now() - startedAt.current) / 1_000),
        ),
        stepKey: 'writing',
        complete: isRetryRound,
        modality: 'text',
        requestKey: request.current.requestKey,
        parentAttemptId:
          isRetryRound ? firstEvaluation?.attemptId : undefined,
      });
      if (!isRetryRound || result.requiresRetry) {
        if (!result.attemptId) {
          throw new Error(
            'O Wolfie corrigiu o texto, mas não conseguiu preparar a nova tentativa. Tente enviar novamente.',
          );
        }
        setFirstAttemptText(submittedText);
        setFirstEvaluation(result);
        setText('');
        request.current = null;
        startedAt.current = Date.now();
        setRoundNumber((current) => current + 1);
        return;
      }
      onComplete(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Não foi possível corrigir seu texto.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-[70vh] bg-brand-bg">
      <ActivityHeader
        session={session}
        kicker="Writing"
        progress={
          isRetryRound
            ? `Rodada ${roundNumber} · reformulação`
            : 'Rodada 1 · versão inicial'
        }
        onBack={onExit}
        onConversation={onConversation}
      />

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-7 lg:grid-cols-[minmax(0,1fr)_19rem] lg:py-8">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="min-w-0 space-y-5"
          aria-labelledby="writing-prompt-title"
        >
          <section className="rounded-2xl border border-brand-border bg-brand-surface-2 p-5 sm:p-6">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
              <PenLine size={17} aria-hidden="true" />
              {!isRetryRound
                ? 'Situação real'
                : 'Nova tentativa obrigatória'}
            </div>
            {content.context ? (
              <p className="mt-3 text-sm leading-7 text-brand-muted">
                {content.context}
              </p>
            ) : null}
            <h2
              id="writing-prompt-title"
              className="mt-4 text-xl font-black leading-8 text-brand-text sm:text-2xl"
            >
              {content.prompt}
            </h2>
          </section>

          {firstEvaluation ? (
            <section
              className="rounded-3xl border border-brand-accent bg-brand-surface p-5 shadow-sm sm:p-7"
              aria-labelledby="writing-feedback-title"
            >
              <div className="flex items-start gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-surface-2 text-brand-accent">
                  <RefreshCw size={19} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
                    Feedback da primeira rodada
                  </p>
                  <h2
                    id="writing-feedback-title"
                    className="mt-2 text-xl font-black leading-7 text-brand-text sm:text-2xl"
                  >
                    Agora escreva novamente com suas próprias palavras
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-brand-muted">
                    Use as versões abaixo como referência. Sua nova resposta
                    precisa incorporar o feedback e não pode repetir o primeiro
                    texto.
                  </p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div className="rounded-2xl border border-brand-border bg-brand-bg p-4">
                  <h3 className="flex items-center gap-2 text-sm font-black text-brand-text">
                    <CheckCircle2
                      size={16}
                      className="text-green-600 dark:text-green-400"
                      aria-hidden="true"
                    />
                    Correção precisa
                  </h3>
                  <p
                    lang="en"
                    className="mt-3 whitespace-pre-wrap text-sm leading-7 text-brand-text"
                  >
                    {firstEvaluation.correctedText}
                  </p>
                </div>
                <div className="rounded-2xl border border-brand-accent bg-brand-surface-2 p-4">
                  <h3 className="flex items-center gap-2 text-sm font-black text-brand-accent">
                    <Sparkles size={16} aria-hidden="true" />
                    Versão mais natural
                  </h3>
                  <p
                    lang="en"
                    className="mt-3 whitespace-pre-wrap text-sm leading-7 text-brand-text"
                  >
                    {firstEvaluation.naturalVersion}
                  </p>
                </div>
              </div>

              {firstEvaluation.explanationPt ? (
                <p className="mt-4 rounded-2xl bg-brand-surface-2 p-4 text-sm leading-6 text-brand-muted">
                  {firstEvaluation.explanationPt}
                </p>
              ) : null}

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl bg-green-50 p-4 dark:bg-green-950/20">
                  <p className="font-black text-green-800 dark:text-green-300">
                    O que funcionou
                  </p>
                  {(firstEvaluation.strengths ?? []).length ? (
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-brand-muted">
                      {firstEvaluation.strengths.map((strength) => (
                        <li key={strength} className="flex gap-2">
                          <Check
                            size={16}
                            className="mt-1 shrink-0"
                            aria-hidden="true"
                          />
                          {strength}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-brand-muted">
                      O foco desta rodada está nos ajustes abaixo.
                    </p>
                  )}
                </div>
                <div className="rounded-2xl bg-amber-50 p-4 dark:bg-amber-950/20">
                  <p className="font-black text-amber-800 dark:text-amber-300">
                    O que aplicar agora
                  </p>
                  {(firstEvaluation.priorities ?? []).length ? (
                    <ul className="mt-3 space-y-2 text-sm leading-6 text-brand-muted">
                      {firstEvaluation.priorities.map((priority) => (
                        <li key={priority} className="flex gap-2">
                          <Target
                            size={16}
                            className="mt-1 shrink-0"
                            aria-hidden="true"
                          />
                          {priority}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-brand-muted">
                      Reescreva com mais clareza e naturalidade.
                    </p>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-7">
            <label
              htmlFor="wolfie-writing-response"
              className="text-sm font-black text-brand-text"
            >
              {!isRetryRound
                ? 'Sua mensagem em inglês'
                : 'Sua reformulação em inglês'}
            </label>
            <p
              id="wolfie-writing-help"
              className="mt-1 text-sm leading-6 text-brand-muted"
            >
              {!isRetryRound
                ? 'Escreva como você realmente escreveria. O Wolfie separa correção gramatical de naturalidade.'
                : 'Reescreva sem copiar. Aplique os pontos prioritários e preserve a sua intenção.'}
            </p>
            <textarea
              id="wolfie-writing-response"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={12_000}
              rows={12}
              autoFocus
              spellCheck
              lang="en"
              aria-describedby="wolfie-writing-help wolfie-writing-count"
              placeholder={
                !isRetryRound
                  ? 'Write your message here…'
                  : 'Write your improved version here…'
              }
              className={`${inputClass} mt-4 min-h-64 resize-y leading-7`}
              disabled={submitting}
            />
            <div
              id="wolfie-writing-count"
              className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-brand-muted"
            >
              <span>
                {wordCount} {wordCount === 1 ? 'palavra' : 'palavras'}
              </span>
              <span>{text.length.toLocaleString('pt-BR')} / 12.000 caracteres</span>
            </div>

            {repeatsFirstAttempt ? (
              <p
                className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold leading-6 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
                role="status"
              >
                Este texto ainda está igual ao primeiro. Faça uma reformulação
                real antes de enviar.
              </p>
            ) : null}

            {error ? (
              <div className="mt-5">
                <InlineError message={error} onRetry={() => void submit()} />
              </div>
            ) : null}

            <div className="mt-6 flex justify-end">
              <button
                type="submit"
                disabled={
                  submitting ||
                  text.trim().length < 3 ||
                  repeatsFirstAttempt
                }
                className={primaryButton}
              >
                {submitting ? (
                  <BusyLabel>
                    {!isRetryRound
                      ? 'Wolfie está refinando…'
                      : 'Wolfie está comparando…'}
                  </BusyLabel>
                ) : (
                  <>
                    <Send size={18} aria-hidden="true" />
                    {!isRetryRound
                      ? 'Receber feedback'
                      : 'Enviar nova tentativa'}
                  </>
                )}
              </button>
            </div>
          </section>
        </form>

        <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
          <ReadinessCard goal={content.readinessGoal} />
          <section className="rounded-2xl border border-brand-border bg-brand-surface p-4">
            <h2 className="text-xs font-black uppercase tracking-[0.14em] text-brand-muted">
              Antes de enviar
            </h2>
            <div className="mt-3">
              <Checklist items={content.checklist ?? []} />
            </div>
          </section>
          <VocabularyCard items={content.targetVocabulary ?? []} />
        </aside>
      </main>
    </div>
  );
}
