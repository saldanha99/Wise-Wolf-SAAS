import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import HubNativeProductTour from './HubNativeProductTour';

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

describe('HubNativeProductTour', () => {
  it('uses real native product captures and exposes scene selection accessibly', () => {
    const { container } = render(<HubNativeProductTour kind="school" />);

    expect(container.querySelector('[data-tour-kind="school"]')).not.toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(4);
    expect(screen.getByAltText('Dashboard nativo do diretor com indicadores da unidade')).toHaveAttribute(
      'src',
      '/assets/hub/native/director-dashboard.png',
    );

    const brandingStep = screen.getByRole('button', { name: /04 · Marca por escola/i });
    fireEvent.click(brandingStep);

    expect(brandingStep).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Branding, credenciais e dados isolados por ambiente')).toBeInTheDocument();
  });
});
