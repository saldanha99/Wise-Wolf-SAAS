import React, { useEffect, useRef, useState } from "react";
import { WolfieOpenerBubble } from "../WolfieOpenerBubble";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Lightbulb,
  Loader2,
  MessageCircle,
  Mic,
  RotateCcw,
  Sparkles,
  Target,
  X,
  XCircle,
} from "lucide-react";
import {
  type AnsweredItem,
  answerLessonTrackItem,
  type AnswerResult,
  completeLessonTrack,
  getLessonTrack,
  getRoleplayFeedback,
  type LessonTrackDetail,
  lessonDayLabel,
  type RoleplayFeedback,
} from "../../../services/wolfieLessonTrackService";
import type { WolfieTutorSessionSummary } from "../../../../components/wolfieTutorSession";
import type { WolfieUserSummary } from "../types";
import { parseRoleplayCharacter } from "../visuals/RoleplayCounterpart";

const WolfieConversationTutor = React.lazy(
  () => import("../../../../components/WolfieTutor"),
);

type Stage = "warmup" | "mistakes" | "practice" | "speaking" | "roleplay" | "feedback";
const STAGES: { id: Stage; label: string }[] = [
  { id: "warmup", label: "Aquecimento" },
  { id: "mistakes", label: "Seus erros" },
  { id: "practice", label: "Prática" },
  { id: "speaking", label: "Fala" },
  { id: "roleplay", label: "Conversa" },
  { id: "feedback", label: "Cartões" },
];

interface SessionProps {
  trackId: string;
  // O mesmo usuário que o fluxo do Wolfie já passa ao WolfieTutor.
  user: WolfieUserSummary;
  level: string;
  onClose: () => void;
}

interface ItemState {
  answer: string;
  result: AnswerResult | null;
  busy: boolean;
  error: string;
}

const panel = "rounded-2xl border border-slate-800 bg-slate-900/70 p-5 sm:p-6";
const input =
  "w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400/30";
const primary =
  "inline-flex items-center justify-center gap-2 rounded-full bg-emerald-400 px-5 py-3 text-sm font-black text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200";
const ghost =
  "inline-flex items-center justify-center gap-2 rounded-full border border-slate-700 px-5 py-3 text-sm font-bold text-slate-200 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400";

function fromAnswered(item: AnsweredItem | undefined): ItemState | undefined {
  if (!item) return undefined;
  return {
    answer: item.answer,
    busy: false,
    error: "",
    result: {
      correct: item.correct,
      attempts: item.attempts,
      expected: item.expected,
      whyPt: item.whyPt,
      native: item.native,
      hintPt: item.hintPt,
      canRetry: item.canRetry,
    },
  };
}

/** Resposta do Wolfie a um item: certo, dica (tente de novo) ou o cartão com a forma certa. */
const Verdict: React.FC<{ result: AnswerResult; example?: boolean }> = ({ result, example = false }) => {
  if (result.canRetry && result.hintPt) {
    return (
      <div className="mt-3 flex gap-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-100" role="status">
        <Lightbulb size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p><strong>Quase. Dica:</strong> {result.hintPt} Tente de novo.</p>
      </div>
    );
  }
  return (
    <div
      className={`mt-3 rounded-xl border p-3 text-sm ${
        result.correct ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-50" : "border-rose-400/30 bg-rose-400/10 text-rose-50"
      }`}
      role="status"
    >
      <p className="flex items-center gap-2 font-bold">
        {result.correct
          ? <CheckCircle2 size={16} aria-hidden="true" />
          : <XCircle size={16} aria-hidden="true" />}
        {result.correct ? "Certo!" : "Ainda não."}
      </p>
      {result.corrected && !result.correct ? <p className="mt-1">Sua frase corrigida: <em>{result.corrected}</em></p> : null}
      {result.expected
        ? <p className="mt-1">{example ? "Exemplo de resposta" : "Forma certa"}: <strong>{result.expected}</strong></p>
        : null}
      {result.whyPt ? <p className="mt-1 text-slate-200">Por quê: {result.whyPt}</p> : null}
      {result.native ? <p className="mt-1 text-slate-300">Como um nativo diria: <em>{result.native}</em></p> : null}
    </div>
  );
};

