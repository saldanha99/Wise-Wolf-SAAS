// Locução de PRÉVIA com a voz do macOS.
//
// Serve para construir e revisar os anúncios sem gastar caractere de provedor pago. O
// manifesto sai com `commercialUseAllowed: false`, e o `AdFilm` desenha a tarja
// "PRÉVIA · locução local" por cima — para nenhum arquivo desses subir por engano para o
// gerenciador de anúncios.
//
// Quando o roteiro estiver aprovado, a locução final é regerada na ElevenLabs
// (`.env.video.local` já tem a chave) e o manifesto é substituído.
//
// Uso: npx tsx remotion-ads/scripts/generate-preview-voice.ts

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AD_FPS } from '../meta/formats';
import { ALL_ADS } from '../content/all-ads';
import { AD_BEATS, type AdBeatId, type AdBeatTiming, type AdCaption, type AdVoiceTrack } from '../types';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const adsRoot = path.join(projectRoot, 'remotion-ads');
const audioDir = path.join(adsRoot, 'public/assets/voz');
const manifestPath = path.join(adsRoot, 'generated/voice-manifest.json');

const voiceName = process.env.ADS_LOCAL_VOICE?.trim() || 'Luciana';
// 178 é um pouco mais lento que a fala institucional: anúncio precisa ser entendido de
// primeira, sem rebobinar.
const speechRate = Number(process.env.ADS_LOCAL_RATE || 178);
// Respiro entre batidas. Sem ele a virada de cena atropela a última palavra da anterior.
const BEAT_GAP_SECONDS = 0.22;
// Tempo que o card final fica no ar depois que a voz para.
const CTA_HOLD_SECONDS = 1.9;

const fixed = (value: number) => Number(value.toFixed(3));

const assertVoiceInstalled = () => {
  const installed = execFileSync('say', ['-v', '?'], { encoding: 'utf8' });
  const line = installed.split('\n').find((row) => row.trim().startsWith(voiceName));
  if (!line || !/pt_BR/.test(line)) {
    throw new Error(
      `A voz "${voiceName}" não está instalada como pt_BR neste Mac. ` +
        `Vozes pt-BR disponíveis:\n${installed.split('\n').filter((r) => /pt_BR/.test(r)).join('\n')}`,
    );
  }
};

const probeDuration = (filePath: string): number =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { encoding: 'utf8' },
    ).trim(),
  );

/** Quebra a fala em pedaços curtos, do tamanho de uma legenda lida de relance. */
const chunkWords = (text: string): string[] => {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length) {
      chunks.push(current.join(' '));
      current = [];
    }
  };

  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (current.length >= 4 || candidate.length > 28) flush();
    current.push(word);
    if (/[.!?…]$/u.test(word) || (current.length >= 3 && /[,;:]$/u.test(word))) flush();
  }
  flush();
  return chunks;
};

/**
 * Peso de cada pedaço na duração da batida.
 *
 * Conta letras e soma um extra na pontuação: quem termina em ponto final fica mais tempo
 * na tela porque a voz de fato pausa ali. Sem isso, a última legenda de cada frase some
 * antes de a pessoa terminar de ler.
 */
const chunkWeight = (text: string): number => {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
  const pause = /[.!?…]$/u.test(text) ? 5 : /[,;:]$/u.test(text) ? 2 : 0;
  return Math.max(letters + pause, 1);
};

