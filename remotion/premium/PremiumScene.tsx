import React from 'react';
import type { HubVideoContent, HubVideoFormat, HubVideoSceneId } from '../types';
import { CtaScene } from './scenes/CtaScene';
import { HookScene } from './scenes/HookScene';
import { ProblemScene } from './scenes/ProblemScene';
import { ProductScene } from './scenes/ProductScene';
import { ProofScene } from './scenes/ProofScene';

export const PremiumScene: React.FC<{
  content: HubVideoContent;
  format: HubVideoFormat;
  scene: HubVideoSceneId;
  durationInFrames: number;
}> = ({ content, format, scene, durationInFrames }) => {
  if (scene === 'hook') return <HookScene content={content} format={format} durationInFrames={durationInFrames} />;
  if (scene === 'problem') return <ProblemScene content={content} format={format} durationInFrames={durationInFrames} />;
  if (scene === 'product') return <ProductScene content={content} format={format} durationInFrames={durationInFrames} />;
  if (scene === 'proof') return <ProofScene content={content} format={format} durationInFrames={durationInFrames} />;
  return <CtaScene content={content} format={format} durationInFrames={durationInFrames} />;
};
