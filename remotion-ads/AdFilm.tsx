import React from 'react';
import { Audio } from '@remotion/media';
import { AbsoluteFill, Sequence, staticFile, useVideoConfig } from 'remotion';
import { bodyFontFamily } from './brand/fonts';
import { adBrand } from './brand/tokens';
import { AdCaptions } from './components/AdCaptions';
import { adLayoutFor, fs } from './components/layout';
import { CornerMark } from './components/Lockup';
import { CtaBeat, HookBeat, ProofBeat, TurnBeat } from './scenes/Beats';
import { AD_BEATS, type AdBeatId, type AdCompositionProps } from './types';

const BEAT_COMPONENT: Record<AdBeatId, React.FC<any>> = {
  hook: HookBeat,
  turn: TurnBeat,
  proof: ProofBeat,
  cta: CtaBeat,
};

export const AdFilm: React.FC<AdCompositionProps> = ({ script, voice, format }) => {
  const { fps, durationInFrames } = useVideoConfig();
  const layout = adLayoutFor(format);

  return (
    <AbsoluteFill style={{ background: adBrand.background, color: adBrand.ink, fontFamily: bodyFontFamily }}>
      {AD_BEATS.map((beat, index) => {
        const timing = voice.beats[beat];
        const last = index === AD_BEATS.length - 1;
        const from = Math.max(0, Math.floor(timing.startSeconds * fps));
        const until = last
          ? durationInFrames
          : Math.min(durationInFrames, Math.ceil(voice.beats[AD_BEATS[index + 1]].startSeconds * fps));
        const beatDuration = Math.max(until - from, 1);
        const Beat = BEAT_COMPONENT[beat];

        return (
          <Sequence key={beat} from={from} durationInFrames={beatDuration} premountFor={fps}>
            <AbsoluteFill>
              <Beat script={script} layout={layout} durationInFrames={beatDuration} />
            </AbsoluteFill>
          </Sequence>
        );
      })}

      {/* Marca presente do primeiro ao último quadro, menos na batida final onde o
          logotipo já aparece grande e centralizado. */}
      <Sequence from={0} durationInFrames={Math.max(1, Math.floor(voice.beats.cta.startSeconds * fps))}>
        <CornerMark layout={layout} />
      </Sequence>

      {voice.ready && <Audio src={staticFile(voice.audioPath)} volume={1} />}

      <AdCaptions captions={voice.captions} layout={layout} accent={script.accent} />

      {/* Enquanto a locução for a voz local do macOS, o vídeo carrega a marca de prévia.
          É a mesma trava do pipeline institucional: prévia não comercial não pode ser
          publicada por engano. */}
      {!voice.commercialUseAllowed && (
        <div
          style={{
            position: 'absolute',
            zIndex: 95,
            right: layout.safe.x,
            top: layout.safe.y,
            padding: `${fs(layout, 8, 4)}px ${fs(layout, 14, 7)}px`,
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.14)',
            background: 'rgba(5,6,9,0.6)',
            color: 'rgba(255,255,255,0.72)',
            fontFamily: bodyFontFamily,
            fontSize: fs(layout, 18, 10),
            fontWeight: 750,
            letterSpacing: '0.05em',
          }}
        >
          PRÉVIA · locução local
        </div>
      )}
    </AbsoluteFill>
  );
};
