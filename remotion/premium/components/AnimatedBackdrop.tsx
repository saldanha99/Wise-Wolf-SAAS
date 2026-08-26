import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { FILM_BACKDROPS } from '../filmAssets';

export const AnimatedBackdrop: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  shade?: string;
  strength?: number;
}> = ({ content, format, shade, strength = 1 }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const story = format === 'story';
  const zoom = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [1.03, story ? 1.18 : 1.11], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const driftX = Math.sin(frame / 54) * (story ? 18 : 10);
  const driftY = Math.cos(frame / 67) * (story ? 12 : 7);

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#07080b' }}>
      <Img
        src={staticFile(`assets/hub/videos/generated-v2/${FILM_BACKDROPS[content.slug]}`)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          objectPosition: story ? '52% center' : 'center',
          scale: zoom,
          translate: `${driftX}px ${driftY}px`,
          filter: 'saturate(0.92) contrast(1.08)',
        }}
      />
      <AbsoluteFill style={{ background: shade ?? (story ? 'linear-gradient(180deg, rgba(5,6,9,0.88), rgba(5,6,9,0.34) 42%, rgba(5,6,9,0.93))' : 'linear-gradient(90deg, rgba(5,6,9,0.92), rgba(5,6,9,0.24) 58%, rgba(5,6,9,0.72))') }} />
      <AbsoluteFill style={{ opacity: 0.16 * strength, background: `radial-gradient(circle at ${30 + Math.sin(frame / 46) * 10}% ${42 + Math.cos(frame / 58) * 8}%, ${content.accent}, transparent 34%)`, mixBlendMode: 'screen' }} />
      <AbsoluteFill style={{ opacity: 0.1 * strength, background: `radial-gradient(circle at ${78 + Math.cos(frame / 52) * 8}% ${68 + Math.sin(frame / 64) * 8}%, ${content.secondaryAccent}, transparent 32%)`, mixBlendMode: 'screen' }} />
      <AbsoluteFill style={{ opacity: 0.08, backgroundImage: 'radial-gradient(rgba(255,255,255,0.82) 0.7px, transparent 0.8px)', backgroundSize: '5px 5px', backgroundPosition: `${frame % 5}px ${(frame * 0.68) % 5}px`, mixBlendMode: 'soft-light' }} />
    </AbsoluteFill>
  );
};
