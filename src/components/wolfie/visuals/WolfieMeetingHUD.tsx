import React from "react";
import {
  CheckCircle2,
  CirclePause,
  HelpCircle,
  RotateCcw,
  Scale,
  UserRound,
  Video,
} from "lucide-react";
import type {
  MeetingScenarioStatus,
  MeetingVisualState,
} from "./visualStateResolver";

export interface WolfieMeetingHUDProps {
  state: MeetingVisualState;
  compact?: boolean;
  className?: string;
}

const statusStyles: Record<MeetingScenarioStatus, string> = {
  active: "border-cyan-300/30 bg-cyan-400/10 text-cyan-100",
  paused: "border-violet-300/30 bg-violet-400/10 text-violet-100",
  awaiting_retry: "border-amber-300/35 bg-amber-400/10 text-amber-100",
  completed:
    "border-emerald-300/30 bg-emerald-400/10 text-emerald-100",
};

const checkpointItems = (
  state: MeetingVisualState,
): Array<{
  label: string;
  value: string;
  icon: typeof UserRound;
}> => [
  {
    label: "Interlocutor ativo",
    value: state.counterpart ?? "Aguardando definição do interlocutor",
    icon: UserRound,
  },
  {
    label: "Pergunta pendente",
    value: state.pendingQuestion ?? "Nenhuma pergunta pendente",
    icon: HelpCircle,
  },
  {
    label: "Decisão em jogo",
    value: state.pendingDecision ?? "Aguardando definição da decisão",
    icon: Scale,
  },
];

function StatusIcon({ status }: { status: MeetingScenarioStatus }) {
  if (status === "paused") return <CirclePause size={16} aria-hidden="true" />;
  if (status === "awaiting_retry") {
    return <RotateCcw size={16} aria-hidden="true" />;
  }
  if (status === "completed") {
    return <CheckCircle2 size={16} aria-hidden="true" />;
  }
  return <Video size={16} aria-hidden="true" />;
}

export function WolfieMeetingHUD({
  state,
  compact = false,
  className = "",
}: WolfieMeetingHUDProps) {
  return (
    <section
      aria-label="Estado da reunião global"
      data-meeting-status={state.scenarioStatus}
      data-meeting-stage={state.stage}
      className={`rounded-3xl border border-white/10 bg-slate-950/80 p-4 text-white shadow-2xl backdrop-blur-2xl ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
            {state.stageMeta.eyebrow}
          </p>
          <h2 className="mt-1 text-lg font-black text-white">
            {state.stageMeta.label}
          </h2>
          {!compact && (
            <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-300">
              {state.stageMeta.description}
            </p>
          )}
        </div>

        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 py-2 text-[10px] font-black uppercase tracking-wider ${statusStyles[state.scenarioStatus]}`}
        >
          <StatusIcon status={state.scenarioStatus} />
          {state.statusLabel}
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          <span>
            Etapa {state.stageIndex + 1} de {state.stageCount}
          </span>
          <span>{state.progressValue}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="Progresso da reunião global"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.progressValue}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
        >
          <div
            className="h-full rounded-full bg-cyan-300 transition-[width] motion-reduce:transition-none"
            style={{ width: `${state.progressValue}%` }}
          />
        </div>
      </div>

      <dl className={`mt-4 grid gap-2 ${compact ? "" : "md:grid-cols-3"}`}>
        {checkpointItems(state).map((item) => {
          const Icon = item.icon;
          return (
            <div
              key={item.label}
              className="rounded-2xl border border-white/10 bg-white/[0.045] p-3"
            >
              <dt className="flex items-center gap-2 text-[10px] font-black uppercase tracking-wider text-slate-400">
                <Icon size={14} className="text-cyan-300" aria-hidden="true" />
                {item.label}
              </dt>
              <dd className="mt-2 text-sm font-semibold leading-5 text-slate-100">
                {item.value}
              </dd>
            </div>
          );
        })}
      </dl>

      {state.scenarioStatus !== "active" && !compact && (
        <p className="mt-3 rounded-xl bg-white/[0.045] px-3 py-2 text-xs leading-5 text-slate-300">
          {state.statusDescription}
        </p>
      )}
    </section>
  );
}

export default WolfieMeetingHUD;
