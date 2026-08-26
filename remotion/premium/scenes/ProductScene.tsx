import React from 'react';
import { Check, MousePointer2 } from 'lucide-react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../../brand/fonts';
import { BrandBackground } from '../../components/BrandBackground';
import type { HubVideoContent, HubVideoFormat } from '../../types';
import { FilmChrome } from '../components/FilmChrome';
import { InterfaceStage } from '../components/InterfaceStage';

const TOUR_LABELS: Record<HubVideoContent['mockup'], string[]> = {
  ecosystem: ['Ensinar', 'Planejar', 'Engajar', 'Operar'],
  library: ['Buscar', 'Filtrar', 'Abrir', 'Levar à aula'],
  educator: ['Definir resultado', 'Dar contexto', 'Estruturar', 'Adaptar'],
  wolfie: ['Escolher cenário', 'Conversar', 'Receber retorno', 'Repetir'],
  school: ['Atrair', 'Matricular', 'Coordenar', 'Renovar'],
};

export const ProductScene: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  durationInFrames: number;
}> = ({ content, format, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const story = format === 'story';
  const labels = TOUR_LABELS[content.mockup];
  const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const active = Math.min(labels.length - 1, Math.floor(progress * labels.length));
  const titleReveal = spring({ frame: frame - 2, fps, config: { damping: 20, stiffness: 102 } });

  return (
    <AbsoluteFill style={{ overflow: 'hidden', background: '#07080b' }}>
      <BrandBackground accent={content.accent} secondaryAccent={content.secondaryAccent} intensity={0.82} />
      <FilmChrome content={content} format={format} label="Tour guiado da plataforma" />

      <div style={{
        position: 'absolute',
        zIndex: 24,
        left: story ? 58 : 86,
        right: story ? 58 : 86,
        top: story ? 202 : 84,
        display: story ? 'block' : 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 28,
        opacity: titleReveal,
        translate: `0 ${(1 - titleReveal) * 28}px`,
      }}>
        <div>
          <small style={{ color: content.accent, fontFamily: bodyFontFamily, fontSize: story ? 16 : 11, fontWeight: 900, letterSpacing: '0.14em' }}>O PRODUTO ENTRA NA ROTINA</small>
          <h2 style={{ margin: story ? '14px 0 0' : '9px 0 0', maxWidth: story ? 880 : undefined, color: '#fff', fontFamily: displayFontFamily, fontSize: story ? 54 : 39, fontWeight: 650, lineHeight: story ? 1.02 : undefined, letterSpacing: '-0.05em', textWrap: 'balance' }}>{content.productHeadline}</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: story ? 'fit-content' : undefined, marginTop: story ? 18 : 0, border: `1px solid ${content.accent}4f`, borderRadius: 999, background: `${content.accent}14`, color: '#fff', padding: story ? '10px 15px' : '10px 14px', fontFamily: bodyFontFamily, fontSize: story ? 13 : 11, fontWeight: 800 }}><MousePointer2 size={story ? 18 : 16} color={content.accent} /> Fluxo demonstrado na interface</div>
      </div>

      <InterfaceStage content={content} format={format} mode="product" durationInFrames={durationInFrames} />

      <div style={{
        position: 'absolute',
        zIndex: 25,
        left: story ? 58 : 164,
        right: story ? 58 : 164,
        bottom: story ? 338 : 154,
        display: 'grid',
        gridTemplateColumns: story ? 'repeat(2, 1fr)' : `repeat(${labels.length}, 1fr)`,
        gap: story ? 14 : 10,
      }}>
        {labels.map((label, index) => {
          const reveal = spring({ frame: frame - 14 - index * 4, fps, config: { damping: 18, stiffness: 120 } });
          const selected = active === index;
          return (
            <div key={label} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              minHeight: story ? 68 : 54,
              border: `1px solid ${selected ? `${content.accent}7a` : 'rgba(255,255,255,0.11)'}`,
              borderRadius: story ? 20 : 16,
              background: selected ? `${content.accent}20` : 'rgba(7,8,11,0.78)',
              color: selected ? '#fff' : 'rgba(255,255,255,0.57)',
              padding: story ? '0 16px' : '0 13px',
              fontFamily: bodyFontFamily,
              fontSize: story ? 14 : 11,
              fontWeight: 800,
              boxShadow: selected ? `0 18px 46px rgba(0,0,0,0.32), 0 0 28px ${content.accent}20` : undefined,
              opacity: reveal,
              scale: selected ? 1.025 : 1,
              translate: `0 ${(1 - reveal) * 18}px`,
            }}><span style={{ display: 'grid', width: story ? 32 : 26, height: story ? 32 : 26, placeItems: 'center', borderRadius: 10, background: selected ? content.accent : 'rgba(255,255,255,0.07)', color: '#fff' }}>{selected ? <Check size={story ? 18 : 14} /> : String(index + 1).padStart(2, '0')}</span>{label}</div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
