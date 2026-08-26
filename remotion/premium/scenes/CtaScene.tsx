import React from 'react';
import { ArrowRight, PlayCircle } from 'lucide-react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import { LogoLockup } from '../../components/LogoLockup';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { AnimatedBackdrop } from '../components/AnimatedBackdrop';
import { FILM_URLS } from '../filmAssets';

export const CtaScene: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  durationInFrames: number;
}> = ({ content, format, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const story = format === 'story';
  const reveal = spring({ frame: frame - 2, fps, config: { damping: 18, stiffness: 98, mass: 0.9 } });
  const button = spring({ frame: frame - 14, fps, config: { damping: 17, stiffness: 110 } });
  const holdPulse = 1 + Math.sin(frame / 18) * 0.012;
  const ambient = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0.45, 0.82], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#07080b' }}>
      <AnimatedBackdrop content={content} format={format} strength={0.8} shade={story ? 'linear-gradient(180deg, rgba(5,6,9,0.9), rgba(5,6,9,0.56), rgba(5,6,9,0.94))' : 'linear-gradient(90deg, rgba(5,6,9,0.9), rgba(5,6,9,0.48), rgba(5,6,9,0.9))'} />
      <div style={{ position: 'absolute', inset: 0, opacity: ambient, background: `radial-gradient(circle at 50% 52%, ${content.accent}35, transparent 38%)` }} />

      <div style={{
        position: 'absolute',
        zIndex: 20,
        left: story ? 64 : 210,
        right: story ? 64 : 210,
        top: story ? 290 : 142,
        bottom: story ? 290 : 148,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        opacity: reveal,
        translate: `0 ${(1 - reveal) * 42}px`,
      }}>
        <LogoLockup />
        <small style={{ marginTop: story ? 34 : 24, color: content.accent, fontFamily: bodyFontFamily, fontSize: story ? 17 : 12, fontWeight: 900, letterSpacing: '0.16em', textTransform: 'uppercase' }}>{content.productName}</small>
        <h2 style={{ margin: story ? '22px 0 0' : '16px 0 0', maxWidth: story ? 920 : 1280, color: '#fff', fontFamily: displayFontFamily, fontSize: story ? 92 : 84, fontWeight: 660, lineHeight: 0.96, letterSpacing: '-0.064em', textWrap: 'balance' }}>{content.cta}</h2>
        <p style={{ margin: story ? '24px 0 0' : '18px 0 0', maxWidth: 820, color: 'rgba(255,255,255,0.7)', fontFamily: bodyFontFamily, fontSize: story ? 25 : 20, lineHeight: 1.45 }}>{content.ctaSupport}</p>

        <div style={{
          display: story ? 'grid' : 'flex',
          gridTemplateColumns: story && content.ctaButtons.length > 1 ? '1fr 1fr' : '1fr',
          alignItems: 'center',
          justifyContent: 'center',
          gap: story ? 14 : 16,
          width: story ? '100%' : undefined,
          marginTop: story ? 42 : 32,
          opacity: button,
          scale: button * holdPulse,
        }}>
          {content.ctaButtons.map((label, index) => (
            <div key={label} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              minWidth: story ? undefined : 290,
              minHeight: story ? 76 : 64,
              border: `1px solid ${index === 0 ? `${content.accent}a0` : 'rgba(255,255,255,0.24)'}`,
              borderRadius: 999,
              background: index === 0 ? `linear-gradient(135deg, ${content.accent}, ${content.secondaryAccent})` : 'rgba(255,255,255,0.08)',
              boxShadow: index === 0 ? `0 28px 80px ${content.accent}48` : '0 20px 60px rgba(0,0,0,0.24)',
              color: '#fff',
              padding: story ? '0 20px' : '0 26px',
              fontFamily: bodyFontFamily,
              fontSize: story ? 17 : 17,
              fontWeight: 850,
            }}>{index === 0 ? <PlayCircle size={story ? 22 : 20} /> : null}{label}<ArrowRight size={story ? 21 : 19} /></div>
          ))}
        </div>

        <div style={{ marginTop: story ? 36 : 28, color: 'rgba(255,255,255,0.62)', fontFamily: bodyFontFamily, fontSize: story ? 17 : 13, fontWeight: 700, letterSpacing: '0.02em' }}>{FILM_URLS[content.slug]}</div>
      </div>

      <div style={{ position: 'absolute', left: '50%', top: '50%', width: story ? 940 : 1240, height: story ? 940 : 760, border: `1px solid ${content.accent}24`, borderRadius: '50%', translate: '-50% -50%', scale: 0.72 + reveal * 0.28, boxShadow: `0 0 110px ${content.accent}12, inset 0 0 110px ${content.secondaryAccent}0f` }} />
    </AbsoluteFill>
  );
};
