import { AnimatePresence, m, useReducedMotion } from "framer-motion";
import { Headphones, Mic2, Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  WolfieCharacter,
  type WolfieCharacterState,
} from "../../../../../src/components/wolfie/visuals/WolfieCharacter";
import type { WolfieVisualSceneProfile } from "../../../../../src/components/wolfie/visuals/types";

const DEMO_PROFILE: WolfieVisualSceneProfile = {
  version: 1,
  key: "landing:global-meeting-demo",
  experienceId: "meetings-technology",
  universeId: "global-meetings",
  layout: "meeting",
  environmentId: "global-meeting-room",
  environmentDescription: "Sala contemporânea preparada para uma reunião global.",
  castIds: ["wolfie-coach"],
  camera: "medium",
  characterSide: "right",
  palette: {
    accent: "#ff725f",
    glow: "rgba(255, 114, 95, .32)",
    scrim: "rgba(7, 12, 22, .3)",
    gradient: "linear-gradient(145deg, #111827 0%, #26394f 52%, #8d554b 100%)",
  },
  hudVariant: "meeting",
  accessibleEnvironmentLabel: "Sala de reunião global com o Wolfie em primeiro plano.",
};

const SPEECH_PATTERN = [
  0.04, 0.13, 0.08, 0.17, 0.06, 0.12, 0.19, 0.09, 0.15, 0.05, 0.18, 0.1,
  0.07, 0.16, 0.11, 0.2, 0.06, 0.14,
] as const;

type DemoMode = Extract<WolfieCharacterState, "LISTENING" | "SPEAKING">;

function AnimatedWolfie({
  visible,
  mode,
  reducedMotion,
}: {
  visible: boolean;
  mode: DemoMode;
  reducedMotion: boolean;
}) {
  const [outputLevel, setOutputLevel] = useState(0);

  useEffect(() => {
    if (!visible || reducedMotion || mode !== "SPEAKING") {
      setOutputLevel(0);
      return;
    }

    let index = 0;
    setOutputLevel(SPEECH_PATTERN[index]);
    const timer = window.setInterval(() => {
      index = (index + 1) % SPEECH_PATTERN.length;
      setOutputLevel(SPEECH_PATTERN[index]);
    }, 95);
    return () => window.clearInterval(timer);
  }, [mode, reducedMotion, visible]);

  if (!visible) return null;

  return (
    <WolfieCharacter
      profile={DEMO_PROFILE}
      state={mode}
      inputLevel={mode === "LISTENING" ? 0.24 : 0}
      outputLevel={outputLevel}
      reducedMotion={reducedMotion}
      decorative={false}
      accessibleLabel="Wolfie na demonstração da landing page"
      className="px-2 sm:px-8"
    />
  );
}

const modeCopy: Record<DemoMode, {
  eyebrow: string;
  title: string;
  message: string;
}> = {
  LISTENING: {
    eyebrow: "Wolfie está ouvindo",
    title: "Conte primeiro o que precisa acontecer.",
    message: "Tenho de explicar um atraso sem parecer defensivo na reunião de amanhã.",
  },
  SPEAKING: {
    eyebrow: "Wolfie está falando",
    title: "A resposta entra no seu contexto.",
    message: "Try: “We ran into a delay, and I’d like to walk you through the recovery plan.”",
  },
};

