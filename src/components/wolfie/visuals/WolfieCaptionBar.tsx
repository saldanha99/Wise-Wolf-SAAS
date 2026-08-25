import React from "react";
import { AudioLines, Loader2, Mic2 } from "lucide-react";
import type { WolfieCharacterState } from "./WolfieCharacter";

export interface WolfieCaptionBarProps {
  text?: string;
  speaker?: string;
  language?: string;
  state?: WolfieCharacterState;
  placeholder?: string;
  isFinal?: boolean;
  announceFinal?: boolean;
  actions?: React.ReactNode;
  actionsLabel?: string;
  captionLabel?: string;
  variant?: "default" | "ugc";
  className?: string;
}

const EMPTY_STATE_COPY: Record<WolfieCharacterState, string> = {
  IDLE: "Pronto para conversar",
  LISTENING: "Estou ouvindo você…",
  THINKING: "Wolfie está organizando a resposta…",
  SYNTHESIZING: "Preparando a voz…",
  SPEAKING: "Wolfie está falando…",
  INTERRUPTED: "A fala foi interrompida",
  ERROR: "A resposta não ficou disponível",
};

const StateIcon = ({ state }: { state: WolfieCharacterState }) => {
  if (state === "LISTENING") return <Mic2 size={17} aria-hidden="true" />;
  if (state === "SPEAKING") return <AudioLines size={17} aria-hidden="true" />;
  if (state === "THINKING" || state === "SYNTHESIZING") {
    return <Loader2 size={17} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />;
  }
  return null;
};

/** Legenda estável: somente uma fala final é anunciada por leitor de tela. */
export function WolfieCaptionBar({
  text = "",
  speaker,
  language = "en",
  state = "IDLE",
  placeholder,
  isFinal = true,
  announceFinal = false,
  actions,
  actionsLabel = "Ações da legenda",
  captionLabel = "Legenda da conversa",
  variant = "default",
  className = "",
}: WolfieCaptionBarProps) {
  const normalizedText = text.trim();
  const visibleText = normalizedText || placeholder || EMPTY_STATE_COPY[state];
  const shouldAnnounce = Boolean(
    announceFinal && isFinal && normalizedText,
  );
  const isUgcVariant = variant === "ugc";

  return (
    <section
      aria-label={captionLabel}
      className={`w-full ${
        isUgcVariant ? "px-2 sm:px-4" : "px-3 sm:px-5 lg:px-7"
      } ${className}`}
      data-caption-final={isFinal ? "true" : "false"}
      data-caption-state={state}
      data-caption-variant={variant}
    >
      <div className={`mx-auto flex w-full flex-col gap-2 border border-white/12 bg-slate-950/78 shadow-2xl backdrop-blur-2xl sm:flex-row sm:items-center ${
        isUgcVariant
          ? "max-w-3xl rounded-[1.35rem] px-4 py-2.5 sm:gap-3 sm:px-5 sm:py-3"
          : "max-w-5xl rounded-2xl px-4 py-3 sm:gap-4 sm:px-5"
      }`}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-cyan-200">
            <StateIcon state={state} />
            <span className="truncate">{speaker || "Wolfie Tutor"}</span>
            {!isFinal && normalizedText
              ? (
                <span className="rounded-full bg-white/8 px-2 py-0.5 text-[9px] text-slate-300">
                  ao vivo
                </span>
              )
              : null}
          </div>
          <p
            className={`mt-1 overflow-y-auto whitespace-pre-wrap ${
              isUgcVariant
                ? "max-h-20 text-[15px] font-semibold leading-6 drop-shadow-lg sm:text-lg sm:leading-7"
                : "max-h-28 text-sm leading-6 sm:text-base sm:leading-7"
            } ${
              normalizedText ? "text-white" : "text-slate-400"
            }`}
            lang={normalizedText ? language : "pt-BR"}
            dir="auto"
            aria-live={shouldAnnounce ? "polite" : "off"}
            aria-atomic={shouldAnnounce ? "true" : undefined}
          >
            {visibleText}
          </p>
        </div>

        {actions
          ? (
            <div
              role="group"
              aria-label={actionsLabel}
              className="pointer-events-auto flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-t border-white/10 pt-2 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0"
              data-caption-slot="actions"
            >
              {actions}
            </div>
          )
          : null}
      </div>
    </section>
  );
}

export default WolfieCaptionBar;
