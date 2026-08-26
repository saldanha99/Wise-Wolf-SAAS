import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily, displayFontFamily } from '../brand/fonts';
import { adBrand, textOnImageShadow } from '../brand/tokens';
import { Backdrop } from '../components/Backdrop';
import { EvidenceStage } from '../components/EvidenceStage';
import { fs, type AdLayout } from '../components/layout';
import { Lockup } from '../components/Lockup';
import { Headline, Kicker, Points } from '../components/Typo';
import type { AdScript } from '../types';

type BeatProps = {
  script: AdScript;
  layout: AdLayout;
  durationInFrames: number;
};

/**
 * Bloco de texto posicionado dentro da zona segura, abaixo da faixa da marca.
 *
 * A âncora é `layout.contentTop`, não `layout.safe.y`: entre os dois existe a faixa
 * reservada ao logotipo de canto. Ancorar no topo da zona segura é o que faz o texto
 * atropelar a marca.
 */
const TextColumn: React.FC<{ layout: AdLayout; children: React.ReactNode; align?: 'top' | 'center' }> = ({
  layout,
  children,
  align = 'top',
}) => (
  <div
    style={{
      position: 'absolute',
      zIndex: 30,
      left: layout.safe.x,
      top: layout.contentTop,
      width: layout.stacked ? layout.safe.width : layout.safe.width * 0.44,
      height: layout.contentHeight,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: align === 'center' ? 'center' : 'flex-start',
    }}
  >
    {children}
  </div>
);

/**
 * BATIDA 1 — o gancho. 0 a ~3,5s.
 *
 * É a única batida em que o texto ocupa o quadro inteiro: nos três primeiros segundos a
 * pessoa decide se para o dedo, e dividir a atenção com uma tela de produto aí desperdiça
 * o único momento garantido de audiência.
 */
export const HookBeat: React.FC<BeatProps> = ({ script, layout, durationInFrames }) => {
  const frame = useCurrentFrame();
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 9), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <Backdrop
        file={script.backdrop}
        layout={layout}
        accent={script.accent}
        durationInFrames={durationInFrames}
        anchor={layout.vertical ? 'center' : 'right'}
        shade={0.7}
      />
      <TextColumn layout={layout} align="center">
        <Kicker layout={layout} accent={script.accent}>
          {script.hookKicker}
        </Kicker>
        <Headline
          layout={layout}
          accent={script.accent}
          line={script.hookLine}
          emphasis={script.hookEmphasis}
          size={layout.vertical ? 96 : 86}
        />
      </TextColumn>
    </AbsoluteFill>
  );
};

/** BATIDA 2 — a virada. O que muda, em três pontos. */
export const TurnBeat: React.FC<BeatProps> = ({ script, layout, durationInFrames }) => {
  const frame = useCurrentFrame();
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 9), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      <Backdrop
        file={script.backdrop}
        layout={layout}
        accent={script.accent}
        durationInFrames={durationInFrames}
        anchor={layout.vertical ? 'center' : 'right'}
        shade={0.74}
      />
      <TextColumn layout={layout} align="center">
        <Headline
          layout={layout}
          accent={script.accent}
          line={script.turnHeadline}
          size={layout.vertical ? 72 : 66}
        />
        <Points layout={layout} accent={script.accent} items={script.turnPoints} delay={10} />
      </TextColumn>
    </AbsoluteFill>
  );
};

