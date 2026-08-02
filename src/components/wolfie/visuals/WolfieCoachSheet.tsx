import React, {
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import {
  ArrowRight,
  BookOpenCheck,
  HelpCircle,
  MessageSquareQuote,
  MessagesSquare,
  Sparkles,
  Target,
} from "lucide-react";
import type { GlobalMeetingLearnerIntent } from "../../../../supabase/functions/_shared/wolfie-global-meeting-policy";
import type { MeetingVisualState } from "./visualStateResolver";

type CoachIntent = Exclude<GlobalMeetingLearnerIntent, "perform">;

export interface WolfieCoachSheetProps {
  state: MeetingVisualState;
  open?: boolean;
  children?: ReactNode;
  onResume?: () => void;
  resumeLabel?: string;
  resumeDisabled?: boolean;
  className?: string;
}

const intentCopy: Record<
  CoachIntent,
  { eyebrow: string; title: string; description: string; icon: typeof HelpCircle }
> = {
  ask_doubt: {
    eyebrow: "Pausa pedagógica",
    title: "Tire a dúvida e volte ao mesmo ponto",
    description:
      "O Wolfie responde de forma breve, pode propor uma microprática e preserva a reunião.",
    icon: HelpCircle,
  },
  clarify_intent: {
    eyebrow: "Clarificação neutra",
    title: "O que você quer esclarecer?",
    description:
      "Defina se a dúvida é sobre o inglês ou sobre o conteúdo da reunião antes de continuar.",
    icon: MessagesSquare,
  },
  request_review: {
    eyebrow: "Revisão em contexto",
    title: "Revise uma correção e reutilize-a",
    description:
      "Pratique um ponto anterior em um novo contexto antes de retomar a pergunta pendente.",
    icon: BookOpenCheck,
  },
  request_model: {
    eyebrow: "Modelos de linguagem",
    title: "Compare Good, Better e Executive",
    description:
      "Use os modelos como referência de significado e depois produza sua própria versão.",
    icon: MessageSquareQuote,
  },
  request_feedback: {
    eyebrow: "Feedback da rodada",
    title: "Observe a evidência e escolha uma prioridade",
    description:
      "O feedback cita a sua produção e devolve a ação para você antes da retomada.",
    icon: Sparkles,
  },
};

const fallbackCopy = {
  eyebrow: "Reunião pausada",
  title: "Checkpoint preservado",
  description:
    "O apoio não altera o interlocutor, a pergunta pendente nem a decisão em jogo.",
  icon: Target,
};

export function WolfieCoachSheet({
  state,
  open = state.showCoachSheet,
  children,
  onResume,
  resumeLabel = "Retomar reunião",
  resumeDisabled = false,
  className = "",
}: WolfieCoachSheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const priorFocusRef = useRef<HTMLElement | null>(null);
  const onResumeRef = useRef(onResume);
  const resumeDisabledRef = useRef(resumeDisabled);

  useEffect(() => {
    onResumeRef.current = onResume;
    resumeDisabledRef.current = resumeDisabled;
  }, [onResume, resumeDisabled]);

  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    headingRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" || !onResumeRef.current ||
        resumeDisabledRef.current
      ) return;
      event.preventDefault();
      onResumeRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      priorFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const copy = state.learnerIntent === "perform"
    ? fallbackCopy
    : intentCopy[state.learnerIntent];
  const Icon = copy.icon;

  return (
    <div
      className={`fixed inset-0 z-[230] flex items-end justify-center bg-slate-950/55 p-0 backdrop-blur-sm sm:items-center sm:p-5 ${className}`}
    >
      <div className="absolute inset-0" aria-hidden="true" />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-coach-intent={state.learnerIntent}
        className="relative max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-[2rem] border border-white/10 bg-slate-950 p-5 text-white shadow-[0_-24px_80px_rgba(2,6,23,.55)] sm:rounded-[2rem] sm:p-7"
      >
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-violet-300/20 bg-violet-400/10 text-violet-200">
            <Icon size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-violet-300">
              {copy.eyebrow}
            </p>
            <h2
              ref={headingRef}
              id={titleId}
              tabIndex={-1}
              className="mt-1 text-xl font-black outline-none sm:text-2xl"
            >
              {copy.title}
            </h2>
            <p
              id={descriptionId}
              className="mt-2 text-sm leading-6 text-slate-300"
            >
              {copy.description}
            </p>
          </div>
        </div>

        <dl className="mt-5 grid gap-2 rounded-2xl border border-white/10 bg-white/[0.045] p-4 sm:grid-cols-3">
          <div>
            <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Interlocutor
            </dt>
            <dd className="mt-1 text-xs font-semibold leading-5 text-slate-100">
              {state.counterpart ?? "Aguardando definição"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Pergunta preservada
            </dt>
            <dd className="mt-1 text-xs font-semibold leading-5 text-slate-100">
              {state.pendingQuestion ?? "Nenhuma pergunta pendente"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Decisão preservada
            </dt>
            <dd className="mt-1 text-xs font-semibold leading-5 text-slate-100">
              {state.pendingDecision ?? "Aguardando definição"}
            </dd>
          </div>
        </dl>

        {children && <div className="mt-5">{children}</div>}

        {onResume && (
          <div className="mt-6 flex justify-end">
            <button
              type="button"
              onClick={onResume}
              disabled={resumeDisabled}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-violet-500 px-5 py-3 text-sm font-black text-white shadow-lg transition hover:bg-violet-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              {resumeLabel}
              <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default WolfieCoachSheet;
