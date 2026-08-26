import React from 'react';
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { FILM_CAPTURES } from '../filmAssets';

export const RealScreenFilmstrip: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  durationInFrames: number;
}> = ({ content, format, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const story = format === 'story';
  const captures = FILM_CAPTURES[content.slug];
  const beat = Math.max(Math.round(fps * 2.15), Math.floor(durationInFrames / captures.length));
  const activeIndex = Math.min(captures.length - 1, Math.floor(frame / beat));
  const scan = interpolate(frame % beat, [0, beat], [-18, 114], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{
      position: 'absolute',
      zIndex: 20,
      left: story ? 48 : 76,
      right: story ? 48 : 76,
      top: story ? 458 : 166,
      height: story ? 776 : 690,
      overflow: 'hidden',
      border: `1px solid ${content.accent}68`,
      borderRadius: story ? 42 : 34,
      background: '#06070a',
      boxShadow: `0 52px 150px rgba(0,0,0,0.7), 0 0 96px ${content.accent}28`,
    }}>
      {captures.map((capture, index) => {
        const brandingCapture = capture.file === 'school-branding.png';
        const start = index * beat;
        const next = (index + 1) * beat;
        const opacity = index === activeIndex
          ? 1
          : interpolate(frame, [start - 8, start, next - 8, next], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
        const reveal = spring({ frame: frame - start, fps, config: { damping: 22, stiffness: 92 } });
        const localProgress = interpolate(frame, [start, Math.max(start + 1, next)], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.inOut(Easing.cubic),
        });
        if (opacity < 0.001) return null;

        return (
          <div key={capture.file} style={{ position: 'absolute', inset: 0, opacity }}>
            <Img
              src={staticFile(`assets/hub/videos/native/${capture.file}`)}
              style={{
                position: 'absolute',
                inset: story ? '0 0 auto' : 0,
                width: '100%',
                height: story ? 610 : '100%',
                objectFit: 'cover',
                objectPosition: brandingCapture ? 'center 18%' : 'center',
                scale: story
                  ? (brandingCapture ? 1.06 : 1.008) + localProgress * 0.018
                  : (brandingCapture ? 1.04 : 1.025) + localProgress * 0.035,
                translate: story ? `${(0.5 - localProgress) * 12}px 0` : `${(0.5 - localProgress) * 18}px 0`,
                filter: 'saturate(0.96) contrast(1.06)',
              }}
            />
            <div style={{ position: 'absolute', inset: 0, background: story ? 'linear-gradient(180deg, rgba(3,4,7,0.08), transparent 54%, rgba(3,4,7,0.94) 82%, #06070a)' : 'linear-gradient(180deg, rgba(3,4,7,0.08), transparent 56%, rgba(3,4,7,0.86))' }} />
            <div style={{ position: 'absolute', left: `${scan}%`, top: -220, width: 170, height: 1320, background: `linear-gradient(90deg, transparent, ${content.accent}3d, rgba(255,255,255,0.2), transparent)`, filter: 'blur(12px)', rotate: '8deg' }} />

            <div style={{
              position: 'absolute',
              left: story ? 24 : 34,
              top: story ? 22 : 28,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              border: '1px solid rgba(255,255,255,0.16)',
              borderRadius: 999,
              background: 'rgba(4,6,10,0.84)',
              color: '#fff',
              padding: story ? '10px 14px' : '9px 13px',
              fontFamily: bodyFontFamily,
              fontSize: story ? 12 : 10,
              fontWeight: 850,
              letterSpacing: '0.11em',
              textTransform: 'uppercase',
              opacity: reveal,
            }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: content.accent, boxShadow: `0 0 16px ${content.accent}` }} />
              TELA REAL · DADOS DE DEMONSTRAÇÃO
            </div>

            <div style={{
              position: 'absolute',
              left: story ? 34 : 42,
              right: story ? 34 : 42,
              bottom: story ? 30 : 34,
              display: 'flex',
              alignItems: 'end',
              justifyContent: 'space-between',
              gap: story ? 18 : 24,
              opacity: reveal,
              translate: `0 ${(1 - reveal) * 32}px`,
            }}>
              <div style={{ maxWidth: story ? '76%' : undefined }}>
                <small style={{ display: 'block', color: content.accent, fontFamily: bodyFontFamily, fontSize: story ? 13 : 11, fontWeight: 900, letterSpacing: '0.14em' }}>{capture.focus}</small>
                <strong style={{ display: 'block', marginTop: story ? 6 : 9, color: '#fff', fontFamily: displayFontFamily, fontSize: story ? 40 : 36, fontWeight: 680, lineHeight: 1, letterSpacing: '-0.045em' }}>{capture.label}</strong>
                <span style={{ display: 'block', marginTop: story ? 7 : 8, color: 'rgba(255,255,255,0.68)', fontFamily: bodyFontFamily, fontSize: story ? 17 : 14, fontWeight: 600 }}>{capture.detail}</span>
              </div>
              <div style={{ display: 'flex', flex: '0 0 auto', alignSelf: story ? 'end' : undefined, gap: 8, paddingBottom: story ? 8 : 0 }}>
                {captures.map((item, dotIndex) => <span key={item.file} style={{ width: dotIndex === index ? (story ? 48 : 38) : 9, height: 9, borderRadius: 999, background: dotIndex === index ? content.accent : 'rgba(255,255,255,0.2)', boxShadow: dotIndex === index ? `0 0 16px ${content.accent}` : undefined }} />)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};
