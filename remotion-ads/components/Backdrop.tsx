import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { adBrand } from '../brand/tokens';
import type { AdLayout } from './layout';

/**
 * Fundo cinematográfico com push-in lento.
 *
 * O movimento é de câmera, não de elemento: a imagem cresce uns poucos por cento ao longo
 * da batida inteira. Movimento rápido em fundo rouba a atenção do texto, que é quem
 * carrega a mensagem quando o vídeo roda sem som.
 */
export const Backdrop: React.FC<{
  file?: string;
  layout: AdLayout;
  accent: string;
  durationInFrames: number;
  /** Direção do enquadramento: qual terço da imagem fica visível no vertical. */
  anchor?: 'left' | 'center' | 'right';
  /** Escurecimento sobre a imagem, para o texto ter contraste garantido. */
  shade?: number;
}> = ({ file, layout, accent, durationInFrames, anchor = 'center', shade = 0.62 }) => {
  const frame = useCurrentFrame();

  const push = interpolate(frame, [0, Math.max(1, durationInFrames)], [1.06, 1.14], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const fade = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const objectPosition = anchor === 'left' ? '22% center' : anchor === 'right' ? '78% center' : 'center';

  // No vertical o texto ocupa a metade de cima e a prova a de baixo, então o degradê
  // escurece as duas pontas e deixa o miolo respirar. No horizontal escurece a esquerda,
  // onde o texto mora.
  const gradient = layout.vertical
    ? `linear-gradient(180deg, rgba(5,6,9,${shade + 0.24}) 0%, rgba(5,6,9,${shade - 0.16}) 42%, rgba(5,6,9,${shade + 0.3}) 100%)`
    : `linear-gradient(90deg, rgba(5,6,9,${shade + 0.28}) 0%, rgba(5,6,9,${shade - 0.06}) 52%, rgba(5,6,9,${shade + 0.12}) 100%)`;

  return (
    <AbsoluteFill style={{ background: adBrand.background, overflow: 'hidden' }}>
      {file && (
        <AbsoluteFill style={{ opacity: fade }}>
          <Img
            src={staticFile(file)}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              objectPosition,
              scale: String(push),
            }}
          />
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ background: gradient }} />
      {/* Brilho de acento, muito discreto: dá identidade cromática sem virar filtro colorido. */}
      <AbsoluteFill
        style={{
          background: layout.vertical
            ? `radial-gradient(circle at 50% 26%, ${accent}1f, transparent 46%)`
            : `radial-gradient(circle at 26% 46%, ${accent}1f, transparent 44%)`,
        }}
      />
      {/* Vinheta: segura o olho no centro. */}
      <AbsoluteFill style={{ boxShadow: 'inset 0 0 220px rgba(0,0,0,0.62)' }} />
    </AbsoluteFill>
  );
};
