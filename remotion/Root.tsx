import React from 'react';
import { Composition, Folder } from 'remotion';
import voiceManifestData from './generated/hub-voice-manifest.json';
import {
  HUB_VIDEOS,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_STORY_HEIGHT,
  VIDEO_STORY_WIDTH,
  VIDEO_WIDTH,
} from './content/hub-videos';
import { HubMarketingVideo } from './HubMarketingVideo';
import type { HubVideoSlug, HubVoiceTrack } from './types';

const voiceManifest = voiceManifestData as Record<HubVideoSlug, HubVoiceTrack>;

export const RemotionRoot: React.FC = () => (
  <Folder name="WiseWolfHub">
    {HUB_VIDEOS.map((content) => {
      const voiceTrack = voiceManifest[content.slug];
      return (
        <React.Fragment key={content.id}>
          <Composition
            id={content.id}
            component={HubMarketingVideo}
            width={VIDEO_WIDTH}
            height={VIDEO_HEIGHT}
            fps={VIDEO_FPS}
            durationInFrames={voiceTrack.durationInFrames}
            defaultProps={{ content, voiceTrack, format: 'landscape' as const }}
          />
          <Composition
            id={`${content.id}Story`}
            component={HubMarketingVideo}
            width={VIDEO_STORY_WIDTH}
            height={VIDEO_STORY_HEIGHT}
            fps={VIDEO_FPS}
            durationInFrames={voiceTrack.durationInFrames}
            defaultProps={{ content, voiceTrack, format: 'story' as const }}
          />
        </React.Fragment>
      );
    })}
  </Folder>
);
