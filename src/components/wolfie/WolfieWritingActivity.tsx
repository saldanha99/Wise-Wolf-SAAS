import React, { useMemo, useRef, useState } from 'react';
import { PenLine, Send } from 'lucide-react';
import {
  createWolfieRequestKey,
  submitWolfieText,
} from '../../services/wolfieActivityService';
import type {
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
}

export function WolfieWritingActivity({
  session,
  onComplete,
  onExit,
}: WolfieWritingActivityProps) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const startedAt = useRef(Date.now());
  const request = useRef<{ text: string; requestKey: string } | null>(null);
  const content = session.activity_content;

  const wordCount = useMemo(
    () => text.trim().split(/\s+/).filter(Boolean).length,
    [text],
  );

  const submit = async () => {
    if (text.trim().length < 3 || submitting) return;
    const submittedText = text.trim();
    if (request.current?.text !== submittedText) {
      request.current = {
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
        complete: true,
        modality: 'text',
        requestKey: request.current.requestKey,
      });
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
        onBack={onExit}
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
              Situação real
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

          <section className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-7">
            <label
              htmlFor="wolfie-writing-response"
              className="text-sm font-black text-brand-text"
            >
              Sua mensagem em inglês
            </label>
            <p
              id="wolfie-writing-help"
              className="mt-1 text-sm leading-6 text-brand-muted"
            >
              Escreva como você realmente escreveria. O Wolfie separa correção
              gramatical de naturalidade.
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
              placeholder="Write your message here…"
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

            {error ? (
              <div className="mt-5">
                <InlineError message={error} onRetry={() => void submit()} />
              </div>
            ) : null}

            <div className="mt-6 flex justify-end">
              <button
                type="submit"
                disabled={submitting || text.trim().length < 3}
                className={primaryButton}
              >
                {submitting ? (
                  <BusyLabel>Wolfie está refinando…</BusyLabel>
                ) : (
                  <>
                    <Send size={18} aria-hidden="true" />
                    Corrigir e tornar natural
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
