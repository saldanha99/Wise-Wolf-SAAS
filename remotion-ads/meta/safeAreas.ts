// Zonas seguras da Meta — a razão principal deste projeto existir separado.
//
// A Meta publica na própria página de especificações (facebook.com/business/ads-guide,
// seções instagram-reels / instagram-story / facebook-facebook-reels) a reserva de
// "14% do topo, 35% da base e 6% de cada lado" para 9:16. Essa faixa é coberta pela
// interface do app: foto do perfil e nome no topo; curtir/comentar/compartilhar, a
// legenda do criador e o botão de call-to-action na base.
//
// ⚠️ O pipeline institucional em `remotion/` NÃO respeita isso, e é medível:
// `remotion/components/CaptionLayer.tsx:56` posiciona a legenda queimada em
// `bottom: 122` no formato story. Em 1080x1920 a base reservada tem 672px — ou seja,
// a legenda fica 550px DENTRO da área que o Reels cobre. Os 5 stories já renderizados
// têm a legenda tapada pela interface. Não existe nenhuma constante de zona segura em
// `remotion/` (grep por SAFE/safeZone: zero ocorrências).
//
// Aqui a zona segura é a origem das coordenadas, não uma correção posterior.

import { AD_FORMATS, type AdFormatId } from './formats';

export type SafeArea = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type SafeBox = {
  /** Margens reservadas para a interface do app. */
  reserved: SafeArea;
  /** Retângulo em que é seguro colocar texto e call-to-action. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Frações reservadas por formato.
 *
 * `reels` usa os números publicados pela Meta. `feed` e `wide` não têm sobreposição de
 * interface comparável — a reserva ali é margem de composição, não exigência da
 * plataforma, e por isso é bem menor. Manter o mesmo 35% no Feed jogaria fora um terço
 * do quadro sem motivo.
 */
const RESERVED_FRACTIONS: Record<AdFormatId, SafeArea> = {
  reels: { top: 0.14, right: 0.06, bottom: 0.35, left: 0.06 },
  feed: { top: 0.06, right: 0.055, bottom: 0.10, left: 0.055 },
  wide: { top: 0.075, right: 0.06, bottom: 0.09, left: 0.06 },
};

export const safeAreaFor = (format: AdFormatId): SafeBox => {
  const { width, height } = AD_FORMATS[format];
  const fraction = RESERVED_FRACTIONS[format];

  const reserved: SafeArea = {
    top: Math.round(height * fraction.top),
    right: Math.round(width * fraction.right),
    bottom: Math.round(height * fraction.bottom),
    left: Math.round(width * fraction.left),
  };

  return {
    reserved,
    x: reserved.left,
    y: reserved.top,
    width: width - reserved.left - reserved.right,
    height: height - reserved.top - reserved.bottom,
  };
};

/**
 * Onde a legenda queimada pode ficar.
 *
 * Em 9:16 a legenda é ancorada ao RODAPÉ da zona segura, não ao rodapé do quadro —
 * é exatamente a distinção que o pipeline institucional erra.
 */
export const captionAnchorFor = (format: AdFormatId): { left: number; right: number; bottom: number } => {
  const box = safeAreaFor(format);
  const { height } = AD_FORMATS[format];
  return {
    left: box.x,
    right: box.x,
    // distância do rodapé do quadro até o rodapé da zona segura
    bottom: height - (box.y + box.height),
  };
};

/**
 * Verificação usada em teste: um elemento nessas coordenadas está dentro da zona segura?
 * Coordenadas em pixels, medidas a partir do canto superior esquerdo do quadro.
 */
export const isWithinSafeArea = (
  format: AdFormatId,
  element: { x: number; y: number; width: number; height: number },
): boolean => {
  const box = safeAreaFor(format);
  return (
    element.x >= box.x &&
    element.y >= box.y &&
    element.x + element.width <= box.x + box.width &&
    element.y + element.height <= box.y + box.height
  );
};
