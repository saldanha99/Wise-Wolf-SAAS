import { AD_FORMATS, type AdFormatId } from '../meta/formats';
import { safeAreaFor, type SafeBox } from '../meta/safeAreas';

export type AdLayout = {
  format: AdFormatId;
  width: number;
  height: number;
  safe: SafeBox;
  /**
   * Escala tipográfica. A referência é a LARGURA DA ZONA SEGURA, não a largura do quadro:
   * em 9:16 a Meta come 6% de cada lado, então dimensionar pelo quadro produziria texto
   * grande demais para o espaço que sobra.
   */
  scale: number;
  vertical: boolean;
  /** Layout de coluna única (vertical e feed) ou de duas colunas (horizontal). */
  stacked: boolean;
  /** Altura reservada no topo da zona segura para a marca de canto. */
  markHeight: number;
  /** Topo da região de conteúdo: abaixo da marca, para nada colidir com o logotipo. */
  contentTop: number;
  /** Altura útil de conteúdo, já descontada a marca. */
  contentHeight: number;
};

const REFERENCE_SAFE_WIDTH = 950; // largura útil do 9:16, o formato mais apertado

export const adLayoutFor = (format: AdFormatId): AdLayout => {
  const { width, height } = AD_FORMATS[format];
  const safe = safeAreaFor(format);
  const scale = safe.width / REFERENCE_SAFE_WIDTH;

  // A marca fica DENTRO da zona segura (acima dela o app desenha foto e nome do perfil),
  // e o conteúdo começa abaixo dela. Foi exatamente essa reserva que faltou no pipeline
  // institucional, onde o eyebrow das cenas Product e Proof cai por cima do logotipo.
  const markHeight = Math.round(56 * scale);
  const gap = Math.round(26 * scale);

  return {
    format,
    width,
    height,
    safe,
    scale,
    vertical: format === 'reels',
    stacked: format !== 'wide',
    markHeight,
    contentTop: safe.y + markHeight + gap,
    contentHeight: safe.height - markHeight - gap,
  };
};

/** Tamanho de fonte proporcional ao formato, com piso para não sumir no feed. */
export const fs = (layout: AdLayout, base: number, min = 12): number =>
  Math.max(min, Math.round(base * layout.scale));
