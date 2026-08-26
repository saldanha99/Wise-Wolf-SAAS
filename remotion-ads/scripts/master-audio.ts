// Masteriza o áudio dos MP4 já renderizados para -16 LUFS / -1,5 dBTP.
//
// Por que é um passo separado do render: o Remotion converte a locução mono em estéreo, e
// duplicar um canal soma ~3 LU na medição integrada. Medido: a locução sai do gerador a
// -16,1 LUFS e o MP4 renderizado mede -12,9. Não é clipe (o true peak fica em -3,2 dBTP),
// é só um desvio do alvo — mas é o mesmo alvo que o pipeline institucional usa, e um lote
// de anúncios com volumes diferentes entre si soa amador quando tocam em sequência.
//
// O vídeo é COPIADO sem recodificar (`-c:v copy`): só a faixa AAC é refeita. Não há
// segunda perda de qualidade de imagem e o passo leva segundos por arquivo.
//
// Uso: npx tsx remotion-ads/scripts/master-audio.ts

import { execFileSync, spawnSync } from 'node:child_process';
import { readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outRoot = path.join(projectRoot, 'remotion-ads/out');

const TARGET_LUFS = -16;
const TARGET_TP = -1.5;
const TARGET_LRA = 11;

/**
 * O ffmpeg escreve o resumo do loudnorm em STDERR, não em stdout — por isso spawnSync,
 * que devolve os dois separados. `execFileSync` devolve só stdout e a medição vinha nula.
 */
const measure = (filePath: string): number => {
  const result = spawnSync(
    'ffmpeg',
    ['-i', filePath, '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:print_format=summary`, '-f', 'null', '-'],
    { encoding: 'utf8' },
  );
  const match = (result.stderr ?? '').match(/Input Integrated:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  if (!match) throw new Error(`Não consegui medir a loudness de ${filePath}`);
  return Number(match[1]);
};

const collectVideos = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await collectVideos(full));
    else if (entry.name.endsWith('.mp4')) found.push(full);
  }
  return found.sort();
};

const main = async () => {
  const videos = await collectVideos(outRoot);
  if (videos.length === 0) throw new Error('Nenhum MP4 em remotion-ads/out. Renderize antes.');

  for (const video of videos) {
    const before = measure(video);
    const temp = `${video}.master.mp4`;

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-i', video,
        '-c:v', 'copy',
        '-af', `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP}:LRA=${TARGET_LRA}`,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '48000',
        '-movflags', '+faststart',
        temp,
      ],
      { stdio: 'ignore' },
    );

    await rename(temp, video);
    const after = measure(video);
    const size = (await stat(video)).size / 1048576;
    console.log(
      `✓ ${path.basename(video).padEnd(46)} ${before.toFixed(1)} → ${after.toFixed(1)} LUFS  ${size.toFixed(1)} MB`,
    );
  }

  console.log(`\n${videos.length} arquivos masterizados para ${TARGET_LUFS} LUFS.`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
