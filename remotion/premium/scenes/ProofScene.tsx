import React from 'react';
import { CheckCircle2, ShieldCheck } from 'lucide-react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import { BrandBackground } from '../../components/BrandBackground';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { FilmChrome } from '../components/FilmChrome';
import { RealScreenFilmstrip } from '../components/RealScreenFilmstrip';

export const ProofScene: React.FC<{
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
      <BrandBackground accent={content.accent} secondaryAccent={content.secondaryAccent} intensity={0.52} />
      <FilmChrome content={content} format={format} label="A interface é a prova" />

      <div style={{
        position: 'absolute',
        zIndex: 32,
        left: story ? 58 : 92,
        right: story ? 58 : 92,
        top: story ? 198 : 90,
        display: story ? 'block' : 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 28,
      }}>
        <div>
          <small style={{ color: content.accent, fontFamily: bodyFontFamily, fontSize: story ? 16 : 11, fontWeight: 900, letterSpacing: '0.14em' }}>PROVA VISUAL · TELAS DO PRODUTO</small>
          <h2 style={{ margin: story ? '14px 0 0' : '9px 0 0', maxWidth: story ? 900 : undefined, color: '#fff', fontFamily: displayFontFamily, fontSize: story ? 52 : 40, fontWeight: 650, lineHeight: story ? 1.02 : undefined, letterSpacing: '-0.05em', textWrap: 'balance' }}>{content.proofHeadline}</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, width: story ? 'fit-content' : undefined, marginTop: story ? 17 : 0, border: `1px solid ${content.accent}52`, borderRadius: 999, background: `${content.accent}17`, color: '#fff', padding: story ? '10px 15px' : '10px 14px', fontFamily: bodyFontFamily, fontSize: story ? 13 : 11, fontWeight: 820 }}><ShieldCheck size={story ? 18 : 16} color={content.accent} /> Dados fictícios, fluxo verdadeiro</div>
      </div>

      <RealScreenFilmstrip content={content} format={format} durationInFrames={durationInFrames} />

      <div style={{
        position: 'absolute',
        zIndex: 34,
        left: story ? 58 : 112,
        right: story ? 58 : 112,
        bottom: story ? 342 : 152,
        display: 'grid',
        gridTemplateColumns: story ? 'repeat(2, 1fr)' : `repeat(${Math.min(4, content.proofItems.length)}, 1fr)`,
        gap: story ? 14 : 12,
      }}>
        {content.proofItems.slice(0, 4).map((item, index) => {
          const reveal = spring({ frame: frame - 10 - index * 6, fps, config: { damping: 19, stiffness: 112 } });
          return (
            <div key={item} style={{
              display: 'flex',
              alignItems: 'center',
              gap: story ? 12 : 9,
              minHeight: story ? 68 : 58,
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: story ? 20 : 17,
              background: 'rgba(5,7,10,0.84)',
              boxShadow: `0 20px 56px rgba(0,0,0,0.34), inset 0 0 30px ${content.accent}0d`,
              color: '#fff',
              padding: story ? '0 16px' : '0 14px',
              fontFamily: bodyFontFamily,
              fontSize: story ? 13 : 11,
              fontWeight: 760,
              opacity: reveal,
              translate: `0 ${(1 - reveal) * 22}px`,
            }}><CheckCircle2 size={story ? 21 : 17} color={content.accent} />{item}</div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
