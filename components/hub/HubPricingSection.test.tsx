import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import HubPricingSection from './HubPricingSection';
import { resolveHubCheckoutInitialCycle } from './HubCheckoutDialog';
import type { HubPlan } from './types';

vi.mock('./HubMarketingShell', () => ({
  HubReveal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HubSectionIntro: ({ description }: { description: string }) => <div>{description}</div>,
}));

const plan: HubPlan = {
  id: 'educator-pro',
  code: 'EDUCATOR_PRO',
  name: 'Professor Pro',
  description: 'Planejamento e biblioteca.',
  audience: 'EDUCATOR',
  price_monthly: 119,
  price_yearly: 1190,
  trial_days: 0,
  features: ['Biblioteca'],
  metadata: {},
  product_family: 'HUB_CORE',
};

const overviewPlans: HubPlan[] = [
  {
    ...plan,
    id: 'library-solo',
    code: 'LIBRARY_SOLO',
    name: 'Professor Essencial',
    price_monthly: 59,
    price_yearly: 590,
  },
  plan,
  {
    ...plan,
    id: 'hub-complete',
    code: 'HUB_COMPLETE',
    name: 'Professor Studio',
    price_monthly: 169,
    price_yearly: 1690,
  },
];

describe('Hub pricing checkout cycle', () => {
  it('passes the cycle selected in pricing together with the plan', () => {
    const onChoosePlan = vi.fn();
    render(<HubPricingSection plans={[plan]} onChoosePlan={onChoosePlan} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mensal' }));
    fireEvent.click(screen.getByRole('button', { name: 'Escolher Professor Pro' }));

    expect(onChoosePlan).toHaveBeenCalledWith(plan, 'MONTHLY');
  });

  it('honors the intended cycle when checkout opens', () => {
    expect(resolveHubCheckoutInitialCycle(plan, 'YEARLY')).toBe('YEARLY');
    expect(resolveHubCheckoutInitialCycle(plan, 'MONTHLY')).toBe('MONTHLY');
    expect(resolveHubCheckoutInitialCycle(plan, 'YEARLY', true, 'YEARLY')).toBe('MONTHLY');
  });

  it('presents the three educator entries plus the Wolfie and School OS paths', () => {
    render(<HubPricingSection plans={overviewPlans} onChoosePlan={() => undefined} mode="overview" />);

    expect(screen.getByRole('button', { name: 'Escolher Professor Essencial' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Escolher Professor Pro' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Escolher Professor Studio' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Wolfie a partir de R\$ 49,90\/mês/i })).toHaveAttribute('href', '/hub/wolfie');
    expect(screen.getByRole('link', { name: /School OS sob medida/i })).toHaveAttribute('href', '/hub/saas-escolar');
  });

  it('closes Hub Core sales when the authoritative catalog is not ready', () => {
    const onChoosePlan = vi.fn();
    render(<HubPricingSection plans={overviewPlans} onChoosePlan={onChoosePlan} mode="overview" catalogReady={false} />);

    expect(screen.getByRole('status')).toHaveTextContent('Catálogo em curadoria · abertura em breve');
    const coreButtons = screen.getAllByRole('button', { name: 'Abertura em breve' });
    expect(coreButtons).toHaveLength(3);
    coreButtons.forEach((button) => expect(button).toBeDisabled());
    fireEvent.click(coreButtons[0]);
    expect(onChoosePlan).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Wolfie a partir de R\$ 49,90\/mês/i })).toHaveAttribute('href', '/hub/wolfie');
    expect(screen.getByRole('link', { name: /School OS sob medida/i })).toHaveAttribute('href', '/hub/saas-escolar');
  });
});
