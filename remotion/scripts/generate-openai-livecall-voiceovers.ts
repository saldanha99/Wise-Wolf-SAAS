import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { balanceHubCaptions, makeHubVtt } from '../captions';
import { HUB_VIDEOS, VIDEO_FPS } from '../content/hub-videos';
import type {
  HubVideoCaption,
  HubVideoSceneId,
  HubVideoSceneTiming,
  HubVideoSlug,
  HubVoiceTrack,
} from '../types';

type RemoteScene = {
  id: string;
  text: string;
  sceneHash: string;
};

type RemoteSceneResult = {
  id: string;
  file: string;
  requestId: string;
  sha256: string;
  bytes: number;
  transcriptSha256: string;
};

type RemoteManifest = {
  gateway: 'openrouter';
  model: string;
  voice: string;
  audioFormat: 'pcm16-wav';
  sampleRateHz: 24000;
  generatedAt: string;
  scenes: RemoteSceneResult[];
};

type CachedSceneMetadata = RemoteSceneResult & {
  sceneHash: string;
  durationSeconds: number;
  generatedAt: string;
  sourcePcmWavSha256: string;
  sourcePcmWavBytes: number;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(projectRoot, 'remotion/generated/hub-voice-manifest.json');
const audioDirectory = path.join(projectRoot, 'remotion/public/assets/hub/videos/audio');
const captionsDirectory = path.join(projectRoot, 'remotion/previews/assets/hub/videos/captions');
const generationDirectory = path.join(projectRoot, 'remotion/generated/voice');
const sceneCacheDirectory = path.join(projectRoot, 'remotion/generated/openai-livecall-scenes');
const sshHost = process.env.DEPLOY_SSH_HOST?.trim();
const modelId = 'openai/gpt-audio';
const voiceId = 'marin';
const voiceName = 'OpenAI Marin via OpenRouter · LiveCall PT-BR';
const generatorVersion = 3;
const temperature = 0.2;
const remoteBatchSize = 5;
const sceneGapSeconds = 0.18;
const tailSeconds = 0.35;
const instructions = [
  'Você é uma locutora brasileira profissional e fala exclusivamente português do Brasil com sotaque brasileiro neutro.',
  'Não use pronúncia, prosódia ou vocabulário de português de Portugal, espanhol ou inglês.',
  'Leia exatamente, palavra por palavra, o texto recebido na mensagem do usuário; não traduza, não reescreva, não corrija, não resuma e não acrescente nenhuma palavra.',
  'Use dicção clara, ritmo conversacional natural, pausas breves, tom acolhedor e comercial e energia crescente, sem cadência robotizada.',
  'A transcrição retornada também deve reproduzir exatamente o texto recebido.',
].join(' ');

if (!sshHost) throw new Error('DEPLOY_SSH_HOST precisa estar configurado em .env.deploy.local.');

const fixed = (value: number) => Number(value.toFixed(3));

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sha256Pattern = /^[a-f0-9]{64}$/u;

const normalizeTranscript = (value: string): string => value
  .normalize('NFC')
  .replace(/\u00a0/gu, ' ')
  .replace(/[\u200b-\u200d\ufeff]/gu, '')
  .replace(/\s+/gu, ' ')
  .trim();

const getDuration = (filePath: string): number => Number(execFileSync(
  'ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
  { encoding: 'utf8' },
).trim());

const safeReadJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
};

const chunkWords = (text: string): string[] => {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join(' '));
    current = [];
  };

  for (const word of words) {
    const candidate = [...current, word].join(' ');
    if (current.length >= 4 || candidate.length > 30) flush();
    current.push(word);
    if (/[.!?…]$/u.test(word) || (current.length >= 3 && /[,;:]$/u.test(word))) flush();
  }
  flush();
  return chunks;
};

const captionWeight = (text: string): number => {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length;
  const pause = /[.!?…]$/u.test(text) ? 5 : /[,;:]$/u.test(text) ? 2 : 0;
  return Math.max(letters + pause, 1);
};

