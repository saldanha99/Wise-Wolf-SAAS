import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HubVideoShowcase, { HUB_VIDEO_CATALOG, resolveHubPublicVideosEnabled } from './HubVideoShowcase';

describe('HubVideoShowcase', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('enables public Hub videos only through an explicit build opt-in', () => {
    expect(resolveHubPublicVideosEnabled(undefined)).toBe(false);
    expect(resolveHubPublicVideosEnabled('false')).toBe(false);
    expect(resolveHubPublicVideosEnabled('true')).toBe(true);
  });

  it('uses the local MP4, poster and PT-BR captions for every Hub film', () => {
    expect(HUB_VIDEO_CATALOG).toMatchObject({
      overview: {
        src: '/assets/hub/videos/hub-overview.mp4',
        poster: '/assets/hub/videos/posters/hub-overview.webp',
        captions: '/assets/hub/videos/captions/hub-overview.pt-BR.vtt',
      },
      library: {
        src: '/assets/hub/videos/library.mp4',
        poster: '/assets/hub/videos/posters/library.webp',
        captions: '/assets/hub/videos/captions/library.pt-BR.vtt',
      },
      'educator-ai': {
        src: '/assets/hub/videos/educator-ai.mp4',
        poster: '/assets/hub/videos/posters/educator-ai.webp',
        captions: '/assets/hub/videos/captions/educator-ai.pt-BR.vtt',
      },
      wolfie: {
        src: '/assets/hub/videos/wolfie.mp4',
        poster: '/assets/hub/videos/posters/wolfie.webp',
        captions: '/assets/hub/videos/captions/wolfie.pt-BR.vtt',
      },
      'school-os': {
        src: '/assets/hub/videos/school-os.mp4',
        poster: '/assets/hub/videos/posters/school-os.webp',
        captions: '/assets/hub/videos/captions/school-os.pt-BR.vtt',
      },
    });
  });

  it('waits for an explicit action and exposes native accessible controls', () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const { container } = render(<HubVideoShowcase videoId="overview" />);
    const video = screen.getByLabelText('Conheça o Wise Wolf Hub') as HTMLVideoElement;
    const source = container.querySelector('source');
    const track = container.querySelector('track');

    expect(play).not.toHaveBeenCalled();
    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.preload).toBe('metadata');
    expect(video.poster).toContain('/assets/hub/videos/posters/hub-overview.webp');
    expect(source?.getAttribute('src')).toBe('/assets/hub/videos/hub-overview.mp4');
    expect(track?.getAttribute('kind')).toBe('captions');
    expect(track?.getAttribute('srclang')).toBe('pt-BR');
    expect(track?.hasAttribute('default')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Reproduzir vídeo: Conheça o Wise Wolf Hub' }));
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.play(video);
    expect(screen.queryByRole('button', { name: 'Reproduzir vídeo: Conheça o Wise Wolf Hub' })).toBeNull();
  });

  it('offers a friendly direct link if the media cannot load', () => {
    const { container } = render(<HubVideoShowcase videoId="school-os" />);
    fireEvent.error(screen.getByLabelText('Conheça o Wise Wolf School OS'));

    expect(screen.getByRole('status').textContent).toContain('O vídeo não carregou agora.');
    expect(screen.getByRole('link', { name: 'Abrir vídeo' }).getAttribute('href')).toBe('/assets/hub/videos/school-os.mp4');
    expect(container.querySelector('[data-video-state="error"]')).not.toBeNull();
  });
});
