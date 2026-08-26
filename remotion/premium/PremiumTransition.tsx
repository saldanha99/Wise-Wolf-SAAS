import React from 'react';
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import type { HubVideoContent, HubVideoFormat } from '../types';

export const PREMIUM_TRANSITION_FRAMES = 16;

export const PremiumTransition: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  index: number;
}> = ({ content, format, index }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width, height } = useVideoConfig();
  const story = format === 'story';
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const opacity = interpolate(progress, [0, 0.18, 0.82, 1], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const direction = index % 2 === 0 ? 1 : -1;
  const sweep = interpolate(progress, [0, 1], [direction > 0 ? -26 : 126, direction > 0 ? 126 : -26]);
  const radius = interpolate(progress, [0, 0.5, 1], [80, story ? 1220 : 1520, story ? 2400 : 2800]);

  return (
    <AbsoluteFill style={{ zIndex: 90, overflow: 'hidden', pointerEvents: 'none', opacity }}>
      <div style={{ position: 'absolute', left: `${sweep}%`, top: -height * 0.25, width: story ? 210 : 250, height: height * 1.5, background: `linear-gradient(90deg, transparent, ${content.accent}80, rgba(255,255,255,0.78), ${content.secondaryAccent}76, transparent)`, filter: 'blur(13px)', rotate: `${direction * (story ? 3 : 9)}deg`, translate: '-50% 0' }} />
      <div style={{ position: 'absolute', left: width / 2, top: height / 2, width: radius, height: radius, border: `3px solid ${content.accent}`, borderRadius: '50%', boxShadow: `0 0 90px ${content.accent}55, inset 0 0 90px ${content.secondaryAccent}32`, translate: '-50% -50%', opacity: Math.sin(progress * Math.PI) }} />
      <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(circle at 50% 50%, transparent ${Math.max(0, 16 + progress * 42)}%, rgba(5,6,9,${0.75 * Math.sin(progress * Math.PI)}) 76%)` }} />
    </AbsoluteFill>
  );
};
