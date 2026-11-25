import React, { useEffect, useState } from "react";
import { CheckCircle2, Loader2, X, XCircle } from "lucide-react";
import {
  answerLessonReviewItem,
  completeLessonReview,
  getLessonReview,
  type LessonReviewDetail,
  REVIEW_LABEL,
} from "../../../services/wolfieLessonTrackService";

interface Result {
  correct: boolean;
  expected: string;
  whyPt: string;
}

/** Revisão curta (3 min): itens com gabarito no servidor, sem IA. */
export const WolfieLessonReview: React.FC<{ reviewId: string; onClose: () => void }> = ({ reviewId, onClose }) => {
  const [review, setReview] = useState<LessonReviewDetail | null>(null);
  const [error, setError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [score, setScore] = useState<number | null>(null);

  useEffect(() => {
    getLessonReview(reviewId)
      .then(({ review: detail }) => setReview(detail))
      .catch((err: Error) => setError(err.message));
  }, [reviewId]);

  const send = async (itemId: string, answer: string | number) => {
    setBusy(itemId);
    try {
      const result = await answerLessonReviewItem(reviewId, itemId, answer);
      setResults((current) => ({ ...current, [itemId]: result }));
      setAnswers((current) => ({ ...current, [itemId]: String(answer) }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const allDone = review ? review.items.every((item) => results[item.id] || review.answers[item.id]) : false;

  return (
    <div className="fixed inset-0 z-[60] overflow-y-auto bg-slate-950 text-slate-100" role="dialog" aria-modal="true" aria-label="Revisão">
      <div className="mx-auto max-w-2xl px-4 pb-10 pt-4 sm:px-6">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="Fechar revisão"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {error ? <p className="text-rose-300">{error}</p> : null}
        {!review && !error
          ? <p className="flex items-center gap-2 text-slate-300"><Loader2 size={18} className="animate-spin" aria-hidden="true" /> Abrindo…</p>
          : null}
        {review
          ? (
            <>
              <p className="text-xs font-bold uppercase tracking-[0.14em] text-sky-300">{REVIEW_LABEL[review.step]}</p>
              <h1 className="mt-1 text-2xl font-black tracking-tight text-white">{review.topic || "Sua aula"}</h1>
              <p className="mt-1 text-sm text-slate-400">
                {review.step === "CHECKIN"
                  ? "Três perguntas antes da próxima aula. O resultado ajuda seu professor a planejar."
                  : "Puxe da memória antes de olhar: é isso que fixa."}
              </p>
              <div className="mt-6 space-y-4">
                {review.items.map((item) => {
                  const result = results[item.id] ?? (review.answers[item.id]
                    ? { correct: review.answers[item.id].correct, expected: "", whyPt: "" }
                    : undefined);
                  return (
                    <div key={item.id} className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
                      {item.older
                        ? <span className="mb-2 inline-block rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-bold text-sky-300">Tema anterior</span>
                        : null}
                      <p className="text-slate-100">{item.prompt}</p>
                      {item.kind === "recognize"
                        ? (
                          <div className="mt-3 grid gap-2 sm:grid-cols-3">
                            {item.options.map((option, index) => (
                              <button
                                key={option}
                                type="button"
                                disabled={!!result || busy === item.id}
                                onClick={() => void send(item.id, index)}
                                className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold ${
                                  answers[item.id] === String(index)
                                    ? result?.correct ? "border-emerald-400 bg-emerald-400/10" : "border-rose-400 bg-rose-400/10"
                                    : "border-slate-700 bg-slate-950 hover:border-slate-500"
                                }`}
                              >
                                {option}
                              </button>
                            ))}
                          </div>
                        )
                        : (
                          <form
                            className="mt-3 flex flex-col gap-2 sm:flex-row"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const value = (answers[item.id] ?? "").trim();
                              if (value && !result) void send(item.id, value);
                            }}
                          >
                            <input
                              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-slate-100 focus:border-sky-400 focus:outline-none"
                              value={answers[item.id] ?? ""}
                              disabled={!!result}
                              autoCapitalize="off"
                              autoCorrect="off"
                              spellCheck={false}
                              onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                            />
                            {!result
                              ? (
                                <button type="submit" disabled={busy === item.id} className="rounded-full bg-sky-400 px-5 py-3 text-sm font-black text-slate-950">
                                  Verificar
                                </button>
                              )
                              : null}
                          </form>
                        )}
                      {result
                        ? (
                          <div className={`mt-3 rounded-xl p-3 text-sm ${result.correct ? "bg-emerald-400/10 text-emerald-50" : "bg-rose-400/10 text-rose-50"}`}>
                            <p className="flex items-center gap-2 font-bold">
                              {result.correct ? <CheckCircle2 size={16} aria-hidden="true" /> : <XCircle size={16} aria-hidden="true" />}
                              {result.correct ? "Certo!" : "Ainda não."}
                            </p>
                            {!result.correct && result.expected ? <p className="mt-1">Forma certa: <strong>{result.expected}</strong></p> : null}
                            {result.whyPt ? <p className="mt-1 text-slate-200">{result.whyPt}</p> : null}
                          </div>
                        )
                        : null}
                    </div>
                  );
                })}
              </div>
              <div className="mt-6">
                {score === null
                  ? (
                    <button
                      type="button"
                      disabled={!allDone}
                      onClick={() => void completeLessonReview(reviewId).then((r) => setScore(r.score)).catch(() => setScore(-1))}
                      className="rounded-full bg-sky-400 px-6 py-3 text-sm font-black text-slate-950 disabled:opacity-50"
                    >
                      Concluir revisão
                    </button>
                  )
                  : (
                    <div className="rounded-xl bg-sky-400/10 p-4 text-sky-50">
                      <p>Revisão concluída{score >= 0 ? ` · ${score}%` : ""}.</p>
                      <button type="button" onClick={onClose} className="mt-3 rounded-full border border-slate-700 px-5 py-2 text-sm font-bold">
                        Voltar ao Wolfie
                      </button>
                    </div>
                  )}
              </div>
            </>
          )
          : null}
      </div>
    </div>
  );
};

export default WolfieLessonReview;
