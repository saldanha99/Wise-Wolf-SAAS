import { spawnSync } from 'node:child_process';
import { lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const HUB_AUDIO_MASTERING = {
  algorithm: 'ffmpeg-loudnorm',
  targetIntegratedLufs: -16,
  targetLraLu: 11,
  targetTruePeakDbtp: -1.5,
  maxTruePeakDbtp: -1,
  audioCodec: 'aac',
  audioBitrate: '128k',
  sampleRateHz: 48_000,
} as const;

export type HubAudioLoudnessMetrics = {
  integratedLufs: number;
  loudnessRangeLu: number;
  truePeakDbtp: number;
};

type ProbeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  start_time?: string;
  duration?: string;
};

type ProbeOutput = {
  streams?: ProbeStream[];
  format?: {
    duration?: string;
  };
};

export type HubAudioMasteringResult = {
  changed: boolean;
  before: HubAudioLoudnessMetrics;
  after: HubAudioLoudnessMetrics;
  durationSeconds: number;
  videoPacketSha256: string;
};

const sanitizedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu.test(key)),
);

const runCapture = (command: string, args: string[]): { stdout: string; stderr: string } => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: sanitizedEnvironment,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || '').trim().slice(-1_200);
    throw new Error(`${path.basename(command)} falhou${reason ? `: ${reason}` : ''}`);
  }
  return { stdout: result.stdout || '', stderr: result.stderr || '' };
};

const parseFiniteMetric = (summary: string, pattern: RegExp, label: string): number => {
  const match = summary.match(pattern);
  const value = Number(match?.[1]);
  if (!Number.isFinite(value)) throw new Error(`Métrica ${label} ausente na análise EBU R128.`);
  return value;
};

export const parseEbur128Summary = (output: string): HubAudioLoudnessMetrics => {
  const summaryStart = output.lastIndexOf('Summary:');
  if (summaryStart < 0) throw new Error('Resumo EBU R128 ausente.');
  const summary = output.slice(summaryStart);
  return {
    integratedLufs: parseFiniteMetric(summary, /I:\s*(-?\d+(?:\.\d+)?)\s+LUFS/u, 'I'),
    loudnessRangeLu: parseFiniteMetric(summary, /LRA:\s*(-?\d+(?:\.\d+)?)\s+LU/u, 'LRA'),
    truePeakDbtp: parseFiniteMetric(summary, /Peak:\s*(-?\d+(?:\.\d+)?)\s+dBFS/u, 'true peak'),
  };
};

export const measureAudioLoudness = (filePath: string): HubAudioLoudnessMetrics => {
  const result = runCapture('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i', filePath,
    '-map', '0:a:0',
    '-af', 'ebur128=peak=true',
    '-f', 'null',
    '-',
  ]);
  return parseEbur128Summary(result.stderr);
};

export const isAudioWithinMasteringSpec = (metrics: HubAudioLoudnessMetrics): boolean =>
  metrics.truePeakDbtp <= HUB_AUDIO_MASTERING.maxTruePeakDbtp + 0.05
  && Math.abs(metrics.integratedLufs - HUB_AUDIO_MASTERING.targetIntegratedLufs) <= 0.75;

const probeMedia = (filePath: string): ProbeOutput => {
  const result = runCapture('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,start_time,duration:format=duration',
    '-of', 'json',
    filePath,
  ]);
  return JSON.parse(result.stdout) as ProbeOutput;
};

