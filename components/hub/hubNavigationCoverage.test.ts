import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import marketingPages from './hubMarketingPages.json';

/**
 * Guarda contra página órfã.
 *
 * `/hub/saas-escolar` existiu por semanas construída, servida e com smoke test
 * próprio — e sem UM link interno apontando para ela. A única referência vivia
 * num ramo de `HubSaasShowcase` que nenhuma tela renderiza, ou seja, código
 * morto. Página de venda que o comprador não alcança não vende, e sem link
 * interno o crawler também não chega.
 *
 * O teste varre o CÓDIGO-FONTE das superfícies de marketing atrás de
 * `hubMarketingPath('<página>')` e exige que toda rota do catálogo tenha
 * entrada. Roda offline, antes de qualquer deploy.
 */

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));

const readSurface = (fileName: string): string =>
  readFileSync(path.join(HUB_DIR, fileName), 'utf8');

const SURFACES = {
  shell: readSurface('HubMarketingShell.tsx'),
  home: readSurface('HubLanding.tsx'),
  audience: readSurface('HubAudienceLanding.tsx'),
  solution: readSurface('HubSolutionLanding.tsx'),
} as const;

const linkedPages = (source: string): Set<string> => {
  const matches = source.matchAll(/hubMarketingPath\(\s*'([a-z-]+)'/g);
  return new Set(Array.from(matches, (match) => match[1]));
};

const CATALOG_PAGES = Object.keys(marketingPages);
const SOLUTION_PAGES = ['library', 'educator-ai', 'wolfie', 'school-os'] as const;

describe('cobertura de navegação do Hub', () => {
  it('a varredura enxerga os links que sabidamente existem', () => {
    // Âncora: sem ela, um regex quebrado faria todo o resto "passar" sempre.
    expect(linkedPages(SURFACES.shell)).toContain('teachers');
    expect(linkedPages(SURFACES.home)).toContain('schools');
    expect(linkedPages(SURFACES.solution)).toContain('overview');
  });

  it('o catálogo de páginas e o tipo de rota não divergiram', () => {
    expect(CATALOG_PAGES).toEqual([
      'overview',
      'teachers',
      'schools',
      'library',
      'educator-ai',
      'wolfie',
      'school-os',
      'terms',
      'privacy',
    ]);
  });

  it('nenhuma página do catálogo fica sem link de entrada', () => {
    const reachable = new Set<string>();
    for (const source of Object.values(SURFACES)) {
      for (const page of linkedPages(source)) reachable.add(page);
    }

    const orphans = CATALOG_PAGES.filter((page) => !reachable.has(page));
    expect(orphans).toEqual([]);
  });

  it('o rodapé do shell alcança toda solução em qualquer página', () => {
    // O menu do topo roteia por público. É o rodapé — presente em todas as
    // páginas — que garante um link para cada solução em todo o site.
    const fromShell = linkedPages(SURFACES.shell);
    for (const page of SOLUTION_PAGES) {
      expect(fromShell).toContain(page);
    }
  });

  it('a home dá entrada própria para cada solução', () => {
    const fromHome = linkedPages(SURFACES.home);
    for (const page of SOLUTION_PAGES) {
      expect(fromHome).toContain(page);
    }
  });

  it('a página de escolas leva ao aprofundamento do School OS', () => {
    // O caminho natural do comprador institucional: a LP de público explica a
    // jornada, a página de solução detalha o sistema.
    expect(SURFACES.audience).toContain("hubMarketingPath('school-os')");
  });
});
