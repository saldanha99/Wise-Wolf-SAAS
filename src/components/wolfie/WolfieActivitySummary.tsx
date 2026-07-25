import React from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  Mic,
  RefreshCw,
  Sparkles,
  Target,
  Trophy,
} from 'lucide-react';
import type {
  EvaluationRubric,
  QuizResult,
  SpeechEvaluationResult,
  SpeechMetric,
  TextEvaluationResult,
  WolfieActivityResult,
  WolfieActivitySession,
} from './types';
import { primaryButton, secondaryButton } from './WolfieActivityUI';
import {
  getLevelOption,
  getSubjectOption,
} from './catalog';
import {
  isQuizResult,
  isSpeechResult,
} from './types';

interface WolfieActivitySummaryProps {
  session: WolfieActivitySession;
  result: WolfieActivityResult;
  onRetry: () => void;
  onNewActivity: () => void;
  onOpenRepertoire: () => void;
  onConversation: () => void;
}

const scoreMessage = (score: number) => {
  if (score >= 90) return 'Pronto para usar';
  if (score >= 75) return 'Quase automático';
  if (score >= 60) return 'Boa base construída';
  return 'Em fase de consolidação';
};

const rubricLabels: Record<keyof EvaluationRubric, string> = {
  taskCompletion: 'Objetivo',
  structure: 'Estrutura',
  clarity: 'Clareza',
  accuracy: 'Precisão',
  naturalness: 'Naturalidade',
  levelFit: 'Adequação ao nível',
  scenarioFit: 'Adequação ao cenário',
};

function ScoreHero({
  score,
  xp,
  label = 'de 100',
}: {
  score: number;
  xp?: number;
  label?: string;
}) {
  const normalizedScore = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <div className="flex flex-col items-center text-center">
      <div
        className="relative grid h-36 w-36 place-items-center rounded-full"
        style={{
          background: `conic-gradient(var(--brand-accent) ${normalizedScore * 3.6}deg, var(--brand-surface-2) 0deg)`,
        }}
        role="progressbar"
        aria-label={`Pontuação ${normalizedScore} de 100`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={normalizedScore}
      >
        <div className="grid h-28 w-28 place-items-center rounded-full bg-brand-surface">
          <div>
            <span className="block text-4xl font-black tracking-tight text-brand-text">
              {normalizedScore}
            </span>
            <span className="text-xs font-bold uppercase tracking-wider text-brand-muted">
              {label}
            </span>
          </div>
        </div>
      </div>
      <h2 className="mt-4 text-2xl font-black text-brand-text">
        {scoreMessage(normalizedScore)}
      </h2>
      {typeof xp === 'number' && xp > 0 ? (
        <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-brand-surface-2 px-3 py-1.5 text-xs font-black text-brand-accent">
          <Sparkles size={14} aria-hidden="true" />+{xp} XP
        </span>
      ) : null}
    </div>
  );
}