export const WolfieLessonTrackSession: React.FC<SessionProps> = ({ trackId, user, level, onClose }) => {
  const [track, setTrack] = useState<LessonTrackDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [stage, setStage] = useState<Stage>("warmup");
  const [items, setItems] = useState<Record<string, ItemState>>({});
  const [roleplayOpen, setRoleplayOpen] = useState(false);
  const [feedback, setFeedback] = useState<RoleplayFeedback | null>(null);
  const [feedbackState, setFeedbackState] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [completedScore, setCompletedScore] = useState<number | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    getLessonTrack(trackId)
      .then(({ track: detail }) => {
        if (!alive) return;
        setTrack(detail);
        setFeedback(detail.roleplayFeedback);
        const restored: Record<string, ItemState> = {};
        for (const [id, value] of Object.entries(detail.answered)) {
          const state = fromAnswered(value);
          if (state) restored[id] = state;
        }
        setItems(restored);
        if (detail.completed) setStage("feedback");
      })
      .catch((error: Error) => {
        if (alive) setLoadError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [trackId]);

  useEffect(() => {
    topRef.current?.scrollIntoView({ block: "start" });
  }, [stage]);

  const stageIndex = STAGES.findIndex((s) => s.id === stage);
  const content = track?.content;

  const setItem = (id: string, patch: Partial<ItemState>) =>
    setItems((current) => ({
      ...current,
      [id]: { answer: "", result: null, busy: false, error: "", ...current[id], ...patch },
    }));

  const submit = async (id: string, answer: string | number) => {
    if (!track) return;
    setItem(id, { busy: true, error: "" });
    try {
      const result = await answerLessonTrackItem(track.id, id, answer);
      setItem(id, { busy: false, result, answer: String(answer) });
    } catch (error) {
      setItem(id, { busy: false, error: (error as Error).message });
    }
  };

  const done = (id: string) => {
    const r = items[id]?.result;
    return !!r && !r.canRetry;
  };

  const stageDone = (() => {
    if (!content) return false;
    if (stage === "warmup") return content.warmup.every((w) => done(w.id));
    if (stage === "mistakes") return content.mistakes.every((m) => done(m.id));
    if (stage === "practice") return content.practice.every((p) => done(p.id));
    if (stage === "speaking") return done(content.speaking.id);
    return true;
  })();

  const finishRoleplay = async (summary: WolfieTutorSessionSummary) => {
    setRoleplayOpen(false);
    setStage("feedback");
    if (!track || !summary.conversationId || summary.learnerTurns < 1) {
      setFeedbackState(feedback ? "idle" : "empty");
      return;
    }
    setFeedbackState("loading");
    try {
      const result = await getRoleplayFeedback(track.id, summary.conversationId);
      setFeedback(result.feedback);
      setFeedbackState(result.feedback ? "idle" : "empty");
    } catch {
      setFeedbackState("error");
    }
  };

  const finish = async () => {
    if (!track) return;
    try {
      const result = await completeLessonTrack(track.id);
      setCompletedScore(result.score);
    } catch {
      setCompletedScore(-1);
    }
  };

  const textItem = (
    id: string,
    label: React.ReactNode,
    placeholder: string,
    multiline = false,
    example = false,
  ) => {
    const state = items[id];
    const locked = state?.result && !state.result.canRetry;
    return (
      <div className={panel} key={id}>
        <div className="text-base text-slate-100">{label}</div>
        <form
          className="mt-3 flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const value = (state?.answer ?? "").trim();
            if (value && !locked) void submit(id, value);
          }}
        >
          {multiline
            ? (
              <textarea
                className={`${input} min-h-[96px]`}
                value={state?.answer ?? ""}
                disabled={!!locked}
                placeholder={placeholder}
                onChange={(event) => setItem(id, { answer: event.target.value })}
              />
            )
            : (
              <input
                className={input}
                value={state?.answer ?? ""}
                disabled={!!locked}
                placeholder={placeholder}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setItem(id, { answer: event.target.value })}
              />
            )}
          {!locked
            ? (
              <button type="submit" className={primary} disabled={state?.busy || !(state?.answer ?? "").trim()}>
                {state?.busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : null}
                Verificar
              </button>
            )
            : null}
        </form>
        {state?.error ? <p className="mt-2 text-sm text-rose-300">{state.error}</p> : null}
        {state?.result ? <Verdict result={state.result} example={example} /> : null}
      </div>
    );
  };

  if (loadError) {
    return (
      <Shell onClose={onClose}>
        <p className="text-slate-300">{loadError}</p>
      </Shell>
    );
  }
  if (!track || !content) {
    return (
      <Shell onClose={onClose}>
        <p className="flex items-center gap-2 text-slate-300">
          <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Abrindo sua trilha…
        </p>
      </Shell>
    );
  }

  if (roleplayOpen) {
    return (
      <React.Suspense
        fallback={
          <Shell onClose={() => setRoleplayOpen(false)}>
            <p className="text-slate-300">Conectando com o Wolfie…</p>
          </Shell>
        }
      >
        <WolfieConversationTutor
          user={{ ...user, levelBadge: level }}
          voiceMode
          topic={track.roleplay.topic}
          experienceMode="roleplay"
          correctionMode="selective"
          languageMode={/^(A1|A2)/i.test(level) ? "bilingual" : "immersive"}
          difficulty="adaptive"
          scenario={track.roleplay.scenario}
          studentGoal={track.roleplay.studentGoal}
          targetSkill={track.roleplay.targetSkill}
          roleplayCast={{
            ...parseRoleplayCharacter(content.roleplay.character),
            objectives: content.roleplay.objectives,
          }}
          onClose={(summary) => void finishRoleplay(summary)}
        />
      </React.Suspense>
    );
  }

  return (
    <Shell onClose={onClose}>
      <div ref={topRef} />
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-emerald-300">
          Trilha da aula de {lessonDayLabel(track.classDate)}
        </p>
        <h1 className="mt-1 text-2xl font-black tracking-tight text-white sm:text-3xl">{content.topic}</h1>
        {stageIndex === 0 && <WolfieOpenerBubble className="mt-3" tone="emerald" />}
        <ol className="mt-4 flex gap-1.5" aria-label="Etapas">
          {STAGES.map((s, index) => (
            <li
              key={s.id}
              className={`h-1.5 flex-1 rounded-full ${index <= stageIndex ? "bg-emerald-400" : "bg-slate-800"}`}
              aria-current={s.id === stage ? "step" : undefined}
              title={s.label}
            />
          ))}
        </ol>
        <p className="mt-2 text-sm text-slate-400">{stageIndex + 1}/{STAGES.length} · {STAGES[stageIndex].label}</p>
      </header>

      <div className="mt-6 space-y-4">
        {stage === "warmup"
          ? (
            <>
              <p className="text-slate-300">Sem olhar o caderno: como se diz em inglês? São palavras da sua aula.</p>
              {content.warmup.map((w) => textItem(w.id, <span className="font-semibold">“{w.pt}”</span>, "em inglês…"))}
            </>
          )
          : null}

        {stage === "mistakes"
          ? (
            <>
              <p className="text-slate-300">
                Estas frases apareceram na sua aula. Corrija você mesmo: na primeira tentativa o Wolfie só dá uma dica.
              </p>
              {content.mistakes.map((m) =>
                textItem(
                  m.id,
                  <span>
                    <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">
                      {m.fromClass ? "Você disse na aula" : "Erro comum deste tema"}
                    </span>
                    <span className="mt-1 block text-lg text-rose-200 line-through decoration-rose-400/60">{m.said}</span>
                  </span>,
                  "escreva a frase corrigida…",
                )
              )}
            </>
          )
          : null}

        {stage === "practice"
          ? (
            <>
              <div className={panel}>
                <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">Foco na forma</p>
                <p className="mt-2 text-slate-100">{content.grammar.explanationPt}</p>
                {content.grammar.pattern
                  ? <p className="mt-3 inline-block rounded-lg bg-slate-950 px-3 py-1.5 font-mono text-sm text-emerald-200">{content.grammar.pattern}</p>
                  : null}
                <ul className="mt-3 space-y-1.5">
                  {content.grammar.examples.map((example) => (
                    <li key={example.en} className="text-sm">
                      <span className="text-slate-100">{example.en}</span>
                      <span className="text-slate-500"> — {example.pt}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {content.practice.map((p) => {
                const chip = p.topic === "previous"
                  ? <span className="mb-2 inline-block rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs font-bold text-sky-300">Tema anterior</span>
                  : null;
                if (p.kind === "recognize") {
                  const state = items[p.id];
                  const locked = !!state?.result;
                  return (
                    <div className={panel} key={p.id}>
                      {chip}
                      <p className="text-slate-100">{p.prompt}</p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-3">
                        {p.options.map((option, index) => (
                          <button
                            key={option}
                            type="button"
                            disabled={locked || state?.busy}
                            onClick={() => void submit(p.id, index)}
                            className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
                              state?.answer === String(index)
                                ? state.result?.correct
                                  ? "border-emerald-400 bg-emerald-400/10"
                                  : "border-rose-400 bg-rose-400/10"
                                : "border-slate-700 bg-slate-950 hover:border-slate-500"
                            }`}
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                      {state?.result ? <Verdict result={state.result} /> : null}
                    </div>
                  );
                }
                const verbs = { complete: "Complete", transform: "Transforme", produce: "Escreva" } as const;
                return textItem(
                  p.id,
                  <span>
                    {chip}
                    <span className="block text-xs font-bold uppercase tracking-wider text-slate-400">{verbs[p.kind]}</span>
                    <span className="mt-1 block">{p.prompt}</span>
                  </span>,
                  p.kind === "produce" ? "sua frase, sobre a sua vida…" : "sua resposta…",
                  p.kind === "produce",
                  p.kind === "produce",
                );
              })}
              <div className={panel}>
                <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">Vocabulário da aula no seu dia a dia</p>
                <ul className="mt-3 space-y-2">
                  {content.vocabulary.map((v) => (
                    <li key={v.term} className="text-sm">
                      <strong className="text-white">{v.term}</strong>
                      <span className="text-slate-400"> ({v.meaningPt})</span>
                      <span className="block text-slate-300">{v.sentence}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )
          : null}

        {stage === "speaking"
          ? (
            <>
              <p className="text-slate-300">
                Agora é você que produz. Responda sobre a sua vida usando o tema da aula ({content.speaking.targetPt}).
                Dá para ditar pelo microfone do teclado do celular.
              </p>
              {textItem(
                content.speaking.id,
                <span className="flex items-start gap-2 text-lg font-semibold">
                  <Mic size={18} className="mt-1 shrink-0 text-emerald-300" aria-hidden="true" />
                  {content.speaking.question}
                </span>,
                "sua resposta em inglês…",
                true,
              )}
            </>
          )
          : null}

        {stage === "roleplay"
          ? (
            <div className={panel}>
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">Conversa com o Wolfie · 4–5 min</p>
              <h2 className="mt-2 text-xl font-black text-white">{content.roleplay.titlePt}</h2>
              <p className="mt-2 text-slate-300">{content.roleplay.scenario}</p>
              <p className="mt-2 text-sm text-slate-400">O Wolfie faz o papel de: <strong className="text-slate-200">{content.roleplay.character}</strong></p>
              <p className="mt-4 text-xs font-bold uppercase tracking-wider text-slate-400">Seus 3 objetivos</p>
              <ol className="mt-2 space-y-2">
                {content.roleplay.objectives.map((objective, index) => (
                  <li key={objective} className="flex gap-3 rounded-xl bg-slate-950 p-3 text-sm text-slate-100">
                    <Target size={16} className="mt-0.5 shrink-0 text-emerald-300" aria-hidden="true" />
                    <span><strong>{index + 1}.</strong> {objective}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-4 text-sm text-slate-400">
                O Wolfie só pede para repetir quando o erro for do tema da aula. O resto vira cartão no final.
              </p>
              <div className="mt-5 flex flex-wrap gap-3">
                <button type="button" className={primary} onClick={() => setRoleplayOpen(true)}>
                  <MessageCircle size={16} aria-hidden="true" /> Começar a conversa
                </button>
                <button type="button" className={ghost} onClick={() => setStage("feedback")}>
                  Pular por agora
                </button>
              </div>
            </div>
          )
          : null}

        {stage === "feedback"
          ? (
            <FeedbackStage
              feedback={feedback}
              state={feedbackState}
              objectives={content.roleplay.objectives}
              completed={track.completed || completedScore !== null}
              score={completedScore ?? track.score}
              onRetryRoleplay={() => setRoleplayOpen(true)}
              onFinish={() => void finish()}
              onClose={onClose}
            />
          )
          : null}
      </div>

      {stage !== "feedback"
        ? (
          <nav className="sticky bottom-0 mt-8 flex items-center justify-between gap-3 border-t border-slate-800 bg-slate-950/95 py-4 backdrop-blur">
            <button
              type="button"
              className={ghost}
              disabled={stageIndex === 0}
              onClick={() => setStage(STAGES[Math.max(0, stageIndex - 1)].id)}
            >
              <ArrowLeft size={16} aria-hidden="true" /> Voltar
            </button>
            {stage !== "roleplay"
              ? (
                <button
                  type="button"
                  className={primary}
                  disabled={!stageDone}
                  onClick={() => setStage(STAGES[stageIndex + 1].id)}
                >
                  Próximo <ArrowRight size={16} aria-hidden="true" />
                </button>
              )
              : null}
          </nav>
        )
        : null}
    </Shell>
  );
};

const Shell: React.FC<{ onClose: () => void; children: React.ReactNode }> = ({ onClose, children }) => (
  <div className="fixed inset-0 z-[60] overflow-y-auto bg-slate-950 text-slate-100" role="dialog" aria-modal="true" aria-label="Trilha da aula">
    <div className="mx-auto max-w-2xl px-4 pb-10 pt-4 sm:px-6">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-400 hover:bg-slate-800 hover:text-white"
          aria-label="Fechar trilha"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      {children}
    </div>
  </div>
);

interface FeedbackStageProps {
  feedback: RoleplayFeedback | null;
  state: "idle" | "loading" | "empty" | "error";
  objectives: string[];
  completed: boolean;
  score: number | null;
  onRetryRoleplay: () => void;
  onFinish: () => void;
  onClose: () => void;
}

const FeedbackStage: React.FC<FeedbackStageProps> = ({
  feedback,
  state,
  objectives,
  completed,
  score,
  onRetryRoleplay,
  onFinish,
  onClose,
}) => {
  const [retry, setRetry] = useState<Record<number, string>>({});
  return (
    <>
      {state === "loading"
        ? (
          <p className="flex items-center gap-2 text-slate-300">
            <Loader2 size={18} className="animate-spin" aria-hidden="true" /> Montando seus cartões da conversa…
          </p>
        )
        : null}
      {state === "error"
        ? <p className="text-rose-300">Não deu para montar os cartões agora. A trilha continua valendo.</p>
        : null}
      {state === "empty" && !feedback
        ? <p className="text-slate-300">Sem falas suficientes na conversa para montar cartões. Você pode tentar de novo.</p>
        : null}
      {feedback
        ? (
          <>
            <div className={panel}>
              <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">Objetivos da conversa</p>
              <ul className="mt-2 space-y-1.5">
                {objectives.map((objective, index) => (
                  <li key={objective} className="flex gap-2 text-sm">
                    {feedback.objectivesDone[index]
                      ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-label="feito" />
                      : <XCircle size={16} className="mt-0.5 shrink-0 text-slate-500" aria-label="ainda não" />}
                    <span className="text-slate-200">{objective}</span>
                  </li>
                ))}
              </ul>
            </div>
            {feedback.strengths.length
              ? (
                <div className={panel}>
                  <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">Você mandou bem</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-200">
                    {feedback.strengths.map((strength) => <li key={strength}>{strength}</li>)}
                  </ul>
                </div>
              )
              : null}
            {feedback.corrections.map((card, index) => {
              const attempt = retry[index] ?? "";
              const matches = attempt.trim().length > 3 &&
                attempt.toLowerCase().replace(/[^a-z' ]/g, "").trim() ===
                  card.correct.toLowerCase().replace(/[^a-z' ]/g, "").trim();
              return (
                <div className={`${panel} border-rose-400/20`} key={`${card.said}-${index}`}>
                  <p className="text-xs font-bold uppercase tracking-wider text-rose-300">
                    {card.onTopic ? "Erro do tema da aula" : "Para ajustar"}
                  </p>
                  <p className="mt-2 text-sm text-slate-400">Você disse</p>
                  <p className="text-rose-200 line-through decoration-rose-400/60">{card.said}</p>
                  <p className="mt-2 text-sm text-slate-400">Forma certa</p>
                  <p className="font-semibold text-emerald-200">{card.correct}</p>
                  {card.rulePt ? <p className="mt-2 text-sm text-slate-300">Regra: {card.rulePt}</p> : null}
                  {card.native ? <p className="mt-1 text-sm text-slate-300">Como um nativo diria: <em>{card.native}</em></p> : null}
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      className={input}
                      value={attempt}
                      placeholder="Regrave: fale (ditado do teclado) ou digite a forma certa"
                      onChange={(event) => setRetry((current) => ({ ...current, [index]: event.target.value }))}
                    />
                    <span className={`inline-flex items-center gap-1 text-sm font-bold ${matches ? "text-emerald-300" : "text-slate-500"}`}>
                      <RotateCcw size={14} aria-hidden="true" /> {matches ? "Isso!" : "Regravar"}
                    </span>
                  </div>
                </div>
              );
            })}
            {feedback.modelSentence
              ? (
                <div className={panel}>
                  <p className="text-xs font-bold uppercase tracking-wider text-emerald-300">Frase-modelo</p>
                  <p className="mt-2 text-lg text-white">{feedback.modelSentence}</p>
                </div>
              )
              : null}
            {feedback.priorityPt
              ? (
                <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-5 text-amber-50">
                  <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
                    <Sparkles size={14} aria-hidden="true" /> Uma prioridade para a próxima aula
                  </p>
                  <p className="mt-2">{feedback.priorityPt}</p>
                </div>
              )
              : null}
          </>
        )
        : null}

      <div className="mt-6 flex flex-wrap gap-3">
        {!completed
          ? (
            <button type="button" className={primary} onClick={onFinish}>
              Concluir trilha <CheckCircle2 size={16} aria-hidden="true" />
            </button>
          )
          : (
            <p className="w-full rounded-xl bg-emerald-400/10 p-4 text-emerald-100">
              Trilha concluída{score !== null && score >= 0 ? ` · nota ${score}` : ""}. Amanhã aparece a primeira revisão (3 min).
            </p>
          )}
        <button type="button" className={ghost} onClick={onRetryRoleplay}>
          <MessageCircle size={16} aria-hidden="true" /> {feedback ? "Conversar de novo" : "Fazer a conversa"}
        </button>
        {completed
          ? (
            <button type="button" className={ghost} onClick={onClose}>
              Voltar ao Wolfie
            </button>
          )
          : null}
      </div>
    </>
  );
};

export default WolfieLessonTrackSession;
