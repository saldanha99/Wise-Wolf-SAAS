import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 48_000;
const TRACK_DURATION_SECONDS = 48;
const SOUND_VERSION = 2;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputDirectory = path.join(projectRoot, 'remotion/public/assets/hub/videos/sound');

type StereoSample = { left: number; right: number };

const clamp = (value: number, minimum = -1, maximum = 1) => Math.min(maximum, Math.max(minimum, value));
const smoothstep = (value: number) => {
  const normalized = clamp(value, 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
};
const oscillator = (frequency: number, time: number, phase = 0) => Math.sin(Math.PI * 2 * frequency * time + phase);

const createNoise = (seed = 0x6d2b79f5) => {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (((value ^ (value >>> 14)) >>> 0) / 4_294_967_296) * 2 - 1;
  };
};

const encodeWav = (samples: StereoSample[]): Buffer => {
  const channelCount = 2;
  const bytesPerSample = 2;
  const dataSize = samples.length * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (const sample of samples) {
    buffer.writeInt16LE(Math.round(clamp(sample.left) * 32_767), offset);
    buffer.writeInt16LE(Math.round(clamp(sample.right) * 32_767), offset + 2);
    offset += 4;
  }
  return buffer;
};

const normalize = (samples: StereoSample[], targetPeak: number) => {
  const peak = samples.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample.left), Math.abs(sample.right)), 0);
  const gain = peak > 0 ? targetPeak / peak : 1;
  return samples.map((sample) => ({ left: sample.left * gain, right: sample.right * gain }));
};

type BedProfile = {
  bpm: number;
  roots: number[];
  seed: number;
  pad: number;
  bass: number;
  kick: number;
  pluck: number;
  hat: number;
  air: number;
  movement: number;
};

const createCinematicBed = (profile: BedProfile): StereoSample[] => {
  const totalSamples = TRACK_DURATION_SECONDS * SAMPLE_RATE;
  const beatSeconds = 60 / profile.bpm;
  const barSeconds = beatSeconds * 4;
  const roots = profile.roots;
  const chordRatios = [1, 1.5, 2, 2.5];
  const arpeggioRatios = [2, 3, 4, 3, 2.5, 3, 4.5, 4];
  const transitionMoments = [7.4, 14.6, 22.1, 29.5, 37.2, 44.2];
  const noise = createNoise(profile.seed);
  let previousNoise = 0;
  const samples: StereoSample[] = [];

  for (let index = 0; index < totalSamples; index += 1) {
    const time = index / SAMPLE_RATE;
    const barPosition = time / barSeconds;
    const barIndex = Math.floor(barPosition);
    const localBar = barPosition - barIndex;
    const root = roots[barIndex % roots.length];
    const nextRoot = roots[(barIndex + 1) % roots.length];
    const chordBlend = smoothstep((localBar - 0.78) / 0.22);
    const padRoot = root * (1 - chordBlend) + nextRoot * chordBlend;
    const localBeat = time % beatSeconds;
    const beatEnvelope = Math.exp(-localBeat * 6.8);
    const halfBeat = beatSeconds / 2;
    const localPulse = time % halfBeat;
    const pulseIndex = Math.floor(time / halfBeat);
    const pluckEnvelope = Math.exp(-localPulse * 10.5);
    const arpeggioFrequency = root * arpeggioRatios[pulseIndex % arpeggioRatios.length];
    const pad = chordRatios.reduce((sum, ratio, chordIndex) => (
      sum + oscillator(padRoot * ratio, time, chordIndex * 0.34 + Math.sin(time * 0.11) * 0.18) / (1.6 + chordIndex * 0.7)
    ), 0);
    const padMovement = 0.72 + Math.sin(time * profile.movement) * 0.16 + Math.sin(time * 0.071) * 0.1;
    const bass = oscillator(root, time) * beatEnvelope * profile.bass
      + oscillator(root / 2, time, 0.25) * beatEnvelope * profile.bass * 0.65;
    const kickFrequency = 48 + 62 * Math.exp(-localBeat * 26);
    const kick = oscillator(kickFrequency, localBeat) * Math.exp(-localBeat * 12.5) * profile.kick;
    const pluck = (oscillator(arpeggioFrequency, time) + oscillator(arpeggioFrequency * 2, time, 0.18) * 0.25)
      * pluckEnvelope * profile.pluck;
    const rawNoise = noise();
    const highNoise = rawNoise - previousNoise * 0.92;
    previousNoise = rawNoise;
    const offbeat = Math.abs(localBeat - beatSeconds / 2);
    const hatEnvelope = Math.exp(-offbeat * 62) * (offbeat < 0.09 ? 1 : 0);
    const hat = highNoise * hatEnvelope * profile.hat;
    const air = highNoise * (profile.air + Math.sin(time * 0.19) * profile.air * 0.34);
    const transitionEnergy = transitionMoments.reduce((sum, moment) => {
      const distance = time - moment;
      if (distance < -1.2 || distance > 0.32) return sum;
      const rising = distance < 0 ? smoothstep((distance + 1.2) / 1.2) : 1 - smoothstep(distance / 0.32);
      return sum + rising;
    }, 0);
    const transitionLift = highNoise * transitionEnergy * 0.055
      + oscillator(220 + transitionEnergy * 180, time) * transitionEnergy * 0.018;
    const fadeIn = smoothstep(time / 2.4);
    const fadeOut = 1 - smoothstep((time - (TRACK_DURATION_SECONDS - 3.2)) / 3.2);
    const masterEnvelope = fadeIn * fadeOut;
    const left = (pad * padMovement * profile.pad + bass + kick + pluck * 1.04 + hat + air + transitionLift) * masterEnvelope;
    const rightPad = chordRatios.reduce((sum, ratio, chordIndex) => (
      sum + oscillator(padRoot * ratio * 1.0014, time, 0.48 + chordIndex * 0.29) / (1.6 + chordIndex * 0.7)
    ), 0);
    const right = (rightPad * padMovement * profile.pad + bass * 0.98 + kick + pluck * 0.92 + hat * 0.88 - air + transitionLift * 0.84) * masterEnvelope;
    samples.push({ left, right });
  }

  return normalize(samples, 0.72);
};

