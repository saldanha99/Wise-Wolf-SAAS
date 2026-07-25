import React from 'react';
import {
  ArrowLeft,
  Check,
  Loader2,
  Mic,
  Sparkles,
  Target,
} from 'lucide-react';
import type {
  VocabularyItem,
  WolfieActivitySession,
} from './types';
import { getSubjectOption } from './catalog';

export const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2 focus-visible:ring-offset-brand-bg';

export const primaryButton =
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-brand-accent px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-brand-accent-hover disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const secondaryButton =
  `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-brand-border bg-brand-surface px-5 py-3 text-sm font-bold text-brand-text transition hover:border-brand-accent hover:text-brand-accent disabled:cursor-not-allowed disabled:opacity-50 ${focusRing}`;

export const inputClass =
  `w-full rounded-2xl border border-brand-border bg-brand-bg px-4 py-3 text-base text-brand-text placeholder:text-brand-muted/70 shadow-inner outline-none transition focus:border-brand-accent focus:ring-2 focus:ring-brand-accent/20 ${focusRing}`;

export function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div
      className="rounded-2xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
      role="alert"
    >
      <p>{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={`mt-3 rounded-lg font-bold underline underline-offset-4 ${focusRing}`}
        >
          Tentar novamente
        </button>
      ) : null}
    </div>
  );
}

export function ActivityHeader({
  session,
  kicker,
  progress,
  onBack,
  onConversation,
}: {
  session: WolfieActivitySession;
  kicker: string;
  progress?: string;
  onBack?: () => void;
  onConversation?: () => void;
}) {
  const subject = getSubjectOption(session.subject);
  return (
    <header className="border-b border-brand-border bg-brand-surface px-4 py-5 sm:px-7">
      <div className="mx-auto flex max-w-6xl items-start gap-3">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className={`mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-brand-border bg-brand-bg text-brand-muted hover:border-brand-accent hover:text-brand-accent ${focusRing}`}
            aria-label="Sair desta atividade"
          >
            <ArrowLeft size={19} aria-hidden="true" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-brand-accent">
            <span>{kicker}</span>
            <span aria-hidden="true">•</span>
            <span>{session.cefr_level}</span>
            {progress ? (
              <>
                <span aria-hidden="true">•</span>
                <span>{progress}</span>
              </>
            ) : null}
          </div>
          <h1 className="mt-2 text-2xl font-black tracking-tight text-brand-text sm:text-3xl">
            {session.activity_content.title || subject.title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-muted">
            {session.activity_content.instructionsPt}
          </p>
          {onConversation ? (
            <button
              type="button"
              onClick={onConversation}
              className={`${secondaryButton} mt-4 w-full sm:w-auto`}
            >
              <Mic size={18} aria-hidden="true" />
              Conversar em tempo real sobre este tema
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function ReadinessCard({ goal }: { goal: string }) {
  if (!goal) return null;
  return (
    <div className="rounded-2xl border border-brand-border bg-brand-surface-2 p-4">
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-brand-accent">
        <Target size={16} aria-hidden="true" />
        Sua meta de prontidão
      </div>
      <p className="mt-2 text-sm leading-6 text-brand-text">{goal}</p>
    </div>
  );
}

export function VocabularyCard({
  items,
  title = 'Repertório desta prática',
}: {
  items: VocabularyItem[];
  title?: string;
}) {
  if (!items.length) return null;
  return (
    <section className="rounded-2xl border border-brand-border bg-brand-surface p-4">
      <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-brand-muted">
        <Sparkles size={16} className="text-brand-accent" aria-hidden="true" />
        {title}
      </div>
      <div className="mt-3 space-y-3">
        {items.map((item) => (
          <details
            key={`${item.term}-${item.translation}`}
            className="group rounded-xl border border-brand-border bg-brand-bg px-3 py-2"
          >
            <summary
              className={`cursor-pointer list-none text-sm font-bold text-brand-text ${focusRing}`}
            >
              <span>{item.term}</span>
              <span className="ml-2 font-normal text-brand-muted">
                {item.translation}
              </span>
            </summary>
            <p className="mt-2 text-xs leading-5 text-brand-muted">
              {item.definitionPt}
            </p>
            {item.example ? (
              <p className="mt-1 text-xs italic leading-5 text-brand-text">
                “{item.example}”
              </p>
            ) : null}
          </details>
        ))}
      </div>
    </section>
  );
}

export function Checklist({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item} className="flex gap-2 text-sm leading-6 text-brand-muted">
          <span className="mt-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-surface-2 text-brand-accent">
            <Check size={13} aria-hidden="true" />
          </span>
          {item}
        </li>
      ))}
    </ul>
  );
}

export function BusyLabel({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Loader2 size={17} className="animate-spin" aria-hidden="true" />
      {children}
    </>
  );
}
