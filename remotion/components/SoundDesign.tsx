import React from 'react';
import { Audio } from '@remotion/media';
import { Sequence, interpolate, staticFile, useVideoConfig } from 'remotion';
import type { HubVideoCaption, HubVideoSlug } from '../types';

const MUSIC_PATHS: Record<HubVideoSlug, string> = {
  'hub-overview': 'assets/hub/videos/sound/hub-overview-bed-v2.wav',
  library: 'assets/hub/videos/sound/library-bed-v2.wav',
  'educator-ai': 'assets/hub/videos/sound/educator-ai-bed-v2.wav',
  wolfie: 'assets/hub/videos/sound/wolfie-bed-v2.wav',
  'school-os': 'assets/hub/videos/sound/school-os-bed-v2.wav',
};
const WHOOSH_PATH = 'assets/hub/videos/sound/hub-scene-whoosh-v1.wav';
const LOGO_IMPACT_PATH = 'assets/hub/videos/sound/hub-logo-impact-v1.wav';

const voiceDucking = (frame: number, fps: number, captions: HubVideoCaption[]) => {
  const fadeFrames = Math.max(1, Math.round(fps * 0.2));
  let activity = 0;
  for (const caption of captions) {
    const start = caption.startMs / 1000 * fps;
    const end = caption.endMs / 1000 * fps;
    const attack = interpolate(frame, [start - fadeFrames, start], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    const release = interpolate(frame, [end, end + fadeFrames], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    activity = Math.max(activity, Math.min(attack, release));
  }
  return interpolate(activity, [0, 1], [1, 0.64]);
};

export const SoundDesign: React.FC<{
  slug: HubVideoSlug;
  captions: HubVideoCaption[];
  boundaryFrames: number[];
  ctaFrame: number;
}> = ({ slug, captions, boundaryFrames, ctaFrame }) => {
  const { durationInFrames, fps } = useVideoConfig();

  return (
    <>
      <Audio
        src={staticFile(MUSIC_PATHS[slug])}
        volume={(frame) => {
          const fade = interpolate(
            frame,
            [0, fps * 1.3, Math.max(fps * 1.3 + 1, durationInFrames - fps * 2.2), durationInFrames],
            [0, 0.62, 0.62, 0],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
          );
          const pulse = 0.95 + Math.sin(frame / (fps * 0.82)) * 0.05;
          return fade * pulse * voiceDucking(frame, fps, captions);
        }}
      />
      {boundaryFrames.map((boundaryFrame) => (
        <Sequence key={boundaryFrame} from={Math.max(0, boundaryFrame - 10)} durationInFrames={Math.round(fps * 0.92)}>
          <Audio
            src={staticFile(WHOOSH_PATH)}
            volume={(frame) => interpolate(frame, [0, fps * 0.22, fps * 0.92], [0, 0.2, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })}
          />
        </Sequence>
      ))}
      <Sequence from={Math.max(0, ctaFrame - 2)} durationInFrames={Math.round(fps * 1.55)}>
        <Audio src={staticFile(LOGO_IMPACT_PATH)} volume={0.62} />
      </Sequence>
    </>
  );
};
