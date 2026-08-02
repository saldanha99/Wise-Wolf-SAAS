import React, { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { WolfieVisualSceneProfile } from "./types";

export const WOLFIE_CHARACTER_STATES = [
  "IDLE",
  "LISTENING",
  "THINKING",
  "SYNTHESIZING",
  "SPEAKING",
  "INTERRUPTED",
  "ERROR",
] as const;

export type WolfieCharacterState =
  (typeof WOLFIE_CHARACTER_STATES)[number];

export type WolfieCharacterStateImages = Partial<
  Record<WolfieCharacterState, string>
>;

export interface WolfieCharacterProps {
  profile: WolfieVisualSceneProfile;
  state?: WolfieCharacterState;
  inputLevel?: number;
  outputLevel?: number;
  imageSrc?: string;
  stateImages?: WolfieCharacterStateImages;
  fallbackImageSrc?: string | null;
  reducedMotion?: boolean;
  decorative?: boolean;
  accessibleLabel?: string;
  className?: string;
  onImageError?: (failedSource: string) => void;
}

export const DEFAULT_WOLFIE_CHARACTER_IMAGE =
  "/assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.webp";
export const LEGACY_WOLFIE_CHARACTER_IMAGE =
  "/assets/wolfie/wolfie-tutor-mascot.webp";

const STATE_LABELS: Record<WolfieCharacterState, string> = {
  IDLE: "pronto para conversar",
  LISTENING: "ouvindo",
  THINKING: "pensando",
  SYNTHESIZING: "preparando a voz",
  SPEAKING: "falando",
  INTERRUPTED: "fala interrompida",
  ERROR: "com dificuldade para responder",
};

const clampEnergy = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
};

const alignmentClass: Record<
  WolfieVisualSceneProfile["characterSide"],
  string
> = {
  left: "justify-start",
  right: "justify-end",
  center: "justify-center",
};

/**
 * Personagem em camada transparente, separado do cenário e da UI.
 *
 * Este componente não tenta aplicar os recortes faciais do avatar legado a
 * personagens arbitrários. Ele usa poses completas quando fornecidas e mantém
 * o bitmap antigo apenas como fallback funcional durante a migração.
 */
