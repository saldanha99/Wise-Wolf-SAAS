import React, { useMemo } from 'react';
import { useAudioData, visualizeAudio } from '@remotion/media-utils';
import { Easing, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { displayFontFamily } from '../brand/fonts';
import { brand } from '../brand/tokens';
import {
  createKineticCaptionPages,
  findActiveCaptionPage,
  findActiveCaptionToken,
  summarizeVoiceMotion,
} from '../caption-motion';
import type { HubVideoCaption, HubVideoSceneId, HubVideoSceneTiming, HubVideoSlug } from '../types';

type CaptionLayerProps = {
  captions: HubVideoCaption[];
  audioPath?: string;
  audioReady?: boolean;
  accent?: string;
  secondaryAccent?: string;
  slug?: HubVideoSlug;
  sceneTimings?: Record<HubVideoSceneId, HubVideoSceneTiming>;
};

type CaptionVisualProps = CaptionLayerProps & {
  frequencies: number[] | null;
};

const CaptionVisual: React.FC<CaptionVisualProps> = ({
  captions,
  accent = brand.coral,
  secondaryAccent = brand.violet,
  frequencies,
  slug = 'hub-overview',
  sceneTimings,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeMs = frame / fps * 1000;
  const pages = useMemo(() => createKineticCaptionPages(captions), [captions]);
  const page = findActiveCaptionPage(pages, timeMs);
  const sceneEntries = sceneTimings
    ? Object.entries(sceneTimings) as Array<[HubVideoSceneId, HubVideoSceneTiming]>
    : [];
  const activeScene = sceneEntries.find(([, timing]) => timeMs >= timing.startSeconds * 1000 && timeMs < timing.endSeconds * 1000)?.[0];

  if (!page) return null;

  const interfaceScene = activeScene === 'product' || activeScene === 'proof';
  const ctaScene = activeScene === 'cta';
  const compactPage = interfaceScene || ctaScene;
  const captionMaxWidth = interfaceScene ? 1420 : ctaScene ? 1320 : slug === 'school-os' ? 1480 : 1560;
  const captionMinHeight = interfaceScene ? 118 : ctaScene ? 108 : 148;
  const captionBottom = interfaceScene ? 48 : ctaScene ? 46 : 58;

  const activeTokenIndex = findActiveCaptionToken(page, timeMs);
  const pageStartFrame = page.startMs / 1000 * fps;
  const pageEndFrame = page.endMs / 1000 * fps;
  const entrance = spring({
    frame: frame - pageStartFrame,
    fps,
    config: { damping: 18, stiffness: 170, mass: 0.7 },
    durationInFrames: Math.max(8, Math.round(fps * 0.36)),
  });
  const motion = summarizeVoiceMotion({
    frequencies,
    frame,
    fps,
    seed: page.seed,
    active: true,
    barCount: 36,
  });
  const fadeOutStart = Math.max(pageStartFrame + 5, pageEndFrame - 5);
  const opacity = interpolate(frame, [pageStartFrame, pageStartFrame + 4, fadeOutStart, pageEndFrame], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: [Easing.out(Easing.cubic), Easing.linear, Easing.in(Easing.quad)],
  });

  return (
    <div
      style={{
        position: 'absolute',
        zIndex: 80,
        left: 92,
        right: 92,
        bottom: captionBottom + (page.seed % 2) * 4,
        display: 'flex',
        justifyContent: 'center',
        opacity,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: captionMaxWidth,
          minHeight: captionMinHeight,
          overflow: 'hidden',
          border: `1px solid rgba(255,255,255,${0.14 + motion.energy * 0.2})`,
          borderRadius: compactPage ? 28 : 36,
          background: compactPage
            ? 'linear-gradient(135deg, rgba(5,6,9,0.9), rgba(13,14,20,0.82))'
            : 'linear-gradient(135deg, rgba(5,6,9,0.88), rgba(13,14,20,0.8))',
          boxShadow: `0 24px 90px rgba(0,0,0,0.5), 0 0 ${28 + motion.energy * 70}px ${accent}${motion.energy > 0.55 ? '38' : '20'}`,
          backdropFilter: 'blur(24px)',
          padding: compactPage ? '25px 46px 27px' : '31px 54px 33px',
          scale: 0.968 + entrance * 0.032 + motion.energy * (compactPage ? 0.018 : 0.025),
          translate: `${((page.seed % 5) - 2) * 5 + (motion.presence - 0.5) * 12}px ${interpolate(entrance, [0, 1], [34, 0]) - motion.air * 5}px`,
          rotate: `${(motion.presence - 0.5) * 0.34}deg`,
          transformOrigin: '50% 100%',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            opacity: 0.14 + motion.energy * 0.2,
            background: `radial-gradient(circle at ${18 + motion.presence * 64}% 0%, ${accent}80, transparent 42%), radial-gradient(circle at 82% 120%, ${secondaryAccent}5c, transparent 46%)`,
          }}
        />

        <div
          style={{
            position: 'absolute',
            left: 38,
            right: 38,
            top: compactPage ? 8 : 12,
            height: compactPage ? 15 : 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            opacity: 0.32 + motion.energy * 0.46,
          }}
        >
          {motion.bars.map((bar, index) => (
            <div
              key={index}
              style={{
                width: 4,
                height: 3 + bar * (compactPage ? 12 + motion.presence * 8 : 14 + motion.presence * 11),
                borderRadius: 999,
                background: `linear-gradient(180deg, ${index % 2 === 0 ? accent : secondaryAccent}, rgba(255,255,255,0.62))`,
                boxShadow: bar > 0.62 ? `0 0 10px ${accent}` : 'none',
              }}
            />
          ))}
        </div>

        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            justifyContent: 'center',
            columnGap: 17,
            rowGap: 10,
            color: '#ffffff',
            fontFamily: displayFontFamily,
            fontSize: compactPage
              ? page.tokens.length >= 8 ? 52 : page.tokens.length >= 6 ? 58 : 66
              : page.tokens.length >= 8 ? 68 : page.tokens.length >= 6 ? 76 : 86,
            fontWeight: 770,
            lineHeight: 1.01,
            letterSpacing: '-0.055em',
            textAlign: 'center',
            textWrap: 'balance',
          }}
        >
          {page.tokens.map((token, index) => {
            const active = index === activeTokenIndex;
            const spoken = index < activeTokenIndex;
            const tokenStartFrame = token.startMs / 1000 * fps;
            const tokenEntrance = interpolate(frame, [tokenStartFrame - 3, tokenStartFrame + 3], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
              easing: Easing.out(Easing.cubic),
            });
            const tokenDirection = ((page.seed + index) % 2 === 0 ? 1 : -1);

            return (
              <span
                key={`${token.startMs}-${token.text}`}
                style={{
                  position: 'relative',
                  display: 'inline-block',
                  whiteSpace: 'nowrap',
                  color: active ? '#ffffff' : spoken ? 'rgba(255,255,255,0.86)' : 'rgba(255,255,255,0.56)',
                  background: active ? `linear-gradient(135deg, ${accent}d9, ${secondaryAccent}b8)` : 'transparent',
                  borderRadius: active ? compactPage ? 15 : 19 : 0,
                  padding: active ? compactPage ? '0 11px 5px' : '0 14px 6px' : compactPage ? '0 0 5px' : '0 0 6px',
                  marginLeft: active ? compactPage ? -11 : -14 : 0,
                  marginRight: active ? compactPage ? -11 : -14 : 0,
                  boxShadow: active ? `0 13px 42px ${accent}55, inset 0 1px rgba(255,255,255,0.22)` : 'none',
                  textShadow: active ? `0 0 ${22 + motion.energy * 24}px rgba(255,255,255,0.52)` : '0 5px 18px rgba(0,0,0,0.48)',
                  scale: active ? 1.055 + motion.presence * 0.14 : 0.985 + tokenEntrance * 0.015,
                  translate: active
                    ? `${tokenDirection * motion.air * 5}px ${-(5 + motion.bass * 11)}px`
                    : `${tokenDirection * (1 - tokenEntrance) * 7}px ${interpolate(tokenEntrance, [0, 1], [11, 0])}px`,
                  rotate: active ? `${tokenDirection * (0.7 + motion.energy * 1.3)}deg` : `${tokenDirection * (1 - tokenEntrance) * 1.6}deg`,
                  opacity: spoken || active ? 1 : 0.72 + tokenEntrance * 0.28,
                }}
              >
                {active && <span style={{ position: 'absolute', left: '12%', right: '12%', bottom: -8, height: 4 + motion.bass * 4, borderRadius: 999, background: `linear-gradient(90deg, transparent, #fff, ${secondaryAccent}, transparent)`, boxShadow: `0 0 ${12 + motion.energy * 20}px ${accent}`, opacity: 0.72 + motion.energy * 0.28 }} />}
                {token.text}
              </span>
            );
          })}
        </div>

      </div>
    </div>
  );
};

const AudioReactiveCaptionLayer: React.FC<CaptionLayerProps & { audioPath: string }> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audioData = useAudioData(staticFile(props.audioPath));
  const frequencies = audioData
    ? visualizeAudio({
        fps,
        frame,
        audioData,
        numberOfSamples: 64,
        optimizeFor: 'speed',
        smoothing: true,
      })
    : null;

  return <CaptionVisual {...props} frequencies={frequencies} />;
};

export const CaptionLayer: React.FC<CaptionLayerProps> = (props) => {
  if (props.audioReady && props.audioPath) {
    return <AudioReactiveCaptionLayer {...props} audioPath={props.audioPath} />;
  }

  return <CaptionVisual {...props} frequencies={null} />;
};
