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

export type WolfieCharacterFraming = "full" | "ugc";

export interface WolfieCharacterProps {
  profile: WolfieVisualSceneProfile;
  state?: WolfieCharacterState;
  inputLevel?: number;
  outputLevel?: number;
  imageSrc?: string;
  speakingMouthSrc?: string | null;
  stateImages?: WolfieCharacterStateImages;
  fallbackImageSrc?: string | null;
  framing?: WolfieCharacterFraming;
  reducedMotion?: boolean;
  decorative?: boolean;
  accessibleLabel?: string;
  className?: string;
  onImageError?: (failedSource: string) => void;
}

export const DEFAULT_WOLFIE_CHARACTER_IMAGE =
  "/assets/wolfie/characters/wolfie-coach/wolfie-v2-listening.07cf0629cc2d.webp";
export const DEFAULT_WOLFIE_SPEAKING_MOUTH_IMAGE =
  "/assets/wolfie/characters/wolfie-coach/wolfie-v2-speaking.b3384896f5ef.webp";
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

const ugcCropClass: Record<WolfieVisualSceneProfile["camera"], string> = {
  close: "h-[172%] sm:h-[180%] lg:h-[188%]",
  medium: "h-[162%] sm:h-[170%] lg:h-[178%]",
  wide: "h-[152%] sm:h-[160%] lg:h-[168%]",
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
  speakingMouthSrc = DEFAULT_WOLFIE_SPEAKING_MOUTH_IMAGE,
  stateImages,
  fallbackImageSrc = LEGACY_WOLFIE_CHARACTER_IMAGE,
  framing = "full",
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
  const [mouthAvailable, setMouthAvailable] = useState(Boolean(speakingMouthSrc));
  const [hasMeasuredOutput, setHasMeasuredOutput] = useState(false);

  useEffect(() => {
    setActiveSource(primarySource || fallbackImageSrc || null);
  }, [fallbackImageSrc, primarySource]);

  useEffect(() => {
    setMouthAvailable(Boolean(speakingMouthSrc));
  }, [speakingMouthSrc]);

  useEffect(() => {
    if (state !== "SPEAKING") {
      setHasMeasuredOutput(false);
      return;
    }
    if (outputEnergy >= 0.015) setHasMeasuredOutput(true);
  }, [outputEnergy, state]);

  const mouthOpenness = hasMeasuredOutput
    ? clampEnergy(outputEnergy * 5.2)
    : 0;
  const canAnimateMouth = Boolean(
    speakingMouthSrc &&
      mouthAvailable &&
      activeSource === DEFAULT_WOLFIE_CHARACTER_IMAGE,
  );
  const lipSyncMode = staticMode || state !== "SPEAKING" || !canAnimateMouth
    ? "off"
    : hasMeasuredOutput
    ? "audio"
    : "fallback";

  const mouthMotion = useMemo(() => {
    if (lipSyncMode === "off") {
      return {
        animate: { opacity: 0 },
        transition: { duration: 0.08 },
      };
    }
    if (lipSyncMode === "audio") {
      return {
        animate: { opacity: mouthOpenness },
        transition: { duration: 0.055, ease: "linear" as const },
      };
    }
    return {
      animate: { opacity: [0.06, 0.7, 0.2, 0.88, 0.12, 0.62, 0.04] },
      transition: {
        duration: 1.04,
        repeat: Infinity,
        ease: "easeInOut" as const,
        times: [0, 0.15, 0.3, 0.5, 0.66, 0.82, 1],
      },
    };
  }, [lipSyncMode, mouthOpenness]);

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
            x: profile.characterSide === "right" ? -5 : 5,
            y: -4 - inputEnergy * 7,
            rotate: profile.characterSide === "right" ? -1.25 : 1.25,
            scale: 1.006 + inputEnergy * 0.026,
          },
          transition: { type: "spring" as const, stiffness: 135, damping: 18 },
        };
      case "THINKING":
        return {
          animate: { x: [0, 2, 0], y: [0, -8, 0], rotate: [0, 1.2, 0], scale: 1 },
          transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" },
        };
      case "SYNTHESIZING":
        return {
          animate: { y: [0, -5, 0], scale: [1, 1.02, 1] },
          transition: { duration: 1.4, repeat: Infinity, ease: "easeInOut" },
        };
      case "SPEAKING":
        return {
          animate: {
            x: (profile.characterSide === "right" ? -1 : 1) *
              (1.5 + outputEnergy * 2.5),
            y: -2 - outputEnergy * 6,
            rotate: (profile.characterSide === "right" ? -1 : 1) *
              (0.3 + outputEnergy * 0.8),
            scale: 1.008 + outputEnergy * 0.026,
          },
          transition: { duration: 0.075, ease: "linear" },
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
          animate: {
            x: [0, 1.5, 0],
            y: [0, -8, 0],
            rotate: [-0.45, 0.45, -0.45],
            scale: [1, 1.008, 1],
          },
          transition: { duration: 4.8, repeat: Infinity, ease: "easeInOut" },
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
  const isUgcFraming = framing === "ugc";

  return (
    <div
      className={`pointer-events-none relative flex h-full w-full select-none ${
        isUgcFraming
          ? "items-start justify-center overflow-hidden"
          : `items-end overflow-visible ${alignmentClass[profile.characterSide]}`
      } ${className}`}
      data-character-side={profile.characterSide}
      data-character-state={state}
      data-character-camera={profile.camera}
      data-character-framing={framing}
      data-input-level={inputEnergy.toFixed(3)}
      data-output-level={outputEnergy.toFixed(3)}
      data-motion={staticMode ? "static" : "dynamic"}
      data-lip-sync={lipSyncMode}
      data-mouth-openness={mouthOpenness.toFixed(3)}
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : announcedLabel}
    >
      <motion.div
        aria-hidden="true"
        className={`absolute rounded-full blur-[72px] ${
          isUgcFraming
            ? "left-1/2 top-[8%] h-[62%] w-[58%] -translate-x-1/2"
            : "bottom-[8%] h-[58%] w-[58%]"
        }`}
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
        className={`relative flex h-full items-start justify-center ${
          isUgcFraming
            ? "w-full max-w-none overflow-hidden"
            : "max-w-[88%] items-end sm:max-w-[76%] lg:max-w-[68%]"
        }`}
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
            <div
              className={`relative flex shrink-0 items-start justify-center ${
                isUgcFraming
                  ? `${ugcCropClass[profile.camera]} max-w-none`
                  : "h-full max-w-full items-end"
              }`}
              data-character-layer="crop"
            >
              <img
                src={activeSource}
                alt=""
                draggable={false}
                decoding="async"
                onError={handleImageError}
                data-character-layer="base"
                className={`h-full w-auto object-contain ${
                  isUgcFraming
                    ? "max-w-none object-top"
                    : "max-h-full max-w-full object-bottom"
                }`}
              />
              {canAnimateMouth && speakingMouthSrc
                ? (
                  <motion.img
                    src={speakingMouthSrc}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                    decoding="async"
                    loading="eager"
                    initial={false}
                    animate={mouthMotion.animate}
                    transition={mouthMotion.transition}
                    onError={() => {
                      setMouthAvailable(false);
                      onImageError?.(speakingMouthSrc);
                    }}
                    data-character-layer="mouth"
                    className={`absolute inset-0 h-full w-full object-contain ${
                      isUgcFraming ? "object-top" : "object-bottom"
                    }`}
                  />
                )
                : null}
            </div>
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
