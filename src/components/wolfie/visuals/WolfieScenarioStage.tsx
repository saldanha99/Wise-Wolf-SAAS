import React, { useEffect, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { WolfieVisualSceneProfile } from "./types";

export interface WolfieScenarioStageProps {
  profile: WolfieVisualSceneProfile;
  presentation?: "immersive" | "ugc";
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
  presentation = "immersive",
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
  const isUgcPresentation = presentation === "ugc";
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
      className={`relative isolate grid h-full min-h-0 w-full overflow-x-hidden overflow-y-auto bg-slate-950 text-white ${
        isUgcPresentation
          ? "grid-rows-[auto_minmax(19rem,1fr)_auto]"
          : "grid-rows-[auto_minmax(0,1fr)_auto_auto]"
      } ${className}`}
      data-scene-key={profile.key}
      data-scene-layout={profile.layout}
      data-hud-variant={profile.hudVariant}
      data-stage-presentation={presentation}
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
              <motion.img
                src={backgroundSource}
                alt=""
                width={1920}
                height={1080}
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                decoding="async"
                onError={handleBackgroundError}
                data-stage-layer="background"
                className={`h-full w-full object-cover object-center will-change-transform ${
                  isUgcPresentation ? "blur-xl" : ""
                }`}
                animate={staticMode
                  ? { scale: 1, x: "0%", y: "0%" }
                  : {
                    scale: [1.025, 1.055, 1.025],
                    x: ["0%", "-0.6%", "0%"],
                    y: ["0%", "-0.35%", "0%"],
                  }}
                transition={staticMode
                  ? { duration: 0 }
                  : { duration: 20, repeat: Infinity, ease: "easeInOut" }}
                style={{
                  filter: isUgcPresentation
                    ? "brightness(.52) saturate(.86)"
                    : "brightness(1.06) saturate(1.08)",
                }}
              />
            </picture>
          )
          : null}
      </div>

      <div
        className="pointer-events-none absolute inset-0 -z-20"
        style={{ background: profile.palette.scrim }}
        data-stage-layer="scrim"
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

      {isUgcPresentation
        ? (
          <div className="relative z-10 min-h-0 px-3 pb-3 pt-2 sm:px-5 sm:pb-4 lg:px-7 lg:pb-5">
            <div
              className="relative mx-auto h-full min-h-[19rem] w-full max-w-7xl overflow-hidden rounded-[1.75rem] border border-white/15 bg-slate-900/35 shadow-[0_28px_90px_rgba(2,6,23,.55)] ring-1 ring-black/20 sm:rounded-[2rem]"
              role="group"
              aria-label={stageLabel}
              data-stage-slot="scene"
              data-stage-camera="ugc"
            >
              {!backgroundFailed && backgroundSource
                ? (
                  <picture className="pointer-events-none absolute inset-0 -z-20" aria-hidden="true">
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
                    <motion.img
                      src={backgroundSource}
                      alt=""
                      width={1920}
                      height={1080}
                      loading={priority ? "eager" : "lazy"}
                      fetchPriority={priority ? "high" : "auto"}
                      decoding="async"
                      onError={handleBackgroundError}
                      data-stage-layer="camera-background"
                      className="h-full w-full object-cover object-center will-change-transform"
                      animate={staticMode
                        ? { scale: 1 }
                        : { scale: [1.01, 1.035, 1.01] }}
                      transition={staticMode
                        ? { duration: 0 }
                        : { duration: 16, repeat: Infinity, ease: "easeInOut" }}
                      style={{ filter: "brightness(.88) saturate(1.08)" }}
                    />
                  </picture>
                )
                : null}

              <div
                className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(2,6,23,.18)_0%,rgba(2,6,23,.03)_42%,rgba(2,6,23,.72)_100%)]"
                aria-hidden="true"
                data-stage-layer="camera-scrim"
              />
              <div
                className="pointer-events-none absolute inset-x-[12%] top-0 h-px bg-gradient-to-r from-transparent via-white/55 to-transparent"
                aria-hidden="true"
              />

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

              {caption
                ? (
                  <div
                    aria-label={captionLabel}
                    className="pointer-events-auto absolute inset-x-0 bottom-2 z-40 min-w-0 sm:bottom-3"
                    data-stage-slot="caption"
                  >
                    {caption}
                  </div>
                )
                : null}

              {context
                ? (
                  <aside
                    aria-label={contextLabel}
                    className="pointer-events-auto absolute inset-x-2 bottom-2 z-50 max-h-[58%] overflow-y-auto rounded-[1.5rem] border border-white/12 bg-slate-950/88 p-3 pb-[max(.75rem,env(safe-area-inset-bottom))] shadow-2xl backdrop-blur-2xl sm:inset-x-auto sm:bottom-3 sm:right-3 sm:top-3 sm:w-[min(23rem,42%)] sm:max-h-none sm:p-4"
                    data-stage-slot="context"
                  >
                    {context}
                  </aside>
                )
                : null}
            </div>
          </div>
        )
        : (
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
        )}

      {caption && !isUgcPresentation
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
