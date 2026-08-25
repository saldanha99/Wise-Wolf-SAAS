import type { Caption } from '@remotion/captions';

export type HubVideoSlug =
  | 'hub-overview'
  | 'library'
  | 'educator-ai'
  | 'wolfie'
  | 'school-os';

export type HubVideoSceneId = 'hook' | 'problem' | 'product' | 'proof' | 'cta';

export type HubVideoCaptionToken = {
  text: string;
  startMs: number;
  endMs: number;
};

export type HubVideoCaption = Caption & {
  startSeconds: number;
  endSeconds: number;
  tokens?: HubVideoCaptionToken[];
};

export type HubVideoSceneTiming = {
  startSeconds: number;
  endSeconds: number;
};

export type HubVoiceProvider = 'elevenlabs' | 'openai' | 'local-preview';

export type HubVoiceGateway = 'openai' | 'openrouter';

export type HubVoiceLocaleValidation =
  | 'verified_languages'
  | 'voice_labels'
  | 'multilingual_premade_override'
  | 'openai_prompted_pt_br';

export type HubVoiceTrack = {
  ready: boolean;
  durationSeconds: number;
  durationInFrames: number;
  audioPath: string;
  voiceProvider?: HubVoiceProvider;
  voiceGateway?: HubVoiceGateway;
  voiceId?: string;
  voiceName?: string;
  voiceLocale?: 'pt-BR';
  voiceAccent?: string;
  voiceSourceAccent?: string;
  voiceNative?: boolean;
  voiceLocaleValidation?: HubVoiceLocaleValidation;
  modelId?: string;
  scriptHash?: string;
  subscriptionTier?: string;
  subscriptionStatus?: string;
  commercialUseAllowed?: boolean;
  commercialLicenseBasis?: 'openai_api_terms' | 'openrouter_terms';
  commercialLicenseAcknowledgedAt?: string;
  ttsInstructionsSha256?: string;
  aiDisclosureMode?: 'burned-in';
  generatedAt?: string;
  requestId?: string;
  captions: HubVideoCaption[];
  scenes: Record<HubVideoSceneId, HubVideoSceneTiming>;
};

export type HubCommercialRenderFingerprint = {
  schemaVersion: 4;
  slug: HubVideoSlug;
  compositionId: string;
  scriptHash: string;
  audioSha256: string;
  compositionInputSha256: string;
  compositionSourceSha256: string;
  remotionVersion: string;
  voiceProvider: 'elevenlabs' | 'openai';
  voiceGateway: HubVoiceGateway | null;
  voiceId: string;
  voiceName: string | null;
  voiceLocale: 'pt-BR';
  voiceAccent: string;
  voiceSourceAccent: string;
  voiceNative: boolean;
  voiceLocaleValidation: HubVoiceLocaleValidation;
  modelId: string;
  providerEvidence:
    | {
      provider: 'elevenlabs';
      subscriptionTier: string;
      subscriptionStatus: 'active' | 'trialing';
    }
    | {
      provider: 'openai';
      gateway: HubVoiceGateway;
      licenseBasis: 'openai_api_terms' | 'openrouter_terms';
      acknowledgedAt: string;
      ttsInstructionsSha256: string;
      aiDisclosureMode: 'burned-in';
    };
  commercialUseAllowed: true;
  voiceGeneratedAt: string;
  providerRequestId: string;
  render: {
    width: number;
    height: number;
    fps: number;
    codec: 'h264';
    pixelFormat: 'yuv420p';
    crf: 22;
    audioBitrate: '128k';
    colorSpace: 'bt709';
    audioMastering: {
      algorithm: 'ffmpeg-loudnorm';
      targetIntegratedLufs: -16;
      targetLraLu: 11;
      targetTruePeakDbtp: -1.5;
      maxTruePeakDbtp: -1;
      audioCodec: 'aac';
      audioBitrate: '128k';
      sampleRateHz: 48000;
    };
  };
};

export type HubCommercialRenderReceipt = {
  schemaVersion: 1;
  slug: HubVideoSlug;
  generatedAt: string;
  language: 'pt-BR';
  compositionId: string;
  commercialUseAllowed: true;
  renderFingerprintSha256: string;
  receiptFingerprintSha256: string;
  artifacts: {
    videoSha256: string;
    posterSha256: string;
    captionsSha256: string;
  };
};

export type HubVideoContent = {
  id: string;
  slug: HubVideoSlug;
  productName: string;
  eyebrow: string;
  title: string;
  emphasis: string;
  accent: string;
  secondaryAccent: string;
  mockup: 'ecosystem' | 'library' | 'educator' | 'wolfie' | 'school';
  problemHeadline: string;
  problemItems: string[];
  productHeadline: string;
  proofHeadline: string;
  proofItems: string[];
  cta: string;
  ctaButtons: string[];
  ctaSupport: string;
  narration: Array<{
    scene: HubVideoSceneId;
    text: string;
  }>;
};
