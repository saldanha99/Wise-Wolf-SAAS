import React from 'react';
import { Check, MousePointer2 } from 'lucide-react';
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { FILM_CAPTURES } from '../filmAssets';

const CAMERA_FOCUS: Record<string, Array<{ x: number; y: number; scale: number }>> = {
  'library-native.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 63, y: 50, scale: 1.14 },
    { x: 74, y: 55, scale: 1.22 },
  ],
  'student-materials.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 58, y: 50, scale: 1.16 },
    { x: 64, y: 54, scale: 1.2 },
  ],
  'planner-native.png': [
    { x: 42, y: 48, scale: 1.04 },
    { x: 28, y: 54, scale: 1.2 },
    { x: 70, y: 54, scale: 1.16 },
  ],
  'wolfie-interview.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 72, y: 48, scale: 1.13 },
    { x: 54, y: 58, scale: 1.2 },
  ],
  'wolfie-business.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 72, y: 47, scale: 1.14 },
    { x: 52, y: 58, scale: 1.18 },
  ],
  'wolfie-medical.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 72, y: 47, scale: 1.14 },
    { x: 52, y: 58, scale: 1.18 },
  ],
  'director-dashboard.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 56, y: 54, scale: 1.12 },
    { x: 68, y: 58, scale: 1.2 },
  ],
  'school-crm.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 60, y: 44, scale: 1.15 },
    { x: 70, y: 52, scale: 1.22 },
  ],
  'school-agenda.png': [
    { x: 50, y: 48, scale: 1.02 },
    { x: 65, y: 50, scale: 1.16 },
    { x: 76, y: 56, scale: 1.23 },
  ],
  'school-branding.png': [
    { x: 54, y: 38, scale: 1.03 },
    { x: 66, y: 34, scale: 1.14 },
    { x: 80, y: 38, scale: 1.2 },
  ],
};

const getFocus = (file: string, progress: number) => {
  const points = CAMERA_FOCUS[file] ?? [
    { x: 50, y: 50, scale: 1.02 },
    { x: 58, y: 52, scale: 1.12 },
    { x: 66, y: 54, scale: 1.18 },
  ];
  const segment = Math.min(points.length - 2, Math.floor(progress * (points.length - 1)));
  const local = progress * (points.length - 1) - segment;
  const from = points[segment];
  const to = points[segment + 1];
  return {
    x: from.x + (to.x - from.x) * local,
    y: from.y + (to.y - from.y) * local,
    scale: from.scale + (to.scale - from.scale) * local,
  };
};