const buildCaptions = (text: string, startSeconds: number, durationSeconds: number): AdCaption[] => {
  const chunks = chunkWords(text);
  const weights = chunks.map(chunkWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let elapsed = 0;

  return chunks.map((chunk, index) => {
    const from = startSeconds + durationSeconds * (elapsed / total);
    elapsed += weights[index];
    const to = startSeconds + durationSeconds * (elapsed / total);
    return {
      text: chunk,
      startSeconds: fixed(from),
      endSeconds: fixed(to),
      startMs: Math.round(from * 1000),
      endMs: Math.round(to * 1000),
      timestampMs: null,
      confidence: null,
    } as AdCaption;
  });
};

const synthesize = (text: string, outputPath: string) => {
  execFileSync(
    'say',
    ['-v', voiceName, '-r', String(speechRate), '--data-format=BEI16@44100', '-o', outputPath, text],
    { stdio: 'ignore' },
  );
};

/** Junta as batidas com o respiro entre elas e exporta um MP3 único. */
const concatenate = (parts: string[], outputPath: string) => {
  const inputs = parts.flatMap((part) => ['-i', part]);
  const padded = parts
    .map((_, index) =>
      index === parts.length - 1
        ? `[${index}:a]aformat=sample_rates=44100:channel_layouts=mono[a${index}]`
        : `[${index}:a]aformat=sample_rates=44100:channel_layouts=mono,apad=pad_dur=${BEAT_GAP_SECONDS}[a${index}]`,
    )
    .join(';');
  const joined = parts.map((_, index) => `[a${index}]`).join('');

  execFileSync(
    'ffmpeg',
    [
      '-y',
      ...inputs,
      '-filter_complex',
      `${padded};${joined}concat=n=${parts.length}:v=0:a=1[out]`,
      '-map',
      '[out]',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '192k',
      outputPath,
    ],
    { stdio: 'ignore' },
  );
};

const main = async () => {
  assertVoiceInstalled();
  await mkdir(audioDir, { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });

  const manifest: Record<string, AdVoiceTrack> = {};

  for (const script of ALL_ADS) {
    const workDir = path.join(adsRoot, '.work', script.slug);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });

    const beatFiles: string[] = [];
    const beatDurations: number[] = [];

    for (const beat of AD_BEATS) {
      const line = script.narration.find((item) => item.beat === beat);
      if (!line) throw new Error(`Anúncio ${script.slug} não tem locução para a batida "${beat}".`);
      const filePath = path.join(workDir, `${beat}.aiff`);
      synthesize(line.text, filePath);
      beatFiles.push(filePath);
      beatDurations.push(probeDuration(filePath));
    }

    const audioFile = `assets/voz/${script.slug}.mp3`;
    const audioPath = path.join(adsRoot, 'public', audioFile);
    concatenate(beatFiles, audioPath);

    // Os tempos das batidas seguem as durações medidas mais o respiro entre elas.
    const beats = {} as Record<AdBeatId, AdBeatTiming>;
    const captions: AdCaption[] = [];
    let cursor = 0;

    AD_BEATS.forEach((beat, index) => {
      const duration = beatDurations[index];
      beats[beat] = { startSeconds: fixed(cursor), endSeconds: fixed(cursor + duration) };
      const line = script.narration.find((item) => item.beat === beat)!;
      captions.push(...buildCaptions(line.text, cursor, duration));
      cursor += duration + (index === AD_BEATS.length - 1 ? 0 : BEAT_GAP_SECONDS);
    });

    const totalDuration = probeDuration(audioPath);
    // Sobra no fim para o card de CTA ficar LEGÍVEL depois que a locução termina.
    //
    // Meio segundo não bastava: o botão entra com atraso de 12 quadros e ainda tem a
    // acomodação da mola, então levava ~1s para aparecer inteiro. Numa batida de 3s isso
    // deixava o call-to-action em força total por menos de um segundo — que é o mesmo que
    // não ter call-to-action, num anúncio pago.
    const durationSeconds = fixed(Math.max(totalDuration, cursor) + CTA_HOLD_SECONDS);

    manifest[script.slug] = {
      ready: true,
      commercialUseAllowed: false,
      durationSeconds,
      durationInFrames: Math.ceil(durationSeconds * AD_FPS),
      audioPath: audioFile,
      voiceProvider: 'local-preview',
      voiceName,
      modelId: 'macos-say-preview',
      scriptHash: createHash('sha256')
        .update(script.narration.map((item) => `${item.beat}:${item.text}`).join('\n'))
        .digest('hex'),
      generatedAt: new Date().toISOString(),
      captions,
      beats,
    };

    await rm(workDir, { recursive: true, force: true });
    console.log(
      `✓ ${script.slug.padEnd(26)} ${durationSeconds.toFixed(1)}s  ${captions.length} legendas  (${script.angle})`,
    );
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await rm(path.join(adsRoot, '.work'), { recursive: true, force: true });
  console.log(`\nManifesto: ${path.relative(projectRoot, manifestPath)}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
