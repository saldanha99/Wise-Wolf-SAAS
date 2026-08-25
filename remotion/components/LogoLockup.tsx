import React from 'react';
import { Img, staticFile } from 'remotion';
import { displayFontFamily } from '../brand/fonts';
import { brand } from '../brand/tokens';

export const LogoLockup: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 14 : 20 }}>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        width: compact ? 166 : 222,
        height: compact ? 52 : 66,
        border: `1px solid ${brand.line}`,
        borderRadius: compact ? 15 : 19,
        background: 'rgba(3, 4, 6, 0.82)',
        padding: compact ? '10px 14px' : '12px 18px',
        boxShadow: '0 18px 50px rgba(0,0,0,0.28)',
      }}
    >
      <Img
        src={staticFile('assets/wolfie/brand/wise-wolf-logo-horizontal-dark.png')}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    </div>
    <div style={{ width: 1, height: compact ? 30 : 38, background: brand.line }} />
    <span
      style={{
        color: brand.ink,
        fontFamily: displayFontFamily,
        fontSize: compact ? 21 : 27,
        fontWeight: 750,
        letterSpacing: '-0.035em',
        textTransform: 'uppercase',
      }}
    >
      Hub
    </span>
  </div>
);

