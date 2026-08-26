import type {
  HubCaptionTimingSource,
  HubVoiceTrack,
} from '../types';

const BRAZILIAN_ACCENT_PATTERN = /brazil|brasil|brasileir/iu;
const STRICT_ENVIRONMENT_VARIABLE = 'VIDEO_FINAL_AUDIO_STRICT';
const ALLOWED_ALIGNMENT_SOURCES = new Set<HubCaptionTimingSource>([
  'provider_alignment',
  'forced_alignment',
]);

export type HubFinalAudioEvidence = {
  policyVersion: 1;
  voiceProvider: 'elevenlabs';
  voiceLocale: 'pt-BR';
  voiceNative: true;
  voiceGender: 'male';
  narrationTake: 'single_continuous';
  narrationRequestCount: 1;
  captionTimingSource: 'provider_alignment' | 'forced_alignment';
  captionCount: number;
  tokenCount: number;
};

export const isFinalAudioStrictModeEnabled = (
  value = process.env[STRICT_ENVIRONMENT_VARIABLE],
): boolean => value?.trim() !== '0';

const assertFiniteTimestamp = (value: number, label: string): void => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} inválido.`);
};

export const assertHubFinalAudioTrack = (track: HubVoiceTrack): HubFinalAudioEvidence => {
  if (track.ready !== true || track.commercialUseAllowed !== true) {
    throw new Error('A faixa final precisa estar pronta e licenciada para uso comercial.');
  }
  if (track.voiceProvider !== 'elevenlabs' || track.voiceGateway) {
    throw new Error('A faixa final exige geração direta pela ElevenLabs, sem gateway intermediário.');
  }
  if (
    track.voiceLocale !== 'pt-BR'
    || track.voiceNative !== true
    || !BRAZILIAN_ACCENT_PATTERN.test(track.voiceSourceAccent || '')
    || !['verified_languages', 'voice_labels'].includes(track.voiceLocaleValidation || '')
  ) {
    throw new Error('A faixa final exige evidência de voz nativa em português brasileiro.');
  }
  if (track.voiceGender !== 'male') {
    throw new Error('A faixa final exige voz masculina validada pelo perfil do provedor.');
  }
  if (track.narrationTake !== 'single_continuous' || track.narrationRequestCount !== 1) {
    throw new Error('A locução final precisa ser gerada em um único take contínuo e uma única requisição.');
  }
  if (!track.captionTimingSource || !ALLOWED_ALIGNMENT_SOURCES.has(track.captionTimingSource)) {
    throw new Error('As legendas finais exigem alinhamento real por palavra; tempos estimados são recusados.');
  }
  if (!Number.isFinite(track.durationSeconds) || track.durationSeconds <= 0) {
    throw new Error('A duração da locução final é inválida.');
  }
  if (!Array.isArray(track.captions) || track.captions.length === 0) {
    throw new Error('A locução final não possui legendas alinhadas.');
  }

  let previousCaptionEnd = -1;
  let tokenCount = 0;
  for (const [captionIndex, caption] of track.captions.entries()) {
    assertFiniteTimestamp(caption.startMs, `Início da legenda ${captionIndex + 1}`);
    assertFiniteTimestamp(caption.endMs, `Fim da legenda ${captionIndex + 1}`);
    if (caption.endMs <= caption.startMs || caption.startMs < previousCaptionEnd) {
      throw new Error(`A legenda ${captionIndex + 1} possui duração ou ordem inválida.`);
    }
    if (caption.endMs > track.durationSeconds * 1000 + 5) {
      throw new Error(`A legenda ${captionIndex + 1} ultrapassa a duração da locução.`);
    }
    if (!caption.tokens?.length) {
      throw new Error(`A legenda ${captionIndex + 1} não possui timestamps reais por palavra.`);
    }

    let previousTokenEnd = caption.startMs;
    for (const [tokenIndex, token] of caption.tokens.entries()) {
      assertFiniteTimestamp(token.startMs, `Início da palavra ${tokenIndex + 1} da legenda ${captionIndex + 1}`);
      assertFiniteTimestamp(token.endMs, `Fim da palavra ${tokenIndex + 1} da legenda ${captionIndex + 1}`);
      if (
        token.endMs <= token.startMs
        || token.startMs < previousTokenEnd
        || token.startMs < caption.startMs - 1
        || token.endMs > caption.endMs + 1
      ) {
        throw new Error(`A palavra ${tokenIndex + 1} da legenda ${captionIndex + 1} possui alinhamento inválido.`);
      }
      previousTokenEnd = token.endMs;
      tokenCount += 1;
    }

    const tokenText = caption.tokens.map((token) => token.text).join(' ');
    if (tokenText.normalize('NFC') !== caption.text.trim().normalize('NFC')) {
      throw new Error(`O texto da legenda ${captionIndex + 1} diverge dos tokens alinhados.`);
    }
    previousCaptionEnd = caption.endMs;
  }

  return {
    policyVersion: 1,
    voiceProvider: 'elevenlabs',
    voiceLocale: 'pt-BR',
    voiceNative: true,
    voiceGender: 'male',
    narrationTake: 'single_continuous',
    narrationRequestCount: 1,
    captionTimingSource: track.captionTimingSource as 'provider_alignment' | 'forced_alignment',
    captionCount: track.captions.length,
    tokenCount,
  };
};
