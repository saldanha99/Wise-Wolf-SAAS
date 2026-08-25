import { useEffect } from 'react';

const FOCUSABLE_TARGET_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
};

const resolveHashTarget = (hash: string): HTMLElement | null => {
  if (!hash.startsWith('#') || hash.length === 1) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
};

const canSafelyFocus = (target: HTMLElement): boolean => {
  const activeElement = document.activeElement;
  const focusIsIdle = !activeElement
    || activeElement === document.body
    || activeElement === document.documentElement;
  return focusIsIdle
    && target.matches(FOCUSABLE_TARGET_SELECTOR)
    && target.getAttribute('aria-hidden') !== 'true'
    && !target.closest('[inert]');
};

export const scrollToHubHashTarget = (hash = window.location.hash): boolean => {
  const target = resolveHashTarget(hash);
  if (!target) return false;

  target.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'start',
  });

  if (canSafelyFocus(target)) target.focus({ preventScroll: true });
  return true;
};

export const useHubHashNavigation = (ready: boolean, pageKey: string | null): void => {
  useEffect(() => {
    if (!ready) return undefined;

    let frameId: number | null = null;
    let active = true;
    const scheduleHashNavigation = () => {
      if (!active) return;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        scrollToHubHashTarget();
      });
    };

    scheduleHashNavigation();
    const pendingImages = Array.from(document.images).filter((image) => !image.complete);
    pendingImages.forEach((image) => {
      image.addEventListener('load', scheduleHashNavigation);
      image.addEventListener('error', scheduleHashNavigation);
    });
    void document.fonts?.ready.then(scheduleHashNavigation);
    window.addEventListener('hashchange', scheduleHashNavigation);
    window.addEventListener('popstate', scheduleHashNavigation);

    return () => {
      active = false;
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      pendingImages.forEach((image) => {
        image.removeEventListener('load', scheduleHashNavigation);
        image.removeEventListener('error', scheduleHashNavigation);
      });
      window.removeEventListener('hashchange', scheduleHashNavigation);
      window.removeEventListener('popstate', scheduleHashNavigation);
    };
  }, [pageKey, ready]);
};