function QuizSummary({ result }: { result: QuizResult }) {
  const firstAttemptMistakes = result.details.filter(
    (detail) => !detail.correct,
  );
  const masteryCount =
    result.masteryCount ??
    result.details.filter((detail) => detail.mastered ?? detail.correct).length;
  const masteredAfterRetry = result.details.filter(
    (detail) => detail.masteredAfterRetry,
  ).length;
  const unresolved = result.total - masteryCount;
  return (
    <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
            Seu desempenho
          </p>
          <h3 className="mt-2 text-xl font-black text-brand-text">
            {result.correctCount} de {result.total} na primeira tentativa
          </h3>
          <p className="mt-1 text-sm leading-6 text-brand-muted">
            Domínio após as reformulações: {masteryCount} de {result.total}.
          </p>
        </div>
        <span className="rounded-full bg-brand-surface-2 px-3 py-1.5 text-xs font-bold text-brand-muted">
          {unresolved === 0
            ? masteredAfterRetry > 0
              ? `${masteredAfterRetry} ${masteredAfterRetry === 1 ? 'ajuste dominado' : 'ajustes dominados'} após retry`
              : 'Domínio direto, sem retry'
            : `${unresolved} ${unresolved === 1 ? 'ponto ainda frágil' : 'pontos ainda frágeis'}`}
        </span>
      </div>

      {firstAttemptMistakes.length ? (
        <div className="mt-5 space-y-3">
          {firstAttemptMistakes.map((detail, index) => {
            const mastered = detail.mastered ?? detail.correct;
            return (
              <article
                key={`${detail.id}-${index}`}
                className={`rounded-2xl border p-4 ${
                  mastered
                    ? 'border-green-300 bg-green-50 dark:border-green-900/60 dark:bg-green-950/20'
                    : 'border-amber-300 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/20'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2 text-sm font-black text-brand-text">
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-brand-surface-2 text-xs text-brand-accent">
                    {index + 1}
                  </span>
                  {detail.term || 'Revise esta escolha'}
                  {detail.translation ? (
                    <span className="font-normal text-brand-muted">
                      · {detail.translation}
                    </span>
                  ) : null}
                  <span
                    className={`ml-auto rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider ${
                      mastered
                        ? 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300'
                        : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                    }`}
                  >
                    {mastered
                      ? 'Dominado após retry'
                      : 'Ainda precisa praticar'}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-6 text-brand-muted">
                  {detail.explanationPt}
                </p>
                {detail.example ? (
                  <p className="mt-2 rounded-xl bg-brand-surface-2 p-3 text-sm italic leading-6 text-brand-text">
                    “{detail.example}”
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-green-300 bg-green-50 p-4 dark:border-green-900/60 dark:bg-green-950/20">
          <CheckCircle2
            size={21}
            className="mt-0.5 shrink-0 text-green-600 dark:text-green-400"
            aria-hidden="true"
          />
          <p className="text-sm leading-6 text-brand-text">
            Você reconheceu todo o conteúdo neste contexto. Repetir com uma
            nova atividade ajuda a transformar reconhecimento em uso
            automático.
          </p>
        </div>
      )}
      {result.transcript ? (
        <details className="mt-5 rounded-2xl border border-brand-border bg-brand-bg p-4">
          <summary
            className="cursor-pointer text-sm font-black text-brand-accent"
          >
            Conferir transcrição do listening
          </summary>
          <p
            lang="en"
            className="mt-3 whitespace-pre-wrap text-sm leading-7 text-brand-text"
          >
            {result.transcript}
          </p>
        </details>
      ) : null}
    </section>
  );
}

function RubricGrid({ rubric }: { rubric: EvaluationRubric }) {
  const values = Object.entries(rubric).filter(
    ([, value]) => typeof value === 'number',
  ) as Array<[keyof EvaluationRubric, number]>;
  if (!values.length) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {values.map(([key, value]) => (
        <div
          key={key}
          className="rounded-xl border border-brand-border bg-brand-bg p-3"
        >
          <div className="flex justify-between gap-3 text-xs font-bold">
            <span className="text-brand-muted">{rubricLabels[key]}</span>
            <span className="text-brand-text">{value}/100</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-brand-surface-2">
            <div
              className="h-full rounded-full bg-brand-accent"
              style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
              aria-hidden="true"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function TextSummary({ result }: { result: TextEvaluationResult }) {
  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-7">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
          Seu texto refinado
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-brand-border bg-brand-bg p-4">
            <h3 className="text-sm font-black text-brand-muted">
              Correção precisa
            </h3>
            <p
              lang="en"
              className="mt-3 whitespace-pre-wrap text-sm leading-7 text-brand-text"
            >
              {result.correctedText}
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
              {result.naturalVersion}
            </p>
          </div>
        </div>
        {result.explanationPt ? (
          <p className="mt-4 text-sm leading-6 text-brand-muted">
            {result.explanationPt}
          </p>
        ) : null}
      </section>

      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-7">
        <h3 className="text-lg font-black text-brand-text">
          O que já funciona e o que lapidar
        </h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl bg-green-50 p-4 dark:bg-green-950/20">
            <p className="font-black text-green-800 dark:text-green-300">
              Pontos fortes
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-brand-muted">
              {(result.strengths ?? []).map((strength) => (
                <li key={strength} className="flex gap-2">
                  <Check size={16} className="mt-1 shrink-0" aria-hidden="true" />
                  {strength}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl bg-amber-50 p-4 dark:bg-amber-950/20">
            <p className="font-black text-amber-800 dark:text-amber-300">
              Próximos ajustes
            </p>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-brand-muted">
              {(result.priorities ?? []).map((priority) => (
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
          </div>
        </div>
        <div className="mt-5">
          <RubricGrid rubric={result.rubric ?? {}} />
        </div>
      </section>
    </div>
  );
}

function SpeechMetricCard({
  title,
  metric,
}: {
  title: string;
  metric: SpeechMetric;
}) {
  return (
    <article className="rounded-2xl border border-brand-border bg-brand-bg p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-black text-brand-text">{title}</h4>
        <span className="rounded-full bg-brand-surface-2 px-2.5 py-1 text-xs font-black text-brand-accent">
          {metric.score}/100
        </span>
      </div>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-brand-muted">
        {(metric.observations ?? []).map((observation) => (
          <li key={observation} className="flex gap-2">
            <span
              className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-accent"
              aria-hidden="true"
            />
            {observation}
          </li>
        ))}
      </ul>
      {metric.tipPt ? (
        <p className="mt-3 rounded-xl bg-brand-surface-2 p-3 text-sm leading-6 text-brand-text">
          <strong>Dica prática:</strong> {metric.tipPt}
        </p>
      ) : null}
    </article>
  );
}

function SpeechSummary({ result }: { result: SpeechEvaluationResult }) {
  return (
    <div className="space-y-5">
      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-7">
        <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
          O que o Wolfie ouviu
        </p>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-brand-border bg-brand-bg p-4">
            <h3 className="text-sm font-black text-brand-muted">Transcrição</h3>
            <p lang="en" className="mt-3 text-sm leading-7 text-brand-text">
              {result.transcript}
            </p>
          </div>
          <div className="rounded-2xl border border-brand-accent bg-brand-surface-2 p-4">
            <h3 className="text-sm font-black text-brand-accent">
              Forma corrigida
            </h3>
            <p lang="en" className="mt-3 text-sm leading-7 text-brand-text">
              {result.correctedTranscript}
            </p>
          </div>
        </div>
      </section>
      <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-7">
        <h3 className="text-lg font-black text-brand-text">
          Seus três pilares de fala
        </h3>
        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          <SpeechMetricCard
            title="Pronúncia"
            metric={result.pronunciation}
          />
          <SpeechMetricCard title="Entonação" metric={result.intonation} />
          <SpeechMetricCard
            title="Naturalidade"
            metric={result.naturalness}
          />
        </div>
      </section>
    </div>
  );
}

export function WolfieActivitySummary({
  session,
  result,
  onRetry,
  onNewActivity,
  onOpenRepertoire,
  onConversation,
}: WolfieActivitySummaryProps) {
  const subject = getSubjectOption(session.subject);
  const level = getLevelOption(session.cefr_level);

  return (
    <main className="min-h-[70vh] bg-brand-bg px-4 py-7 sm:px-7 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-6 lg:grid-cols-[19rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-5 lg:self-start">
            <section className="rounded-3xl border border-brand-border bg-brand-surface p-6 shadow-sm">
              <div className="mx-auto mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-surface-2 text-brand-accent">
                <Trophy size={24} aria-hidden="true" />
              </div>
              <ScoreHero
                score={result.score}
                xp={result.xpEarned}
                label={isQuizResult(result) ? '1ª tentativa' : 'de 100'}
              />
              <div className="mt-5 border-t border-brand-border pt-4 text-center">
                <p className="text-xs font-black uppercase tracking-wider text-brand-accent">
                  {subject.shortTitle} · {session.cefr_level}
                </p>
                <p className="mt-2 text-xs leading-5 text-brand-muted">
                  Feedback calibrado para: {level.coaching.toLowerCase()}
                </p>
              </div>
            </section>
          </aside>

          <div className="min-w-0 space-y-5">
            <section className="rounded-3xl border border-brand-border bg-brand-surface-2 p-5 sm:p-7">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-accent text-white">
                  <CheckCircle2 size={21} aria-hidden="true" />
                </span>
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
                    Sensação de prontidão
                  </p>
                  <h1 className="mt-2 text-2xl font-black leading-tight text-brand-text sm:text-3xl">
                    {result.readinessMessage}
                  </h1>
                </div>
              </div>
            </section>

            {isQuizResult(result) ? (
              <QuizSummary result={result} />
            ) : isSpeechResult(result) ? (
              <SpeechSummary result={result} />
            ) : (
              <TextSummary result={result} />
            )}

            <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-7">
              <h2 className="text-xl font-black text-brand-text">
                O que você quer fazer agora?
              </h2>
              <p className="mt-2 text-sm leading-6 text-brand-muted">
                Repetir cria segurança; trocar de módulo faz o repertório
                reaparecer em um novo contexto.
              </p>
              <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <button
                  type="button"
                  onClick={onConversation}
                  className={primaryButton}
                >
                  <Mic size={17} aria-hidden="true" />
                  Conversar sobre este tema
                </button>
                <button
                  type="button"
                  onClick={onRetry}
                  className={secondaryButton}
                >
                  <RefreshCw size={17} aria-hidden="true" />
                  Repetir atividade
                </button>
                <button
                  type="button"
                  onClick={onOpenRepertoire}
                  className={secondaryButton}
                >
                  <BookOpen size={17} aria-hidden="true" />
                  Ver repertório
                </button>
                <button
                  type="button"
                  onClick={onNewActivity}
                  className={secondaryButton}
                >
                  Outro assunto
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
