import React from 'react';
import { interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily } from '../brand/fonts';
import { captionAnchorFor } from '../meta/safeAreas';
import type { AdCaption } from '../types';
import { fs, type AdLayout } from './layout';

/**
 * Legenda queimada, ancorada ao RODAPÉ DA ZONA SEGURA.
 *
 * É aqui que o pipeline institucional erra: `remotion/components/CaptionLayer.tsx:56` usa
 * `bottom: 122` no formato story. Em 1080x1920 a Meta reserva 672px de base para a própria
 * interface (curtir, comentar, compartilhar, legenda do criador e botão de CTA), então
 * aquela legenda fica 550px dentro da área tapada. Aqui o rodapé vem de `captionAnchorFor`,
 * que devolve exatamente o limite inferior da zona segura.
 *
 * A legenda é obrigatória num anúncio: mesmo com o Reels iniciando com som ligado, boa
 * parte do público assiste em silêncio ou com o áudio abafado.
 */

const MAX_CHARS_PER_PAGE = 42;

export type CaptionPage = {
  startSeconds: number;
  endSeconds: number;
  words: Array<{ text: string; startSeconds: number; endSeconds: number }>;
};

/** Agrupa as legendas em páginas curtas, legíveis num relance. */
export const buildCaptionPages = (captions: AdCaption[]): CaptionPage[] => {
  const pages: CaptionPage[] = [];
  let current: CaptionPage | null = null;

  for (const caption of captions) {
    const word = {
      text: caption.text.trim(),
      startSeconds: caption.startSeconds,
      endSeconds: caption.endSeconds,
    };
    if (!word.text) continue;

    const wouldBe = current ? current.words.map((w) => w.text).join(' ').length + 1 + word.text.length : word.text.length;
    const breaksSentence = current && /[.!?]$/.test(current.words[current.words.length - 1]?.text ?? '');

    if (!current || wouldBe > MAX_CHARS_PER_PAGE || breaksSentence) {
      current = { startSeconds: word.startSeconds, endSeconds: word.endSeconds, words: [word] };
      pages.push(current);
      continue;
    }

    current.words.push(word);
    current.endSeconds = word.endSeconds;
  }

  return pages;
};

export const AdCaptions: React.FC<{
  captions: AdCaption[];
  layout: AdLayout;
  accent: string;
}> = ({ captions, layout, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const seconds = frame / fps;
  const anchor = captionAnchorFor(layout.format);

  const pages = React.useMemo(() => buildCaptionPages(captions), [captions]);
  const page = pages.find((p) => seconds >= p.startSeconds - 0.08 && seconds <= p.endSeconds + 0.32);
  if (!page) return null;

  const appear = interpolate(seconds, [page.startSeconds - 0.08, page.startSeconds + 0.14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fontSize = fs(layout, layout.vertical ? 46 : 42, 22);

  return (
    <div
      style={{
        position: 'absolute',
        zIndex: 70,
        left: anchor.left,
        right: anchor.right,
        bottom: anchor.bottom,
        display: 'flex',
        justifyContent: 'center',
        opacity: appear,
        translate: `0 ${(1 - appear) * 14}px`,
      }}
    >
      <div
        style={{
          maxWidth: layout.safe.width,
          padding: `${fs(layout, 16, 8)}px ${fs(layout, 26, 12)}px`,
          borderRadius: fs(layout, 22, 10),
          background: 'rgba(6,7,11,0.72)',
          backdropFilter: 'blur(18px)',
          border: '1px solid rgba(255,255,255,0.10)',
          boxShadow: '0 24px 70px rgba(0,0,0,0.45)',
          textAlign: 'center',
          textWrap: 'balance',
        }}
      >
        {page.words.map((word, index) => {
          const active = seconds >= word.startSeconds && seconds <= word.endSeconds;
          return (
            <span
              key={`${word.text}-${index}`}
              style={{
                display: 'inline-block',
                margin: `0 ${fs(layout, 5, 2)}px`,
                color: active ? '#fff' : 'rgba(255,255,255,0.80)',
                fontFamily: bodyFontFamily,
                fontSize,
                fontWeight: 750,
                lineHeight: 1.24,
                letterSpacing: '-0.012em',
                textShadow: active ? `0 0 26px ${accent}88` : 'none',
              }}
            >
              {word.text}
            </span>
          );
        })}
      </div>
    </div>
  );
};