export function WolfieCharacter({
  profile,
  state = "IDLE",
  inputLevel = 0,
  outputLevel = 0,
  imageSrc = DEFAULT_WOLFIE_CHARACTER_IMAGE,
  stateImages,
  fallbackImageSrc = LEGACY_WOLFIE_CHARACTER_IMAGE,
  reducedMotion,
  decorative = true,
  accessibleLabel = "Wolfie, tutor virtual da Wise Wolf",
  className = "",
  onImageError,
}: WolfieCharacterProps) {
  const systemReducedMotion = useReducedMotion();
  const staticMode = reducedMotion ?? Boolean(systemReducedMotion);
  const inputEnergy = state === "LISTENING" ? clampEnergy(inputLevel) : 0;
  const outputEnergy = state === "SPEAKING" ? clampEnergy(outputLevel) : 0;
  const primarySource = stateImages?.[state] || imageSrc || "";
  const initialSource = primarySource || fallbackImageSrc || null;
  const [activeSource, setActiveSource] = useState<string | null>(initialSource);

  useEffect(() => {
    setActiveSource(primarySource || fallbackImageSrc || null);
  }, [fallbackImageSrc, primarySource]);

  const characterMotion = useMemo(() => {
    if (staticMode) {
      return {
        animate: { x: 0, y: 0, rotate: 0, scale: 1 },
        transition: { duration: 0 },
      };
    }

    switch (state) {
      case "LISTENING":
        return {
          animate: {
            x: profile.characterSide === "right" ? -3 : 3,
            y: -2 - inputEnergy * 3,
            rotate: profile.characterSide === "right" ? -0.8 : 0.8,
            scale: 1 + inputEnergy * 0.018,
          },
          transition: { type: "spring" as const, stiffness: 150, damping: 20 },
        };
      case "THINKING":
        return {
          animate: { y: [0, -4, 0], rotate: [0, 0.7, 0], scale: 1 },
          transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" },
        };
      case "SYNTHESIZING":
        return {
          animate: { y: [0, -2, 0], scale: [1, 1.012, 1] },
          transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
        };
      case "SPEAKING":
        return {
          animate: {
            y: -1 - outputEnergy * 2.5,
            rotate: (profile.characterSide === "right" ? -1 : 1) *
              outputEnergy * 0.35,
            scale: 1 + outputEnergy * 0.012,
          },
          transition: { duration: 0.08, ease: "linear" },
        };
      case "INTERRUPTED":
        return {
          animate: { x: [0, -5, 4, 0], y: [0, -2, 0], rotate: [0, -0.8, 0.6, 0] },
          transition: { duration: 0.48, ease: "easeOut" },
        };
      case "ERROR":
        return {
          animate: { y: [2, 4, 2], scale: 0.995 },
          transition: { duration: 3.4, repeat: Infinity, ease: "easeInOut" },
        };
      case "IDLE":
      default:
        return {
          animate: { y: [0, -4, 0], rotate: [-0.2, 0.2, -0.2], scale: 1 },
          transition: { duration: 5.6, repeat: Infinity, ease: "easeInOut" },
        };
    }
  }, [inputEnergy, outputEnergy, profile.characterSide, state, staticMode]);

  const handleImageError = () => {
    if (!activeSource) return;
    onImageError?.(activeSource);
    if (
      fallbackImageSrc &&
      activeSource !== fallbackImageSrc
    ) {
      setActiveSource(fallbackImageSrc);
      return;
    }
    setActiveSource(null);
  };

  const stateLabel = STATE_LABELS[state];
  const announcedLabel = `${accessibleLabel}: ${stateLabel}.`;

  return (
    <div
      className={`pointer-events-none relative flex h-full w-full select-none items-end overflow-visible ${alignmentClass[profile.characterSide]} ${className}`}
      data-character-side={profile.characterSide}
      data-character-state={state}
      data-input-level={inputEnergy.toFixed(3)}
      data-output-level={outputEnergy.toFixed(3)}
      data-motion={staticMode ? "static" : "dynamic"}
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : announcedLabel}
    >
      <motion.div
        aria-hidden="true"
        className="absolute bottom-[8%] h-[58%] w-[58%] rounded-full blur-[72px]"
        animate={staticMode
          ? { opacity: 0.26, scale: 1 }
          : {
            opacity: state === "SPEAKING"
              ? 0.3 + outputEnergy * 0.28
              : state === "LISTENING"
              ? 0.28 + inputEnergy * 0.2
              : [0.22, 0.34, 0.22],
            scale: state === "SPEAKING"
              ? 1 + outputEnergy * 0.06
              : [0.98, 1.03, 0.98],
          }}
        transition={staticMode
          ? { duration: 0 }
          : state === "SPEAKING" || state === "LISTENING"
          ? { duration: 0.1, ease: "linear" }
          : { duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
        style={{ background: profile.palette.glow }}
      />

      <motion.div
        className="relative flex h-full max-w-[88%] items-end justify-center sm:max-w-[76%] lg:max-w-[68%]"
        animate={characterMotion.animate}
        transition={characterMotion.transition}
        style={{
          transformOrigin: "50% 92%",
          filter: state === "ERROR"
            ? "grayscale(.28) saturate(.72) brightness(.84)"
            : "drop-shadow(0 28px 36px rgba(2, 6, 23, .38))",
        }}
      >
        {activeSource
          ? (
            <img
              src={activeSource}
              alt=""
              draggable={false}
              decoding="async"
              onError={handleImageError}
              className="max-h-full w-auto max-w-full object-contain object-bottom"
            />
          )
          : (
            <div
              className="mb-[12%] grid min-h-36 min-w-36 place-items-center rounded-full border border-white/15 bg-slate-950/55 text-center text-white shadow-2xl backdrop-blur-xl"
              data-character-fallback="symbol"
            >
              <div>
                <span className="block text-6xl" aria-hidden="true">🐺</span>
                <span className="mt-2 block text-xs font-black uppercase tracking-wider">
                  Wolfie
                </span>
              </div>
            </div>
          )}
      </motion.div>
    </div>
  );
}

export default WolfieCharacter;