/** BATIDA 3 — a prova. Aqui a interface aparece e o texto encolhe para dar lugar a ela. */
export const ProofBeat: React.FC<BeatProps> = ({ script, layout, durationInFrames }) => {
  const frame = useCurrentFrame();
  const exit = interpolate(frame, [Math.max(0, durationInFrames - 9), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.in(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ opacity: exit }}>
      {/* O fundo continua sendo imagem, não preto: a área reservada da Meta é coberta pela
          interface do app, e deixá-la preta desperdiça o quadro em quem assiste no feed,
          onde a sobreposição é menor. Só o TEXTO precisa ficar fora dela — o pixel, não. */}
      <Backdrop
        file={script.backdrop}
        layout={layout}
        accent={script.accent}
        durationInFrames={durationInFrames}
        anchor={layout.vertical ? 'center' : 'left'}
        shade={0.82}
      />
      <div
        style={{
          position: 'absolute',
          zIndex: 30,
          left: layout.safe.x,
          top: layout.contentTop,
          width: layout.stacked ? layout.safe.width : layout.safe.width * 0.42,
        }}
      >
        <Kicker layout={layout} accent={script.accent}>
          {script.front === 'aluno' ? 'Como funciona' : 'Na prática'}
        </Kicker>
        <Headline
          layout={layout}
          accent={script.accent}
          line={script.proofHeadline}
          size={layout.vertical ? 62 : 58}
        />
      </div>
      <EvidenceStage
        evidence={script.evidence}
        layout={layout}
        accent={script.accent}
        durationInFrames={durationInFrames}
      />
    </AbsoluteFill>
  );
};

/** BATIDA 4 — a ação. Marca, promessa e destino. */
export const CtaBeat: React.FC<BeatProps> = ({ script, layout, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const reveal = spring({ frame: frame - 2, fps, config: { damping: 19, stiffness: 98, mass: 0.9 } });
  const button = spring({ frame: frame - 12, fps, config: { damping: 17, stiffness: 112 } });
  const pulse = 1 + Math.sin(frame / 17) * 0.014;
  const glow = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0.4, 0.78], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ background: adBrand.background, overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          opacity: glow,
          background: `radial-gradient(circle at 50% 46%, ${script.accent}33, transparent 42%)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          zIndex: 30,
          left: layout.safe.x,
          top: layout.safe.y,
          width: layout.safe.width,
          height: layout.safe.height,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          opacity: reveal,
          translate: `0 ${(1 - reveal) * 32}px`,
        }}
      >
        <Lockup layout={layout} />

        <h2
          style={{
            margin: `${fs(layout, 30, 12)}px 0 0`,
            maxWidth: layout.safe.width,
            color: adBrand.ink,
            fontFamily: displayFontFamily,
            fontSize: fs(layout, layout.vertical ? 78 : 70, 26),
            fontWeight: 700,
            lineHeight: 0.99,
            letterSpacing: '-0.05em',
            textWrap: 'balance',
            textShadow: textOnImageShadow,
          }}
        >
          {script.ctaHeadline}
        </h2>

        <p
          style={{
            margin: `${fs(layout, 18, 8)}px 0 0`,
            maxWidth: layout.safe.width * 0.9,
            color: 'rgba(255,255,255,0.74)',
            fontFamily: bodyFontFamily,
            fontSize: fs(layout, 28, 13),
            lineHeight: 1.4,
          }}
        >
          {script.ctaSupport}
        </p>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: fs(layout, 12, 6),
            minHeight: fs(layout, 78, 34),
            marginTop: fs(layout, 34, 14),
            padding: `0 ${fs(layout, 40, 18)}px`,
            borderRadius: 999,
            background: `linear-gradient(135deg, ${script.accent}, ${script.secondaryAccent})`,
            boxShadow: `0 26px 74px ${script.accent}55`,
            color: '#fff',
            fontFamily: bodyFontFamily,
            fontSize: fs(layout, 30, 14),
            fontWeight: 800,
            letterSpacing: '-0.01em',
            opacity: button,
            scale: String(button * pulse),
          }}
        >
          {script.ctaButton}
        </div>

        <div
          style={{
            marginTop: fs(layout, 26, 10),
            color: 'rgba(255,255,255,0.6)',
            fontFamily: bodyFontFamily,
            fontSize: fs(layout, 24, 11),
            fontWeight: 700,
          }}
        >
          {script.destination}
        </div>
      </div>
    </AbsoluteFill>
  );
};
