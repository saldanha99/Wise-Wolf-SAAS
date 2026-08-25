import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HubAudienceLanding from './HubAudienceLanding';
import HubLanding from './HubLanding';
import HubSolutionLanding from './HubSolutionLanding';
import type { HubPlan, HubSettings } from './types';

vi.mock('./HubMarketingShell', () => ({
  default: ({ children, onPrimary, primaryLabel, primaryDisabled }: { children: React.ReactNode; onPrimary: () => void; primaryLabel: string; primaryDisabled?: boolean }) => (
    <div>
      <button type="button" disabled={primaryDisabled} onClick={onPrimary}>{primaryLabel}</button>
      {children}
    </div>
  ),
  HubFaq: () => null,
  HubReveal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HubSectionIntro: ({ description }: { description?: string }) => <div>{description}</div>,
}));

vi.mock('./HubNativeProductTour', () => ({ default: () => <div data-testid="native-tour" /> }));
vi.mock('./HubProductMockups', () => ({ default: () => <div data-testid="product-mockup" /> }));
vi.mock('./HubVideoShowcase', () => ({ default: () => null, HUB_PUBLIC_VIDEOS_ENABLED: false }));

const settings: HubSettings = {
  settings_key: 'default',
  brand_name: 'Wise Wolf Hub',
  headline: 'Hub',
  subheadline: null,
  saas_video_url: null,
  saas_cta_url: '/new-saas',
  support_url: '/suporte',
  metadata: {},
};

const paidPlan: HubPlan = {
  id: 'library-solo',
  code: 'LIBRARY_SOLO',
  name: 'Professor Essencial',
  description: 'Biblioteca para professores.',
  audience: 'EDUCATOR',
  price_monthly: 59,
  price_yearly: 590,
  trial_days: 0,
  features: ['Biblioteca'],
  metadata: {},
  product_family: 'HUB_CORE',
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Hub paid plan entry without Discovery', () => {
  it('opens signup and preserves the selected paid plan from the Hub overview', () => {
    const onAuthenticate = vi.fn();
    const onPlanSelect = vi.fn();

    render(
      <HubLanding
        plans={[paidPlan]}
        settings={settings}
        content={[]}
        onAuthenticate={onAuthenticate}
        onPlanSelect={onPlanSelect}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Escolher Professor Essencial' }));

    expect(onPlanSelect).toHaveBeenCalledWith('LIBRARY_SOLO', 'YEARLY');
    expect(onAuthenticate).toHaveBeenCalledWith('signup', 'EDUCATOR');
  });

  it('does not create a Hub Core user or checkout intent while the catalog is in curatorship', () => {
    const onAuthenticate = vi.fn();
    const onPlanSelect = vi.fn();

    render(
      <HubAudienceLanding
        audience="teachers"
        plans={[paidPlan]}
        settings={settings}
        catalogReady={false}
        onAuthenticate={onAuthenticate}
        onPlanSelect={onPlanSelect}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Abertura em breve' }).length).toBeGreaterThan(0);
    screen.getAllByRole('button', { name: 'Abertura em breve' }).forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByRole('status')).toHaveTextContent('Catálogo em curadoria · abertura em breve');
    expect(onPlanSelect).not.toHaveBeenCalled();
    expect(onAuthenticate).not.toHaveBeenCalled();
  });

  it('keeps Wolfie actionable while Hub Core is in curatorship', () => {
    render(
      <HubSolutionLanding
        page="wolfie"
        plans={[]}
        settings={settings}
        catalogReady={false}
        onAuthenticate={vi.fn()}
        onPlanSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: /Começar com Foco/i })).toBeEnabled();
    expect(screen.queryByText('Catálogo em curadoria · abertura em breve')).not.toBeInTheDocument();
  });

  it('keeps direct paid checkout available on the teacher journey', () => {
    const onAuthenticate = vi.fn();
    const onPlanSelect = vi.fn();

    render(
      <HubAudienceLanding
        audience="teachers"
        plans={[paidPlan]}
        settings={settings}
        onAuthenticate={onAuthenticate}
        onPlanSelect={onPlanSelect}
      />,
    );

    expect(screen.getAllByRole('button', { name: 'Falar com a equipe' }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Escolher Professor Essencial' }));

    expect(onPlanSelect).toHaveBeenCalledWith('LIBRARY_SOLO', 'YEARLY');
    expect(onAuthenticate).toHaveBeenCalledWith('signup', 'EDUCATOR');
  });

  it('keeps the paid solution card actionable while the free trial is unavailable', () => {
    const onAuthenticate = vi.fn();
    const onPlanSelect = vi.fn();

    render(
      <HubSolutionLanding
        page="library"
        plans={[paidPlan]}
        settings={settings}
        onAuthenticate={onAuthenticate}
        onPlanSelect={onPlanSelect}
      />,
    );

    expect(screen.getByText(/Os planos pagos continuam disponíveis em contratação direta/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Escolher Professor Essencial' }));

    expect(onPlanSelect).toHaveBeenCalledWith('LIBRARY_SOLO', 'YEARLY');
    expect(onAuthenticate).toHaveBeenCalledWith('signup', 'EDUCATOR');
  });
});

describe('Hub solution offer integrity', () => {
  it('links every Wolfie plan to its dedicated checkout intent', () => {
    render(
      <HubSolutionLanding
        page="wolfie"
        plans={[]}
        settings={settings}
        onAuthenticate={vi.fn()}
        onPlanSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole('link', { name: /Começar com Foco/i })).toHaveAttribute(
      'href',
      'https://wolfie.wisewolflanguage.com.br/assinar?planCode=FOCO&source=plans',
    );
    expect(screen.getByRole('link', { name: /Criar meu ritmo/i })).toHaveAttribute(
      'href',
      'https://wolfie.wisewolflanguage.com.br/assinar?planCode=RITMO&source=plans',
    );
    expect(screen.getByRole('link', { name: /Treinar em alta intensidade/i })).toHaveAttribute(
      'href',
      'https://wolfie.wisewolflanguage.com.br/assinar?planCode=PERFORMANCE&source=plans',
    );
  });

  it('presents School OS as assisted scope without the legacy institutional price', () => {
    const legacyPlan: HubPlan = {
      ...paidPlan,
      id: 'legacy-institutional',
      code: 'INSTITUTIONAL',
      name: 'Institucional',
      price_monthly: 397,
      price_yearly: 3970,
      audience: 'INSTITUTION',
      product_family: 'LEGACY',
    };

    render(
      <HubSolutionLanding
        page="school-os"
        plans={[legacyPlan]}
        settings={settings}
        onAuthenticate={vi.fn()}
        onPlanSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Sob medida')).toBeInTheDocument();
    expect(screen.getByText(/Não usamos um preço legado/i)).toBeInTheDocument();
    expect(screen.queryByText(/R\$\s*397/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Institucional$/)).not.toBeInTheDocument();
  });
});
