import { describe, expect, it } from 'vitest';
import { AD_FORMATS, AD_FORMAT_IDS } from './formats';
import { captionAnchorFor, isWithinSafeArea, safeAreaFor } from './safeAreas';
import { adLayoutFor } from '../components/layout';

// Estes testes existem por um motivo concreto: o pipeline institucional em `remotion/`
// posiciona a legenda queimada em `bottom: 122` no formato 9:16 (CaptionLayer.tsx:56),
// e a Meta reserva 35% da base — 672px em 1920. A legenda dos 5 filmes já renderizados
// fica 550px dentro da faixa coberta pela interface do Reels.
//
// Se alguém mexer nas frações ou nas âncoras aqui, estes testes quebram antes de sair
// anúncio com legenda tapada.

describe('zonas seguras da Meta', () => {
  it('reserva 14% do topo, 35% da base e 6% dos lados no 9:16', () => {
    const box = safeAreaFor('reels');
    expect(box.reserved.top).toBe(269); // 1920 * 0.14
    expect(box.reserved.bottom).toBe(672); // 1920 * 0.35
    expect(box.reserved.left).toBe(65); // 1080 * 0.06
    expect(box.reserved.right).toBe(65);
    expect(box.width).toBe(950);
    expect(box.height).toBe(979);
  });

  it('ancora a legenda no rodapé da ZONA SEGURA, não do quadro', () => {
    const anchor = captionAnchorFor('reels');
    // 1920 - (269 + 979) = 672: exatamente a faixa reservada.
    expect(anchor.bottom).toBe(672);
    // E é preciso estar MUITO acima do valor do pipeline institucional.
    expect(anchor.bottom).toBeGreaterThan(122);
  });

  it('não reserva 35% da base fora do 9:16 — só o Reels/Stories tem essa sobreposição', () => {
    expect(safeAreaFor('feed').reserved.bottom).toBeLessThan(safeAreaFor('reels').reserved.bottom);
    expect(safeAreaFor('wide').reserved.bottom).toBeLessThan(safeAreaFor('reels').reserved.bottom);
  });

  it.each(AD_FORMAT_IDS)('mantém a região de conteúdo dentro da zona segura em %s', (format) => {
    const layout = adLayoutFor(format);
    expect(
      isWithinSafeArea(format, {
        x: layout.safe.x,
        y: layout.contentTop,
        width: layout.safe.width,
        height: layout.contentHeight,
      }),
    ).toBe(true);
  });

  it.each(AD_FORMAT_IDS)('reserva a faixa da marca acima do conteúdo em %s', (format) => {
    const layout = adLayoutFor(format);
    // O conteúdo começa depois do logotipo: é isso que evita a colisão eyebrow/logo.
    expect(layout.contentTop).toBeGreaterThan(layout.safe.y + layout.markHeight);
    expect(layout.contentHeight).toBeLessThan(layout.safe.height);
  });

  it.each(AD_FORMAT_IDS)('não deixa a zona segura vazar do quadro em %s', (format) => {
    const { width, height } = AD_FORMATS[format];
    const box = safeAreaFor(format);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it('rejeita um elemento que invade a faixa reservada da base', () => {
    // Um elemento posicionado como a legenda do pipeline institucional (bottom: 122).
    const { height } = AD_FORMATS.reels;
    const elementHeight = 112;
    const y = height - 122 - elementHeight;
    expect(isWithinSafeArea('reels', { x: 65, y, width: 950, height: elementHeight })).toBe(false);
  });
});