const buildSceneCaptions = ({
  text,
  startSeconds,
  durationSeconds,
}: {
  text: string;
  startSeconds: number;
  durationSeconds: number;
}): HubVideoCaption[] => {
  const chunks = chunkWords(text);
  const weights = chunks.map(captionWeight);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0) || 1;
  let elapsedWeight = 0;

  return chunks.map((chunk, index) => {
    const captionStart = startSeconds + durationSeconds * (elapsedWeight / totalWeight);
    elapsedWeight += weights[index];
    const captionEnd = startSeconds + durationSeconds * (elapsedWeight / totalWeight);
    const words = chunk.split(/\s+/u).filter(Boolean);
    const wordWeights = words.map(captionWeight);
    const totalWordWeight = wordWeights.reduce((total, weight) => total + weight, 0) || 1;
    let elapsedWordWeight = 0;
    const tokens = words.map((word, wordIndex) => {
      const startMs = Math.round((captionStart + (captionEnd - captionStart) * (elapsedWordWeight / totalWordWeight)) * 1000);
      elapsedWordWeight += wordWeights[wordIndex];
      const endMs = Math.round((captionStart + (captionEnd - captionStart) * (elapsedWordWeight / totalWordWeight)) * 1000);
      return { text: word, startMs, endMs: Math.max(startMs + 1, endMs) };
    });

    return {
      text: chunk,
      startSeconds: fixed(captionStart),
      endSeconds: fixed(captionEnd),
      startMs: Math.round(captionStart * 1000),
      endMs: Math.round(captionEnd * 1000),
      timestampMs: null,
      confidence: null,
      tokens,
    };
  });
};

