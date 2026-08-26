import type { Caption } from '@remotion/captions';
import type { AdFormatId } from './meta/formats';

/** As quatro batidas de um anúncio. Não são as cinco cenas do filme institucional. */
export type AdBeatId = 'hook' | 'turn' | 'proof' | 'cta';

export const AD_BEATS: AdBeatId[] = ['hook', 'turn', 'proof', 'cta'];

export type AdFront = 'aluno' | 'escola';

export type AdCaptionToken = {
  text: string;
  startMs: number;
  endMs: number;
};

export type AdCaption = Caption & {
  startSeconds: number;
  endSeconds: number;
  tokens?: AdCaptionToken[];
};

export type AdBeatTiming = {
  startSeconds: number;
  endSeconds: number;
};

export type AdVoiceTrack = {
  ready: boolean;
  /** Falso enquanto a locução for a voz local do macOS: marca d'água e sem publicação. */
  commercialUseAllowed: boolean;
  durationSeconds: number;
  durationInFrames: number;
  audioPath: string;
  voiceProvider: 'local-preview' | 'elevenlabs';
  voiceName?: string;
  modelId?: string;
  scriptHash: string;
  generatedAt?: string;
  captions: AdCaption[];
  beats: Record<AdBeatId, AdBeatTiming>;
};

/** Painéis do produto desenhados no vídeo, alimentados com números reais da operação. */
export type AdPanelId = 'finance' | 'attendance' | 'crm' | 'wolfie';

/**
 * Uma prova visual. Ou uma imagem (`file`), ou um painel do produto (`panel`).
 *
 * `reads` descreve o que está no pixel, não a intenção. O filme institucional escreve
 * "Biblioteca em funcionamento." por cima de uma tela que diz "Nenhum material na
 * biblioteca ainda" — é o tipo de contradição que custa a confiança da peça inteira.
 */
export type AdEvidence = {
  /** Caminho relativo a remotion-ads/public/ */
  file?: string;
  /** Painel do produto renderizado no vídeo. Tem precedência sobre `file`. */
  panel?: AdPanelId;
  reads: string;
  /** Foco de atenção dentro da imagem, em fração 0-1 do enquadramento. */
  focus?: { x: number; y: number };
};

export type AdScript = {
  id: string;
  slug: string;
  front: AdFront;
  /** Ângulo do anúncio, para nomear variações no gerenciador da Meta. */
  angle: string;
  accent: string;
  secondaryAccent: string;

  /** Batida 1 — 0 a ~3s. Precisa parar o dedo e nomear a dor. */
  hookKicker: string;
  hookLine: string;
  hookEmphasis: string;

  /** Batida 2 — a virada. */
  turnHeadline: string;
  turnPoints: string[];

  /** Batida 3 — a prova. Interface real. */
  proofHeadline: string;
  evidence: AdEvidence[];

  /**
   * Imagem de fundo do filme, usada nas batidas de gancho, virada e prova.
   * Separada de `evidence` de propósito: fundo é clima, prova é argumento, e usar a
   * mesma imagem nos dois papéis ao mesmo tempo faz a peça parecer repetida.
   */
  backdrop?: string;

  /** Batida 4 — a ação. */
  ctaHeadline: string;
  ctaButton: string;
  ctaSupport: string;
  /** Destino real e verificado. Rota pública que existe no SPA. */
  destination: string;

  /** Locução contínua, em take único, dividida por batida. */
  narration: Array<{ beat: AdBeatId; text: string }>;

  /**
   * Afirmações factuais que este roteiro sustenta, com a origem.
   * Serve de auditoria: nada entra no anúncio sem constar aqui.
   */
  claims: Array<{ claim: string; source: string }>;
};

export type AdCompositionProps = {
  script: AdScript;
  voice: AdVoiceTrack;
  format: AdFormatId;
};
