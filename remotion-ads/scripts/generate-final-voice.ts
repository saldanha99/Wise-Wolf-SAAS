// Locução FINAL dos anúncios, na ElevenLabs, com alinhamento real por caractere.
//
// Diferenças para a prévia local:
//   - take ÚNICO e contínuo por anúncio (uma requisição, não uma por batida). Locução
//     costurada de quatro pedaços tem quebra de entonação audível na emenda.
//   - legendas vêm do alinhamento DO PROVEDOR, não de estimativa por peso de letra.
//   - `commercialUseAllowed: true`, o que remove a tarja de prévia e o sufixo `-previa`.
//
// A chave vive só em `.env.video.local` (nunca versionada, nunca com prefixo VITE_).
//
// Uso:
//   node --env-file=.env.video.local node_modules/tsx/dist/cli.mjs \
//     remotion-ads/scripts/generate-final-voice.ts
//
//   ADS_ONLY=aluno-intervalo ...   # regenera um anúncio só
//
// ⚠️ Cada execução CONSOME caracteres da conta. O cache por hash do roteiro evita pagar
// duas vezes pelo mesmo texto: só regenera quando a narração muda de fato.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertProviderCharacterAlignment,
  buildProviderAlignedCaptions,
  type ProviderCharacterAlignment,
} from '../../remotion/scripts/provider-caption-alignment';
import { ALL_ADS } from '../content/all-ads';
import { AD_FPS } from '../meta/formats';
import { AD_BEATS, type AdBeatId, type AdBeatTiming, type AdCaption, type AdVoiceTrack } from '../types';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adsRoot = path.join(projectRoot, 'remotion-ads');
const audioDir = path.join(adsRoot, 'public/assets/voz');
const manifestPath = path.join(adsRoot, 'generated/voice-manifest.json');

const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_multilingual_v2';
const onlySlug = process.env.ADS_ONLY?.trim();

// Respiro entre batidas. A locução é contínua, então o silêncio precisa estar NO TEXTO —
// duas quebras de linha fazem a ElevenLabs pausar de verdade, e a pausa aparece no
// alinhamento, o que mantém legenda e corte de cena sincronizados.
const BEAT_SEPARATOR = '\n\n';

const fixed = (value: number) => Number(value.toFixed(3));

const assertConfig = () => {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY ausente. Rode com --env-file=.env.video.local');
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID ausente.');
};

/**
 * Normaliza a locução para -16 LUFS com teto de -1,5 dBTP.
 *
 * Mesmo alvo do pipeline institucional. A voz do macOS já sai perto disso por acaso
 * (medido: -15,8 e -16,1 LUFS), mas a ElevenLabs varia com a voz e com o texto — e anúncio
 * que toca mais baixo que o vídeo anterior do feed perde a atenção nos primeiros segundos.
 */
const masterLoudness = (filePath: string) => {
  const temp = `${filePath}.tmp.mp3`;
  execFileSync(
    'ffmpeg',
    ['-y', '-i', filePath, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-codec:a', 'libmp3lame', '-b:a', '192k', temp],
    { stdio: 'ignore' },
  );
  execFileSync('mv', [temp, filePath]);
};

const probeDuration = (filePath: string): number =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { encoding: 'utf8' },
    ).trim(),
  );

type TimestampResponse = {
  audio_base64: string;
  alignment?: ProviderCharacterAlignment | null;
  normalized_alignment?: ProviderCharacterAlignment | null;
};