const buildRemotePython = (scenes: RemoteScene[]): string => {
  const payload = Buffer.from(JSON.stringify({
    scenes,
    model: modelId,
    voice: voiceId,
    temperature,
    instructions,
  }), 'utf8').toString('base64');

  return `
import base64
import binascii
import hashlib
import http.client
import io
import json
import os
import re
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import unicodedata
import urllib.error
import urllib.request
import wave

payload = json.loads(base64.b64decode("${payload}").decode("utf-8"))
sample_rate_hz = 24000
transient_statuses = {408, 409, 425, 429, 500, 502, 503, 504}

class TransientStreamError(RuntimeError):
    pass

class TranscriptMismatchError(RuntimeError):
    pass

def read_env(path):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                    value = value[1:-1]
                values[key.strip()] = value
    except FileNotFoundError:
        pass
    return values

def normalize_transcript(value):
    normalized = unicodedata.normalize("NFC", value)
    normalized = normalized.replace(chr(160), " ")
    for marker in (chr(8203), chr(8204), chr(8205), chr(65279)):
        normalized = normalized.replace(marker, "")
    return re.sub(r"\\s+", " ", normalized).strip()

def parse_error(error):
    error_code = "unknown"
    error_type = "unknown"
    try:
        error_data = json.loads(error.read().decode("utf-8"))
        error_details = error_data.get("error", {})
        if isinstance(error_details, dict):
            error_code = str(error_details.get("code") or "unknown")
            error_type = str(error_details.get("type") or "unknown")
    except Exception:
        pass
    return error_code, error_type

def iter_sse(response):
    data_lines = []
    for raw_line in response:
        try:
            line = raw_line.decode("utf-8").rstrip("\\r\\n")
        except UnicodeDecodeError as error:
            raise RuntimeError("OpenRouter devolveu um stream SSE inválido") from error
        if line == "":
            if data_lines:
                yield "\\n".join(data_lines)
                data_lines = []
            continue
        if line.startswith(":"):
            continue
        if line.startswith("data:"):
            value = line[5:]
            if value.startswith(" "):
                value = value[1:]
            data_lines.append(value)
    if data_lines:
        yield "\\n".join(data_lines)

environment = read_env("/opt/wisewolf/supabase-docker/.env")
api_key = os.environ.get("OPENROUTER_API_KEY", "").strip() or environment.get("OPENROUTER_API_KEY", "").strip()
if not api_key:
    result = subprocess.run(
        ["docker", "exec", "supabase-edge-functions", "sh", "-lc", 'printf %s "$OPENROUTER_API_KEY"'],
        check=True,
        capture_output=True,
    )
    api_key = result.stdout.decode("utf-8").strip()
if not api_key:
    raise RuntimeError("OPENROUTER_API_KEY ausente no servidor")

def synthesize(scene, output_path):
    request_body = json.dumps({
        "model": payload["model"],
        "stream": True,
        "modalities": ["text", "audio"],
        "audio": {
            "voice": payload["voice"],
            "format": "pcm16",
        },
        "temperature": payload["temperature"],
        "messages": [
            {"role": "system", "content": payload["instructions"]},
            {"role": "user", "content": scene["text"]},
        ],
    }, ensure_ascii=False).encode("utf-8")
    last_status = None
    for attempt in range(3):
        request = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=request_body,
            headers={
                "Authorization": "Bearer " + api_key,
                "Content-Type": "application/json",
                "Accept": "text/event-stream",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                content_type = response.headers.get("content-type", "").lower()
                if "text/event-stream" not in content_type:
                    raise RuntimeError("OpenRouter não devolveu um stream SSE de áudio")
                header_request_id = (response.headers.get("x-request-id") or "").strip()
                header_generation_id = (response.headers.get("x-generation-id") or "").strip()
                completion_id = ""
                audio_chunks = []
                transcript_parts = []
                stream_finished = False

                for event_data in iter_sse(response):
                    if event_data == "[DONE]":
                        stream_finished = True
                        continue
                    try:
                        event = json.loads(event_data)
                    except json.JSONDecodeError as error:
                        raise RuntimeError("OpenRouter devolveu um evento SSE inválido") from error
                    if isinstance(event.get("error"), dict):
                        error_code = str(event["error"].get("code") or "unknown")
                        error_type = str(event["error"].get("type") or "unknown")
                        raise RuntimeError("OpenRouter interrompeu a locução: code=" + error_code + " type=" + error_type)
                    event_id = event.get("id")
                    if isinstance(event_id, str) and event_id.strip():
                        if completion_id and completion_id != event_id.strip():
                            raise RuntimeError("OpenRouter alternou o identificador durante o stream")
                        completion_id = event_id.strip()
                    choices = event.get("choices")
                    if not isinstance(choices, list):
                        continue
                    for choice in choices:
                        if not isinstance(choice, dict):
                            continue
                        delta = choice.get("delta")
                        if not isinstance(delta, dict):
                            continue
                        audio_delta = delta.get("audio")
                        if not isinstance(audio_delta, dict):
                            continue
                        encoded_audio = audio_delta.get("data")
                        if isinstance(encoded_audio, str) and encoded_audio:
                            try:
                                audio_chunks.append(base64.b64decode(encoded_audio, validate=True))
                            except (binascii.Error, ValueError) as error:
                                raise RuntimeError("OpenRouter devolveu PCM16 em base64 inválido") from error
                        transcript_delta = audio_delta.get("transcript")
                        if isinstance(transcript_delta, str) and transcript_delta:
                            transcript_parts.append(transcript_delta)

            if not stream_finished:
                raise TransientStreamError("OpenRouter encerrou o stream antes de [DONE]")
            request_id = header_request_id or header_generation_id or completion_id
            if not request_id:
                raise RuntimeError("OpenRouter não devolveu x-request-id, x-generation-id nem completion id")
            pcm_audio = b"".join(audio_chunks)
            if len(pcm_audio) < int(sample_rate_hz * 2 * 0.4) or len(pcm_audio) % 2 != 0:
                raise RuntimeError("OpenRouter devolveu PCM16 vazio ou truncado")
            normalized_expected = normalize_transcript(scene["text"])
            normalized_transcript = normalize_transcript("".join(transcript_parts))
            if not normalized_transcript or normalized_transcript != normalized_expected:
                raise TranscriptMismatchError("A transcrição OpenRouter divergiu do roteiro")

            temporary_path = output_path + ".tmp"
            try:
                with wave.open(temporary_path, "wb") as handle:
                    handle.setnchannels(1)
                    handle.setsampwidth(2)
                    handle.setframerate(sample_rate_hz)
                    handle.writeframes(pcm_audio)
                os.replace(temporary_path, output_path)
            finally:
                if os.path.exists(temporary_path):
                    os.remove(temporary_path)
            with open(output_path, "rb") as handle:
                wav_audio = handle.read()
            return (
                request_id,
                hashlib.sha256(wav_audio).hexdigest(),
                len(wav_audio),
                hashlib.sha256(normalized_transcript.encode("utf-8")).hexdigest(),
            )
        except urllib.error.HTTPError as error:
            last_status = error.code
            error_code, error_type = parse_error(error)
            retryable = error.code in transient_statuses and error_code not in ("insufficient_quota", "credit_balance_exhausted")
            if not retryable or attempt == 2:
                raise RuntimeError("OpenRouter recusou a locução: HTTP " + str(error.code) + " code=" + error_code + " type=" + error_type)
            retry_after = error.headers.get("retry-after")
            try:
                wait_seconds = max(float(retry_after), 5.0 * (attempt + 1)) if retry_after else 5.0 * (attempt + 1)
            except ValueError:
                wait_seconds = 5.0 * (attempt + 1)
            time.sleep(min(wait_seconds, 30.0))
        except TranscriptMismatchError as error:
            if attempt == 2:
                raise RuntimeError("A transcrição OpenRouter divergiu do roteiro em três tentativas; a faixa foi recusada") from error
            time.sleep(1.0 * (attempt + 1))
        except (urllib.error.URLError, TimeoutError, ConnectionError, socket.timeout, http.client.IncompleteRead, TransientStreamError) as error:
            if attempt == 2:
                raise RuntimeError("OpenRouter não concluiu o stream após três tentativas transitórias") from error
            time.sleep(5.0 * (attempt + 1))
    raise RuntimeError("OpenRouter não concluiu a locução: HTTP " + str(last_status))

with tempfile.TemporaryDirectory(prefix="wise-wolf-openrouter-voice-") as directory:
    results = []
    for scene in payload["scenes"]:
        scene_id = scene["id"]
        if not scene_id.replace("-", "").isalnum():
            raise RuntimeError("Identificador de cena inválido")
        file_name = scene_id + ".wav"
        file_path = os.path.join(directory, file_name)
        request_id, audio_sha256, byte_count, transcript_sha256 = synthesize(scene, file_path)
        results.append({
            "id": scene_id,
            "file": file_name,
            "requestId": request_id,
            "sha256": audio_sha256,
            "bytes": byte_count,
            "transcriptSha256": transcript_sha256,
        })
        sys.stderr.write("OpenAI via OpenRouter LiveCall gerada: " + scene_id + "\\n")
        sys.stderr.flush()

    remote_manifest = {
        "gateway": "openrouter",
        "model": payload["model"],
        "voice": payload["voice"],
        "audioFormat": "pcm16-wav",
        "sampleRateHz": sample_rate_hz,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "scenes": results,
    }
    manifest_bytes = json.dumps(remote_manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\\n"
    manifest_info = tarfile.TarInfo("remote-manifest.json")
    manifest_info.size = len(manifest_bytes)
    with tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz") as archive:
        archive.addfile(manifest_info, io.BytesIO(manifest_bytes))
        for item in results:
            archive.add(os.path.join(directory, item["file"]), arcname=item["file"], recursive=False)
`;
};

