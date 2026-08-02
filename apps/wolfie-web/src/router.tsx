import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

const routeEvent = "wolfie:navigate";

const subscribe = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  window.addEventListener(routeEvent, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(routeEvent, callback);
  };
};

const getPath = () => `${window.location.pathname}${window.location.search}`;

export const useWolfiePath = () => useSyncExternalStore(
  subscribe,
  getPath,
  () => "/",
);

export const navigate = (target: string, options?: { replace?: boolean }) => {
  const url = new URL(target, window.location.origin);
  if (url.origin !== window.location.origin) {
    throw new Error("Navegação externa bloqueada.");
  }

  const next = `${url.pathname}${url.search}${url.hash}`;
  if (options?.replace) window.history.replaceState({}, "", next);
  else window.history.pushState({}, "", next);
  window.dispatchEvent(new Event(routeEvent));
  window.scrollTo({ top: 0, behavior: "auto" });
};

export const safeAppNextPath = (
  raw: string | null | undefined,
  origin = "https://wolfie.wisewolflanguage.com.br",
) => {
  if (!raw) return "/app";
  try {
    const candidate = new URL(raw, origin);
    if (candidate.origin !== new URL(origin).origin) return "/app";
    if (!/^\/app(?:\/|$)/.test(candidate.pathname)) return "/app";
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return "/app";
  }
};

interface WolfieLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}

export function WolfieLink({
  href,
  className,
  children,
  ariaLabel,
}: WolfieLinkProps) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey ||
      event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };

  return (
    <a href={href} className={className} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </a>
  );
}
