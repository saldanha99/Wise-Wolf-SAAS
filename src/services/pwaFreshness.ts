const DEFAULT_UPDATE_INTERVAL_MS = 5 * 60 * 1000;

export interface PwaRegistrationLike {
  update: () => Promise<unknown>;
}

export interface PwaServiceWorkerLike {
  controller?: unknown | null;
  addEventListener: (type: "controllerchange", listener: EventListener) => void;
  removeEventListener: (type: "controllerchange", listener: EventListener) => void;
  getRegistration: () => Promise<PwaRegistrationLike | undefined>;
}

export interface PwaVisibilityTargetLike {
  visibilityState: string;
  addEventListener: (type: "visibilitychange", listener: EventListener) => void;
  removeEventListener: (type: "visibilitychange", listener: EventListener) => void;
}

export interface PwaFreshnessRuntime {
  serviceWorker?: PwaServiceWorkerLike | null;
  visibilityTarget?: PwaVisibilityTargetLike;
  onUpdateReady?: () => void;
  updateIntervalMs?: number;
}

/**
 * Keeps long-lived PWA tabs on the currently deployed application shell.
 * Workbox can activate and claim a new worker while the tab is still running
 * the old JavaScript. We announce that update without forcing a reload during
 * a live lesson, form or payment flow.
 */
export function installPwaFreshnessGuard(
  runtime: PwaFreshnessRuntime = {},
): () => void {
  const browserServiceWorker = typeof navigator !== "undefined" &&
      "serviceWorker" in navigator
    ? navigator.serviceWorker as unknown as PwaServiceWorkerLike
    : null;
  const serviceWorker = runtime.serviceWorker === undefined
    ? browserServiceWorker
    : runtime.serviceWorker;

  if (!serviceWorker) return () => undefined;

  const visibilityTarget = runtime.visibilityTarget ??
    (typeof document !== "undefined"
      ? document as unknown as PwaVisibilityTargetLike
      : undefined);
  const onUpdateReady = runtime.onUpdateReady ?? (() => undefined);
  const updateIntervalMs = runtime.updateIntervalMs ??
    DEFAULT_UPDATE_INTERVAL_MS;
  let hasController = Boolean(serviceWorker.controller);
  // Fica `true` do momento em que um worker novo assume até o reload. Não há
  // como "desatualizar" de volta: só a página recarregada sai desse estado.
  let updatePending = false;

  const requestUpdate = () => {
    void serviceWorker.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => undefined);
  };

  const handleControllerChange: EventListener = () => {
    if (!hasController) {
      hasController = true;
      return;
    }
    if (updatePending) return;
    updatePending = true;
    onUpdateReady();
  };
  // Ao voltar ao primeiro plano, o aviso é repetido enquanto houver worker
  // novo esperando o reload. Antes ele saía UMA vez: quem tocava em "Depois"
  // num PWA instalado ficava no bundle antigo por semanas — foi assim que um
  // professor rodou, em 11/09/2026, um app de antes de 25/08 e viu a agenda
  // vazia e "conta desativada" (ver lib/staleClient.ts).
  const handleVisibilityChange: EventListener = () => {
    if (visibilityTarget?.visibilityState !== "visible") return;
    requestUpdate();
    if (updatePending) onUpdateReady();
  };

  serviceWorker.addEventListener("controllerchange", handleControllerChange);
  visibilityTarget?.addEventListener(
    "visibilitychange",
    handleVisibilityChange,
  );
  requestUpdate();
  const updateTimer = globalThis.setInterval(requestUpdate, updateIntervalMs);

  return () => {
    globalThis.clearInterval(updateTimer);
    serviceWorker.removeEventListener(
      "controllerchange",
      handleControllerChange,
    );
    visibilityTarget?.removeEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );
  };
}
