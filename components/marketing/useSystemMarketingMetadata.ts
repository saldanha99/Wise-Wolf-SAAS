import { useEffect } from 'react';
import rawSystemMarketingPages from './systemMarketingPages.json';

export type SystemMarketingPage = keyof typeof rawSystemMarketingPages;

const SYSTEM_APP_ORIGIN = 'https://system.wisewolflanguage.com.br';

const syncMetaTag = (
  attribute: 'name' | 'property',
  key: string,
  content: string,
): (() => void) => {
  const existing = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  const element = existing ?? document.createElement('meta');
  const previousContent = existing?.content ?? null;
  if (!existing) {
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
  return () => {
    if (existing) element.content = previousContent ?? '';
    else element.remove();
  };
};

export const useSystemMarketingMetadata = (page: SystemMarketingPage): void => {
  useEffect(() => {
    const metadata = rawSystemMarketingPages[page];
    const canonicalUrl = new URL(metadata.path, SYSTEM_APP_ORIGIN).toString();
    const socialImageUrl = new URL(metadata.imagePath, SYSTEM_APP_ORIGIN).toString();
    const previousTitle = document.title;
    const existingCanonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const canonical = existingCanonical ?? document.createElement('link');
    const previousCanonical = existingCanonical?.href ?? null;
    if (!existingCanonical) {
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    const restoreMeta = [
      syncMetaTag('name', 'description', metadata.description),
      syncMetaTag('name', 'robots', 'index, follow'),
      syncMetaTag('property', 'og:type', 'website'),
      syncMetaTag('property', 'og:url', canonicalUrl),
      syncMetaTag('property', 'og:title', metadata.title),
      syncMetaTag('property', 'og:description', metadata.description),
      syncMetaTag('property', 'og:image', socialImageUrl),
      syncMetaTag('property', 'og:image:alt', metadata.imageAlt),
      syncMetaTag('property', 'og:site_name', 'Wise Wolf'),
      syncMetaTag('name', 'twitter:card', 'summary_large_image'),
      syncMetaTag('name', 'twitter:title', metadata.title),
      syncMetaTag('name', 'twitter:description', metadata.description),
      syncMetaTag('name', 'twitter:image', socialImageUrl),
    ];
    document.title = metadata.title;
    canonical.href = canonicalUrl;
    return () => {
      document.title = previousTitle;
      restoreMeta.forEach((restore) => restore());
      if (existingCanonical) canonical.href = previousCanonical ?? '';
      else canonical.remove();
    };
  }, [page]);
};
