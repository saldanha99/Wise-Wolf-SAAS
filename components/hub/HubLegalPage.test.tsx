import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import HubLegalPage from './HubLegalPage';

describe('Hub legal public documents', () => {
  afterEach(() => cleanup());

  it('publishes the versioned Hub Core terms and links privacy', () => {
    render(<HubLegalPage page="terms" />);

    expect(screen.getByRole('heading', { level: 1, name: /Termos de Uso do Wise Wolf Hub/i })).toBeInTheDocument();
    expect(screen.getByText('Versão 2026-08-24')).toBeInTheDocument();
    expect(screen.getByText(/não representa autorização para marketing/i)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Política de Privacidade/i }).at(-1)).toHaveAttribute('href', '/hub/privacidade');
  });

  it('publishes LGPD rights without mixing transactional and marketing consent', () => {
    render(<HubLegalPage page="privacy" />);

    expect(screen.getByRole('heading', { level: 1, name: /Política de Privacidade do Wise Wolf Hub/i })).toBeInTheDocument();
    expect(screen.getByText('Versão 2026-08-24')).toBeInTheDocument();
    expect(screen.getByText(/Marketing depende de escolha separada/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Direitos do titular/i })).toBeInTheDocument();
  });
});
