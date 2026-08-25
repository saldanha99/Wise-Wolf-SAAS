import React from 'react';
import { Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../brand/fonts';
import type { HubVideoContent, HubVideoSlug } from '../types';

type NativeCapture = {
  file: string;
  label: string;
  position?: string;
};

const CAPTURES: Record<HubVideoSlug, NativeCapture[]> = {
  'hub-overview': [],
  library: [],
  'educator-ai': [],
  wolfie: [
    { file: 'wolfie-interview.png', label: 'Entrevista profissional' },
    { file: 'wolfie-business.png', label: 'Reunião internacional' },
  ],
  'school-os': [],
};

const STARTS: Record<HubVideoSlug, number[]> = {
  'hub-overview': [],
  library: [],
  'educator-ai': [],
  wolfie: [78, 186],
  'school-os': [],
};

export const NativeCaptureMontage: React.FC<{ content: HubVideoContent }> = ({ content }) => {
  const frame = useCurrentFrame();
  const captures = CAPTURES[content.slug];
  const starts = STARTS[content.slug];
  const duration = content.slug === 'school-os' ? 28 : content.slug === 'hub-overview' ? 30 : 36;

  return (
    <>
      {captures.map((capture, index) => {
        const start = starts[index];
        const end = start + duration;
        const opacity = interpolate(frame, [start, start + 6, end - 7, end], [0, 1, 1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: [Easing.out(Easing.cubic), Easing.linear, Easing.in(Easing.cubic)],
        });
        if (opacity <= 0.001) return null;
        const reveal = interpolate(frame, [start, start + 9], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.out(Easing.cubic),
        });
        const localProgress = interpolate(frame, [start, end], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const scan = interpolate(localProgress, [0, 1], [-14, 112]);

        return (
          <div
            key={`${capture.file}-${index}`}
            style={{
              position: 'absolute',
              zIndex: 58,
              left: 82,
              right: 82,
              top: 118,
              bottom: 198,
              overflow: 'hidden',
              border: `1px solid ${content.accent}8a`,
              borderRadius: 32,
              background: '#06070a',
              boxShadow: `0 48px 140px rgba(0,0,0,0.72), 0 0 88px ${content.accent}38`,
              opacity,
              clipPath: `inset(${(1 - reveal) * 2}% ${(1 - reveal) * 44}% round 32px)`,
              scale: 0.965 + reveal * 0.035,
              rotate: `${(1 - reveal) * (index % 2 === 0 ? -0.8 : 0.8)}deg`,
            }}
          >
            <Img
              src={staticFile(`assets/hub/videos/native/${capture.file}`)}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: capture.position || 'center',
                scale: 1.025 + localProgress * 0.045,
                translate: `${(index % 2 === 0 ? -1 : 1) * localProgress * 14}px 0`,
                filter: 'saturate(0.92) contrast(1.04)',
              }}
            />
            <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(3,4,7,0.08), transparent 58%, rgba(3,4,7,0.72))' }} />
            <div style={{ position: 'absolute', left: `${scan}%`, top: -160, width: 150, height: 1100, background: `linear-gradient(90deg, transparent, ${content.accent}35, rgba(255,255,255,0.22), transparent)`, filter: 'blur(10px)', rotate: '8deg' }} />
            <div style={{ position: 'absolute', left: 24, top: 22, display: 'flex', alignItems: 'center', gap: 10, border: '1px solid rgba(255,255,255,0.15)', borderRadius: 999, background: 'rgba(5,7,11,0.84)', color: '#fff', padding: '9px 13px', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 850, letterSpacing: '0.08em', textTransform: 'uppercase', backdropFilter: 'blur(18px)' }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: content.accent, boxShadow: `0 0 14px ${content.accent}` }} />
              Interface do produto
            </div>
            <div style={{ position: 'absolute', left: 30, right: 30, bottom: 24, display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 20 }}>
              <div>
                <small style={{ display: 'block', color: content.accent, fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 900, letterSpacing: '0.13em', textTransform: 'uppercase' }}>Wise Wolf em funcionamento</small>
                <strong style={{ display: 'block', marginTop: 6, color: '#fff', fontFamily: displayFontFamily, fontSize: 32, fontWeight: 720, letterSpacing: '-0.045em' }}>{capture.label}</strong>
              </div>
              <span style={{ color: 'rgba(255,255,255,0.64)', fontFamily: bodyFontFamily, fontSize: 10, fontWeight: 750 }}>dados fictícios de demonstração</span>
            </div>
          </div>
        );
      })}
    </>
  );
};