const generateRemoteScenes = async ({
  scenes,
  outputDirectory,
}: {
  scenes: RemoteScene[];
  outputDirectory: string;
}): Promise<RemoteManifest> => {
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', sshHost, 'python3 -'],
    {
      input: buildRemotePython(scenes),
      encoding: null,
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr || '');
    const reason = stderr.trim().slice(-2000) || 'erro remoto sem detalhes';
    if (reason.includes('HTTP 402') || reason.includes('code=credit_balance_exhausted')) {
      throw new Error('O saldo OpenRouter usado pelo LiveCall está esgotado. Recarregue a conta e execute novamente; nenhuma faixa foi substituída.');
    }
    throw new Error(`Falha ao gerar locuções OpenAI via OpenRouter no servidor: ${reason}`);
  }
  const archiveBuffer = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(String(result.stdout || ''), 'binary');
  if (archiveBuffer.length < 1000) {
    throw new Error('O servidor não devolveu o pacote de locuções OpenAI via OpenRouter.');
  }

  const archivePath = path.join(outputDirectory, 'openai-livecall-scenes.tar.gz');
  await writeFile(archivePath, archiveBuffer, { mode: 0o600 });
  const archiveEntries = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  const expectedArchiveEntries = [
    'remote-manifest.json',
    ...scenes.map((scene) => `${scene.id}.wav`),
  ].sort();
  if (JSON.stringify(archiveEntries) !== JSON.stringify(expectedArchiveEntries)) {
    throw new Error('O pacote remoto contém arquivos inesperados e foi recusado.');
  }
  execFileSync('tar', ['-xzf', archivePath, '-C', outputDirectory], { stdio: 'ignore' });
  for (const entry of expectedArchiveEntries) {
    const details = await lstat(path.join(outputDirectory, entry));
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`O pacote remoto contém uma entrada insegura: ${entry}.`);
    }
  }
  const remoteManifest = await safeReadJson<RemoteManifest>(path.join(outputDirectory, 'remote-manifest.json'));
  if (
    !remoteManifest
    || remoteManifest.gateway !== 'openrouter'
    || remoteManifest.model !== modelId
    || remoteManifest.voice !== voiceId
    || remoteManifest.audioFormat !== 'pcm16-wav'
    || remoteManifest.sampleRateHz !== 24000
    || Number.isNaN(Date.parse(remoteManifest.generatedAt))
    || !Array.isArray(remoteManifest.scenes)
    || remoteManifest.scenes.length !== scenes.length
  ) {
    throw new Error('Manifesto remoto OpenAI via OpenRouter inválido.');
  }
  const expectedById = new Map(scenes.map((scene) => [scene.id, scene]));
  const resultIds = new Set<string>();
  for (const resultScene of remoteManifest.scenes) {
    const expectedScene = expectedById.get(resultScene.id);
    if (
      !expectedScene
      || resultIds.has(resultScene.id)
      || typeof resultScene.file !== 'string'
      || resultScene.file !== `${resultScene.id}.wav`
      || typeof resultScene.requestId !== 'string'
      || !resultScene.requestId.trim()
      || typeof resultScene.sha256 !== 'string'
      || !sha256Pattern.test(resultScene.sha256)
      || typeof resultScene.bytes !== 'number'
      || !Number.isSafeInteger(resultScene.bytes)
      || resultScene.bytes < 1000
      || typeof resultScene.transcriptSha256 !== 'string'
      || resultScene.transcriptSha256 !== sha256(normalizeTranscript(expectedScene.text))
    ) {
      throw new Error(`Evidência remota inválida no trecho ${resultScene.id || 'desconhecido'}.`);
    }
    resultIds.add(resultScene.id);
  }
  return remoteManifest;
};

