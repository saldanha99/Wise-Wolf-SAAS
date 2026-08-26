import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { NativeInterfaceTour } from './NativeInterfaceTour';

export const InterfaceStage: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  mode: 'product' | 'proof';
  durationInFrames: number;
}> = ({ content, format, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const story = format === 'story';
  const reveal = spring({ frame: frame - 3, fps, config: { damping: 20, stiffness: 94, mass: 0.88 } });
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 12), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  if (story) {
    return (
      <div style={{
        position: 'absolute',
        zIndex: 18,
        left: 48,
        right: 48,
        top: 506,
        height: 782,
        overflow: 'hidden',
        border: `1px solid ${content.accent}5c`,
        borderRadius: 42,
        background: '#080a0f',
        boxShadow: `0 60px 150px rgba(0,0,0,0.62), 0 0 90px ${content.accent}24`,
        opacity: reveal * exit,
        scale: 0.965 + reveal * 0.035,
        translate: `0 ${(1 - reveal) * 64}px`,
      }}>
        <NativeInterfaceTour content={content} format={format} durationInFrames={durationInFrames} />
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', boxShadow: 'inset 0 0 90px rgba(3,4,7,0.52)' }} />
      </div>
    );
  }

  const cameraX = Math.sin(frame / 66) * 10;
  const cameraY = Math.cos(frame / 81) * 6;
  return (
    <div style={{
      position: 'absolute',
      zIndex: 18,
      left: '50%',
      top: 164,
      width: 1600,
      height: 720,
      overflow: 'hidden',
      borderRadius: 34,
      background: '#080a0f',
      boxShadow: `0 58px 160px rgba(0,0,0,0.66), 0 0 100px ${content.accent}24`,
      opacity: reveal * exit,
      translate: `calc(-50% + ${cameraX}px) ${(1 - reveal) * 58 + cameraY}px`,
      scale: 0.91 + reveal * 0.09,
      rotate: `${Math.sin(frame / 92) * 0.18}deg`,
      transformOrigin: '50% 20%',
    }}>
      <NativeInterfaceTour content={content} format={format} durationInFrames={durationInFrames} />
    </div>
  );
};
