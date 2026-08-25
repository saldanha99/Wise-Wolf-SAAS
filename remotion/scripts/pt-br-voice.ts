export type ElevenLabsVoiceProfile = {
  voice_id: string;
  name?: string;
  category?: string;
  labels?: Record<string, string>;
  verified_languages?: Array<{
    language?: string;
    locale?: string;
    accent?: string;
    model_id?: string;
  }>;
  high_quality_base_model_ids?: string[];
  is_owner?: boolean;
};

export type PtBrVoiceEvidence = {
  locale: 'pt-BR';
  source: 'verified_languages' | 'voice_labels' | 'multilingual_premade_override';
  language: string;
  accent: string;
  sourceAccent: string;
  native: boolean;
};

export type PtBrVoiceValidationOptions = {
  allowMultilingualPremade?: boolean;
  modelId?: string;
};

const normalize = (value: string | undefined): string => (value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/gu, '')
  .trim()
  .toLowerCase()
  .replace(/_/gu, '-');

const isPortuguese = (value: string | undefined): boolean => {
  const normalized = normalize(value);
  return normalized === 'pt'
    || normalized === 'por'
    || normalized.includes('portuguese')
    || normalized.includes('portugues');
};

const isBrazilian = (value: string | undefined): boolean => {
  const normalized = normalize(value);
  return normalized === 'pt-br'
    || normalized.includes('brazil')
    || normalized.includes('brasil')
    || normalized.includes('brasileir');
};

const isAmerican = (value: string | undefined): boolean => {
  const normalized = normalize(value);
  return normalized === 'american'
    || normalized === 'en-us'
    || normalized.includes('american')
    || normalized.includes('estadunidense');
};

export const SUPPORTED_PT_BR_NARRATION_MODELS = [
  'eleven_v3',
  'eleven_multilingual_v2',
] as const;

const isSupportedPtBrNarrationModel = (modelId: string | undefined): boolean => SUPPORTED_PT_BR_NARRATION_MODELS
  .includes(modelId as typeof SUPPORTED_PT_BR_NARRATION_MODELS[number]);

export const getPtBrVoiceEvidence = (
  voice: ElevenLabsVoiceProfile,
  options: PtBrVoiceValidationOptions = {},
): PtBrVoiceEvidence | null => {
  const category = normalize(voice.category);
  if (category === 'premade') {
    const sourceAccent = voice.labels?.accent || '';
    if (!options.allowMultilingualPremade || !isSupportedPtBrNarrationModel(options.modelId) || !isAmerican(sourceAccent)) {
      return null;
    }
    const verifiedOutput = (voice.verified_languages || []).find((language) => (
      normalize(language.locale) === 'pt-br'
      && (!options.modelId || language.model_id === options.modelId)
    ));
    return {
      locale: 'pt-BR',
      source: 'multilingual_premade_override',
      language: verifiedOutput?.language || 'pt',
      accent: verifiedOutput?.accent || 'model-directed',
      sourceAccent,
      native: false,
    };
  }

  for (const language of voice.verified_languages || []) {
    const exactLocale = normalize(language.locale) === 'pt-br';
    const regionalLanguage = isPortuguese(language.language) && isBrazilian(language.accent);
    if (exactLocale || regionalLanguage) {
      return {
        locale: 'pt-BR',
        source: 'verified_languages',
        language: language.language || 'pt',
        accent: language.accent || 'brazilian',
        sourceAccent: language.accent || 'brazilian',
        native: true,
      };
    }
  }

  const labelLanguage = voice.labels?.language;
  const labelAccent = voice.labels?.accent;
  const labelEvidenceAllowed = category === 'professional' || category === 'cloned';
  if (labelEvidenceAllowed && isPortuguese(labelLanguage) && isBrazilian(labelAccent)) {
    return {
      locale: 'pt-BR',
      source: 'voice_labels',
      language: labelLanguage || 'pt',
      accent: labelAccent || 'brazilian',
      sourceAccent: labelAccent || 'brazilian',
      native: true,
    };
  }

  return null;
};

export const assertPtBrVoice = (
  voice: ElevenLabsVoiceProfile,
  options: PtBrVoiceValidationOptions = {},
): PtBrVoiceEvidence => {
  if (!voice.voice_id?.trim()) throw new Error('A ElevenLabs retornou uma voz sem identificador.');
  const evidence = getPtBrVoiceEvidence(voice, options);
  if (!evidence) {
    const voiceLabel = voice.name ? `“${voice.name}”` : voice.voice_id;
    throw new Error(
      `A voz ${voiceLabel} não possui evidência regional PT-BR confiável. `
      + 'Escolha no Voice Library uma voz nativa em Portuguese (Brazil), copie o ID e defina ELEVENLABS_VOICE_ID. '
      + 'Voz premade americana exige ELEVENLABS_ALLOW_MULTILINGUAL_PREMADE=1 e modelo eleven_multilingual_v2 ou eleven_v3; '
      + 'sem essa autorização explícita, PT-PT, voz predefinida e voz sem locale verificado são recusadas.',
    );
  }
  return evidence;
};

export const assertPtBrNarrationModel = (modelId: string): void => {
  if (!SUPPORTED_PT_BR_NARRATION_MODELS.includes(modelId as typeof SUPPORTED_PT_BR_NARRATION_MODELS[number])) {
    throw new Error(
      `Modelo ElevenLabs não aprovado para a narração PT-BR: ${modelId}. `
      + `Use ${SUPPORTED_PT_BR_NARRATION_MODELS.join(' ou ')}.`,
    );
  }
};

export const getPtBrNarrationVoiceSettings = (modelId: string): Record<string, number | boolean> => {
  assertPtBrNarrationModel(modelId);
  return modelId === 'eleven_multilingual_v2'
    ? {
      stability: 0.38,
      similarity_boost: 0.78,
      style: 0.34,
      use_speaker_boost: true,
      speed: 0.98,
    }
    : { stability: 0.5 };
};
