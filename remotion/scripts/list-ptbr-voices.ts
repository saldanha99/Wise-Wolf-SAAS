/**
 * Lista as vozes ElevenLabs elegíveis para a narração PT-BR.
 *
 * Existe porque o gerador exige `ELEVENLABS_VOICE_ID` explícito e recusa voz
 * sem evidência regional brasileira — então é preciso descobrir QUAL id usar
 * antes de gerar. Reaproveita `getPtBrVoiceEvidence`, a mesma função que o
 * gerador usa para aprovar, para a lista não prometer voz que será recusada.
 *
 * Nunca imprime a chave: lê de `.env.video.local` via --env-file-if-exists.
 */
import { getPtBrVoiceEvidence, type ElevenLabsVoiceProfile } from './pt-br-voice';

type SharedVoice = ElevenLabsVoiceProfile & {
  public_owner_id?: string;
  accent?: string;
  language?: string;
  locale?: string;
  descriptive?: string;
  use_case?: string;
};

const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_v3';
const allowMultilingualPremade = process.env.ELEVENLABS_ALLOW_MULTILINGUAL_PREMADE === '1';
if (!apiKey) {
  console.error(
    'ELEVENLABS_API_KEY ausente.\n'
    + 'Crie .env.video.local (já coberto pelo .gitignore) com a chave e rode de novo.',
  );
  process.exit(1);
}

const headers = { 'xi-api-key': apiKey, accept: 'application/json' };

const getJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`ElevenLabs ${response.status} em ${new URL(url).pathname}`);
  }
  return response.json() as Promise<T>;
};

const line = (parts: string[]) => parts.join('  ');

const main = async () => {
  // 1) Vozes já na conta — utilizáveis imediatamente pelo gerador.
  const own = await getJson<{ voices: ElevenLabsVoiceProfile[] }>(
    'https://api.elevenlabs.io/v2/voices?page_size=100',
  );
  const eligible = own.voices
    .map((voice) => ({
      voice,
      evidence: getPtBrVoiceEvidence(voice, { allowMultilingualPremade, modelId }),
    }))
    .filter((entry) => entry.evidence !== null);

  console.log('\n=== JÁ NA SUA CONTA (prontas para usar) ===');
  if (eligible.length === 0) {
    console.log('nenhuma voz da conta tem evidência PT-BR confiável.');
  }
  for (const { voice, evidence } of eligible) {
    console.log(line([
      voice.voice_id.padEnd(24),
      (voice.name || '—').padEnd(22),
      (voice.category || '—').padEnd(13),
      `sotaque=${evidence?.accent}`,
      `origem=${evidence?.sourceAccent}`,
      `nativa=${evidence?.native ? 'sim' : 'não'}`,
      `evidência=${evidence?.source}`,
    ]));
  }

  // 2) Voice Library pública — precisam ser adicionadas à conta antes do uso.
  const shared = await getJson<{ voices: SharedVoice[] }>(
    'https://api.elevenlabs.io/v1/shared-voices?page_size=60&language=pt',
  );
  const brazilian = shared.voices.filter((voice) => {
    const accent = (voice.accent || '').toLowerCase();
    const locale = (voice.locale || '').toLowerCase().replace('_', '-');
    return accent.includes('brazil') || accent.includes('brasil') || locale === 'pt-br';
  });

  console.log('\n=== VOICE LIBRARY · PORTUGUESE (BRAZIL) ===');
  console.log('(precisam ser adicionadas à conta antes de gerar)\n');
  if (brazilian.length === 0) {
    console.log('a busca não retornou voz brasileira; ajuste os filtros no site.');
  }
  for (const voice of brazilian.slice(0, 25)) {
    console.log(line([
      (voice.voice_id || '—').padEnd(24),
      (voice.name || '—').padEnd(22),
      (voice.category || '—').padEnd(13),
      `sotaque=${voice.accent || '—'}`,
      `dono=${voice.public_owner_id || '—'}`,
    ]));
  }
  console.log('\nEscolha um id e defina ELEVENLABS_VOICE_ID em .env.video.local.\n');
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
