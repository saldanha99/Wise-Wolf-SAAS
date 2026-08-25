import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import hubMarketingPages from './hubMarketingPages.json';
import systemMarketingPages from '../marketing/systemMarketingPages.json';
import {
  generateHubStaticHtml,
  renderHubMarketingHtml,
  renderHubNotFoundHtml,
  renderHubSitemapXml,
  renderRobotsTxt,
  renderSystemSitemapXml,
  renderSystemMarketingHtml,
} from '../../scripts/generate-hub-static-html.mjs';

const TEMPLATE = `<!doctype html><html><head>
<meta name="theme-color" content="#002366">
<title>Aplicação</title>
<meta name="description" content="Descrição genérica">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://system.wisewolflanguage.com.br/">
<meta property="og:url" content="https://system.wisewolflanguage.com.br/">
<meta property="og:title" content="Aplicação">
<meta property="og:description" content="Descrição genérica">
<meta property="og:image" content="https://system.wisewolflanguage.com.br/generic.webp">
<meta name="twitter:title" content="Aplicação">
<meta name="twitter:description" content="Descrição genérica">
<meta name="twitter:image" content="https://system.wisewolflanguage.com.br/generic.webp">
</head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Hub static HTML generation', () => {
  it('renders specific metadata while consolidating both hosts on the Hub canonical', () => {
    const metadata = {
      segment: 'professores',
      title: 'Professores | Wise Wolf',
      description: 'Uma descrição específica.',
      imagePath: '/assets/hub/marketing/hub-overview-og.webp',
      imageAlt: 'Plataforma para professores',
    };
    const systemHtml = renderHubMarketingHtml(TEMPLATE, metadata);
    const dedicatedHtml = renderHubMarketingHtml(TEMPLATE, metadata);

    expect(systemHtml).toContain('<title>Professores | Wise Wolf</title>');
    expect(systemHtml).toContain('href="https://hub.wisewolflanguage.com.br/professores"');
    expect(systemHtml).toContain('content="https://hub.wisewolflanguage.com.br/assets/hub/marketing/hub-overview-og.webp"');
    expect(dedicatedHtml).toContain('href="https://hub.wisewolflanguage.com.br/professores"');
    expect(dedicatedHtml).toContain('content="https://hub.wisewolflanguage.com.br/assets/hub/marketing/hub-overview-og.webp"');
  });

  it('renders system-only commercial LP metadata', () => {
    const html = renderSystemMarketingHtml(TEMPLATE, {
      path: '/seja-professor',
      title: 'Professor Negócio | Gestão para Professores de Inglês',
      description: 'Uma descrição própria.',
      imagePath: '/assets/hub/marketing/hub-overview-og.webp',
      imageAlt: 'Gestão para professores',
    });

    expect(html).toContain('<title>Professor Negócio | Gestão para Professores de Inglês</title>');
    expect(html).toContain('href="https://system.wisewolflanguage.com.br/seja-professor"');
    expect(html).toContain('content="https://system.wisewolflanguage.com.br/assets/hub/marketing/hub-overview-og.webp"');
  });

  it('renders a useful noindex shell for unknown routes', () => {
    const html = renderHubNotFoundHtml(TEMPLATE, { dedicatedHost: false });

    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('Esta página saiu da trilha.');
    expect(html).toContain('href="/hub"');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('property="og:url"');
  });

  it('writes every known LP for both hosts plus both 404 documents', async () => {
    const distDir = await mkdtemp(path.join(os.tmpdir(), 'wise-wolf-hub-static-'));
    temporaryDirectories.push(distDir);
    await writeFile(path.join(distDir, 'index.html'), TEMPLATE, 'utf8');

    const generatedPaths = await generateHubStaticHtml({ distDir });
    const teacherSystemHtml = await readFile(path.join(distDir, 'hub/professores/index.html'), 'utf8');
    const schoolDedicatedHtml = await readFile(path.join(distDir, '__hub_host/escolas/index.html'), 'utf8');
    const dedicatedNotFoundHtml = await readFile(path.join(distDir, '__hub_host/404.html'), 'utf8');
    const teacherBusinessHtml = await readFile(path.join(distDir, 'seja-professor/index.html'), 'utf8');
    const schoolDiagnosisHtml = await readFile(path.join(distDir, 'new-saas/index.html'), 'utf8');

    const expectedGeneratedPathCount =
      Object.keys(hubMarketingPages).length * 2 +
      Object.keys(systemMarketingPages).length +
      6;
    expect(generatedPaths).toHaveLength(expectedGeneratedPathCount);
    expect(teacherSystemHtml).toContain('https://hub.wisewolflanguage.com.br/professores');
    expect(schoolDedicatedHtml).toContain('https://hub.wisewolflanguage.com.br/escolas');
    expect(dedicatedNotFoundHtml).toContain('content="noindex, nofollow"');
    expect(dedicatedNotFoundHtml).toContain('href="/"');
    expect(teacherBusinessHtml).toContain('https://system.wisewolflanguage.com.br/seja-professor');
    expect(schoolDiagnosisHtml).toContain('https://system.wisewolflanguage.com.br/new-saas');
  });

  it('separa as URLs canônicas nos sitemaps de cada host', () => {
    const hubXml = renderHubSitemapXml(
      { overview: { segment: '' }, 'school-os': { segment: 'saas-escolar' } },
    );
    const systemXml = renderSystemSitemapXml(
      { 'teacher-business': { path: '/seja-professor' } },
    );

    expect(hubXml).toContain('<loc>https://hub.wisewolflanguage.com.br/</loc>');
    expect(hubXml).toContain('<loc>https://hub.wisewolflanguage.com.br/saas-escolar</loc>');
    expect(hubXml).not.toContain('system.wisewolflanguage.com.br');
    expect(systemXml).toContain('<loc>https://system.wisewolflanguage.com.br/seja-professor</loc>');
    expect(systemXml).not.toContain('hub.wisewolflanguage.com.br');
  });

  it('declara o sitemap e barra as rotas de token no robots', () => {
    const robots = renderRobotsTxt();

    expect(robots).toContain('Sitemap: https://system.wisewolflanguage.com.br/sitemap.xml');
    expect(robots).toContain('Disallow: /confirmar-presenca');
    expect(robots).toContain('Disallow: /mudar-plano');
    expect(robots).toContain('Disallow: /__hub_host');
    expect(robots).not.toContain('Disallow: /hub');
  });

  it('entrega sitemap e robots para os dois hosts', async () => {
    const distDir = await mkdtemp(path.join(os.tmpdir(), 'wise-wolf-hub-seo-'));
    temporaryDirectories.push(distDir);
    await writeFile(path.join(distDir, 'index.html'), TEMPLATE, 'utf8');

    await generateHubStaticHtml({ distDir });
    const systemSitemap = await readFile(path.join(distDir, 'sitemap.xml'), 'utf8');
    const dedicatedSitemap = await readFile(path.join(distDir, '__hub_host/sitemap.xml'), 'utf8');
    const dedicatedRobots = await readFile(path.join(distDir, '__hub_host/robots.txt'), 'utf8');

    expect(systemSitemap).toContain('<loc>https://system.wisewolflanguage.com.br/new-saas</loc>');
    expect(systemSitemap).not.toContain('hub.wisewolflanguage.com.br');
    expect(dedicatedSitemap).toContain('<loc>https://hub.wisewolflanguage.com.br/saas-escolar</loc>');
    expect(dedicatedSitemap).not.toContain('system.wisewolflanguage.com.br');
    expect(dedicatedRobots).toContain('Sitemap: https://hub.wisewolflanguage.com.br/sitemap.xml');
  });
});
