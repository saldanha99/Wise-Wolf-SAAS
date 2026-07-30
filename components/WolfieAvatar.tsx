import React, { useMemo, useState } from "react";
import {
  motion,
  type MotionProps,
  useReducedMotion,
} from "framer-motion";

export type WolfieAvatarState =
  | "IDLE"
  | "LISTENING"
  | "THINKING"
  | "SYNTHESIZING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "ERROR";

export interface WolfieAvatarProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "state"> {
  state?: WolfieAvatarState;
  /**
   * RMS/energia normalizada do microfone, entre 0 e 1.
   * É usada somente no estado LISTENING.
   */
  inputLevel?: number;
  /**
   * RMS/energia normalizada do áudio que está sendo reproduzido, entre 0 e 1.
   * É a única fonte que abre a boca no estado SPEAKING.
   */
  outputLevel?: number;
  imageSrc?: string;
  accessibleLabel?: string;
  showStatus?: boolean;
  forceStatic?: boolean;
}

interface CroppedImageProps {
  src: string;
  left: number;
  top: number;
  width: number;
  height: number;
  className?: string;
  style?: React.CSSProperties;
}

const DEFAULT_IMAGE_SRC = "/assets/wolfie/wolfie-tutor-mascot.webp";
const AVATAR_STATES = new Set<WolfieAvatarState>([
  "IDLE",
  "LISTENING",
  "THINKING",
  "SYNTHESIZING",
  "SPEAKING",
  "INTERRUPTED",
  "ERROR",
]);

const STATE_COPY: Record<
  WolfieAvatarState,
  { label: string; color: string; glow: string }
> = {
  IDLE: {
    label: "pronto para conversar",
    color: "#818cf8",
    glow: "rgba(99, 102, 241, 0.30)",
  },
  LISTENING: {
    label: "ouvindo",
    color: "#fb7185",
    glow: "rgba(244, 63, 94, 0.34)",
  },
  THINKING: {
    label: "pensando",
    color: "#c084fc",
    glow: "rgba(168, 85, 247, 0.34)",
  },
  SYNTHESIZING: {
    label: "preparando a voz",
    color: "#fbbf24",
    glow: "rgba(245, 158, 11, 0.32)",
  },
  SPEAKING: {
    label: "falando",
    color: "#22d3ee",
    glow: "rgba(6, 182, 212, 0.34)",
  },
  INTERRUPTED: {
    label: "fala interrompida",
    color: "#94a3b8",
    glow: "rgba(148, 163, 184, 0.26)",
  },
  ERROR: {
    label: "com dificuldade para responder",
    color: "#f87171",
    glow: "rgba(239, 68, 68, 0.34)",
  },
};

