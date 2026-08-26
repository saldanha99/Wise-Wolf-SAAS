import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import type { HubVideoContent, HubVideoFormat } from '../../types';

export const SceneEyebrow: React.FC<{
  content: HubVideoContent;
  children: React.ReactNode;
  format: HubVideoFormat;
}> = ({ content, children, format }) => {
  const frame = useCurrentFrame();
  const reveal = interpolate(frame, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: format === 'story' ? 14 : 12,
      color: 'rgba(255,255,255,0.78)',
      fontFamily: bodyFontFamily,
      fontSize: format === 'story' ? 17 : 12,
      fontWeight: 850,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      opacity: reveal,
      translate: `${(1 - reveal) * -22}px 0`,
    }}>
      <span style={{ width: format === 'story' ? 44 : 36, height: 3, borderRadius: 999, background: content.accent, boxShadow: `0 0 18px ${content.accent}` }} />
      {children}
    </div>
  );
};

export const SceneHeadline: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  children: React.ReactNode;
  maxWidth?: number;
  align?: 'left' | 'center' | 'right';
}> = ({ content, format, children, maxWidth, align = 'left' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const reveal = spring({ frame: frame - 4, fps, config: { damping: 19, stiffness: 102, mass: 0.9 } });

  return (
    <h2 style={{
      maxWidth: maxWidth ?? (format === 'story' ? 920 : 1120),
      margin: format === 'story' ? '24px 0 0' : '18px 0 0',
      color: '#fff',
      fontFamily: displayFontFamily,
      fontSize: format === 'story' ? 88 : 72,
      fontWeight: 650,
      lineHeight: 0.96,
      letterSpacing: '-0.058em',
      textAlign: align,
      textWrap: 'balance',
      opacity: reveal,
      translate: `0 ${(1 - reveal) * 46}px`,
    }}>
      {children}
    </h2>
  );
};
