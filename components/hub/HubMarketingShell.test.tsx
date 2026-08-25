import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import HubMarketingShell, { HUB_THEME_STORAGE_KEY } from './HubMarketingShell';

describe('HubMarketingShell theme isolation', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem('theme', 'dark');
    window.localStorage.setItem(HUB_THEME_STORAGE_KEY, 'light');
    document.documentElement.classList.add('dark');
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('keeps the global document theme synchronized with the Hub toggle', () => {
    render(
      <HubMarketingShell onLogin={() => undefined} onPrimary={() => undefined} primaryLabel="Começar">
        <main>Conteúdo</main>
      </HubMarketingShell>,
    );

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem('theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: 'Ativar modo escuro' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(window.localStorage.getItem(HUB_THEME_STORAGE_KEY)).toBe('dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button', { name: 'Ativar modo claro' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(window.localStorage.getItem(HUB_THEME_STORAGE_KEY)).toBe('light');
    expect(window.localStorage.getItem('theme')).toBe('light');
  });

  it('exposes one close control and restores focus after dismissing the mobile menu', () => {
    render(
      <HubMarketingShell onLogin={() => undefined} onPrimary={() => undefined} primaryLabel="Começar">
        <main>Conteúdo</main>
      </HubMarketingShell>,
    );

    const trigger = screen.getByRole('button', { name: 'Abrir menu' });
    fireEvent.click(trigger);

    expect(screen.getAllByRole('button', { name: 'Fechar menu' })).toHaveLength(1);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Menu do Hub' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('uses native links for actions that leave the Hub', () => {
    render(
      <HubMarketingShell
        loginHref="https://system.wisewolflanguage.com.br/"
        primaryHref="https://system.wisewolflanguage.com.br/new-saas"
        primaryLabel="Solicitar diagnóstico"
      >
        <main>Conteúdo</main>
      </HubMarketingShell>,
    );

    expect(screen.getByRole('link', { name: 'Entrar' })).toHaveAttribute(
      'href',
      'https://system.wisewolflanguage.com.br/',
    );
    expect(screen.getByRole('link', { name: 'Solicitar diagnóstico' })).toHaveAttribute(
      'href',
      'https://system.wisewolflanguage.com.br/new-saas',
    );
  });
});