const createWhoosh = (): StereoSample[] => {
  const durationSeconds = 0.92;
  const totalSamples = Math.round(durationSeconds * SAMPLE_RATE);
  const noise = createNoise();
  let previousNoise = 0;
  const samples = Array.from({ length: totalSamples }, (_, index) => {
    const time = index / SAMPLE_RATE;
    const progress = time / durationSeconds;
    const envelope = Math.pow(Math.sin(Math.PI * progress), 1.65);
    const rawNoise = noise();
    const highNoise = rawNoise - previousNoise * 0.86;
    previousNoise = rawNoise;
    const tone = oscillator(170 + progress * 760, time, progress * 8) * 0.16;
    const pan = Math.sin((progress - 0.5) * Math.PI) * 0.36;
    return {
      left: (highNoise * 0.45 + tone) * envelope * (1 - pan),
      right: (highNoise * 0.45 + tone) * envelope * (1 + pan),
    };
  });
  return normalize(samples, 0.76);
};

const createLogoImpact = (): StereoSample[] => {
  const durationSeconds = 1.55;
  const totalSamples = Math.round(durationSeconds * SAMPLE_RATE);
  const noise = createNoise();
  const samples = Array.from({ length: totalSamples }, (_, index) => {
    const time = index / SAMPLE_RATE;
    const lowEnvelope = Math.exp(-time * 3.3);
    const chimeEnvelope = Math.exp(-time * 2.15);
    const shimmerEnvelope = Math.exp(-time * 4.8);
    const low = oscillator(54, time) * 0.54 + oscillator(81, time, 0.18) * 0.23;
    const chimeLeft = oscillator(440, time) * 0.19 + oscillator(660, time, 0.37) * 0.12;
    const chimeRight = oscillator(441.6, time, 0.32) * 0.19 + oscillator(663, time, 0.64) * 0.12;
    const shimmer = noise() * shimmerEnvelope * 0.12;
    return {
      left: low * lowEnvelope + chimeLeft * chimeEnvelope + shimmer,
      right: low * lowEnvelope + chimeRight * chimeEnvelope - shimmer * 0.72,
    };
  });
  return normalize(samples, 0.78);
};

