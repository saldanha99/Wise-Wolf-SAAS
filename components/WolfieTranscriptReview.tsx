import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Mic, PencilLine, RotateCcw } from "lucide-react";
import { uniqueTranscriptAlternatives } from "../lib/wolfieVoiceSafety";
import type { TranscriptConfirmationReason } from "../supabase/functions/wolfie-brain/factual-integrity.ts";

interface WolfieTranscriptReviewProps {
  transcript: string;
  alternatives?: string[];
  confidence?: number | null;
  busy?: boolean;
  /** Why the review opened. Changes the copy only. */
  reason?: TranscriptConfirmationReason | null;
  /** When set, the transcript is sent by itself after this delay unless the learner interacts. */
  autoConfirmAfterMs?: number | null;
  /** Error from the last attempt, shown inside the dialog (never behind it). */
  errorMessage?: string | null;
  onConfirm: (transcript: string) => void;
  onRetry: () => void;
}

const COPY: Record<TranscriptConfirmationReason, { title: string; hint: string }> = {
  personal_fact: {
    title: "Confira antes de salvar",
    hint: "Nomes e informações pessoais nunca serão corrigidos por suposição.",
  },
  personal_data: {
    title: "Confira antes de salvar",
    hint: "Você falou um contato ou documento. Confira antes de enviar.",
  },
  unreliable_transcript: {
    title: "Não deu para entender sua fala",
    hint: "Fale de novo ou escreva o que você disse.",
  },
  low_confidence: {
    title: "O Wolfie não teve certeza do que ouviu",
    hint: "Confira ou corrija a frase antes de enviar.",
  },
  uncertain_detail: {
    title: "Confira o nome ou número",
    hint: "Se estiver certo, não precisa fazer nada: enviamos sozinho.",
  },
};

const DEFAULT_COPY = {
  title: "Confirme o que o Wolfie ouviu",
  hint: "Nomes e informações pessoais nunca serão corrigidos por suposição.",
};

export const WolfieTranscriptReview: React.FC<
  WolfieTranscriptReviewProps
> = ({
  transcript,
  alternatives = [],
  confidence,
  busy = false,
  reason = null,
  autoConfirmAfterMs = null,
  errorMessage = null,
  onConfirm,
  onRetry,
}) => {
  const unreliable = reason === "unreliable_transcript";
  // An echo of the ASR prompt is not what the learner said: start empty.
  const [value, setValue] = useState(unreliable ? "" : transcript);
  const [countdownMs, setCountdownMs] = useState<number | null>(
    autoConfirmAfterMs && autoConfirmAfterMs > 0 ? autoConfirmAfterMs : null,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const choices = unreliable
    ? []
    : uniqueTranscriptAlternatives(transcript, alternatives);
  const copy = (reason && COPY[reason]) || DEFAULT_COPY;

  useEffect(() => {
    setValue(unreliable ? "" : transcript);
    setCountdownMs(
      autoConfirmAfterMs && autoConfirmAfterMs > 0 ? autoConfirmAfterMs : null,
    );
    window.requestAnimationFrame(() =>
      (unreliable ? retryButtonRef : confirmButtonRef).current?.focus()
    );
  }, [transcript, unreliable, autoConfirmAfterMs]);

  const stopCountdown = () => setCountdownMs(null);

  const confirm = () => {
    const normalized = valueRef.current.trim();
    if (normalized && !busy) onConfirm(normalized);
  };

  // Medium confidence: send by itself unless the learner touches anything.
  useEffect(() => {
    if (countdownMs === null || busy) return;
    if (countdownMs <= 0) {
      setCountdownMs(null);
      confirm();
      return;
    }
    const timer = window.setTimeout(
      () => setCountdownMs((current) => (current === null ? null : current - 250)),
      250,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdownMs, busy]);

  const countdownSeconds = countdownMs === null
    ? null
    : Math.max(1, Math.ceil(countdownMs / 1000));

  return (
    <div
      className="w-[min(92vw,38rem)] rounded-3xl border border-amber-300/35 bg-slate-950/95 p-5 text-left shadow-[0_24px_80px_rgba(0,0,0,0.65)] backdrop-blur-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wolfie-transcript-review-title"
      aria-describedby="wolfie-transcript-review-hint"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onRetry();
        }
      }}
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-full bg-amber-400/15 p-2 text-amber-200">
          <Mic size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p
            id="wolfie-transcript-review-title"
            className="text-[11px] font-black uppercase tracking-[0.18em] text-amber-200"
          >
            {copy.title}
          </p>
          <p
            id="wolfie-transcript-review-hint"
            className="mt-1 text-xs leading-5 text-slate-300"
          >
            {copy.hint}
          </p>
        </div>
        {typeof confidence === "number" && confidence > 0 && !unreliable && (
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[9px] font-bold text-slate-400">
            {Math.round(confidence * 100)}%
          </span>
        )}
      </div>

      <label className="mt-4 flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-1 transition focus-within:border-cyan-300 hover:border-cyan-400/35">
        <span className="sr-only">Editar o que o Wolfie ouviu</span>
        <input
          ref={inputRef}
          value={value}
          placeholder={unreliable ? "Escreva o que você disse" : undefined}
          onChange={(event) => {
            stopCountdown();
            setValue(event.target.value);
          }}
          onFocus={stopCountdown}
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirm();
            }
          }}
          className="min-h-11 w-full bg-transparent py-2 text-base font-semibold text-white outline-hidden placeholder:font-normal placeholder:text-slate-500"
          aria-label="Editar o que o Wolfie ouviu"
          data-testid="wolfie-transcript-input"
        />
        <PencilLine size={15} className="shrink-0 text-cyan-300" aria-hidden="true" />
      </label>

      {choices.length > 0 && (
        <div className="mt-3">
          <p className="mb-2 text-[9px] font-black uppercase tracking-wider text-slate-500">
            Outras possibilidades
          </p>
          <div className="flex flex-wrap gap-2">
            {choices.map((choice) => (
              <button
                key={choice}
                type="button"
                disabled={busy}
                onClick={() => {
                  stopCountdown();
                  setValue(choice);
                }}
                className="min-h-9 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-300 transition hover:border-violet-400/35 hover:text-white"
              >
                {choice}
              </button>
            ))}
          </div>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-2xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-100"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-2">
        <button
          ref={retryButtonRef}
          type="button"
          onClick={() => {
            stopCountdown();
            onRetry();
          }}
          disabled={busy}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw size={14} aria-hidden="true" />
          Falar novamente
        </button>
        <button
          ref={confirmButtonRef}
          type="button"
          onClick={() => {
            stopCountdown();
            confirm();
          }}
          disabled={!value.trim() || busy}
          aria-busy={busy}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-wider text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? <Loader2 size={15} className="animate-spin" aria-hidden="true" />
            : <Check size={15} aria-hidden="true" />}
          {busy
            ? "Enviando…"
            : errorMessage
            ? "Tentar de novo"
            : countdownSeconds !== null
            ? `Enviar (${countdownSeconds}s)`
            : unreliable
            ? "Enviar texto"
            : "Está correto"}
        </button>
      </div>
    </div>
  );
};

export default WolfieTranscriptReview;
