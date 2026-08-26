import React from 'react';
import { Composition, Folder } from 'remotion';
import { AdFilm } from './AdFilm';
import { ALL_ADS } from './content/all-ads';
import { AD_FORMATS, AD_FORMAT_IDS, AD_FPS } from './meta/formats';
import voiceManifestData from './generated/voice-manifest.json';
import type { AdVoiceTrack } from './types';

const voiceManifest = voiceManifestData as Record<string, AdVoiceTrack>;

/**
 * Uma composição por anúncio E por formato.
 *
 * Os três formatos são composições PRÓPRIAS, não recortes: o 9:16 tem zona segura de 35%
 * na base e o 16:9 tem duas colunas. Recortar um do outro jogaria o texto para fora da
 * área visível ou para dentro da faixa que a interface do app cobre.
 */
export const RemotionRoot: React.FC = () => (
  <>
    {(['aluno', 'escola'] as const).map((front) => (
      <Folder key={front} name={front === 'aluno' ? 'FrenteA-Alunos' : 'FrenteB-Escolas'}>
        {ALL_ADS.filter((script) => script.front === front).map((script) => {
          const voice = voiceManifest[script.slug];
          if (!voice) return null;
          return AD_FORMAT_IDS.map((formatId) => {
            const format = AD_FORMATS[formatId];
            // O `key` vai no Fragment: o tipo de `Composition` no Remotion não aceita `key`.
            return (
              <React.Fragment key={`${script.id}${format.suffix}`}>
                <Composition
                  id={`${script.id}${format.suffix}`}
                  component={AdFilm}
                  width={format.width}
                  height={format.height}
                  fps={AD_FPS}
                  durationInFrames={voice.durationInFrames}
                  defaultProps={{ script, voice, format: formatId }}
                />
              </React.Fragment>
            );
          });
        })}
      </Folder>
    ))}
  </>
);
