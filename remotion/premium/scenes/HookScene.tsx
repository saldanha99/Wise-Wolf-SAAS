import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { displayFontFamily } from '../../brand/fonts';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { FILM_CAPTURES } from '../filmAssets';
import { AnimatedBackdrop } from '../components/AnimatedBackdrop';
import { FilmChrome } from '../components/FilmChrome';
import { SceneEyebrow } from '../components/SceneText';

export const HookScene: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  durationInFrames: number;
}> = ({ content, format, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const story = format === 'story';
  const title = spring({ frame: frame - 3, fps, config: { damping: 18, stiffness: 96, mass: 0.92 } });
  const emphasis = spring({ frame: frame - 11, fps, config: { damping: 17, stiffness: 106 } });
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 12), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });
  const preview = FILM_CAPTURES[content.slug][0];

  return (
    <AbsoluteFill style={{ overflow: 'hidden', opacity: exit }}>
      <AnimatedBackdrop content={content} format={format} />
      <FilmChrome content={content} format={format} label="A transformação começa aqui" />

      <div style={{
        position: 'absolute',
        zIndex: 18,
        left: story ? 60 : 96,
        right: story ? 60 : undefined,
        top: story ? 238 : 190,
        width: story ? undefined : 1040,
      }}>
        <SceneEyebrow content={content} format={format}>{content.eyebrow}</SceneEyebrow>
        <h1 style={{
          margin: story ? '28px 0 0' : '24px 0 0',
          color: '#fff',
          fontFamily: displayFontFamily,
          fontSize: story ? 104 : 106,
          fontWeight: 650,
          lineHeight: story ? 0.94 : 0.91,
          letterSpacing: '-0.068em',
          textWrap: 'balance',
          opacity: title,
          translate: `${(1 - title) * -58}px ${(1 - title) * 30}px`,
        }}>
          {content.title}
          <span style={{ display: 'block', marginTop: 14, color: content.accent, textShadow: `0 0 44px ${content.accent}42`, opacity: emphasis, translate: `0 ${(1 - emphasis) * 38}px` }}>{content.emphasis}</span>
        </h1>
      </div>

      <div style={{
        position: 'absolute',
        zIndex: 12,
        right: story ? 56 : 74,
        left: story ? 56 : undefined,
        top: story ? 830 : 274,
        width: story ? undefined : 680,
        height: story ? 620 : 430,
        overflow: 'hidden',
        border: `1px solid ${content.accent}66`,
        borderRadius: story ? 38 : 30,
        background: '#080a0f',
        boxShadow: `0 48px 130px rgba(0,0,0,0.62), 0 0 84px ${content.accent}2b`,
        opacity: emphasis,
        scale: 0.9 + emphasis * 0.1,
        translate: `${story ? 0 : (1 - emphasis) * 90}px ${(1 - emphasis) * 34}px`,
        rotate: story ? '0deg' : `${(1 - emphasis) * 2.4 - 1.4}deg`,
      }}>
        <Img src={staticFile(`assets/hub/videos/native/${preview.file}`)} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: story ? '44% center' : 'center', scale: 1.04 + frame / 8000 }} />
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(4,5,8,0.05), transparent 52%, rgba(4,5,8,0.78))' }} />
        <div style={{ position: 'absolute', left: 28, right: 28, bottom: 24, color: '#fff', fontFamily: displayFontFamily, fontSize: story ? 34 : 25, fontWeight: 680 }}>{preview.label} <span style={{ color: content.accent }}>em funcionamento.</span></div>
      </div>

      <div style={{
        position: 'absolute',
        zIndex: 15,
        left: story ? 60 : 98,
        bottom: story ? 260 : 180,
        width: story ? 720 : 620,
        height: 3,
        borderRadius: 999,
        background: `linear-gradient(90deg, ${content.accent}, ${content.secondaryAccent}, transparent)`,
        boxShadow: `0 0 24px ${content.accent}`,
        scale: `${interpolate(frame, [8, 34], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) })} 1`,
        transformOrigin: '0 50%',
      }} />
    </AbsoluteFill>
  );
};
