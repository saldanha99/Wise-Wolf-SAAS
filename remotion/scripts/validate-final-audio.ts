import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_VIDEOS } from '../content/hub-videos';
import type { HubVideoSlug, HubVoiceTrack } from '../types';
import { assertHubFinalAudioTrack } from './final-audio-policy';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<HubVideoSlug, HubVoiceTrack>;
const failures: string[] = [];

for (const content of HUB_VIDEOS) {
  try {
    const evidence = assertHubFinalAudioTrack(manifest[content.slug]);
    console.log(`${content.slug}: take único, voz masculina PT-BR nativa, ${evidence.tokenCount} palavras alinhadas`);
  } catch (error) {
    failures.push(`${content.slug}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length > 0) {
  console.error('A coleção ainda não atende ao padrão final de áudio:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('As cinco locuções atendem ao padrão final premium.');
}
