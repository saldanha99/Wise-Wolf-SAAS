import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  useSystemMarketingMetadata,
  type SystemMarketingPage,
} from './useSystemMarketingMetadata';

const MetadataProbe: React.FC<{ page: SystemMarketingPage }> = ({ page }) => {
  useSystemMarketingMetadata(page);
  return null;
};

afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
});

describe('useSystemMarketingMetadata', () => {
  it('syncs each commercial LP title, canonical and social preview in React', () => {
    document.title = 'Aplicação';
    document.head.insertAdjacentHTML('beforeend', [
      '<meta name="description" content="Genérica">',
      '<meta name="robots" content="index, follow">',
      '<meta property="og:title" content="Aplicação">',
      '<link rel="canonical" href="https://system.wisewolflanguage.com.br/">',
    ].join(''));

    const view = render(<MetadataProbe page="teacher-business" />);
    expect(document.title).toBe('Professor Negócio | Gestão para Professores de Inglês');
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href)
      .toBe('https://system.wisewolflanguage.com.br/seja-professor');
    expect(document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content)
      .toBe('https://system.wisewolflanguage.com.br/assets/hub/marketing/hub-overview-og.webp');

    view.rerender(<MetadataProbe page="school-diagnosis" />);
    expect(document.title).toBe('Diagnóstico para Escolas de Inglês | Wise Wolf School OS');
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href)
      .toBe('https://system.wisewolflanguage.com.br/new-saas');
    expect(document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content)
      .toBe('https://system.wisewolflanguage.com.br/assets/hub/marketing/school-os-og.webp');
  });
});
