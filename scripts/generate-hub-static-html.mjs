import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_FILE_PATH = import.meta.url.startsWith('file:') ? fileURLToPath(import.meta.url) : '';
const PROJECT_ROOT = MODULE_FILE_PATH ? path.dirname(path.dirname(MODULE_FILE_PATH)) : process.cwd();
const PAGE_CONFIG_PATH = path.join(PROJECT_ROOT, 'components/hub/hubMarketingPages.json');
const SYSTEM_PAGE_CONFIG_PATH = path.join(PROJECT_ROOT, 'components/marketing/systemMarketingPages.json');

export const SYSTEM_APP_ORIGIN = 'https://system.wisewolflanguage.com.br';
export const HUB_MARKETING_ORIGIN = 'https://hub.wisewolflanguage.com.br';

const HTML_ATTRIBUTE_ESCAPE = {
  '&': '&amp;',
  '"': '&quot;',
  '<': '&lt;',
  '>': '&gt;',
};

const escapeAttribute = (value) => value.replace(/[&"<>]/g, (character) => HTML_ATTRIBUTE_ESCAPE[character]);
const escapeText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const replaceRequired = (html, pattern, replacement, label) => {
  if (!pattern.test(html)) throw new Error(`Template HTML sem ${label}`);
  return html.replace(pattern, replacement);
};

const upsertMeta = (html, attribute, key, content) => {
  const pattern = new RegExp(`<meta\\s+${attribute}=["']${escapeRegExp(key)}["'][^>]*>`, 'i');
  const tag = `<meta ${attribute}="${escapeAttribute(key)}" content="${escapeAttribute(content)}">`;
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace('</head>', `  ${tag}\n</head>`);
};

const removeMeta = (html, attribute, key) => {
  const pattern = new RegExp(`\\s*<meta\\s+${attribute}=["']${escapeRegExp(key)}["'][^>]*>`, 'i');
  return html.replace(pattern, '');
};

const upsertCanonical = (html, canonicalUrl) => {
  const pattern = /<link\s+rel=["']canonical["'][^>]*>/i;
  const tag = `<link rel="canonical" href="${escapeAttribute(canonicalUrl)}">`;
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace('</head>', `  ${tag}\n</head>`);
};

const removeCanonical = (html) => html.replace(/\s*<link\s+rel=["']canonical["'][^>]*>/i, '');

export const removeMetaPixel = (html) => html
  .replace(/\s*<!--\s*Meta Pixel Code\s*-->[\s\S]*?<!--\s*End Meta Pixel Code\s*-->/gi, '')
  .replace(/\s*<!--\s*Meta Pixel \(noscript\):[\s\S]*?-->\s*<noscript>[\s\S]*?facebook\.com\/tr[\s\S]*?<\/noscript>/gi, '');

const replaceTitle = (html, title) => replaceRequired(
  html,
  /<title>[\s\S]*?<\/title>/i,
  `<title>${escapeText(title)}</title>`,
  '<title>',
);

const hubCanonicalPath = (segment) => segment ? `/${segment}` : '/';

const renderMarketingHtml = (template, metadata, canonicalUrl) => {
  const socialImageUrl = new URL(metadata.imagePath, new URL(canonicalUrl).origin).toString();
  let html = replaceTitle(template, metadata.title);
  html = upsertMeta(html, 'name', 'description', metadata.description);
  html = upsertMeta(html, 'name', 'robots', 'index, follow');
  html = upsertMeta(html, 'name', 'theme-color', '#070d1a');
  html = upsertMeta(html, 'property', 'og:type', 'website');
  html = upsertMeta(html, 'property', 'og:url', canonicalUrl);
  html = upsertMeta(html, 'property', 'og:title', metadata.title);
  html = upsertMeta(html, 'property', 'og:description', metadata.description);
  html = upsertMeta(html, 'property', 'og:image', socialImageUrl);
  html = upsertMeta(html, 'property', 'og:image:alt', metadata.imageAlt);
  html = upsertMeta(html, 'property', 'og:site_name', 'Wise Wolf Hub');
  html = upsertMeta(html, 'name', 'twitter:card', 'summary_large_image');
  html = upsertMeta(html, 'name', 'twitter:title', metadata.title);
  html = upsertMeta(html, 'name', 'twitter:description', metadata.description);
  html = upsertMeta(html, 'name', 'twitter:image', socialImageUrl);
  return upsertCanonical(html, canonicalUrl);
};

export const renderHubMarketingHtml = (template, metadata) => {
  const canonicalUrl = new URL(hubCanonicalPath(metadata.segment), HUB_MARKETING_ORIGIN).toString();
  return renderMarketingHtml(template, metadata, canonicalUrl);
};

export const renderDedicatedHubMarketingHtml = (template, metadata) =>
  removeMetaPixel(renderHubMarketingHtml(template, metadata));

export const renderSystemMarketingHtml = (template, metadata) => {
  const canonicalUrl = new URL(metadata.path, SYSTEM_APP_ORIGIN).toString();
  return renderMarketingHtml(template, metadata, canonicalUrl);
};

export const renderHubNotFoundHtml = (template, { dedicatedHost }) => {
  const homePath = dedicatedHost ? '/' : '/hub';
  let html = replaceTitle(template, 'Página não encontrada | Wise Wolf Hub');
  html = upsertMeta(html, 'name', 'description', 'Esta página não existe ou mudou de endereço. Continue pelo início do Wise Wolf Hub.');
  html = upsertMeta(html, 'name', 'robots', 'noindex, nofollow');
  html = removeCanonical(html);
  for (const [attribute, key] of [
    ['property', 'og:url'],
    ['property', 'og:title'],
    ['property', 'og:description'],
    ['property', 'og:image'],
    ['property', 'og:image:alt'],
    ['name', 'twitter:title'],
    ['name', 'twitter:description'],
    ['name', 'twitter:image'],
  ]) {
    html = removeMeta(html, attribute, key);
  }
  const fallback = `<div id="root"><main style="min-height:100vh;display:grid;place-items:center;padding:2rem;background:#070d1a;color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center"><section><p style="font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:#93c5fd">Erro 404</p><h1 style="margin:.75rem 0;font-size:clamp(2rem,6vw,4rem)">Esta página saiu da trilha.</h1><p style="max-width:36rem;color:#cbd5e1;line-height:1.7">O endereço não existe ou mudou. Volte ao Hub para encontrar a solução certa.</p><a href="${homePath}" style="display:inline-block;margin-top:1.5rem;padding:.9rem 1.25rem;border-radius:999px;background:#fff;color:#0f172a;font-weight:800;text-decoration:none">Ir para o Wise Wolf Hub</a></section></main></div>`;
  return replaceRequired(html, /<div\s+id=["']root["']><\/div>/i, fallback, '#root vazio');
};

// Rotas do app que só existem atrás de um token enviado por WhatsApp ou e-mail.
// Elas nunca devem ser rastreadas: não são páginas de marketing e o conteúdo
// pertence a uma pessoa específica.
const CRAWLER_DISALLOWED_PATHS = [
  '/confirmar-presenca',
  '/mudar-plano',
  '/transferencia',
  '/view-contract',
  '/claim-opportunity',
  '/teacher-onboarding',
  '/vendor-onboarding',
  '/__hub_host',
];

export const SYSTEM_SITEMAP_URL = new URL('/sitemap.xml', SYSTEM_APP_ORIGIN).toString();
export const HUB_SITEMAP_URL = new URL('/sitemap.xml', HUB_MARKETING_ORIGIN).toString();

const renderLocationsSitemapXml = (locations) => {
  const entries = locations.map((location) => `  <url>\n    <loc>${escapeText(location)}</loc>\n  </url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
};

export const renderHubSitemapXml = (pages) => renderLocationsSitemapXml(
  Object.values(pages).map((metadata) => new URL(
    hubCanonicalPath(metadata.segment),
    HUB_MARKETING_ORIGIN,
  ).toString()),
);

export const renderSystemSitemapXml = (systemPages) => renderLocationsSitemapXml(
  Object.values(systemPages).map((metadata) => new URL(
    metadata.path,
    SYSTEM_APP_ORIGIN,
  ).toString()),
);

export const renderRobotsTxt = ({
  sitemapUrl = SYSTEM_SITEMAP_URL,
  disallowedPaths = CRAWLER_DISALLOWED_PATHS,
} = {}) => [
  'User-agent: *',
  'Allow: /',
  ...disallowedPaths.map((route) => `Disallow: ${route}`),
  '',
  `Sitemap: ${sitemapUrl}`,
  '',
].join('\n');

const assertPageConfig = (pages) => {
  const expectedKeys = ['overview', 'teachers', 'schools', 'library', 'educator-ai', 'wolfie', 'school-os', 'terms', 'privacy'];
  if (JSON.stringify(Object.keys(pages)) !== JSON.stringify(expectedKeys)) {
    throw new Error('Catálogo de páginas do Hub incompleto ou fora da ordem esperada');
  }
  const segments = new Set();
  for (const [page, metadata] of Object.entries(pages)) {
    for (const field of ['segment', 'title', 'description', 'imagePath', 'imageAlt']) {
      if (typeof metadata[field] !== 'string' || (field !== 'segment' && !metadata[field].trim())) {
        throw new Error(`Metadado inválido em ${page}.${field}`);
      }
    }
    if (metadata.segment && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.segment)) {
      throw new Error(`Segmento inválido em ${page}`);
    }
    if (segments.has(metadata.segment)) throw new Error(`Segmento duplicado: ${metadata.segment}`);
    segments.add(metadata.segment);
  }
};

const assertSystemPageConfig = (pages) => {
  const expectedKeys = ['teacher-business', 'school-diagnosis'];
  if (JSON.stringify(Object.keys(pages)) !== JSON.stringify(expectedKeys)) {
    throw new Error('Catálogo de LPs comerciais incompleto ou fora da ordem esperada');
  }
  const paths = new Set();
  for (const [page, metadata] of Object.entries(pages)) {
    for (const field of ['path', 'title', 'description', 'imagePath', 'imageAlt']) {
      if (typeof metadata[field] !== 'string' || !metadata[field].trim()) {
        throw new Error(`Metadado inválido em ${page}.${field}`);
      }
    }
    if (!/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.path)) {
      throw new Error(`Caminho inválido em ${page}`);
    }
    if (paths.has(metadata.path)) throw new Error(`Caminho duplicado: ${metadata.path}`);
    paths.add(metadata.path);
  }
};

const writeHtml = async (targetPath, html) => {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, html, 'utf8');
};

export const generateHubStaticHtml = async ({ distDir = path.join(PROJECT_ROOT, 'dist') } = {}) => {
  const [template, rawPages, rawSystemPages] = await Promise.all([
    readFile(path.join(distDir, 'index.html'), 'utf8'),
    readFile(PAGE_CONFIG_PATH, 'utf8'),
    readFile(SYSTEM_PAGE_CONFIG_PATH, 'utf8'),
  ]);
  const pages = JSON.parse(rawPages);
  const systemPages = JSON.parse(rawSystemPages);
  assertPageConfig(pages);
  assertSystemPageConfig(systemPages);

  const generatedPaths = [];
  for (const metadata of Object.values(pages)) {
    const systemTarget = path.join(distDir, 'hub', metadata.segment, 'index.html');
    const dedicatedTarget = path.join(distDir, '__hub_host', metadata.segment, 'index.html');
    await Promise.all([
      writeHtml(systemTarget, renderHubMarketingHtml(template, metadata)),
      writeHtml(dedicatedTarget, renderDedicatedHubMarketingHtml(template, metadata)),
    ]);
    generatedPaths.push(systemTarget, dedicatedTarget);
  }

  const systemNotFound = path.join(distDir, 'hub', '404.html');
  const dedicatedNotFound = path.join(distDir, '__hub_host', '404.html');
  await Promise.all([
    writeHtml(systemNotFound, renderHubNotFoundHtml(template, { dedicatedHost: false })),
    writeHtml(dedicatedNotFound, removeMetaPixel(renderHubNotFoundHtml(template, { dedicatedHost: true }))),
  ]);
  generatedPaths.push(systemNotFound, dedicatedNotFound);

  for (const metadata of Object.values(systemPages)) {
    const systemTarget = path.join(distDir, metadata.path.slice(1), 'index.html');
    await writeHtml(systemTarget, renderSystemMarketingHtml(template, metadata));
    generatedPaths.push(systemTarget);
  }

  const systemSitemapTarget = path.join(distDir, 'sitemap.xml');
  const systemRobotsTarget = path.join(distDir, 'robots.txt');
  const hubSitemapTarget = path.join(distDir, '__hub_host', 'sitemap.xml');
  const hubRobotsTarget = path.join(distDir, '__hub_host', 'robots.txt');
  await Promise.all([
    writeHtml(systemSitemapTarget, renderSystemSitemapXml(systemPages)),
    writeHtml(systemRobotsTarget, renderRobotsTxt()),
    writeHtml(hubSitemapTarget, renderHubSitemapXml(pages)),
    writeHtml(hubRobotsTarget, renderRobotsTxt({
      sitemapUrl: HUB_SITEMAP_URL,
      disallowedPaths: [],
    })),
  ]);
  generatedPaths.push(
    systemSitemapTarget,
    systemRobotsTarget,
    hubSitemapTarget,
    hubRobotsTarget,
  );
  return generatedPaths;
};

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (MODULE_FILE_PATH && invokedPath === MODULE_FILE_PATH) {
  const generatedPaths = await generateHubStaticHtml();
  process.stdout.write(`Shells estáticos de marketing gerados: ${generatedPaths.length}\n`);
}