await mkdir(outputDirectory, { recursive: true });
const assets = [
  {
    name: 'hub-overview-bed-v2.wav',
    samples: createCinematicBed({ bpm: 96, roots: [73.416, 55, 82.407, 65.406], seed: 0x6d2b79f5, pad: 0.13, bass: 0.34, kick: 0.5, pluck: 0.16, hat: 0.055, air: 0.012, movement: 0.33 }),
    durationSeconds: TRACK_DURATION_SECONDS,
    role: 'music-hub-overview',
  },
  {
    name: 'library-bed-v2.wav',
    samples: createCinematicBed({ bpm: 84, roots: [65.406, 82.407, 73.416, 55], seed: 0x27d4eb2d, pad: 0.16, bass: 0.24, kick: 0.28, pluck: 0.12, hat: 0.032, air: 0.018, movement: 0.24 }),
    durationSeconds: TRACK_DURATION_SECONDS,
    role: 'music-library',
  },
  {
    name: 'educator-ai-bed-v2.wav',
    samples: createCinematicBed({ bpm: 102, roots: [55, 65.406, 82.407, 73.416], seed: 0x165667b1, pad: 0.11, bass: 0.28, kick: 0.38, pluck: 0.21, hat: 0.048, air: 0.01, movement: 0.42 }),
    durationSeconds: TRACK_DURATION_SECONDS,
    role: 'music-educator-ai',
  },
  {
    name: 'wolfie-bed-v2.wav',
    samples: createCinematicBed({ bpm: 108, roots: [82.407, 73.416, 65.406, 98], seed: 0x9e3779b9, pad: 0.1, bass: 0.3, kick: 0.42, pluck: 0.18, hat: 0.062, air: 0.014, movement: 0.48 }),
    durationSeconds: TRACK_DURATION_SECONDS,
    role: 'music-wolfie',
  },
  {
    name: 'school-os-bed-v2.wav',
    samples: createCinematicBed({ bpm: 92, roots: [55, 73.416, 65.406, 49], seed: 0x85ebca6b, pad: 0.12, bass: 0.4, kick: 0.46, pluck: 0.1, hat: 0.04, air: 0.009, movement: 0.28 }),
    durationSeconds: TRACK_DURATION_SECONDS,
    role: 'music-school-os',
  },
  { name: 'hub-scene-whoosh-v1.wav', samples: createWhoosh(), durationSeconds: 0.92, role: 'transition' },
  { name: 'hub-logo-impact-v1.wav', samples: createLogoImpact(), durationSeconds: 1.55, role: 'logo' },
];
const manifestAssets = [];

for (const asset of assets) {
  const buffer = encodeWav(asset.samples);
  await writeFile(path.join(outputDirectory, asset.name), buffer, { mode: 0o644 });
  manifestAssets.push({
    file: asset.name,
    role: asset.role,
    durationSeconds: asset.durationSeconds,
    sampleRate: SAMPLE_RATE,
    channels: 2,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  });
}

await writeFile(
  path.join(outputDirectory, 'original-soundtrack.json'),
  `${JSON.stringify({
    schemaVersion: 1,
    soundVersion: SOUND_VERSION,
    title: 'Wise Wolf Hub · Solution Scores',
    origin: 'Procedurally synthesized for Wise Wolf from deterministic source code in this repository.',
    license: 'Original Wise Wolf production audio. No third-party samples, melodies, recordings or remote assets.',
    assets: manifestAssets,
  }, null, 2)}\n`,
  { encoding: 'utf8', mode: 0o644 },
);

console.log(`Trilha e assinatura sonora originais geradas em ${outputDirectory}.`);
