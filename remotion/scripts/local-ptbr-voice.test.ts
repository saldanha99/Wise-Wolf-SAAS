import { describe, expect, it } from 'vitest';
import { assertLocalPtBrVoice, parseMacOsSayVoices } from './local-ptbr-voice';

const installedVoices = [
  'Joana               pt_PT    # Olá! Chamo-me Joana.',
  'Luciana             pt_BR    # Olá, meu nome é Luciana.',
  'Reed (Português)    pt_BR    # Olá, meu nome é Reed.',
].join('\n');

describe('local macOS PT-BR voice validation', () => {
  it('parses names with spaces and their exact locale', () => {
    expect(parseMacOsSayVoices(installedVoices)).toEqual([
      { name: 'Joana', locale: 'pt_PT' },
      { name: 'Luciana', locale: 'pt_BR' },
      { name: 'Reed (Português)', locale: 'pt_BR' },
    ]);
  });

  it('parses localized macOS names separated by a single space', () => {
    const voices = parseMacOsSayVoices('Reed (Português (Brasil)) pt_BR    # Olá, meu nome é Reed.');

    expect(voices).toEqual([{ name: 'Reed (Português (Brasil))', locale: 'pt_BR' }]);
  });

  it('accepts only an exact installed pt_BR voice', () => {
    expect(assertLocalPtBrVoice({ voiceName: 'Luciana', voicesOutput: installedVoices })).toEqual({
      name: 'Luciana',
      locale: 'pt_BR',
    });
    expect(() => assertLocalPtBrVoice({ voiceName: 'luciana', voicesOutput: installedVoices })).toThrow(/não está instalada/u);
  });

  it('rejects a Portuguese voice from Portugal', () => {
    expect(() => assertLocalPtBrVoice({ voiceName: 'Joana', voicesOutput: installedVoices })).toThrow(/pt_PT, não pt_BR/u);
  });
});