const convertSceneWavToMp3 = ({ inputPath, outputPath }: { inputPath: string; outputPath: string }) => {
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '1',
    outputPath,
  ], { stdio: 'ignore' });
};

const concatenateScenes = ({ scenePaths, outputPath }: { scenePaths: string[]; outputPath: string }) => {
  const inputs = scenePaths.flatMap((scenePath) => ['-i', scenePath]);
  const filters = scenePaths.map((_, index) => {
    const format = `[${index}:a]aformat=sample_rates=44100:channel_layouts=mono`;
    return index === scenePaths.length - 1
      ? `${format}[scene${index}]`
      : `${format},apad=pad_dur=${sceneGapSeconds}[scene${index}]`;
  });
  const labels = scenePaths.map((_, index) => `[scene${index}]`).join('');
  filters.push(`${labels}concat=n=${scenePaths.length}:v=0:a=1[joined]`);
  filters.push(`[joined]highpass=f=65,lowpass=f=15000,loudnorm=I=-18:LRA=7:TP=-1.5,apad=pad_dur=${tailSeconds}[out]`);

  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[out]',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    '-ac',
    '1',
    outputPath,
  ], { stdio: 'ignore' });
};

const writeAtomic = async (filePath: string, contents: string | Buffer) => {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, contents, { mode: 0o644 });
  await rename(temporaryPath, filePath);
};