function clampLevel(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeAvatarState(value: unknown): WolfieAvatarState {
  return typeof value === "string" &&
      AVATAR_STATES.has(value as WolfieAvatarState)
    ? value as WolfieAvatarState
    : "IDLE";
}

function imageMotion(
  state: WolfieAvatarState,
  inputEnergy: number,
  outputEnergy: number,
  staticMode: boolean,
): Pick<MotionProps, "animate" | "transition"> {
  if (staticMode) {
    return {
      animate: { x: 0, y: 0, rotate: 0, scale: 1 },
      transition: { duration: 0 },
    };
  }

  switch (state) {
    case "IDLE":
      return {
        animate: {
          y: [0, -3, 0],
          rotate: [-0.35, 0.35, -0.35],
          scale: [1.012, 1.019, 1.012],
        },
        transition: {
          duration: 5.4,
          ease: "easeInOut",
          repeat: Infinity,
        },
      };
    case "LISTENING":
      return {
        animate: {
          x: -2,
          y: -2 - inputEnergy * 2,
          rotate: -1.2,
          scale: 1.018 + inputEnergy * 0.012,
        },
        transition: { type: "spring", stiffness: 180, damping: 20 },
      };
    case "THINKING":
      return {
        animate: {
          x: [0, 3, 0],
          y: [0, -3, 0],
          rotate: [0.5, 1.4, 0.5],
          scale: 1.016,
        },
        transition: {
          duration: 2.8,
          ease: "easeInOut",
          repeat: Infinity,
        },
      };
    case "SYNTHESIZING":
      return {
        animate: {
          y: [0, -2, 0],
          rotate: [-0.3, 0.3, -0.3],
          scale: [1.012, 1.022, 1.012],
        },
        transition: {
          duration: 1.15,
          ease: "easeInOut",
          repeat: Infinity,
        },
      };
    case "SPEAKING":
      return {
        animate: {
          x: outputEnergy * 0.8,
          y: -outputEnergy * 2.2,
          rotate: outputEnergy * 0.45,
          scale: 1.014 + outputEnergy * 0.008,
        },
        transition: { duration: 0.075, ease: "linear" },
      };
    case "INTERRUPTED":
      return {
        animate: {
          x: [0, -5, 4, -2, 0],
          y: [0, -2, 0],
          rotate: [0, -1.2, 1, 0],
          scale: [1.014, 1.022, 1.014],
        },
        transition: { duration: 0.48, ease: "easeOut" },
      };
    case "ERROR":
      return {
        animate: {
          y: [2, 4, 2],
          rotate: [-0.5, 0.5, -0.5],
          scale: 1.006,
        },
        transition: {
          duration: 3.2,
          ease: "easeInOut",
          repeat: Infinity,
        },
      };
  }
}

/**
 * Reutiliza uma região do PNG achatado como overlay mascarado.
 * Isso permite pequenos movimentos locais sem fingir que o asset já possui rig.
 */
function CroppedImage({
  src,
  left,
  top,
  width,
  height,
  className,
  style,
}: CroppedImageProps) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        position: "absolute",
        left: `${left}%`,
        top: `${top}%`,
        width: `${width}%`,
        height: `${height}%`,
        overflow: "hidden",
        pointerEvents: "none",
        ...style,
      }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          left: `${-(left / width) * 100}%`,
          top: `${-(top / height) * 100}%`,
          width: `${(100 / width) * 100}%`,
          height: `${(100 / height) * 100}%`,
          maxWidth: "none",
          userSelect: "none",
        }}
      />
    </div>
  );
}

