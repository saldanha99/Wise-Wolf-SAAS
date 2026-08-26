// Formatos de anúncio da Meta.
//
// ⚠️ Este projeto vive FORA de `remotion/` de propósito. `computeCompositionSourceSha256`
// (remotion/scripts/render-provenance.ts:124) hasheia TODO arquivo .ts/.tsx/.json sob
// `remotion/` e TODO arquivo sob `remotion/public/`. Qualquer arquivo novo ali invalidaria
// os 5 receipts comerciais dos vídeos institucionais e faria
// `npm run video:validate -- --public` falhar — que é a PRIMEIRA coisa que o
// `deploy/vps/release.sh` roda (linhas 173 e 692), antes de tocar a VPS.
// Ou seja: criar os anúncios dentro de `remotion/` derrubaria o deploy da produção.

export type AdFormatId = 'reels' | 'feed' | 'wide';

export type AdFormat = {
  id: AdFormatId;
  width: number;
  height: number;
  /** Rótulo curto para nome de composição e de arquivo. */
  suffix: string;
  /** Onde este master é veiculado. Fonte: guia oficial de especificações da Meta. */
  placements: string[];
};

export const AD_FPS = 30;

export const AD_FORMATS: Record<AdFormatId, AdFormat> = {
  // Cobre 5 dos 7 posicionamentos: IG Reels, IG Stories, FB Reels, FB Stories e IG Feed vídeo.
  reels: {
    id: 'reels',
    width: 1080,
    height: 1920,
    suffix: 'Reels',
    placements: ['Instagram Reels', 'Instagram Stories', 'Facebook Reels', 'Facebook Stories', 'Instagram Feed (vídeo)'],
  },
  // O guia da Meta pede 4:5 para vídeo no Feed do Facebook. O pipeline institucional não tem
  // este formato — é a lacuna real de cobertura de posicionamento.
  feed: {
    id: 'feed',
    width: 1080,
    height: 1350,
    suffix: 'Feed',
    placements: ['Facebook Feed (vídeo)', 'Instagram Feed'],
  },
  // Horizontal, pedido explicitamente. In-stream aceita 16:9.
  wide: {
    id: 'wide',
    width: 1920,
    height: 1080,
    suffix: 'Wide',
    placements: ['In-stream', 'Facebook Video Feeds', 'YouTube/site (reaproveitamento)'],
  },
};

export const AD_FORMAT_IDS: AdFormatId[] = ['reels', 'feed', 'wide'];

export const isVertical = (format: AdFormatId): boolean => format === 'reels';
