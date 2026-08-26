import React from 'react';
import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../brand/fonts';
import { adBrand, textOnImageShadow } from '../brand/tokens';
import { fs, type AdLayout } from './layout';

export const Kicker: React.FC<{ layout: AdLayout; accent: string; children: React.ReactNode }> = ({
  layout,
  accent,
  children,
}) => {
  const frame = useCurrentFrame();
  const reveal = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: fs(layout, 12, 6),
        color: 'rgba(255,255,255,0.82)',
        fontFamily: bodyFontFamily,
        fontSize: fs(layout, 22, 11),
        fontWeight: 800,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        textShadow: textOnImageShadow,
        opacity: reveal,
        translate: `${(1 - reveal) * -18}px 0`,
      }}
    >
      <span
        style={{
          width: fs(layout, 34, 16),
          height: 3,
          borderRadius: 999,
          background: accent,
          boxShadow: `0 0 16px ${accent}`,
        }}
      />
      {children}
    </div>
  );
};

/**
 * Manchete em duas partes: a linha neutra e a linha de ênfase, que entra depois e no acento.
 * A ênfase carrega a ideia — é a parte que precisa ser lida se a pessoa der só meio segundo.
 */
export const Headline: React.FC<{
  layout: AdLayout;
  accent: string;
  line: string;
  emphasis?: string;
  delay?: number;
  size?: number;
}> = ({ layout, accent, line, emphasis, delay = 0, size }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const a = spring({ frame: frame - delay - 2, fps, config: { damping: 19, stiffness: 100, mass: 0.9 } });
  const b = spring({ frame: frame - delay - 10, fps, config: { damping: 18, stiffness: 108, mass: 0.9 } });

  const fontSize = fs(layout, size ?? (layout.vertical ? 88 : 78), 26);

  return (
    <h1
      style={{
        margin: `${fs(layout, 18, 8)}px 0 0`,
        maxWidth: layout.safe.width,
        color: adBrand.ink,
        fontFamily: displayFontFamily,
        fontSize,
        fontWeight: 700,
        lineHeight: 0.98,
        letterSpacing: '-0.05em',
        textWrap: 'balance',
        textShadow: textOnImageShadow,
      }}
    >
      <span style={{ display: 'block', opacity: a, translate: `0 ${(1 - a) * 26}px` }}>{line}</span>
      {emphasis && (
        <span
          style={{
            display: 'block',
            marginTop: fs(layout, 8, 3),
            color: accent,
            textShadow: `0 0 44px ${accent}55, ${textOnImageShadow}`,
            opacity: b,
            translate: `0 ${(1 - b) * 28}px`,
          }}
        >
          {emphasis}
        </span>
      )}
    </h1>
  );
};

/** Lista de pontos que entram em cascata, um por vez. */
export const Points: React.FC<{
  layout: AdLayout;
  accent: string;
  items: string[];
  delay?: number;
}> = ({ layout, accent, items, delay = 8 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: fs(layout, 14, 6),
        marginTop: fs(layout, 30, 12),
      }}
    >
      {items.map((item, index) => {
        const enter = spring({
          frame: frame - delay - index * 6,
          fps,
          config: { damping: 20, stiffness: 108, mass: 0.85 },
        });
        return (
          <div
            key={item}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: fs(layout, 14, 7),
              opacity: enter,
              translate: `${(1 - enter) * -22}px 0`,
            }}
          >
            <span
              style={{
                flex: '0 0 auto',
                width: fs(layout, 10, 5),
                height: fs(layout, 10, 5),
                borderRadius: 999,
                background: accent,
                boxShadow: `0 0 14px ${accent}`,
              }}
            />
            <span
              style={{
                color: 'rgba(255,255,255,0.94)',
                fontFamily: bodyFontFamily,
                fontSize: fs(layout, 32, 15),
                fontWeight: 600,
                letterSpacing: '-0.01em',
                textShadow: textOnImageShadow,
              }}
            >
              {item}
            </span>
          </div>
        );
      })}
    </div>
  );
};
