import React from 'react';
import {
  ArrowLeft,
  BarChart3,
  BookOpen,
  CalendarClock,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import type {
  RepertoireItem,
  WolfieOverview,
  WolfieSubject,
} from './types';
import {
  focusRing,
  InlineError,
  primaryButton,
  secondaryButton,
} from './WolfieActivityUI';
import { getSubjectOption } from './catalog';

interface WolfieRepertoireProps {
  overview: WolfieOverview | null;
  loading: boolean;
  error: string;
  onBack: () => void;
  onReload: () => void;
  onPractice: () => void;
}

const formatReviewDate = (value: string | null) => {
  if (!value) return 'Revisão a definir';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Revisão a definir';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const review = new Date(date);
  review.setHours(0, 0, 0, 0);
  const days = Math.round((review.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return 'Pronto para revisar';
  if (days === 0) return 'Revisar hoje';
  if (days === 1) return 'Revisar amanhã';
  return `Revisar em ${days} dias`;
};

function TermCard({ item }: { item: RepertoireItem }) {
  const mastery = Math.max(0, Math.min(100, Math.round(item.mastery_score)));
  return (
    <article className="rounded-2xl border border-brand-border bg-brand-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-base font-black text-brand-text">
            {item.term}
          </h3>
          <p className="mt-0.5 text-sm text-brand-muted">{item.translation}</p>
        </div>
        <span className="shrink-0 rounded-full bg-brand-surface-2 px-2.5 py-1 text-xs font-black text-brand-accent">
          {mastery}%
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-brand-surface-2">
        <div
          className="h-full rounded-full bg-brand-accent"
          style={{ width: `${mastery}%` }}
          aria-hidden="true"
        />
      </div>
      {item.definition_pt ? (
        <p className="mt-3 text-xs leading-5 text-brand-muted">
          {item.definition_pt}
        </p>
      ) : null}
      {item.example_sentence ? (
        <p className="mt-2 text-xs italic leading-5 text-brand-text">
          “{item.example_sentence}”
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-brand-border pt-3 text-[11px] font-bold text-brand-muted">
        <span>
          {item.cefr_level} ·{' '}
          {item.source_subject === 'conversation'
            ? 'Conversação'
            : getSubjectOption(item.source_subject as WolfieSubject).shortTitle}
        </span>
        <span className="inline-flex items-center gap-1">
          <CalendarClock size={13} aria-hidden="true" />
          {formatReviewDate(item.next_review_at)}
        </span>
      </div>
    </article>
  );
}

export function WolfieRepertoire({
  overview,
  loading,
  error,
  onBack,
  onReload,
  onPractice,
}: WolfieRepertoireProps) {
  return (
    <main className="min-h-[70vh] bg-brand-bg px-4 py-7 sm:px-7 sm:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={onBack}
              className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-border bg-brand-surface text-brand-muted hover:border-brand-accent hover:text-brand-accent ${focusRing}`}
              aria-label="Voltar ao início do Wolfie"
            >
              <ArrowLeft size={19} aria-hidden="true" />
            </button>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-brand-accent">
                Memória ativa
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-tight text-brand-text sm:text-4xl">
                Meu repertório
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-brand-muted">
                Tudo que você aprende volta em outras atividades. Os itens mais
                frágeis aparecem primeiro para virarem uso automático.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onPractice}
            className={primaryButton}
          >
            <Sparkles size={17} aria-hidden="true" />
            Começar uma prática
          </button>
        </header>

        {loading ? (
          <div
            className="mt-10 grid min-h-64 place-items-center rounded-3xl border border-brand-border bg-brand-surface"
            role="status"
          >
            <div className="text-center">
              <Loader2
                size={28}
                className="mx-auto animate-spin text-brand-accent"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-bold text-brand-muted">
                Organizando seu repertório…
              </p>
            </div>
          </div>
        ) : error ? (
          <div className="mt-8">
            <InlineError message={error} onRetry={onReload} />
          </div>
        ) : overview ? (
          <>
            <section
              className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              aria-label="Resumo do repertório"
            >
              {[
                {
                  label: 'Atividades concluídas',
                  value: overview.completedSessions,
                  icon: CheckCircle2,
                },
                {
                  label: 'Média de prontidão',
                  value:
                    overview.averageScore === null
                      ? '—'
                      : `${overview.averageScore}%`,
                  icon: BarChart3,
                },
                {
                  label: 'Expressões guardadas',
                  value: overview.repertoireCount,
                  icon: BookOpen,
                },
                {
                  label: 'Expressões prontas',
                  value: overview.readyTerms,
                  icon: Sparkles,
                },
              ].map((metric) => {
                const Icon = metric.icon;
                return (
                  <div
                    key={metric.label}
                    className="rounded-2xl border border-brand-border bg-brand-surface p-4"
                  >
                    <Icon
                      size={19}
                      className="text-brand-accent"
                      aria-hidden="true"
                    />
                    <p className="mt-3 text-2xl font-black text-brand-text">
                      {metric.value}
                    </p>
                    <p className="mt-1 text-xs font-bold text-brand-muted">
                      {metric.label}
                    </p>
                  </div>
                );
              })}
            </section>

            {overview.subjectProgress.some(
              (subject) => subject.completed > 0,
            ) ? (
              <section className="mt-8 rounded-3xl border border-brand-border bg-brand-surface p-5 sm:p-7">
                <h2 className="text-lg font-black text-brand-text">
                  Progresso cruzado
                </h2>
                <p className="mt-1 text-sm text-brand-muted">
                  Seu desempenho por tipo de prática.
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {overview.subjectProgress
                    .filter(
                      (item) =>
                        item.subject !== 'conversation' &&
                        item.completed > 0,
                    )
                    .map((item) => {
                      const subject = getSubjectOption(
                        item.subject as WolfieSubject,
                      );
                      return (
                        <div
                          key={item.subject}
                          className="rounded-2xl bg-brand-surface-2 p-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="text-sm font-black text-brand-text">
                              {subject.shortTitle}
                            </h3>
                            <span className="text-xs font-black text-brand-accent">
                              {item.averageScore === null
                                ? '—'
                                : `${item.averageScore}%`}
                            </span>
                          </div>
                          <p className="mt-2 text-xs text-brand-muted">
                            {item.completed}{' '}
                            {item.completed === 1
                              ? 'atividade concluída'
                              : 'atividades concluídas'}
                          </p>
                        </div>
                      );
                    })}
                </div>
              </section>
            ) : null}

            <section className="mt-8">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-black text-brand-text">
                    Expressões em construção
                  </h2>
                  <p className="mt-1 text-sm text-brand-muted">
                    Do menor para o maior domínio.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={onReload}
                  className={secondaryButton}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  Atualizar
                </button>
              </div>

              {overview.repertoire.length ? (
                <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {overview.repertoire.map((item) => (
                    <div key={item.id}>
                      <TermCard item={item} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-5 rounded-3xl border-2 border-dashed border-brand-border bg-brand-surface p-10 text-center">
                  <BookOpen
                    size={28}
                    className="mx-auto text-brand-muted"
                    aria-hidden="true"
                  />
                  <h3 className="mt-3 font-black text-brand-text">
                    Seu repertório começa na primeira prática
                  </h3>
                  <p className="mt-2 text-sm text-brand-muted">
                    Palavras e expressões usadas nas atividades vão aparecer
                    aqui para revisão e reutilização.
                  </p>
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
