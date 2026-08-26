import React from 'react';
import { AlertTriangle, ArrowUpRight } from 'lucide-react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import { BrandBackground } from '../../components/BrandBackground';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { FilmChrome } from '../components/FilmChrome';
import { SceneEyebrow, SceneHeadline } from '../components/SceneText';

export const ProblemScene: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  durationInFrames: number;
}> = ({ content, format, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const story = format === 'story';
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 12), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#07080b', opacity: exit }}>
      <BrandBackground accent={content.accent} secondaryAccent={content.secondaryAccent} intensity={0.68} />
      <FilmChrome content={content} format={format} label="O atrito que precisa desaparecer" />

      <div style={{ position: 'absolute', zIndex: 18, left: story ? 58 : 94, right: story ? 58 : undefined, top: story ? 260 : 166, width: story ? undefined : 770 }}>
        <SceneEyebrow content={content} format={format}>Antes da transformação</SceneEyebrow>
        <SceneHeadline content={content} format={format} maxWidth={story ? 900 : 760}>{content.problemHeadline}</SceneHeadline>
        <p style={{ margin: story ? '26px 0 0' : '20px 0 0', color: 'rgba(255,255,255,0.6)', fontFamily: bodyFontFamily, fontSize: story ? 24 : 17, lineHeight: 1.42, maxWidth: story ? 820 : 620 }}>
          O problema aparece quando cada etapa exige outra aba, outra busca e outra reconstrução de contexto.
        </p>
      </div>

      <div style={{
        position: 'absolute',
        zIndex: 20,
        left: story ? 58 : 930,
        right: story ? 58 : 86,
        top: story ? 800 : 178,
        height: story ? 650 : 570,
      }}>
        {content.problemItems.map((item, index) => {
          const reveal = spring({ frame: frame - 7 - index * 7, fps, config: { damping: 17, stiffness: 116, mass: 0.82 } });
          const y = story ? index * 188 : index * 150;
          const drift = Math.sin(frame / (31 + index * 6) + index) * (story ? 7 : 5);
          return (
            <div key={item} style={{
              position: 'absolute',
              left: story ? (index % 2) * 34 : index * 24,
              right: story ? (1 - index % 2) * 34 : 0,
              top: y + drift,
              display: 'grid',
              gridTemplateColumns: story ? '70px 1fr 42px' : '60px 1fr 36px',
              alignItems: 'center',
              gap: story ? 19 : 16,
              minHeight: story ? 142 : 118,
              overflow: 'hidden',
              border: `1px solid ${index === 1 ? `${content.accent}70` : 'rgba(255,255,255,0.13)'}`,
              borderRadius: story ? 28 : 24,
              background: index === 1 ? `linear-gradient(110deg, ${content.accent}22, rgba(11,12,17,0.92))` : 'rgba(11,12,17,0.88)',
              boxShadow: `0 26px 76px rgba(0,0,0,0.46), 0 0 42px ${content.accent}${index === 1 ? '1f' : '0d'}`,
              padding: story ? '22px 24px' : '18px 21px',
              opacity: reveal,
              translate: `${(1 - reveal) * (index % 2 ? 160 : -160)}px ${(1 - reveal) * 30}px`,
              rotate: `${(1 - reveal) * (index - 1) * 2.4}deg`,
            }}>
              <span style={{ display: 'grid', width: story ? 64 : 54, height: story ? 64 : 54, placeItems: 'center', borderRadius: story ? 20 : 17, background: `${content.accent}1e`, color: content.accent }}><AlertTriangle size={story ? 29 : 24} /></span>
              <div><small style={{ display: 'block', color: content.accent, fontFamily: bodyFontFamily, fontSize: story ? 13 : 10, fontWeight: 900, letterSpacing: '0.13em' }}>ATRITO 0{index + 1}</small><strong style={{ display: 'block', marginTop: 8, color: '#fff', fontFamily: displayFontFamily, fontSize: story ? 31 : 27, fontWeight: 630, letterSpacing: '-0.035em' }}>{item}</strong></div>
              <ArrowUpRight size={story ? 28 : 22} color="rgba(255,255,255,0.42)" />
              <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: index === 1 ? content.accent : 'rgba(255,255,255,0.11)', boxShadow: index === 1 ? `0 0 18px ${content.accent}` : undefined }} />
            </div>
          );
        })}
        <svg width="100%" height="100%" viewBox="0 0 800 620" style={{ position: 'absolute', inset: 0, zIndex: -1, overflow: 'visible', opacity: 0.42 }}>
          <path d="M80 70 C 610 80, 180 300, 690 310 S 210 540, 700 555" fill="none" stroke={content.accent} strokeWidth="3" strokeDasharray="9 14" strokeDashoffset={-frame * 1.4} />
        </svg>
      </div>
    </AbsoluteFill>
  );
};