export function LandingTutorDemo() {
  const containerRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<DemoMode>("LISTENING");
  const [autoPlay, setAutoPlay] = useState(true);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { rootMargin: "140px 0px", threshold: 0.12 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!autoPlay || !visible || reducedMotion) return;
    const timer = window.setTimeout(
      () => setMode((current) => current === "LISTENING" ? "SPEAKING" : "LISTENING"),
      mode === "LISTENING" ? 3200 : 4600,
    );
    return () => window.clearTimeout(timer);
  }, [autoPlay, mode, reducedMotion, visible]);

  const copy = modeCopy[mode];

  return (
    <div
      ref={containerRef}
      className="relative isolate scroll-mt-[104px] overflow-hidden rounded-[40px] bg-[#10141f] text-white shadow-[0_34px_100px_rgba(26,31,43,.2)] sm:rounded-[48px]"
      data-demo-mode={mode.toLowerCase()}
    >
      <picture aria-hidden="true">
        <source
          media="(max-width: 767px)"
          srcSet="/assets/wolfie/scenes/global-meetings/meetings-technology/mobile.3033a4a4558e.webp"
        />
        <img
          src="/assets/wolfie/scenes/global-meetings/meetings-technology/desktop.cc9f82869f7f.webp"
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover opacity-80"
        />
      </picture>
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(9,13,23,.94)_0%,rgba(9,13,23,.72)_42%,rgba(9,13,23,.2)_76%,rgba(9,13,23,.34)_100%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_78%_32%,rgba(255,125,101,.18),transparent_34%)]" />

      <div className="relative grid lg:min-h-[760px] lg:grid-cols-[.9fr_1.1fr] lg:items-stretch">
        <div className="z-10 flex flex-col justify-center px-7 pb-6 pt-10 sm:px-12 sm:pb-10 sm:pt-14 lg:px-16 lg:py-20">
          <p className="inline-flex w-fit items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-extrabold uppercase tracking-[.16em] backdrop-blur-md">
            <span className="h-2 w-2 rounded-full bg-[#5ee29a] shadow-[0_0_14px_rgba(94,226,154,.8)]" />
            Demonstração do personagem
          </p>
          <h3 className="mt-5 max-w-xl font-display text-[2.6rem] font-extrabold leading-[.98] tracking-[-.055em] sm:mt-7 sm:text-6xl">
            Veja o Wolfie ouvir e responder.
          </h3>
          <p className="mt-5 max-w-xl text-base leading-7 text-white/70 sm:mt-6 sm:text-lg sm:leading-8">
            <span className="sm:hidden">Ele muda de estado e movimenta os lábios no ritmo do áudio.</span>
            <span className="hidden sm:inline">O Wolfie alterna entre ouvir e responder. Durante a fala, a camada labial acompanha a energia do áudio de saída e os movimentos permanecem discretos para não disputar atenção com o treino.</span>
          </p>

          <div className="mt-6 flex flex-wrap gap-2 sm:mt-8" role="group" aria-label="Controles da demonstração do Wolfie">
            <button
              type="button"
              aria-pressed={mode === "LISTENING"}
              onClick={() => {
                setAutoPlay(false);
                setMode("LISTENING");
              }}
              className={`inline-flex min-h-12 items-center gap-2 rounded-full border px-4 py-3 text-sm font-extrabold transition sm:px-5 ${mode === "LISTENING" ? "border-white bg-white text-[#17191f]" : "border-white/20 bg-white/5 text-white hover:bg-white/10"}`}
            >
              <Headphones size={17} /> <span className="sm:hidden">Ouvir</span><span className="hidden sm:inline">Ouvir você</span>
            </button>
            <button
              type="button"
              aria-pressed={mode === "SPEAKING"}
              onClick={() => {
                setAutoPlay(false);
                setMode("SPEAKING");
              }}
              className={`inline-flex min-h-12 items-center gap-2 rounded-full border px-4 py-3 text-sm font-extrabold transition sm:px-5 ${mode === "SPEAKING" ? "border-[#ff8b79] bg-[#ff8b79] text-[#241412]" : "border-white/20 bg-white/5 text-white hover:bg-white/10"}`}
            >
              <Volume2 size={17} /> <span className="sm:hidden">Wolfie fala</span><span className="hidden sm:inline">Ver Wolfie falar</span>
            </button>
            {!reducedMotion ? (
              <button
                type="button"
                onClick={() => setAutoPlay((current) => {
                  if (current) setMode("LISTENING");
                  return !current;
                })}
                className="inline-flex min-h-12 items-center gap-2 rounded-full border border-white/20 bg-white/5 px-4 py-3 text-sm font-extrabold text-white transition hover:bg-white/10 sm:px-5"
                aria-label={autoPlay ? "Pausar troca automática de estado" : "Retomar troca automática de estado"}
              >
                {autoPlay ? <Pause size={17} /> : <Play size={17} />}
                <span className="hidden sm:inline">{autoPlay ? "Pausar ciclo" : "Retomar ciclo"}</span>
              </button>
            ) : null}
          </div>

          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {copy.eyebrow}. {copy.title} {copy.message}
          </p>

          <div className="mt-6 hidden overflow-hidden rounded-[28px] border border-white/[.12] bg-black/25 p-4 backdrop-blur-xl sm:mt-8 sm:block sm:p-5">
            <AnimatePresence mode="wait" initial={false}>
              <m.div
                key={mode}
                initial={reducedMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reducedMotion ? undefined : { opacity: 0, y: -8 }}
                transition={{ duration: reducedMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] }}
              >
                <p className="text-[10px] font-extrabold uppercase tracking-[.17em] text-[#ff9c8d]">{copy.eyebrow}</p>
                <p className="mt-2 font-display text-xl font-extrabold">{copy.title}</p>
                <p className="mt-3 text-sm font-semibold leading-6 text-white/70">{copy.message}</p>
              </m.div>
            </AnimatePresence>
          </div>
          <p className="mt-5 hidden text-xs leading-5 text-white/[.45] lg:block">
            Demonstração visual. No tutor, o estado do personagem responde à sessão e ao áudio reais.
          </p>
        </div>

        <div className="relative min-h-[520px] overflow-hidden sm:min-h-[560px] lg:min-h-0">
          <div className="absolute right-5 top-5 z-20 inline-flex items-center gap-2 rounded-full border border-white/15 bg-[#10141f]/70 px-4 py-2 text-xs font-extrabold backdrop-blur-xl sm:right-8 sm:top-8">
            <span className={`h-2.5 w-2.5 rounded-full ${mode === "SPEAKING" ? "bg-[#ff725f] shadow-[0_0_14px_rgba(255,114,95,.75)]" : "bg-[#5ee29a] shadow-[0_0_14px_rgba(94,226,154,.75)]"}`} />
            {mode === "SPEAKING" ? "Wolfie falando" : "Wolfie ouvindo"}
          </div>

          <div className="absolute inset-x-0 bottom-0 top-14">
            <AnimatedWolfie
              visible={visible}
              mode={mode}
              reducedMotion={Boolean(reducedMotion)}
            />
          </div>

          <div className="absolute inset-x-5 bottom-5 z-20 rounded-[24px] border border-white/15 bg-[#10141f]/[.72] px-5 py-4 shadow-2xl backdrop-blur-xl sm:inset-x-8 sm:bottom-8">
            <div className="flex items-center gap-4">
              <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${mode === "SPEAKING" ? "bg-[#ff8b79] text-[#241412]" : "bg-white/[.12]"}`}>
                {mode === "SPEAKING" ? <Volume2 size={19} /> : <Mic2 size={19} />}
              </span>
              <div className="flex h-11 flex-1 items-center justify-center gap-1" aria-hidden="true">
                {SPEECH_PATTERN.map((value, index) => {
                  return (
                    <span
                      key={`${value}-${index}`}
                      className={`w-1 rounded-full transition-[height,background-color,opacity] duration-100 ${mode === "SPEAKING" ? "wolfie-wavebar bg-[#ff8b79] opacity-100" : "bg-white opacity-[.35]"}`}
                      style={{
                        height: mode === "SPEAKING" ? `${8 + Math.round(value * 84)}px` : "12px",
                        animationDelay: `${index * 45}ms`,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
