import React from "react";
import { Clock3, X } from "lucide-react";
import type { WolfieCharacterState } from "./WolfieCharacter";
import type { WolfieVisualSceneProfile } from "./types";

export interface WolfieSessionHUDProps {
  profile: WolfieVisualSceneProfile;
  state?: WolfieCharacterState;
  statusLabel?: string;
  elapsedSeconds?: number;
  level?: string;
  topic?: string;
  stageLabel?: string;
  modeLabel?: string;
  connectionLabel?: string;
  leading?: React.ReactNode;
  controls?: React.ReactNode;
  controlsLabel?: string;
  onClose?: () => void;
  closeLabel?: string;
  announceStatus?: boolean;
  className?: string;
}

const STATE_STATUS: Record<WolfieCharacterState, string> = {
  IDLE: "Pronto para conversar",
  LISTENING: "Ouvindo",
  THINKING: "Pensando",
  SYNTHESIZING: "Preparando a voz",
  SPEAKING: "Falando",
  INTERRUPTED: "Fala interrompida",
  ERROR: "Não foi possível responder",
};

const STATE_COLOR: Record<WolfieCharacterState, string> = {
  IDLE: "#818cf8",
  LISTENING: "#fb7185",
  THINKING: "#c084fc",
  SYNTHESIZING: "#fbbf24",
  SPEAKING: "#22d3ee",
  INTERRUPTED: "#cbd5e1",
  ERROR: "#f87171",
};

const formatElapsedTime = (seconds: number): string => {
  const safeSeconds = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds))
    : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${
    remainder.toString().padStart(2, "0")
  }`;
};

/** HUD compacto; informações secundárias desaparecem antes dos controles. */
export function WolfieSessionHUD({
  profile,
  state = "IDLE",
  statusLabel,
  elapsedSeconds,
  level,
  topic,
  stageLabel,
  modeLabel,
  connectionLabel,
  leading,
  controls,
  controlsLabel = "Controles da sessão",
  onClose,
  closeLabel = "Fechar Wolfie Tutor",
  announceStatus = false,
  className = "",
}: WolfieSessionHUDProps) {
  const visibleStatus = statusLabel || STATE_STATUS[state];
  const stateColor = STATE_COLOR[state] || profile.palette.accent;

  return (
    <header
      className={`pointer-events-none w-full px-3 pt-[max(.75rem,env(safe-area-inset-top))] sm:px-5 lg:px-7 ${className}`}
      aria-label="Informações da sessão Wolfie"
      data-session-state={state}
      data-hud-variant={profile.hudVariant}
      style={{ "--wolfie-hud-accent": profile.palette.accent } as React.CSSProperties}
    >
      <div className="mx-auto flex w-full max-w-7xl items-start gap-2 sm:gap-3">
        <div className="min-w-0 flex-1 rounded-2xl border border-white/12 bg-slate-950/68 px-3 py-2.5 shadow-2xl backdrop-blur-2xl sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            {leading
              ? (
                <div className="hidden shrink-0 sm:block" data-hud-slot="leading">
                  {leading}
                </div>
              )
              : null}

            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className="inline-flex min-w-0 items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-white sm:text-xs"
                  aria-live={announceStatus ? "polite" : "off"}
                  aria-atomic="true"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    aria-hidden="true"
                    style={{
                      backgroundColor: stateColor,
                      boxShadow: `0 0 14px ${stateColor}`,
                    }}
                  />
                  <span className="truncate">{visibleStatus}</span>
                </span>
                {connectionLabel
                  ? (
                    <span className="hidden rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-slate-300 md:inline-flex">
                      {connectionLabel}
                    </span>
                  )
                  : null}
              </div>

              {(topic || stageLabel)
                ? (
                  <div className="mt-1 flex min-w-0 items-center gap-2 text-[11px] text-slate-300 sm:text-xs">
                    {stageLabel
                      ? (
                        <strong className="shrink-0 text-cyan-200">
                          {stageLabel}
                        </strong>
                      )
                      : null}
                    {topic
                      ? (
                        <span
                          className="hidden min-w-0 truncate border-l border-white/10 pl-2 sm:block"
                          title={topic}
                        >
                          {topic}
                        </span>
                      )
                      : null}
                  </div>
                )
                : null}
            </div>

            <div className="flex shrink-0 items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-300">
              {elapsedSeconds !== undefined
                ? (
                  <span
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5"
                    aria-label={`Tempo de sessão ${formatElapsedTime(elapsedSeconds)}`}
                  >
                    <Clock3 size={12} aria-hidden="true" />
                    <span className="font-mono">
                      {formatElapsedTime(elapsedSeconds)}
                    </span>
                  </span>
                )
                : null}
              {level
                ? (
                  <span className="inline-flex min-h-8 items-center rounded-full border border-white/10 bg-white/5 px-2.5 text-cyan-100">
                    {level}
                  </span>
                )
                : null}
              {modeLabel
                ? (
                  <span className="hidden min-h-8 items-center rounded-full border border-white/10 bg-white/5 px-2.5 text-slate-200 lg:inline-flex">
                    {modeLabel}
                  </span>
                )
                : null}
            </div>
          </div>

          {controls
            ? (
              <div
                role="group"
                aria-label={controlsLabel}
                className="pointer-events-auto mt-2 flex min-h-11 flex-nowrap items-center gap-2 overflow-x-auto border-t border-white/10 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:flex-wrap sm:overflow-visible"
                data-hud-slot="controls"
              >
                {controls}
              </div>
            )
            : null}
        </div>

        {onClose
          ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={closeLabel}
              className="pointer-events-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/12 bg-slate-950/68 text-white shadow-xl backdrop-blur-2xl transition hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <X size={19} aria-hidden="true" />
            </button>
          )
          : null}
      </div>
    </header>
  );
}

export default WolfieSessionHUD;
