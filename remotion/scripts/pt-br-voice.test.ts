import { describe, expect, it } from 'vitest';
import {
  assertPtBrNarrationModel,
  assertPtBrVoice,
  getPtBrNarrationVoiceSettings,
  getPtBrVoiceEvidence,
} from './pt-br-voice';

describe('PT-BR voice validation', () => {
  it('accepts an exact verified pt-BR locale', () => {
    expect(getPtBrVoiceEvidence({
      voice_id: 'native-br',
      category: 'professional',
      verified_languages: [{ language: 'pt', locale: 'pt-BR', accent: 'brazilian' }],
    })).toEqual({
      locale: 'pt-BR',
      source: 'verified_languages',
      language: 'pt',
      accent: 'brazilian',
      sourceAccent: 'brazilian',
      native: true,
    });
  });

  it('accepts a professional or cloned voice with strong regional labels', () => {
    expect(getPtBrVoiceEvidence({
      voice_id: 'native-clone',
      category: 'cloned',
      labels: { language: 'Português', accent: 'Brasileiro' },
    })?.source).toBe('voice_labels');
  });

  it('rejects European Portuguese and generic Portuguese voices', () => {
    expect(getPtBrVoiceEvidence({
      voice_id: 'pt-pt',
      category: 'professional',
      verified_languages: [{ language: 'pt', locale: 'pt-PT', accent: 'portuguese' }],
    })).toBeNull();
    expect(getPtBrVoiceEvidence({
      voice_id: 'generic-pt',
      category: 'professional',
      labels: { language: 'Portuguese' },
    })).toBeNull();
  });

  it('rejects English premade fallbacks even when labels are misleading', () => {
    expect(() => assertPtBrVoice({
      voice_id: 'JBFqnCBsd6RMkjVDRZzb',
      name: 'George',
      category: 'premade',
      labels: { language: 'Portuguese', accent: 'Brazilian' },
      verified_languages: [{ language: 'en', locale: 'en-GB', accent: 'british' }],
    })).toThrow(/não possui evidência regional PT-BR confiável/u);
  });

  it('allows an American premade only through the explicit multilingual override', () => {
    const voice = {
      voice_id: 'american-premade',
      name: 'Chris',
      category: 'premade',
      labels: { language: 'en', accent: 'american' },
      verified_languages: [{
        language: 'pt',
        locale: 'pt-BR',
        accent: 'standard',
        model_id: 'eleven_multilingual_v2',
      }],
    };

    expect(getPtBrVoiceEvidence(voice)).toBeNull();
    expect(getPtBrVoiceEvidence(voice, {
      allowMultilingualPremade: true,
      modelId: 'eleven_multilingual_v2',
    })).toEqual({
      locale: 'pt-BR',
      source: 'multilingual_premade_override',
      language: 'pt',
      accent: 'standard',
      sourceAccent: 'american',
      native: false,
    });
  });

  it('does not extend the override to non-American premades or unsupported models', () => {
    expect(getPtBrVoiceEvidence({
      voice_id: 'british-premade',
      category: 'premade',
      labels: { language: 'en', accent: 'british' },
    }, { allowMultilingualPremade: true, modelId: 'eleven_multilingual_v2' })).toBeNull();
    expect(getPtBrVoiceEvidence({
      voice_id: 'american-premade',
      category: 'premade',
      labels: { language: 'en', accent: 'american' },
    }, { allowMultilingualPremade: true, modelId: 'eleven_flash_v2' })).toBeNull();
  });

  it('rejects English-only or unapproved models', () => {
    expect(() => assertPtBrNarrationModel('eleven_flash_v2')).toThrow(/não aprovado/u);
    expect(() => assertPtBrNarrationModel('eleven_v3')).not.toThrow();
    expect(() => assertPtBrNarrationModel('eleven_multilingual_v2')).not.toThrow();
  });

  it('uses the audited natural settings for multilingual PT-BR narration', () => {
    expect(getPtBrNarrationVoiceSettings('eleven_multilingual_v2')).toEqual({
      stability: 0.38,
      similarity_boost: 0.78,
      style: 0.34,
      use_speaker_boost: true,
      speed: 0.98,
    });
  });
});
