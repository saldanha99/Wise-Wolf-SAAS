import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import HubAudienceLanding from './HubAudienceLanding';
import HubSolutionLanding from './HubSolutionLanding';
import { DEFAULT_HUB_SETTINGS } from './hubService';

vi.mock('./HubNativeProductTour', () => ({
  default: () => <div>Tour nativo</div>,
}));

vi.mock('./HubProductMockups', () => ({
  default: () => <div>Mockup do produto</div>,
}));

vi.mock('./HubVideoShowcase', () => ({
  default: () => <div>Vídeo do produto</div>,
  HUB_PUBLIC_VIDEOS_ENABLED: false,
}));

vi.mock('./HubPricingSection', () => ({
  default: () => <div>Planos do Hub</div>,
}));

const settings = {
  ...DEFAULT_HUB_SETTINGS,
  saas_cta_url: '/new-saas',
};

beforeAll(() => {
  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    disconnect = vi.fn();
    observe = vi.fn();
    takeRecords = vi.fn(() => []);
    unobserve = vi.fn();
  }

  vi.stubGlobal('IntersectionObserver', TestIntersectionObserver);
});

afterEach(cleanup);

describe('CTAs externos do Hub', () => {
  it('publica os diagnósticos da jornada de escolas como links reais', () => {
    render(
      <HubAudienceLanding
        audience="schools"
        plans={[]}
        settings={settings}
        catalogReady={false}
        onAuthenticate={() => undefined}
        onPlanSelect={() => undefined}
      />,
    );

    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute(
      'href',
      'https://system.wisewolflanguage.com.br/',
    );
    const diagnosisLinks = screen.getAllByRole('link', { name: /diagnóstico/i });
    expect(diagnosisLinks).toHaveLength(6);
    diagnosisLinks.forEach((link) => {
      expect(link).toHaveAttribute('href', 'https://system.wisewolflanguage.com.br/new-saas');
    });
  });

  it('publica os CTAs do Wolfie como links para o funil próprio', () => {
    render(
      <HubSolutionLanding
        page="wolfie"
        plans={[]}
        settings={settings}
        catalogReady={false}
        onAuthenticate={() => undefined}
        onPlanSelect={() => undefined}
      />,
    );

    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute(
      'href',
      'https://wolfie.wisewolflanguage.com.br/entrar?next=/app/praticar',
    );
    const planLinks = screen.getAllByRole('link', { name: 'Conhecer os planos Wolfie' });
    expect(planLinks).toHaveLength(3);
    planLinks.forEach((link) => {
      expect(link).toHaveAttribute('href', 'https://wolfie.wisewolflanguage.com.br/planos');
    });
  });

  it('publica os CTAs do School OS como links para o diagnóstico', () => {
    render(
      <HubSolutionLanding
        page="school-os"
        plans={[]}
        settings={settings}
        catalogReady={false}
        onAuthenticate={() => undefined}
        onPlanSelect={() => undefined}
      />,
    );

    const conversionLinks = [
      ...screen.getAllByRole('link', { name: 'Solicitar demonstração' }),
      screen.getByRole('link', { name: 'Solicitar diagnóstico' }),
    ];
    expect(conversionLinks).toHaveLength(5);
    conversionLinks.forEach((link) => {
      expect(link).toHaveAttribute('href', 'https://system.wisewolflanguage.com.br/new-saas');
    });
  });
});
