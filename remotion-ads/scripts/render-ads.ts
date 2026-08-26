// Renderiza os anúncios nos três formatos.
//
// Uso:
//   npx tsx remotion-ads/scripts/render-ads.ts                      # tudo
//   npx tsx remotion-ads/scripts/render-ads.ts aluno-intervalo      # um anúncio
//   ADS_FORMATS=reels npx tsx remotion-ads/scripts/render-ads.ts    # um formato
//
// A saída vai para `remotion-ads/out/<frente>/`. Enquanto a locução for a voz local do
// macOS, os arquivos saem com sufixo `-previa` e com a tarja queimada — é a trava que
// impede subir uma prévia para o gerenciador de anúncios por engano.

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_ADS } from '../content/all-ads';
import { AD_FORMATS, AD_FORMAT_IDS, type AdFormatId } from '../meta/formats';
import voiceManifest from '../generated/voice-manifest.json';
import type { AdVoiceTrack } from '../types';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outRoot = path.join(projectRoot, 'remotion-ads/out');
const entry = 'remotion-ads/index.ts';
const config = 'remotion-ads/remotion.config.ts';

const manifest = voiceManifest as unknown as Record<string, AdVoiceTrack>;

const onlySlug = process.argv[2];
const onlyFormats = (process.env.ADS_FORMATS?.split(',').map((f) => f.trim()).filter(Boolean) ??
  AD_FORMAT_IDS) as AdFormatId[];

const main = async () => {
  const targets = ALL_ADS.filter((ad) => !onlySlug || ad.slug === onlySlug);
  if (targets.length === 0) throw new Error(`Nenhum anúncio com slug "${onlySlug}".`);

  const rendered: Array<{ slug: string; format: string; file: string; seconds: number }> = [];

  for (const ad of targets) {
    const voice = manifest[ad.slug];
    if (!voice) throw new Error(`Sem locução para "${ad.slug}". Rode generate-preview-voice.ts antes.`);

    const frontDir = path.join(outRoot, ad.front === 'aluno' ? 'frente-a-alunos' : 'frente-b-escolas');
    await mkdir(frontDir, { recursive: true });

    for (const formatId of onlyFormats) {
      const format = AD_FORMATS[formatId];
      const compositionId = `${ad.id}${format.suffix}`;
      const suffix = voice.commercialUseAllowed ? '' : '-previa';
      const file = path.join(frontDir, `${ad.slug}-${formatId}${suffix}.mp4`);

      process.stdout.write(`→ ${compositionId} (${format.width}x${format.height}) ... `);
      const started = Date.now();
      execFileSync(
        'npx',
        ['remotion', 'render', entry, compositionId, file, `--config=${config}`],
        { stdio: 'ignore', cwd: projectRoot },
      );
      const seconds = (Date.now() - started) / 1000;
      console.log(`${seconds.toFixed(0)}s`);

      rendered.push({
        slug: ad.slug,
        format: formatId,
        file: path.relative(projectRoot, file),
        seconds: voice.durationSeconds,
      });
    }
  }

  // Índice legível para levar ao gerenciador de anúncios: o que é cada arquivo, para
  // qual posicionamento, com que ângulo e para qual destino.
  const index = targets.map((ad) => ({
    slug: ad.slug,
    frente: ad.front,
    angulo: ad.angle,
    destino: ad.destination,
    duracaoSegundos: manifest[ad.slug]?.durationSeconds,
    locucaoComercial: manifest[ad.slug]?.commercialUseAllowed ?? false,
    arquivos: rendered
      .filter((item) => item.slug === ad.slug)
      .map((item) => ({
        formato: item.format,
        posicionamentos: AD_FORMATS[item.format as AdFormatId].placements,
        arquivo: item.file,
      })),
    afirmacoes: ad.claims,
  }));

  await writeFile(path.join(outRoot, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  console.log(`\n${rendered.length} arquivos em ${path.relative(projectRoot, outRoot)}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