const readValidatedCachedScene = async (scene: RemoteScene): Promise<CachedSceneMetadata | null> => {
  const audioPath = path.join(sceneCacheDirectory, `${scene.id}.mp3`);
  const metadata = await safeReadJson<CachedSceneMetadata>(path.join(sceneCacheDirectory, `${scene.id}.json`));
  try {
    if (
      !metadata
      || metadata.id !== scene.id
      || metadata.file !== `${scene.id}.mp3`
      || metadata.sceneHash !== scene.sceneHash
      || !metadata.requestId?.trim()
      || !sha256Pattern.test(metadata.sha256)
      || !sha256Pattern.test(metadata.sourcePcmWavSha256)
      || metadata.transcriptSha256 !== sha256(normalizeTranscript(scene.text))
      || metadata.bytes < 1000
      || metadata.sourcePcmWavBytes < 1000
      || Number.isNaN(Date.parse(metadata.generatedAt))
      || !Number.isFinite(metadata.durationSeconds)
    ) return null;
    const details = await lstat(audioPath);
    const audioBuffer = await readFile(audioPath);
    const durationSeconds = fixed(getDuration(audioPath));
    if (
      !details.isFile()
      || details.isSymbolicLink()
      || details.size !== metadata.bytes
      || audioBuffer.length !== metadata.bytes
      || sha256(audioBuffer) !== metadata.sha256
      || durationSeconds < 0.4
      || Math.abs(durationSeconds - metadata.durationSeconds) > 0.01
    ) return null;
    return metadata;
  } catch {
    return null;
  }
};

await mkdir(audioDirectory, { recursive: true });
await mkdir(captionsDirectory, { recursive: true });
await mkdir(generationDirectory, { recursive: true });
await mkdir(sceneCacheDirectory, { recursive: true });