const requireFinite = (value: string | undefined, label: string): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} ausente no arquivo de vídeo.`);
  return parsed;
};

const videoPacketSha256 = (filePath: string): string => {
  const result = runCapture('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-map', '0:v:0',
    '-c', 'copy',
    '-f', 'hash',
    '-hash', 'sha256',
    '-',
  ]);
  const hash = result.stdout.trim().match(/^SHA256=([a-f0-9]{64})$/u)?.[1];
  if (!hash) throw new Error('Não foi possível calcular o hash do fluxo visual.');
  return hash;
};

const assertPreservedMedia = ({
  before,
  after,
  beforeVideoHash,
  afterVideoHash,
}: {
  before: ProbeOutput;
  after: ProbeOutput;
  beforeVideoHash: string;
  afterVideoHash: string;
}): number => {
  const beforeVideo = before.streams?.find((stream) => stream.codec_type === 'video');
  const afterVideo = after.streams?.find((stream) => stream.codec_type === 'video');
  const beforeAudio = before.streams?.find((stream) => stream.codec_type === 'audio');
  const afterAudio = after.streams?.find((stream) => stream.codec_type === 'audio');
  const beforeDuration = requireFinite(before.format?.duration, 'Duração original');
  const afterDuration = requireFinite(after.format?.duration, 'Duração masterizada');

  if (!beforeVideo || !afterVideo || !beforeAudio || !afterAudio) {
    throw new Error('Faixas de áudio ou vídeo ausentes durante a masterização.');
  }
  if (beforeVideoHash !== afterVideoHash) throw new Error('O fluxo visual mudou durante a masterização.');
  if (afterVideo.codec_name !== beforeVideo.codec_name
    || afterVideo.width !== beforeVideo.width
    || afterVideo.height !== beforeVideo.height
    || afterVideo.r_frame_rate !== beforeVideo.r_frame_rate) {
    throw new Error('Codec, resolução ou taxa de quadros mudou durante a masterização.');
  }
  if (afterAudio.codec_name !== HUB_AUDIO_MASTERING.audioCodec
    || Number(afterAudio.sample_rate) !== HUB_AUDIO_MASTERING.sampleRateHz
    || afterAudio.channels !== beforeAudio.channels) {
    throw new Error('A faixa AAC masterizada não preservou amostragem ou canais.');
  }
  if (Math.abs(afterDuration - beforeDuration) > 0.002) {
    throw new Error(`A duração mudou de ${beforeDuration.toFixed(3)}s para ${afterDuration.toFixed(3)}s.`);
  }
  const beforeVideoStart = requireFinite(beforeVideo.start_time, 'Início original do vídeo');
  const afterVideoStart = requireFinite(afterVideo.start_time, 'Início masterizado do vídeo');
  const beforeAudioStart = requireFinite(beforeAudio.start_time, 'Início original do áudio');
  const afterAudioStart = requireFinite(afterAudio.start_time, 'Início masterizado do áudio');
  if (Math.abs(beforeVideoStart - afterVideoStart) > 0.001
    || Math.abs(beforeAudioStart - afterAudioStart) > 0.001) {
    throw new Error('A sincronia inicial mudou durante a masterização.');
  }
  return afterDuration;
};

export const masterVideoAudio = async (filePath: string): Promise<HubAudioMasteringResult> => {
  const details = await lstat(filePath);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Master inválido: ${filePath}`);

  const before = measureAudioLoudness(filePath);
  const beforeProbe = probeMedia(filePath);
  const beforeVideoHash = videoPacketSha256(filePath);
  const originalDuration = requireFinite(beforeProbe.format?.duration, 'Duração original');
  if (isAudioWithinMasteringSpec(before)) {
    return {
      changed: false,
      before,
      after: before,
      durationSeconds: originalDuration,
      videoPacketSha256: beforeVideoHash,
    };
  }

  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.mastering-${process.pid}-${Date.now()}.mp4`,
  );

  try {
    runCapture('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', filePath,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-map_metadata', '0',
      '-c:v', 'copy',
      '-af', `loudnorm=I=${HUB_AUDIO_MASTERING.targetIntegratedLufs}:LRA=${HUB_AUDIO_MASTERING.targetLraLu}:TP=${HUB_AUDIO_MASTERING.targetTruePeakDbtp}`,
      '-c:a', HUB_AUDIO_MASTERING.audioCodec,
      '-b:a', HUB_AUDIO_MASTERING.audioBitrate,
      '-ar', String(HUB_AUDIO_MASTERING.sampleRateHz),
      '-t', originalDuration.toFixed(6),
      '-movflags', '+faststart',
      temporaryPath,
    ]);

    const afterProbe = probeMedia(temporaryPath);
    const afterVideoHash = videoPacketSha256(temporaryPath);
    const durationSeconds = assertPreservedMedia({
      before: beforeProbe,
      after: afterProbe,
      beforeVideoHash,
      afterVideoHash,
    });
    const after = measureAudioLoudness(temporaryPath);
    if (!isAudioWithinMasteringSpec(after)) {
      throw new Error(`Master fora do padrão: ${after.integratedLufs.toFixed(1)} LUFS / ${after.truePeakDbtp.toFixed(1)} dBTP.`);
    }

    await rename(temporaryPath, filePath);
    return {
      changed: true,
      before,
      after,
      durationSeconds,
      videoPacketSha256: afterVideoHash,
    };
  } finally {
    await unlink(temporaryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
};
