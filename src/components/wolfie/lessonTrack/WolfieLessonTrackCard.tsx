import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, CalendarCheck, Check, Loader2, RotateCcw } from "lucide-react";
import {
  getLessonTrackHome,
  type LessonReviewCard,
  type LessonTrackCard,
  lessonDayLabel,
  prepareLessonTrack,
  REVIEW_LABEL,
} from "../../../services/wolfieLessonTrackService";

interface WolfieLessonTrackCardProps {
  onOpenTrack: (trackId: string) => void;
  onOpenReview: (reviewId: string) => void;
  /** Muda quando o aluno volta de uma sessão: recarrega o progresso. */
  refreshKey?: number;
}

/**
 * 1º cartão da home do Wolfie: "Sua aula de {dia}: {tema}".
 * Sem aula aprovada recente (ou sem conteúdo), não aparece nada e o aluno
 * segue no fluxo de sempre.
 */
export const WolfieLessonTrackCard: React.FC<WolfieLessonTrackCardProps> = ({
  onOpenTrack,
  onOpenReview,
  refreshKey = 0,
}) => {
  const [track, setTrack] = useState<LessonTrackCard | null>(null);
  const [reviews, setReviews] = useState<LessonReviewCard[]>([]);
  const [loading, setLoading] = useState(true);
  const preparing = useRef(false);

  const prepare = useCallback(async () => {
    if (preparing.current) return;
    preparing.current = true;
    setTrack((current) => current ? { ...current, status: "GENERATING" } : current);
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await prepareLessonTrack();
        setTrack(result.track);
        if (!result.track || result.track.status !== "GENERATING") break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    } catch {
      setTrack(null);
    } finally {
      preparing.current = false;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getLessonTrackHome()
      .then((home) => {
        if (!alive) return;
        setTrack(home.track);
        setReviews(home.reviews);
        if (home.track && (home.track.status === "PENDING" || home.track.status === "GENERATING")) {
          void prepare();
        }
      })
      .catch(() => {
        if (alive) setTrack(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [prepare, refreshKey]);

  if (loading || (!track && !reviews.length)) return null;
  if (track && track.status === "FAILED" && !reviews.length) return null;

  const day = track ? lessonDayLabel(track.classDate) : "";
  const total = track?.total ?? 0;
  const answered = track?.answered ?? 0;
  const pct = track?.completed ? 100 : total ? Math.round((answered / total) * 100) : 0;
  const ready = track?.status === "READY" && track.id;

  return (
    <section
      data-tour="wolfie-lesson-track"
      aria-label="Trilha da sua última aula"
      className="mb-4 overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-lg"
    >
      {track && track.status !== "FAILED"
        ? (
          <div className="relative p-5 sm:p-7">
            <div className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-emerald-500/10 blur-3xl" />
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-emerald-300">
              <CalendarCheck size={14} aria-hidden="true" /> Trilha da aula
            </p>
            <h2 className="mt-2 text-xl font-black tracking-tight sm:text-2xl">
              Sua aula de {day}
              {track.topic ? <span className="text-slate-300">: {track.topic}</span> : null}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              {track.completed
                ? "Concluída. As revisões aparecem aqui nos próximos dias."
                : "12–15 min: suas palavras da aula, os seus erros corrigidos por você, prática do tema e uma conversa com o Wolfie."}
            </p>
            {ready
              ? (
                <>
                  <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-800" aria-hidden="true">
                    <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                    <span>{pct}% feito</span>
                    {track.completed && track.score !== null && track.score !== undefined
                      ? <span>Nota {track.score}</span>
                      : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenTrack(track.id as string)}
                    className="mt-5 inline-flex items-center gap-2 rounded-full bg-emerald-400 px-5 py-3 text-sm font-black text-slate-950 transition hover:bg-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200"
                  >
                    {track.completed ? "Rever trilha" : answered ? "Continuar" : "Começar"}
                    <ArrowRight size={16} aria-hidden="true" />
                  </button>
                </>
              )
              : (
                <p className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-slate-300">
                  <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                  O Wolfie está montando a trilha a partir da sua aula…
                </p>
              )}
          </div>
        )
        : null}
      {reviews.length
        ? (
          <ul className="divide-y divide-slate-800 border-t border-slate-800">
            {reviews.map((review) => (
              <li key={review.id}>
                <button
                  type="button"
                  onClick={() => onOpenReview(review.id)}
                  className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-slate-900 sm:px-7"
                >
                  <span className="flex items-center gap-3">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-sky-500/15 text-sky-300">
                      {review.step === "CHECKIN"
                        ? <Check size={15} aria-hidden="true" />
                        : <RotateCcw size={15} aria-hidden="true" />}
                    </span>
                    <span>
                      <span className="block text-sm font-bold">{REVIEW_LABEL[review.step]}</span>
                      <span className="block text-xs text-slate-400">{review.topic || "Sua aula"} · 3 min</span>
                    </span>
                  </span>
                  <ArrowRight size={16} className="text-slate-500" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )
        : null}
    </section>
  );
};
