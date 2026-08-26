import React from 'react';
import { Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily } from '../brand/fonts';
import type { AdEvidence } from '../types';
import { fs, type AdLayout } from './layout';
import { PRODUCT_PANELS } from './product/ProductPanels';

/**
 * A prova visual.
 *
 * Cada peça fica em tela o tempo suficiente para ser lida — abaixo de ~1,2s a pessoa vê
 * um piscar, não uma prova. Por isso o número de peças por anúncio é baixo (2 ou 3) e o
 * corte é cross-dissolve curto em vez de corte seco: em anúncio de 20s, corte seco entre
 * telas de interface lê como ruído.
 *
 * O rótulo NÃO descreve intenção ("Biblioteca em funcionamento"), descreve o que está no
 * pixel. O filme institucional escreve "Biblioteca em funcionamento." por cima de uma tela
 * que diz "Nenhum material na biblioteca ainda" — é o tipo de contradição que o espectador
 * percebe e que custa a confiança da peça inteira.
 */
export const EvidenceStage: React.FC<{
  evidence: AdEvidence[];
  layout: AdLayout;
  accent: string;
  durationInFrames: number;
  showLabels?: boolean;
}> = ({ evidence, layout, accent, durationInFrames, showLabels = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame: frame - 3, fps, config: { damping: 20, stiffness: 92, mass: 0.9 } });
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 10), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  const count = Math.max(1, evidence.length);
  // declarado antes do uso no corpo do JSX
  const per = durationInFrames / count;
  const activeIndex = Math.min(count - 1, Math.floor(frame / per));
  const localFrame = frame - activeIndex * per;
  const fadeIn = interpolate(localFrame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const active = evidence[activeIndex];

  // Enquadramento. No vertical e no feed a prova ocupa a metade de baixo da região de
  // conteúdo; no horizontal, a coluna da direita. A referência é `contentTop`/`contentHeight`
  // (já sem a faixa da marca) e a altura para no rodapé da zona segura, deixando o espaço
  // da legenda livre — sem isso o rótulo da tela e a legenda se sobrepõem.
  const captionBand = fs(layout, 108, 48);
  const box = layout.stacked
    ? {
        left: layout.safe.x,
        width: layout.safe.width,
        top: layout.contentTop + layout.contentHeight * 0.42,
        height: layout.contentHeight * 0.58 - captionBand,
      }
    : {
        left: layout.safe.x + layout.safe.width * 0.46,
        width: layout.safe.width * 0.54,
        top: layout.contentTop,
        height: layout.contentHeight - captionBand,
      };

  const drift = Math.sin(frame / 78) * 5;

  // Os painéis do produto são dimensionados pela ALTURA da caixa, não pela largura do
  // quadro. `layout.scale` cresce com a largura útil, e no 16:9 ela é grande enquanto a
  // altura disponível é pequena — dimensionar pela largura ali corta o painel ao meio
  // (era o que acontecia com o funil, que perdia a última etapa).
  const PANEL_REFERENCE_HEIGHT = 420;
  const panelLayout = {
    ...layout,
    scale: Math.min(layout.scale, box.height / PANEL_REFERENCE_HEIGHT),
  };

  return (
    <div
      style={{
        position: 'absolute',
        zIndex: 20,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        borderRadius: fs(layout, 28, 12),
        overflow: 'hidden',
        border: `1px solid ${active?.panel ? 'rgba(255,255,255,0.16)' : `${accent}55`}`,
        background: active?.panel ? '#ffffff' : '#080a0f',
        boxShadow: `0 50px 130px rgba(0,0,0,0.6), 0 0 80px ${accent}22`,
        opacity: enter * exit,
        scale: String(0.965 + enter * 0.035),
        translate: `0 ${(1 - enter) * 40 + drift}px`,
      }}
    >
      {evidence.map((item, index) => {
        const visible = index === activeIndex;
        if (item.panel) {
          const PanelComponent = PRODUCT_PANELS[item.panel];
          return (
            <div
              key={`${item.panel}-${index}`}
              style={{
                position: 'absolute',
                inset: 0,
                opacity: visible ? fadeIn : 0,
                // O painel do produto é interface, não fotografia: nada de push-in nele,
                // que borraria texto pequeno. Só a entrada.
                scale: String(visible ? 0.99 + fadeIn * 0.01 : 0.99),
              }}
            >
              <PanelComponent layout={panelLayout} />
            </div>
          );
        }
        if (!item.file) return null;
        return (
          <Img
            key={item.file}
            src={staticFile(item.file)}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition: item.focus ? `${item.focus.x * 100}% ${item.focus.y * 100}%` : 'center top',
              opacity: visible ? fadeIn : 0,
              scale: String(1.02 + (visible ? localFrame / 4200 : 0)),
            }}
          />
        );
      })}

      {/* Degradê e rótulo só valem para IMAGEM. Painel de produto já tem cabeçalho
          próprio com título e badge — sobrepor mais uma tarja ali só suja a tela. */}
      {!active?.panel && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, rgba(4,5,8,0.82) 0%, transparent 34%, transparent 100%)',
          }}
        />
      )}

      {showLabels && !active?.panel && (
        <div
          style={{
            position: 'absolute',
            left: fs(layout, 22, 9),
            top: fs(layout, 18, 8),
            maxWidth: '86%',
            padding: `${fs(layout, 7, 3)}px ${fs(layout, 14, 6)}px`,
            borderRadius: 999,
            background: 'rgba(6,7,11,0.62)',
            border: '1px solid rgba(255,255,255,0.10)',
            color: 'rgba(255,255,255,0.92)',
            fontFamily: bodyFontFamily,
            fontSize: fs(layout, 21, 10),
            fontWeight: 650,
            opacity: fadeIn,
          }}
        >
          {evidence[activeIndex]?.reads}
        </div>
      )}
    </div>
  );
};