const synthesize = async (text: string): Promise<{ response: TimestampResponse; requestId: string }> => {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId!)}` +
    '/with-timestamps?output_format=mp3_44100_192';

  const result = await fetch(url, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey!, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: {
        // Mesma regulagem auditada do pipeline institucional para eleven_multilingual_v2.
        stability: 0.38,
        similarity_boost: 0.78,
        style: 0.34,
        use_speaker_boost: true,
        speed: 0.98,
      },
    }),
  });

  if (!result.ok) {
    throw new Error(`ElevenLabs respondeu ${result.status}: ${(await result.text()).slice(0, 400)}`);
  }

  return {
    response: (await result.json()) as TimestampResponse,
    requestId: result.headers.get('x-request-id') ?? result.headers.get('request-id') ?? '',
  };
};

/**
 * Tempo do caractere de índice `charIndex`, lido do alinhamento do provedor.
 * É assim que as batidas ganham início e fim reais em vez de estimativa.
 */
const timeAtChar = (alignment: ProviderCharacterAlignment, charIndex: number, fallback: number): number => {
  const starts = alignment.character_start_times_seconds;
  if (charIndex <= 0) return 0;
  if (charIndex >= starts.length) return fallback;
  return starts[charIndex];
};

const main = async () => {
  assertConfig();
  await mkdir(audioDir, { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });

  let manifest: Record<string, AdVoiceTrack> = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, AdVoiceTrack>;
  } catch {
    manifest = {};
  }

  const targets = ALL_ADS.filter((ad) => !onlySlug || ad.slug === onlySlug);

  for (const script of targets) {
    const narration = AD_BEATS.map((beat) => {
      const line = script.narration.find((item) => item.beat === beat);
      if (!line) throw new Error(`Anúncio ${script.slug} sem locução para "${beat}".`);
      return line.text.trim();
    });
    const fullText = narration.join(BEAT_SEPARATOR);
    const scriptHash = createHash('sha256').update(fullText).digest('hex');

    const cached = manifest[script.slug];
    if (cached?.commercialUseAllowed && cached.scriptHash === scriptHash) {
      console.log(`· ${script.slug.padEnd(26)} já gerado com este roteiro — pulando (sem custo)`);
      continue;
    }

    process.stdout.write(`→ ${script.slug.padEnd(26)} ${fullText.length} caracteres ... `);
    const { response, requestId } = await synthesize(fullText);

    const alignment = response.alignment ?? response.normalized_alignment;
    if (!alignment) throw new Error(`ElevenLabs não devolveu alinhamento para ${script.slug}.`);
    assertProviderCharacterAlignment(fullText, alignment);

    const audioFile = `assets/voz/${script.slug}.mp3`;
    const audioPath = path.join(adsRoot, 'public', audioFile);
    await writeFile(audioPath, Buffer.from(response.audio_base64, 'base64'), { mode: 0o644 });
    masterLoudness(audioPath);

    // A duração é medida DEPOIS da masterização: o loudnorm em dois passos pode devolver
    // alguns milissegundos a mais, e é o arquivo final que o vídeo toca.
    const durationSeconds = probeDuration(audioPath);
    const captions = buildProviderAlignedCaptions(fullText, alignment) as unknown as AdCaption[];

    // Início de cada batida = tempo do primeiro caractere daquele trecho no texto completo.
    const beats = {} as Record<AdBeatId, AdBeatTiming>;
    let charCursor = 0;
    AD_BEATS.forEach((beat, index) => {
      const start = timeAtChar(alignment, charCursor, durationSeconds);
      charCursor += narration[index].length;
      const end = timeAtChar(alignment, charCursor, durationSeconds);
      beats[beat] = { startSeconds: fixed(start), endSeconds: fixed(end) };
      charCursor += BEAT_SEPARATOR.length;
    });

    const total = fixed(durationSeconds + 0.5);
    manifest[script.slug] = {
      ready: true,
      commercialUseAllowed: true,
      durationSeconds: total,
      durationInFrames: Math.ceil(total * AD_FPS),
      audioPath: audioFile,
      voiceProvider: 'elevenlabs',
      voiceName: voiceId,
      modelId,
      scriptHash,
      generatedAt: new Date().toISOString(),
      captions,
      beats,
    };

    console.log(`${total.toFixed(1)}s  ${captions.length} legendas  req=${requestId || 'sem-id'}`);
    // Grava o manifesto a cada anúncio: uma falha no meio não perde o que já foi pago.
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  console.log(`\nManifesto: ${path.relative(projectRoot, manifestPath)}`);
  console.log('Renderize de novo — os arquivos saem sem a tarja de prévia e sem o sufixo -previa.');
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
