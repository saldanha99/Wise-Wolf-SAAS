import React, { useId, useRef, useState } from 'react';
import { Captions, Play, Volume2 } from 'lucide-react';

export type HubVideoId = 'overview' | 'library' | 'educator-ai' | 'wolfie' | 'school-os';

export const resolveHubPublicVideosEnabled = (value?: string) => value === 'true';
export const HUB_PUBLIC_VIDEOS_ENABLED = resolveHubPublicVideosEnabled(import.meta.env.VITE_HUB_PUBLIC_VIDEOS);

type HubVideoAsset = {
  src: string;
  poster: string;
  captions: string;
  title: string;
  description: string;
};

export const HUB_VIDEO_CATALOG: Record<HubVideoId, HubVideoAsset> = {
  overview: {
    src: '/assets/hub/videos/hub-overview.mp4',
    poster: '/assets/hub/videos/posters/hub-overview.webp',
    captions: '/assets/hub/videos/captions/hub-overview.pt-BR.vtt',
    title: 'Conheça o Wise Wolf Hub',
    description: 'Veja como ensino, prática, crescimento e operação trabalham juntos.',
  },
  library: {
    src: '/assets/hub/videos/library.mp4',
    poster: '/assets/hub/videos/posters/library.webp',
    captions: '/assets/hub/videos/captions/library.pt-BR.vtt',
    title: 'Conheça a Wise Wolf Library',
    description: 'Uma visão rápida do acervo pensado para a rotina de quem ensina.',
  },
  'educator-ai': {
    src: '/assets/hub/videos/educator-ai.mp4',
    poster: '/assets/hub/videos/posters/educator-ai.webp',
    captions: '/assets/hub/videos/captions/educator-ai.pt-BR.vtt',
    title: 'Conheça o Educador IA',
    description: 'Do objetivo pedagógico a um plano de aula pronto para adaptar.',
  },
  wolfie: {
    src: '/assets/hub/videos/wolfie.mp4',
    poster: '/assets/hub/videos/posters/wolfie.webp',
    captions: '/assets/hub/videos/captions/wolfie.pt-BR.vtt',
    title: 'Conheça o Wolfie AI Tutor',
    description: 'Prática contextual para transformar intenção em confiança.',
  },
  'school-os': {
    src: '/assets/hub/videos/school-os.mp4',
    poster: '/assets/hub/videos/posters/school-os.webp',
    captions: '/assets/hub/videos/captions/school-os.pt-BR.vtt',
    title: 'Conheça o Wise Wolf School OS',
    description: 'A operação da escola conectada, configurável e isolada por ambiente.',
  },
};

interface HubVideoShowcaseProps {
  videoId: HubVideoId;
  className?: string;
}

const HubVideoShowcase: React.FC<HubVideoShowcaseProps> = ({ videoId, className = '' }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const captionId = useId();
  const [hasStarted, setHasStarted] = useState(false);
  const [hasError, setHasError] = useState(false);
  const asset = HUB_VIDEO_CATALOG[videoId];

  const playVideo = () => {
    const video = videoRef.current;
    if (!video) return;

    video.play().catch(() => {
      video.controls = true;
    });
  };

  const rootClassName = ['hub-video-showcase', className].filter(Boolean).join(' ');

  return (
    <figure className={rootClassName} data-video-id={videoId} data-video-state={hasError ? 'error' : hasStarted ? 'started' : 'ready'}>
      <div className="hub-video-showcase__aura" aria-hidden="true" />
      <div className="hub-video-showcase__frame">
        <div className="hub-video-showcase__chrome" aria-hidden="true">
          <span /><span /><span />
          <p>Wise Wolf • experiência guiada</p>
        </div>

        <div className="hub-video-showcase__media">
          <video
            ref={videoRef}
            aria-label={asset.title}
            aria-describedby={captionId}
            controls
            playsInline
            preload="metadata"
            poster={asset.poster}
            onPlay={() => setHasStarted(true)}
            onEnded={() => setHasStarted(false)}
            onError={() => setHasError(true)}
          >
            <source src={asset.src} type="video/mp4" />
            <track
              kind="captions"
              src={asset.captions}
              srcLang="pt-BR"
              label="Português (Brasil)"
            />
            Seu navegador não conseguiu reproduzir este vídeo.
          </video>

          {!hasStarted && !hasError ? (
            <button
              type="button"
              className="hub-video-showcase__play"
              onClick={playVideo}
              aria-label={`Reproduzir vídeo: ${asset.title}`}
            >
              <span className="hub-video-showcase__play-icon" aria-hidden="true"><Play size={24} fill="currentColor" /></span>
              <span className="hub-video-showcase__play-copy">
                <b>Assistir à experiência</b>
                <small><Volume2 size={13} />Narração em português</small>
              </span>
            </button>
          ) : null}

          {hasError ? (
            <div className="hub-video-showcase__fallback" role="status">
              <span aria-hidden="true"><Play size={23} /></span>
              <p><b>O vídeo não carregou agora.</b><small>Você ainda pode abrir a apresentação diretamente.</small></p>
              <a href={asset.src}>Abrir vídeo</a>
            </div>
          ) : null}
        </div>
      </div>

      <figcaption id={captionId} className="hub-video-showcase__caption">
        <span><Captions size={14} />Vídeo com legendas PT-BR</span>
        <p><b>{asset.title}</b>{asset.description}</p>
      </figcaption>
    </figure>
  );
};

export default HubVideoShowcase;
