import rawMarketingPages from './hubMarketingPages.json';

export type HubMarketingPage = 'overview' | 'library' | 'educator-ai' | 'wolfie' | 'school-os';
export type HubAudienceMarketingPage = 'teachers' | 'schools';
export type HubLegalMarketingPage = 'terms' | 'privacy';
export type HubMarketingRoute = HubMarketingPage | HubAudienceMarketingPage | HubLegalMarketingPage;

export const HUB_MARKETING_ORIGIN = 'https://hub.wisewolflanguage.com.br';
export const SYSTEM_APP_ORIGIN = 'https://system.wisewolflanguage.com.br';

const HUB_HOSTS = new Set([
  'hub.wisewolflanguage.com.br',
]);

const TRUSTED_WISE_WOLF_HOSTS = new Set([
  'system.wisewolflanguage.com.br',
  'wisewolflanguage.com.br',
  'www.wisewolflanguage.com.br',
  'wolfie.wisewolflanguage.com.br',
]);

const PAGE_SEGMENTS = Object.fromEntries(
  (Object.entries(rawMarketingPages) as Array<[HubMarketingRoute, { segment: string }]>)
    .map(([page, metadata]) => [page, metadata.segment]),
) as Record<HubMarketingRoute, string>;

const browserHostname = (): string =>
  typeof window === 'undefined' ? '' : window.location.hostname;

const browserPathname = (): string =>
  typeof window === 'undefined' ? '/' : window.location.pathname;

const isTrustedWiseWolfUrl = (url: URL): boolean =>
  url.protocol === 'https:'
  && TRUSTED_WISE_WOLF_HOSTS.has(url.hostname.toLowerCase())
  && !url.port
  && !url.username
  && !url.password;

export const isHubMarketingHost = (hostname = browserHostname()): boolean =>
  HUB_HOSTS.has(hostname.trim().toLowerCase());

export const hubMarketingPath = (
  page: HubMarketingRoute,
  hostname = browserHostname(),
): string => {
  const segment = PAGE_SEGMENTS[page];
  const base = isHubMarketingHost(hostname) ? '' : '/hub';
  return segment ? `${base}/${segment}` : base || '/';
};

export const resolveHubMarketingPage = (
  pathname = browserPathname(),
  hostname = browserHostname(),
): HubMarketingRoute | null => {
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const withoutBase = isHubMarketingHost(hostname)
    ? normalized
    : normalized === '/hub' ? '/' : normalized.startsWith('/hub/') ? normalized.slice(4) : normalized;
  const segment = withoutBase.replace(/^\/+/, '');
  const match = (Object.entries(PAGE_SEGMENTS) as Array<[HubMarketingRoute, string]>)
    .find(([, candidate]) => candidate === segment);
  return match?.[0] ?? null;
};

export const hubCanonicalUrl = (
  page: HubMarketingRoute,
  _hostname = browserHostname(),
): string => {
  return new URL(
    hubMarketingPath(page, 'hub.wisewolflanguage.com.br'),
    `${HUB_MARKETING_ORIGIN}/`,
  ).toString();
};

export const resolveSystemAppUrl = (
  target?: string | null,
  fallbackPath = '/',
): string => {
  let fallbackUrl = `${SYSTEM_APP_ORIGIN}/`;
  try {
    const fallbackCandidate = new URL(fallbackPath, fallbackUrl);
    if (isTrustedWiseWolfUrl(fallbackCandidate)) fallbackUrl = fallbackCandidate.toString();
  } catch {}
  if (!target) return fallbackUrl;

  try {
    const resolved = new URL(target, `${SYSTEM_APP_ORIGIN}/`);
    return isTrustedWiseWolfUrl(resolved) ? resolved.toString() : fallbackUrl;
  } catch {
    return fallbackUrl;
  }
};
