import React from 'react';
import { BookOpen, Sparkles } from 'lucide-react';
import { focusRing, secondaryButton } from './WolfieActivityUI';

interface WolfiePracticeHeaderProps {
  isSubjectView: boolean;
  actionLabel?: string;
  actionBadge?: number | null;
  onAction: () => void;
}

export function WolfiePracticeHeader({
  isSubjectView,
  actionLabel = 'Meu repertório',
  actionBadge,
  onAction,
}: WolfiePracticeHeaderProps) {
  return (
    <header
      className={`px-4 py-5 sm:px-7 ${
        isSubjectView
          ? 'border-b border-white/10 bg-[#071120]'
          : 'bg-brand-surface'
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl text-white shadow-sm ${
              isSubjectView
                ? 'bg-gradient-to-br from-cyan-400 via-blue-500 to-violet-600 shadow-blue-500/25'
                : 'bg-brand-accent'
            }`}
          >
            <Sparkles size={22} aria-hidden="true" />
          </span>
          <div>
            <p
              className={`font-black tracking-tight ${
                isSubjectView ? 'text-white' : 'text-brand-text'
              }`}
            >
              Wolfie Tutor
            </p>
            <p
              className={`text-xs ${
                isSubjectView ? 'text-slate-400' : 'text-brand-muted'
              }`}
            >
              Imersão que parte da sua vida
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onAction}
          className={isSubjectView
            ? `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm font-bold text-white backdrop-blur-xl transition hover:border-cyan-300/40 hover:bg-white/10 ${focusRing}`
            : secondaryButton}
        >
          <BookOpen size={17} aria-hidden="true" />
          <span className="hidden sm:inline">{actionLabel}</span>
          {actionBadge
            ? (
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  isSubjectView
                    ? 'bg-white/10 text-cyan-200'
                    : 'bg-brand-surface-2 text-brand-accent'
                }`}
              >
                {actionBadge}
              </span>
            )
            : null}
        </button>
      </div>
    </header>
  );
}