export const WolfieAvatar: React.FC<WolfieAvatarProps> = ({
  state = "IDLE",
  inputLevel = 0,
  outputLevel = 0,
  imageSrc = DEFAULT_IMAGE_SRC,
  accessibleLabel = "Wolfie, tutor virtual da Wise Wolf",
  showStatus = false,
  forceStatic = false,
  className = "",
  style,
  ...rest
}) => {
  const reduceMotion = useReducedMotion();
  const [imageFailed, setImageFailed] = useState(false);
  const avatarState = normalizeAvatarState(state);
  const staticMode = forceStatic || Boolean(reduceMotion);
  const inputEnergy = avatarState === "LISTENING"
    ? Math.pow(clampLevel(inputLevel), 0.72)
    : 0;
  const outputEnergy = avatarState === "SPEAKING"
    ? Math.pow(clampLevel(outputLevel), 0.72)
    : 0;
  const stateCopy = STATE_COPY[avatarState];
  const avatarMotion = useMemo(
    () => imageMotion(avatarState, inputEnergy, outputEnergy, staticMode),
    [avatarState, inputEnergy, outputEnergy, staticMode],
  );

  const leftEarRotation = staticMode
    ? 0
    : avatarState === "LISTENING"
    ? -2.5 - inputEnergy * 3
    : avatarState === "INTERRUPTED"
    ? -5
    : avatarState === "ERROR"
    ? 2
    : -0.8;
  const rightEarRotation = staticMode
    ? 0
    : avatarState === "LISTENING"
    ? 2.5 + inputEnergy * 3
    : avatarState === "INTERRUPTED"
    ? 5
    : avatarState === "ERROR"
    ? -2
    : 0.8;
  const mouthHeight = staticMode ? 0.55 : 0.55 + outputEnergy * 3.8;
  const mouthWidthScale = staticMode ? 0.94 : 0.94 + outputEnergy * 0.11;
  const announcedLabel = `${accessibleLabel}: ${stateCopy.label}.`;

  return (
    <div
      {...rest}
      role="img"
      aria-label={announcedLabel}
      data-state={avatarState}
      data-input-level={inputEnergy.toFixed(3)}
      data-output-level={outputEnergy.toFixed(3)}
      className={`relative isolate aspect-square overflow-hidden rounded-[2rem] bg-[#111315] ${className}`}
      style={{
        boxShadow: `0 28px 80px ${stateCopy.glow}`,
        ...style,
      }}
    >
      <span className="sr-only" aria-live="polite">
        {announcedLabel}
      </span>

      <motion.div
        aria-hidden="true"
        className="absolute inset-[8%] rounded-full blur-3xl"
        animate={staticMode
          ? { opacity: 0.22, scale: 1 }
          : {
            opacity: avatarState === "SPEAKING"
              ? 0.28 + outputEnergy * 0.32
              : avatarState === "LISTENING"
              ? 0.24 + inputEnergy * 0.22
              : [0.2, 0.32, 0.2],
            scale: avatarState === "SPEAKING"
              ? 0.98 + outputEnergy * 0.08
              : [0.98, 1.04, 0.98],
          }}
        transition={staticMode
          ? { duration: 0 }
          : avatarState === "SPEAKING" || avatarState === "LISTENING"
          ? { duration: 0.09, ease: "linear" }
          : { duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        style={{
          background: `radial-gradient(circle, ${stateCopy.glow}, transparent 68%)`,
        }}
      />

      {imageFailed
        ? (
          <div className="absolute inset-0 grid place-items-center bg-gradient-to-b from-slate-800 to-slate-950 text-center text-white">
            <div>
              <div className="text-7xl" aria-hidden="true">🐺</div>
              <p className="mt-3 text-sm font-semibold">Wolfie</p>
              <p className="mt-1 text-xs text-slate-300">{stateCopy.label}</p>
            </div>
          </div>
        )
        : (
          <motion.div
            aria-hidden="true"
            className="absolute inset-0"
            animate={avatarMotion.animate}
            transition={avatarMotion.transition}
            style={{
              transformOrigin: "50% 78%",
              filter: avatarState === "ERROR"
                ? "grayscale(0.28) saturate(0.72) brightness(0.82)"
                : "none",
            }}
          >
            <img
              src={imageSrc}
              alt=""
              draggable={false}
              onError={() => setImageFailed(true)}
              className="absolute inset-0 h-full w-full select-none object-cover"
            />

            <motion.div
              className="absolute inset-0"
              animate={{ rotate: leftEarRotation }}
              transition={{ duration: 0.11, ease: "easeOut" }}
              style={{ transformOrigin: "40% 34%" }}
            >
              <CroppedImage
                src={imageSrc}
                left={18}
                top={0}
                width={29}
                height={38}
                style={{
                  WebkitMaskImage:
                    "radial-gradient(ellipse 72% 85% at 58% 55%, #000 58%, transparent 100%)",
                  maskImage:
                    "radial-gradient(ellipse 72% 85% at 58% 55%, #000 58%, transparent 100%)",
                }}
              />
            </motion.div>

            <motion.div
              className="absolute inset-0"
              animate={{ rotate: rightEarRotation }}
              transition={{ duration: 0.11, ease: "easeOut" }}
              style={{ transformOrigin: "65% 34%" }}
            >
              <CroppedImage
                src={imageSrc}
                left={60}
                top={1}
                width={25}
                height={38}
                style={{
                  WebkitMaskImage:
                    "radial-gradient(ellipse 72% 85% at 42% 55%, #000 58%, transparent 100%)",
                  maskImage:
                    "radial-gradient(ellipse 72% 85% at 42% 55%, #000 58%, transparent 100%)",
                }}
              />
            </motion.div>

            {!staticMode && (
              <>
                <motion.div
                  className="absolute left-[35.2%] top-[33.7%] h-[8.2%] w-[13.3%] rounded-[50%] bg-gradient-to-b from-[#75624f] via-[#4b392d] to-[#1d1714]"
                  animate={{ scaleY: [0, 0, 1, 0, 0] }}
                  transition={{
                    duration: 5.6,
                    times: [0, 0.84, 0.865, 0.89, 1],
                    repeat: Infinity,
                    repeatDelay: 0.7,
                  }}
                  style={{ transformOrigin: "50% 15%", opacity: 0.94 }}
                />
                <motion.div
                  className="absolute left-[53.7%] top-[34%] h-[8.2%] w-[13.3%] rounded-[50%] bg-gradient-to-b from-[#75624f] via-[#4b392d] to-[#1d1714]"
                  animate={{ scaleY: [0, 0, 1, 0, 0] }}
                  transition={{
                    duration: 5.6,
                    times: [0, 0.84, 0.865, 0.89, 1],
                    repeat: Infinity,
                    repeatDelay: 0.7,
                  }}
                  style={{ transformOrigin: "50% 15%", opacity: 0.94 }}
                />
              </>
            )}

            <motion.div
              className="absolute inset-0"
              animate={staticMode
                ? { y: 0, scaleY: 1 }
                : {
                  y: outputEnergy * 1.8,
                  scaleY: 1 + outputEnergy * 0.07,
                }}
              transition={{ duration: staticMode ? 0 : 0.065, ease: "linear" }}
              style={{ transformOrigin: "50% 47%" }}
            >
              <CroppedImage
                src={imageSrc}
                left={38.5}
                top={48}
                width={23}
                height={14}
                style={{
                  WebkitMaskImage:
                    "radial-gradient(ellipse 62% 62% at 50% 52%, #000 52%, transparent 100%)",
                  maskImage:
                    "radial-gradient(ellipse 62% 62% at 50% 52%, #000 52%, transparent 100%)",
                }}
              />
            </motion.div>

            <motion.div
              className="absolute left-[44%] top-[56.2%] w-[12%] -translate-x-0 rounded-[50%] bg-gradient-to-b from-[#160c09] via-[#090505] to-[#32130f] shadow-[inset_0_1px_3px_rgba(255,255,255,0.08)]"
              animate={{
                height: `${mouthHeight}%`,
                scaleX: mouthWidthScale,
                opacity: outputEnergy > 0.015 ? 0.98 : 0.34,
              }}
              transition={{ duration: staticMode ? 0 : 0.055, ease: "linear" }}
              style={{ transformOrigin: "50% 0%" }}
            >
              {outputEnergy > 0.42 && !staticMode && (
                <div className="absolute bottom-[12%] left-[31%] h-[22%] w-[38%] rounded-full bg-[#9f4b4b]/70" />
              )}
            </motion.div>
          </motion.div>
        )}

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-white/10"
      />

      {showStatus && (
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-slate-950/72 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-white shadow-xl backdrop-blur-md">
          <motion.span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            animate={staticMode
              ? { opacity: 0.8, scale: 1 }
              : { opacity: [0.55, 1, 0.55], scale: [0.88, 1.12, 0.88] }}
            transition={staticMode
              ? { duration: 0 }
              : { duration: 1.35, repeat: Infinity, ease: "easeInOut" }}
            style={{
              backgroundColor: stateCopy.color,
              boxShadow: `0 0 14px ${stateCopy.color}`,
            }}
          />
          {stateCopy.label}
        </div>
      )}
    </div>
  );
};

export default WolfieAvatar;
