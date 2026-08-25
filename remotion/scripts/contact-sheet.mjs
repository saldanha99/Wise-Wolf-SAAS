/**
 * Monta o contact sheet de revisão a partir dos MP4 já renderizados.
 *
 * Existe porque a folha anterior foi montada à mão e ficou defasada sem ninguém
 * perceber: o render de prévia reaproveita o arquivo antigo quando ele existe,
 * então "Concluído" não garante que a folha mostre o código atual. Aqui os
 * quadros saem SEMPRE do MP4 em disco, e o rodapé carimba o horário do arquivo.
 *
 * Uso: node remotion/scripts/contact-sheet.mjs [slug]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// remotion/scripts/contact-sheet.mjs → sobe três níveis até a raiz do projeto.
const projectRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const videosDir = path.join(projectRoot, 'remotion/previews/assets/hub/videos');
const outDir = path.join(projectRoot, 'remotion/previews/qa-final');
const tmpDir = path.join(outDir, '.frames');

// Momentos que a revisão precisa ver. Para o overview, os quatro painéis do
// ecossistema entram em 12,0s / 14,1s / 16,1s / 18,2s (frames 0/62/124/186 da
// cena de produto, que começa em 11,98s).
const BEATS = {
  'hub-overview': [
    ['02.0', 'Hook'],
    ['07.5', 'Problema'],
    ['13.5', 'Ensinar · livros e ebooks'],
    ['15.4', 'Planejar · Educador IA'],
    ['17.4', 'Engajar · Wolfie'],
    ['20.5', 'Operar · automações'],
    ['27.5', 'Prova · isolamento'],
    ['34.5', 'CTA'],
  ],
  library: [
    ['02.0', 'Hook'],
    ['08.0', 'Problema'],
    ['11.8', 'Busca e filtros'],
    ['14.8', 'Catálogo populado'],
    ['18.2', 'Material aberto'],
    ['24.0', 'Prova de acesso'],
    ['30.5', 'CTA'],
  ],
  'educator-ai': [
    ['02.0', 'Hook'],
    ['09.0', 'Problema'],
    ['14.5', 'Contexto pedagógico'],
    ['17.8', 'Geração do plano'],
    ['21.2', 'Revisão humana'],
    ['26.5', 'Prova de fluxo'],
    ['31.8', 'CTA'],
  ],
  wolfie: [
    ['02.0', 'Hook'],
    ['08.0', 'Problema'],
    ['13.2', 'Cenários'],
    ['15.5', 'Entrevista profissional'],
    ['18.8', 'Reunião internacional'],
    ['26.5', 'Feedback'],
    ['31.8', 'CTA'],
  ],
  'school-os': [
    ['02.0', 'Hook'],
    ['09.0', 'Problema'],
    ['14.0', 'Dashboard'],
    ['16.8', 'CRM'],
    ['19.8', 'Branding e credenciais'],
    ['26.5', 'Isolamento'],
    ['32.0', 'CTA'],
  ],
};

const run = (bin, args) => execFileSync(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
];
const fontFile = FONT_CANDIDATES.find((candidate) => existsSync(candidate));
if (!fontFile) {
  console.error('nenhuma fonte utilizável encontrada para rotular os quadros.');
  process.exit(1);
}

const slug = process.argv[2] || 'hub-overview';
const beats = BEATS[slug];
if (!beats) {
  console.error(`slug desconhecido: ${slug}. Use um de: ${Object.keys(BEATS).join(', ')}`);
  process.exit(1);
}

const videoPath = path.join(videosDir, `${slug}.mp4`);
let renderedAt;
try {
  renderedAt = statSync(videoPath).mtime;
} catch {
  console.error(`vídeo não encontrado: ${videoPath}. Rode npm run video:render:all antes.`);
  process.exit(1);
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const tiles = [];
beats.forEach(([seconds, label], index) => {
  const raw = path.join(tmpDir, `raw-${index}.png`);
  const tile = path.join(tmpDir, `tile-${index}.png`);
  run('ffmpeg', ['-loglevel', 'error', '-ss', seconds, '-i', videoPath, '-frames:v', '1', '-y', raw]);
  // Faixa preta embaixo com o rótulo do momento — sem isso a folha vira um
  // mosaico de telas parecidas e ninguém sabe qual trecho está olhando.
  run('magick', [
    raw,
    '-resize', '860x484',
    '-background', '#0b0e14',
    '-fill', '#e7edfa',
    '-font', fontFile,
    '-pointsize', '22',
    '-gravity', 'south',
    '-splice', '0x44',
    '-gravity', 'southwest',
    '-annotate', '+16+11', `${seconds}s   ${label}`,
    '-bordercolor', '#1c2941',
    '-border', '2',
    tile,
  ]);
  tiles.push(tile);
});

const stamp = renderedAt.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const sheetPath = path.join(outDir, `${slug}-contact-sheet.jpg`);
run('sh', ['-c', [
  `magick montage ${tiles.map((tile) => `'${tile}'`).join(' ')}`,
  `-tile 2x -geometry +8+8 -background '#070a10' png:-`,
  `| magick - -background '#070a10' -fill '#7f8ea9' -font '${fontFile}' -pointsize 20`,
  `-gravity south -splice 0x40 -annotate +0+12`,
  `'${slug}.mp4  ·  renderizado ${stamp}  ·  prévia local pt-BR, não comercial'`,
  `-quality 88 '${sheetPath}'`,
].join(' ')]);

rmSync(tmpDir, { recursive: true, force: true });
console.log(sheetPath);
