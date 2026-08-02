import React, { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { WolfieVisualSceneProfile } from "./types";

export interface WolfieScenarioStageProps {
  profile: WolfieVisualSceneProfile;
  hud?: React.ReactNode;
  character?: React.ReactNode;
  sceneContent?: React.ReactNode;
  context?: React.ReactNode;
  caption?: React.ReactNode;
  actions?: React.ReactNode;
  modal?: React.ReactNode;
  reducedMotion?: boolean;
  priority?: boolean;
  className?: string;
  stageLabel?: string;
  contextLabel?: string;
  captionLabel?: string;
  actionsLabel?: string;
  onBackgroundError?: (failedSource: string) => void;
}

const preferredBackground = (profile: WolfieVisualSceneProfile): string =>
  profile.assets?.desktopWebp ||
  profile.assets?.posterWebp ||
  profile.assets?.mobileWebp ||
  "";

/**
 * Palco responsivo com zonas estáveis para HUD, personagem, contexto, legenda,
 * ações e modal. As camadas decorativas nunca capturam eventos do aluno.
 */
export function WolfieScenarioStage({
  profile,
  hud,
  character,
  sceneContent,
  context,
  caption,
  actions,
  modal,
  reducedMotion,
  priority = false,
  className = "",
  stageLabel = "Palco da conversa",
  contextLabel = "Contexto da prática",
  captionLabel = "Legendas da conversa",
  actionsLabel = "Ações da prática",
  onBackgroundError,
}: WolfieScenarioStageProps) {
  const systemReducedMotion = useReducedMotion();
  const staticMode = reducedMotion ?? Boolean(systemReducedMotion);
  const backgroundSource = useMemo(
    () => preferredBackground(profile),
    [profile],
  );
  const [backgroundFailed, setBackgroundFailed] = useState(!backgroundSource);

  useEffect(() => {
    setBackgroundFailed(!backgroundSource);
  }, [backgroundSource, profile.key]);

  const handleBackgroundError = () => {
    if (backgroundSource) onBackgroundError?.(backgroundSource);
    setBackgroundFailed(true);
  };

  return (
    <section
      aria-label={profile.accessibleEnvironmentLabel}
      className={`relative isolate grid h-full min-h-0 w-full grid-rows-[auto_minmax(0,1fr)_auto_auto] overflow-x-hidden overflow-y-auto bg-slate-950 text-white ${className}`}
      data-scene-key={profile.key}
      data-scene-layout={profile.layout}
      data-hud-variant={profile.hudVariant}
      data-background-status={backgroundFailed ? "fallback" : "image"}
      data-motion={staticMode ? "static" : "dynamic"}
      style={{
        background: profile.palette.gradient,
        "--wolfie-scene-accent": profile.palette.accent,
        "--wolfie-scene-glow": profile.palette.glow,
      } as React.CSSProperties}
    >
      <div className="pointer-events-none absolute inset-0 -z-30" aria-hidden="true">
        {!backgroundFailed && backgroundSource
          ? (
            <picture>
              {profile.assets?.mobileAvif
                ? (
                  <source
                    media="(max-width: 767px)"
                    type="image/avif"
                    srcSet={profile.assets.mobileAvif}
                  />
                )
                : null}
              {profile.assets?.mobileWebp
                ? (
                  <source
                    media="(max-width: 767px)"
                    type="image/webp"
                    srcSet={profile.assets.mobileWebp}
                  />
                )
                : null}
              {profile.assets?.desktopAvif
                ? <source type="image/avif" srcSet={profile.assets.desktopAvif} />
                : null}
              <img
                src={backgroundSource}
                alt=""
                width={1920}
                height={1080}
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                decoding="async"
                onError={handleBackgroundError}
                className="h-full w-full object-cover object-center"
              />
            </picture>
          )
          : null}
      </div>

      <div
        className="pointer-events-none absolute inset-0 -z-20"
        style={{ background: profile.palette.scrim }}
        aria-hidden="true"
      />

      <motion.div
        className="pointer-events-none absolute -left-[12%] top-[6%] -z-10 h-[42vw] max-h-[34rem] w-[42vw] max-w-[34rem] rounded-full blur-[100px]"
        aria-hidden="true"
        animate={staticMode
          ? { opacity: 0.22, scale: 1 }
          : { opacity: [0.18, 0.3, 0.18], scale: [0.98, 1.04, 0.98] }}
        transition={staticMode
          ? { duration: 0 }
          : { duration: 8, repeat: Infinity, ease: "easeInOut" }}
        style={{ background: profile.palette.glow }}
      />

      {hud
        ? (
          <div className="relative z-40 min-w-0" data-stage-slot="hud">
            {hud}
          </div>
        )
        : null}

      <div
        className={`relative z-10 grid min-h-0 ${
          context
            ? "grid-rows-[minmax(11.5rem,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)] lg:grid-rows-1"
            : "grid-cols-1"
        }`}
      >
        <div
          className="relative min-h-0 overflow-hidden"
          role="group"
          aria-label={stageLabel}
          data-stage-slot="scene"
        >
          {character
            ? (
              <div
                className="pointer-events-none absolute inset-0 z-10"
                data-stage-layer="character"
              >
                {character}
              </div>
            )
            : null}
          {sceneContent
            ? (
              <div
                className="pointer-events-auto relative z-20 h-full w-full"
                data-stage-layer="content"
              >
                {sceneContent}
              </div>
            )
            : null}
        </div>

        {context
          ? (
            <aside
              aria-label={contextLabel}
              className="pointer-events-auto relative z-30 max-h-[34dvh] overflow-y-auto border-t border-white/10 bg-slate-950/72 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-2xl sm:p-5 lg:max-h-none lg:border-l lg:border-t-0 lg:p-6"
              data-stage-slot="context"
            >
              {context}
            </aside>
          )
          : null}
      </div>

      {caption
        ? (
          <div
            aria-label={captionLabel}
            className="pointer-events-auto relative z-40 min-w-0"
            data-stage-slot="caption"
          >
            {caption}
          </div>
        )
        : null}

      {actions
        ? (
          <div
            role="group"
            aria-label={actionsLabel}
            className="pointer-events-auto relative z-40 min-w-0 pb-[env(safe-area-inset-bottom)]"
            data-stage-slot="actions"
          >
            {actions}
          </div>
        )
        : null}

      {modal
        ? (
          <div
            className="pointer-events-auto absolute inset-0 z-50"
            data-stage-slot="modal"
          >
            {modal}
          </div>
        )
        : null}
    </section>
  );
}

export default WolfieScenarioStage;