export const NativeInterfaceTour: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  durationInFrames: number;
}> = ({ content, format, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const story = format === 'story';
  const captures = FILM_CAPTURES[content.slug];
  const beat = Math.max(1, Math.floor(durationInFrames / captures.length));
  const activeIndex = Math.min(captures.length - 1, Math.floor(frame / beat));
  const capture = captures[activeIndex];
  const localFrame = frame - activeIndex * beat;
  const localProgress = interpolate(localFrame, [0, Math.max(1, beat - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });
  const focus = getFocus(capture.file, localProgress);
  const reveal = spring({ frame: localFrame, fps, config: { damping: 21, stiffness: 94, mass: 0.9 } });
  const cursorPulse = 1 + Math.sin(localFrame / 4.2) * 0.08;
  const cursorX = interpolate(localProgress, [0, 0.42, 1], story ? [45, 66, 56] : [38, 61, 73], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cursorY = interpolate(localProgress, [0, 0.48, 1], story ? [66, 44, 58] : [68, 48, 60], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#06070a' }}>
      {captures.map((item, index) => {
        const distanceBehind = activeIndex - index;
        if (distanceBehind < 0 || distanceBehind > 1) return null;
        const entering = index === activeIndex ? reveal : 1 - reveal;
        return (
          <div
            key={item.file}
            style={{
              position: 'absolute',
              inset: 0,
              opacity: index === activeIndex ? entering : entering * 0.5,
              translate: `${index === activeIndex ? (1 - reveal) * (story ? 110 : 180) : -reveal * (story ? 80 : 140)}px 0`,
            }}
          >
            <Img
              src={staticFile(`assets/hub/videos/native/${item.file}`)}
              style={{
                position: 'absolute',
                inset: story ? '-3% -26%' : '-8% -2%',
                width: story ? '152%' : '104%',
                height: story ? '106%' : '116%',
                objectFit: 'cover',
                objectPosition: index === activeIndex ? `${focus.x}% ${focus.y}%` : '50% 50%',
                scale: index === activeIndex ? (story ? focus.scale * 1.02 : focus.scale) : 1.02,
                filter: 'saturate(0.96) contrast(1.06) brightness(0.9)',
              }}
            />
          </div>
        );
      })}

      <div style={{ position: 'absolute', inset: 0, background: story ? 'linear-gradient(180deg, rgba(3,4,7,0.18), transparent 42%, rgba(3,4,7,0.93))' : 'linear-gradient(180deg, rgba(3,4,7,0.08), transparent 52%, rgba(3,4,7,0.9))' }} />
      <div style={{ position: 'absolute', inset: 0, boxShadow: `inset 0 0 ${story ? 110 : 80}px rgba(2,3,6,0.7), inset 0 -180px 160px rgba(2,3,6,0.55)` }} />

      <div style={{
        position: 'absolute',
        left: story ? 28 : 30,
        right: story ? 28 : 30,
        top: story ? 26 : 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 18,
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          border: '1px solid rgba(255,255,255,0.16)',
          borderRadius: 999,
          background: 'rgba(4,6,10,0.84)',
          color: '#fff',
          padding: story ? '11px 14px' : '9px 13px',
          fontFamily: bodyFontFamily,
          fontSize: story ? 13 : 10,
          fontWeight: 850,
          letterSpacing: '0.1em',
        }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: content.accent, boxShadow: `0 0 16px ${content.accent}` }} />
          TELA NATIVA · TOUR GUIADO
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          {captures.map((item, index) => (
            <span key={item.file} style={{ width: index === activeIndex ? (story ? 38 : 34) : 8, height: 8, borderRadius: 999, background: index === activeIndex ? content.accent : 'rgba(255,255,255,0.2)', boxShadow: index === activeIndex ? `0 0 14px ${content.accent}` : undefined }} />
          ))}
        </div>
      </div>

      <div style={{
        position: 'absolute',
        left: `${cursorX}%`,
        top: `${cursorY}%`,
        width: story ? 50 : 42,
        height: story ? 50 : 42,
        display: 'grid',
        placeItems: 'center',
        border: `1px solid ${content.accent}a8`,
        borderRadius: '50%',
        background: `${content.accent}26`,
        boxShadow: `0 0 0 ${story ? 12 : 10}px ${content.accent}12, 0 0 36px ${content.accent}72`,
        color: '#fff',
        scale: cursorPulse,
        translate: '-50% -50%',
      }}>
        <MousePointer2 size={story ? 23 : 19} fill="rgba(255,255,255,0.9)" />
      </div>

      <div style={{
        position: 'absolute',
        left: story ? 32 : 34,
        right: story ? 32 : 34,
        bottom: story ? 34 : 28,
        display: 'flex',
        alignItems: 'end',
        justifyContent: 'space-between',
        gap: 26,
        opacity: reveal,
        translate: `0 ${(1 - reveal) * 30}px`,
      }}>
        <div>
          <small style={{ display: 'block', color: content.accent, fontFamily: bodyFontFamily, fontSize: story ? 13 : 10, fontWeight: 900, letterSpacing: '0.13em' }}>{capture.focus}</small>
          <strong style={{ display: 'block', marginTop: 7, color: '#fff', fontFamily: displayFontFamily, fontSize: story ? 36 : 31, fontWeight: 680, letterSpacing: '-0.045em' }}>{capture.label}</strong>
          <span style={{ display: 'block', marginTop: 6, color: 'rgba(255,255,255,0.68)', fontFamily: bodyFontFamily, fontSize: story ? 16 : 13, fontWeight: 620 }}>{capture.detail}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', borderRadius: 999, background: `${content.accent}1f`, color: '#fff', padding: story ? '11px 13px' : '9px 12px', fontFamily: bodyFontFamily, fontSize: story ? 12 : 10, fontWeight: 820 }}>
          <Check size={story ? 17 : 14} color={content.accent} /> FLUXO REAL
        </div>
      </div>
    </div>
  );
};
