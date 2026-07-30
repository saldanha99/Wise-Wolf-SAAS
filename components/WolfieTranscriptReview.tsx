import React, { useEffect, useRef, useState } from "react";
import { Check, Mic, PencilLine, RotateCcw } from "lucide-react";
import { uniqueTranscriptAlternatives } from "../lib/wolfieVoiceSafety";

interface WolfieTranscriptReviewProps {
  transcript: string;
  alternatives?: string[];
  confidence?: number | null;
  onConfirm: (transcript: string) => void;
  onRetry: () => void;
}

export const WolfieTranscriptReview: React.FC<
  WolfieTranscriptReviewProps
> = ({
  transcript,
  alternatives = [],
  confidence,
  onConfirm,
  onRetry,
}) => {
  const [value, setValue] = useState(transcript);
  const [isEditing, setIsEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const transcriptButtonRef = useRef<HTMLButtonElement>(null);
  const choices = uniqueTranscriptAlternatives(transcript, alternatives);

  useEffect(() => {
    setValue(transcript);
    setIsEditing(false);
    window.requestAnimationFrame(() => transcriptButtonRef.current?.focus());
  }, [transcript]);

  useEffect(() => {
    if (isEditing) inputRef.current?.focus();
  }, [isEditing]);

  const confirm = () => {
    const normalized = value.trim();
    if (normalized) onConfirm(normalized);
  };

  return (
    <div
      className="w-[min(92vw,38rem)] rounded-3xl border border-amber-300/35 bg-slate-950/95 p-5 text-left shadow-[0_24px_80px_rgba(0,0,0,0.65)] backdrop-blur-2xl"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wolfie-transcript-review-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isEditing) {
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
            Confirme o que o Wolfie ouviu
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-300">
            Nomes e informações pessoais nunca serão corrigidos por suposição.
          </p>
        </div>
        {typeof confidence === "number" && confidence > 0 && (
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[9px] font-bold text-slate-400">
            {Math.round(confidence * 100)}%
          </span>
        )}
      </div>

      {isEditing
        ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") confirm();
              if (event.key === "Escape") setIsEditing(false);
            }}
            className="mt-4 w-full rounded-2xl border border-cyan-400/35 bg-slate-900 px-4 py-3 text-base text-white outline-none ring-0 transition focus:border-cyan-300"
            aria-label="Editar transcrição"
          />
        )
        : (
          <button
            ref={transcriptButtonRef}
            type="button"
            onClick={() => setIsEditing(true)}
            className="mt-4 flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left text-base font-semibold text-white transition hover:border-cyan-400/35 hover:bg-cyan-500/10"
          >
            <span>“{value}”</span>
            <PencilLine size={15} className="shrink-0 text-cyan-300" />
          </button>
        )}

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
                onClick={() => {
                  setValue(choice);
                  setIsEditing(false);
                }}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-300 transition hover:border-violet-400/35 hover:text-white"
              >
                {choice}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-5 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-300 transition hover:bg-white/10"
        >
          <RotateCcw size={14} />
          Falar novamente
        </button>
        <button
          type="button"
          onClick={confirm}
          disabled={!value.trim()}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-3 text-xs font-black uppercase tracking-wider text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Check size={15} />
          Está correto
        </button>
      </div>
    </div>
  );
};

export default WolfieTranscriptReview;