const runDirectory = await mkdtemp(path.join(tmpdir(), 'wise-wolf-openai-livecall-'));
try {
  const expectedScenes: RemoteScene[] = HUB_VIDEOS.flatMap((content) => content.narration.map((narration, index) => {
    const id = `${content.slug}-${index}-${narration.scene}`;
    return {
      id,
      text: narration.text,
      sceneHash: sha256(JSON.stringify({
        text: narration.text,
        modelId,
        voiceId,
        instructions,
        temperature,
        generatorVersion,
      })),
    };
  }));
  const missingScenes: RemoteScene[] = [];

  for (const scene of expectedScenes) {
    if (!await readValidatedCachedScene(scene)) missingScenes.push(scene);
  }

  if (missingScenes.length > 0) {
    console.log(`Gerando ${missingScenes.length} trechos com OpenAI ${voiceId} via OpenRouter...`);
    for (let batchStart = 0; batchStart < missingScenes.length; batchStart += remoteBatchSize) {
      const sceneBatch = missingScenes.slice(batchStart, batchStart + remoteBatchSize);
      const remoteDirectory = path.join(runDirectory, `remote-${batchStart / remoteBatchSize + 1}`);
      await mkdir(remoteDirectory, { recursive: true });
      const remoteManifest = await generateRemoteScenes({ scenes: sceneBatch, outputDirectory: remoteDirectory });
      const resultById = new Map(remoteManifest.scenes.map((scene) => [scene.id, scene]));

      for (const scene of sceneBatch) {
        const result = resultById.get(scene.id);
        if (!result) throw new Error(`Trecho remoto ausente: ${scene.id}`);
        const sourceAudioPath = path.join(remoteDirectory, result.file);
        const audioBuffer = await readFile(sourceAudioPath);
        if (sha256(audioBuffer) !== result.sha256 || audioBuffer.length !== result.bytes) {
          throw new Error(`Integridade inválida no trecho ${scene.id}.`);
        }
        const convertedAudioPath = path.join(runDirectory, `${scene.id}.mp3`);
        convertSceneWavToMp3({ inputPath: sourceAudioPath, outputPath: convertedAudioPath });
        const convertedAudioBuffer = await readFile(convertedAudioPath);
        const durationSeconds = fixed(getDuration(convertedAudioPath));
        if (convertedAudioBuffer.length < 1000 || durationSeconds < 0.4) {
          throw new Error(`Conversão MP3 inválida no trecho ${scene.id}.`);
        }
        const cachedAudioPath = path.join(sceneCacheDirectory, `${scene.id}.mp3`);
        const cachedMetadataPath = path.join(sceneCacheDirectory, `${scene.id}.json`);
        const temporaryCachedAudioPath = `${cachedAudioPath}.tmp-${process.pid}-${Date.now()}`;
        await copyFile(convertedAudioPath, temporaryCachedAudioPath);
        await rename(temporaryCachedAudioPath, cachedAudioPath);
        await writeAtomic(cachedMetadataPath, `${JSON.stringify({
          id: result.id,
          file: `${result.id}.mp3`,
          requestId: result.requestId,
          sha256: sha256(convertedAudioBuffer),
          bytes: convertedAudioBuffer.length,
          transcriptSha256: result.transcriptSha256,
          sceneHash: scene.sceneHash,
          durationSeconds,
          generatedAt: remoteManifest.generatedAt,
          sourcePcmWavSha256: result.sha256,
          sourcePcmWavBytes: result.bytes,
        }, null, 2)}\n`);
      }
      console.log(`Bloco OpenRouter validado e salvo: ${Math.min(batchStart + sceneBatch.length, missingScenes.length)}/${missingScenes.length} trechos.`);
    }
  } else {
    console.log('Reutilizando os trechos OpenAI via OpenRouter LiveCall já validados.');
  }

  const nextManifest = {} as Record<HubVideoSlug, HubVoiceTrack>;
  const candidateFiles: Array<{
    slug: HubVideoSlug;
    audioPath: string;
    audioFileName: string;
    captionText: string;
    metadataText: string;
  }> = [];

  for (const content of HUB_VIDEOS) {
    const scenePaths: string[] = [];
    const sceneMetadata: CachedSceneMetadata[] = [];

    for (const [index, narration] of content.narration.entries()) {
      const id = `${content.slug}-${index}-${narration.scene}`;
      const audioPath = path.join(sceneCacheDirectory, `${id}.mp3`);
      const metadata = await readValidatedCachedScene({
        id,
        text: narration.text,
        sceneHash: sha256(JSON.stringify({
          text: narration.text,
          modelId,
          voiceId,
          instructions,
          temperature,
          generatorVersion,
        })),
      });
      if (!metadata) throw new Error(`Cache OpenRouter ausente ou inválido para ${id}.`);
      scenePaths.push(audioPath);
      sceneMetadata.push(metadata);
    }

    const candidateAudioPath = path.join(runDirectory, `${content.slug}.mp3`);
    concatenateScenes({ scenePaths, outputPath: candidateAudioPath });
    const durationSeconds = fixed(getDuration(candidateAudioPath));
    const scenes = {} as Record<HubVideoSceneId, HubVideoSceneTiming>;
    const captions: HubVideoCaption[] = [];
    let sceneStart = 0;

    content.narration.forEach((narration, index) => {
      const speechDuration = sceneMetadata[index].durationSeconds;
      const last = index === content.narration.length - 1;
      const sceneEnd = last ? durationSeconds : sceneStart + speechDuration + sceneGapSeconds;
      scenes[narration.scene] = {
        startSeconds: fixed(sceneStart),
        endSeconds: fixed(sceneEnd),
      };
      captions.push(...buildSceneCaptions({
        text: narration.text,
        startSeconds: sceneStart,
        durationSeconds: Math.max(speechDuration - 0.04, 0.1),
      }));
      sceneStart = sceneEnd;
    });

    const balancedCaptions = balanceHubCaptions(captions);
    const narrationText = content.narration.map((narration) => narration.text).join(' ');
    const scriptHash = sha256(JSON.stringify({
      narrationText,
      modelId,
      voiceId,
      instructions,
      temperature,
      sceneHashes: sceneMetadata.map((metadata) => metadata.sceneHash),
      generatorVersion,
    }));
    const requestIds = sceneMetadata.map((metadata) => metadata.requestId);
    const requestId = requestIds[0];
    const generatedAt = new Date(Math.max(
      ...sceneMetadata.map((metadata) => Date.parse(metadata.generatedAt)),
    )).toISOString();
    const audioBuffer = await readFile(candidateAudioPath);
    const audioSha256 = sha256(audioBuffer);
    const audioFileName = `${content.slug}.${audioSha256}.mp3`;

    nextManifest[content.slug] = {
      ready: true,
      durationSeconds,
      durationInFrames: Math.ceil(durationSeconds * VIDEO_FPS),
      audioPath: `assets/hub/videos/audio/${audioFileName}`,
      voiceProvider: 'openai',
      voiceGateway: 'openrouter',
      voiceId,
      voiceName,
      voiceLocale: 'pt-BR',
      voiceAccent: 'brazilian-prompted',
      voiceSourceAccent: 'openai-built-in',
      voiceNative: false,
      voiceLocaleValidation: 'openai_prompted_pt_br',
      modelId,
      scriptHash,
      commercialUseAllowed: true,
      commercialLicenseBasis: 'openrouter_terms',
      commercialLicenseAcknowledgedAt: generatedAt,
      ttsInstructionsSha256: sha256(instructions),
      aiDisclosureMode: 'burned-in',
      generatedAt,
      requestId,
      captions: balancedCaptions,
      scenes,
    };

    candidateFiles.push({
      slug: content.slug,
      audioPath: candidateAudioPath,
      audioFileName,
      captionText: makeHubVtt(balancedCaptions),
      metadataText: `${JSON.stringify({
        slug: content.slug,
        generatedAt,
        provider: 'OpenAI via OpenRouter',
        gateway: 'openrouter',
        modelId,
        voiceId,
        voiceName,
        voiceLocale: 'pt-BR',
        voiceAccent: 'brazilian-prompted',
        voiceSourceAccent: 'openai-built-in',
        voiceNative: false,
        voiceLocaleValidation: 'openai_prompted_pt_br',
        instructions,
        temperature,
        ttsInstructionsSha256: sha256(instructions),
        generatorVersion,
        sourceAudioFormat: 'pcm16-wav',
        sourceSampleRateHz: 24000,
        scriptHash,
        commercialUseAllowed: true,
        commercialLicenseBasis: 'openrouter_terms',
        commercialLicenseAcknowledgedAt: generatedAt,
        aiDisclosureMode: 'burned-in',
        durationSeconds,
        characterCount: narrationText.length,
        requestId,
        requestIds,
        audioSha256,
      }, null, 2)}\n`,
    });
    console.log(`Locução OpenAI via OpenRouter LiveCall preparada: ${content.slug} (${durationSeconds}s)`);
  }

  for (const candidate of candidateFiles) {
    const targetAudioPath = path.join(audioDirectory, candidate.audioFileName);
    const targetCaptionPath = path.join(captionsDirectory, `${candidate.slug}.pt-BR.vtt`);
    const targetMetadataPath = path.join(generationDirectory, `${candidate.slug}.json`);
    const temporaryAudioPath = `${targetAudioPath}.tmp-${process.pid}`;
    await copyFile(candidate.audioPath, temporaryAudioPath);
    await rename(temporaryAudioPath, targetAudioPath);
    await writeAtomic(targetCaptionPath, candidate.captionText);
    await writeAtomic(targetMetadataPath, candidate.metadataText);
  }

  await writeAtomic(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  console.log(`Cinco locuções concluídas com OpenAI ${voiceId} via OpenRouter, o padrão do LiveCall.`);
} finally {
  await rm(runDirectory, { recursive: true, force: true });
}
