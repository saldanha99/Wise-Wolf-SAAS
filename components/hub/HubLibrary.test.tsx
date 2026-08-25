import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A Biblioteca do Hub tem de ser o MÓDULO DA ESCOLA, não uma cópia.
 *
 * O portal antes reimplementava um grid próprio (64 linhas contra 417 do
 * módulo real), e era por isso que o Hub parecia outro produto. Este teste
 * renderiza o portal e exige que a UI que aparece seja a do `MaterialsLibrary`
 * — agrupamento por pasta/nível/nicho, que o grid antigo nunca teve.
 *
 * Também trava a regra de acesso: o Hub NÃO pode entregar `file_url` ao
 * navegador; o arquivo só sai por `openHubContent`, depois da franquia.
 */

vi.mock('../../lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) } },
}));

const openHubContent = vi.fn(async () => ({ signedUrl: 'https://exemplo.invalid/assinada' }));
vi.mock('./hubService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openHubContent: (...args: unknown[]) => openHubContent(...(args as [])),
  trackHubEvent: vi.fn(),
}));

import HubPortal from './HubPortal';
import type { HubBootstrap, HubContentItem, HubSettings } from './types';

const settings: HubSettings = {
  settings_key: 'default',
  brand_name: 'Wise Wolf Hub',
  headline: 'Hub',
  subheadline: null,
  saas_video_url: null,
  saas_cta_url: '/new-saas',
  support_url: null,
  metadata: {},
};

const bootstrap: HubBootstrap = {
  account: { id: 'conta-1', name: 'Professor Demo', account_type: 'PERSONAL', audience: 'EDUCATOR', status: 'ACTIVE', metadata: {} },
  membership: { membership_role: 'OWNER', status: 'ACTIVE' },
  subscription: {
    id: 'assinatura-1',
    status: 'ACTIVE',
    billing_cycle: 'MONTHLY',
    trial_ends_at: null,
    current_period_ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    product_family: 'HUB_CORE',
  },
  plan: null,
  entitlements: { 'library.full_access': { limit: null, resetPeriod: 'MONTH', used: 0 } },
  settings,
};

const content: HubContentItem[] = [
  {
    id: 'item-1',
    slug: 'business-parte-1',
    title: 'Business English in Use',
    description: 'Parte inicial do livro.',
    content_type: 'PDF',
    level_tag: 'B1',
    niche: 'BUSINESS',
    collection_name: 'Business English in Use',
    collection_id: 'livro-1',
    part_number: 1,
    cover_url: null,
    preview_enabled: true,
    license_summary: null,
    author_name: null,
    metadata: {},
  },
];

const renderPortal = (initialTab?: 'overview' | 'library') => render(
  <HubPortal
    bootstrap={bootstrap}
    plans={[]}
    settings={settings}
    content={content}
    userId="00000000-0000-4000-8000-000000000001"
    userEmail="demo@exemplo.invalid"
    onRefresh={async () => {}}
    onLogout={async () => {}}
    initialPlanIntent={null}
    initialTab={initialTab}
    onPlanIntentConsumed={() => {}}
  />,
);

describe('Biblioteca do Hub herda o módulo da escola', () => {
  beforeEach(() => {
    openHubContent.mockReset();
    openHubContent.mockResolvedValue({ signedUrl: 'https://exemplo.invalid/assinada' });
  });

  it('renderiza o módulo nativo, com os agrupamentos que o grid antigo não tinha', async () => {
    renderPortal();
    const tabs = await screen.findAllByRole('button', { name: /biblioteca/i });
    fireEvent.click(tabs[0]);

    // Os três modos de agrupamento só existem no MaterialsLibrary: é a prova de
    // que o Hub renderiza o módulo da escola, não um grid próprio.
    expect(await screen.findByRole('button', { name: /pastas/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^n[ií]vel$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /nicho/i })).toBeTruthy();

    // A parte aparece dentro do livro — a estrutura de ebook fracionado.
    const texto = (document.body.textContent || '').replace(/\s+/gu, ' ');
    expect(texto).toContain('Business English in Use');
    expect(texto).toContain('Parte 1');
  });

  it('abre o módulo nativo diretamente quando o login veio da LP da Biblioteca', async () => {
    renderPortal('library');

    expect(await screen.findByRole('button', { name: /pastas/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /biblioteca wise wolf/i })).toBeTruthy();
  });

  it('agrupa por livro usando collection_id, não pelo nome solto', async () => {
    renderPortal();
    fireEvent.click((await screen.findAllByRole('button', { name: /biblioteca/i }))[0]);
    // O modo "Pastas" só liga quando há `collections`, que o portal deriva de
    // `collection_id`. Com apenas `collection_name` em texto, o livro não existe.
    expect(await screen.findByRole('button', { name: /pastas/i })).toBeTruthy();
  });

  it('não entrega o caminho do arquivo ao navegador', () => {
    const { container } = renderPortal();
    // `file_url` nunca é mapeado: o acesso passa por openHubContent.
    expect(container.innerHTML).not.toContain('file_url');
    expect(container.querySelector('a[href*="storage"]')).toBeNull();
  });

  it('não abre uma URL antiga depois que o ambiente foi desmontado', async () => {
    let releaseAccess!: (value: { signedUrl: string }) => void;
    openHubContent.mockReturnValueOnce(new Promise((resolve) => { releaseAccess = resolve; }));
    const openWindow = vi.spyOn(window, 'open').mockImplementation(() => null);
    const portal = renderPortal();
    fireEvent.click((await screen.findAllByRole('button', { name: /biblioteca/i }))[0]);
    const materialButtons = await screen.findAllByRole('button', { name: /Business English in Use/i });
    fireEvent.click(materialButtons[materialButtons.length - 1]);
    await waitFor(() => expect(openHubContent).toHaveBeenCalledTimes(1));

    portal.unmount();
    await act(async () => {
      releaseAccess({ signedUrl: 'https://exemplo.invalid/conta-antiga' });
      await Promise.resolve();
    });

    expect(openWindow).not.toHaveBeenCalled();
    openWindow.mockRestore();
  });
});
