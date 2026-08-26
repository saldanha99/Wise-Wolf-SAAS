import React from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { bodyFontFamily } from './brand/fonts';
import { brand } from './brand/tokens';
import { CaptionLayer } from './components/CaptionLayer';
import { SoundDesign } from './components/SoundDesign';
import { PremiumScene } from './premium/PremiumScene';
import { PREMIUM_TRANSITION_FRAMES, PremiumTransition } from './premium/PremiumTransition';
import type { HubVideoContent, HubVideoFormat, HubVideoSceneId, HubVoiceTrack } from './types';

const SCENE_ORDER: HubVideoSceneId[] = ['hook', 'problem', 'product', 'proof', 'cta'];

const SceneContent: React.FC<{
  scene: HubVideoSceneId;
  content: HubVideoContent;
  sceneDurationInFrames: number;
  format: HubVideoFormat;
}> = ({ scene, content, sceneDurationInFrames, format }) => (
  <PremiumScene
    scene={scene}
    content={content}
    durationInFrames={sceneDurationInFrames}
    format={format}
  />
);

const SceneEnvelope: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill>{children}</AbsoluteFill>
);

export const HubMarketingVideo: React.FC<{
  content: HubVideoContent;
  voiceTrack: HubVoiceTrack;
  format?: HubVideoFormat;
}> = ({ content, voiceTrack, format = 'landscape' }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const progress = interpolate(frame, [0, durationInFrames - 1], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const boundaryFrames = SCENE_ORDER.slice(1).map((scene) => Math.floor(voiceTrack.scenes[scene].startSeconds * fps));
  const ctaFrame = Math.floor(voiceTrack.scenes.cta.startSeconds * fps);

  return (
    <AbsoluteFill style={{ background: brand.background, color: brand.ink, fontFamily: bodyFontFamily }}>
      {SCENE_ORDER.map((scene, index) => {
        const timing = voiceTrack.scenes[scene];
        const last = index === SCENE_ORDER.length - 1;
        const from = Math.max(0, Math.floor(timing.startSeconds * fps));
        const until = last
          ? durationInFrames
          : Math.min(durationInFrames, Math.ceil(voiceTrack.scenes[SCENE_ORDER[index + 1]].startSeconds * fps));
        const sequenceDuration = Math.max(until - from, 1);

        return (
          <Sequence key={scene} from={from} durationInFrames={sequenceDuration} premountFor={fps}>
            <SceneEnvelope>
              <SceneContent scene={scene} content={content} sceneDurationInFrames={sequenceDuration} format={format} />
            </SceneEnvelope>
          </Sequence>
        );
      })}
      {boundaryFrames.map((boundaryFrame, index) => {
        return (
          <Sequence key={`bridge-${SCENE_ORDER[index + 1]}`} from={Math.max(0, boundaryFrame - PREMIUM_TRANSITION_FRAMES / 2)} durationInFrames={PREMIUM_TRANSITION_FRAMES}>
            <PremiumTransition content={content} format={format} index={index} />
          </Sequence>
        );
      })}
      <SoundDesign slug={content.slug} captions={voiceTrack.captions} boundaryFrames={boundaryFrames} ctaFrame={ctaFrame} />
      {voiceTrack.ready && <Audio src={staticFile(voiceTrack.audioPath)} volume={1} />}
      <CaptionLayer
        captions={voiceTrack.captions}
        audioPath={voiceTrack.audioPath}
        audioReady={voiceTrack.ready}
        accent={content.accent}
        secondaryAccent={content.secondaryAccent}
        slug={content.slug}
        sceneTimings={voiceTrack.scenes}
        format={format}
      />
      {voiceTrack.voiceProvider === 'openai' && (
        <div style={{ position: 'absolute', zIndex: 88, top: format === 'story' ? 138 : 28, right: format === 'story' ? 54 : 34, color: 'rgba(255,255,255,0.7)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 999, background: 'rgba(5,6,9,0.48)', backdropFilter: 'blur(14px)', padding: '8px 13px', fontFamily: bodyFontFamily, fontSize: format === 'story' ? 14 : 12, fontWeight: 700, letterSpacing: '0.04em' }}>
          Voz gerada por IA
        </div>
      )}
      {voiceTrack.commercialUseAllowed !== true && (
        <div style={{ position: 'absolute', zIndex: 88, left: format === 'story' ? 54 : 58, bottom: format === 'story' ? 104 : 44, color: 'rgba(255,255,255,0.62)', fontFamily: bodyFontFamily, fontSize: format === 'story' ? 13 : 12, fontWeight: 650, letterSpacing: '0.02em' }}>
          {voiceTrack.modelId === 'macos-say-preview'
            ? 'Locução local pt-BR · prévia não comercial'
            : voiceTrack.voiceProvider === 'openai'
              ? 'Locução OpenAI · prévia não comercial'
              : 'Voz gerada com ElevenLabs · prévia não comercial'}
        </div>
      )}
      <div style={{ position: 'absolute', zIndex: 90, left: format === 'story' ? 54 : 24, right: format === 'story' ? 54 : 24, bottom: format === 'story' ? 76 : 24, height: format === 'story' ? 4 : 3, overflow: 'hidden', borderRadius: 999, background: 'rgba(255,255,255,0.08)' }}>
        <div style={{ width: `${progress}%`, height: '100%', borderRadius: 999, background: `linear-gradient(90deg, ${content.accent}, ${content.secondaryAccent})`, boxShadow: `0 0 14px ${content.accent}` }} />
      </div>
    </AbsoluteFill>
  );
};
