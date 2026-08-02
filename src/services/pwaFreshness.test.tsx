import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installPwaFreshnessGuard,
  type PwaServiceWorkerLike,
  type PwaVisibilityTargetLike,
} from "./pwaFreshness";

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("installPwaFreshnessGuard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("checks for updates and announces a replacement worker only once", async () => {
    vi.useFakeTimers();
    const workerListeners = new Map<string, EventListener>();
    const visibilityListeners = new Map<string, EventListener>();
    const update = vi.fn().mockResolvedValue(undefined);
    const onUpdateReady = vi.fn();
    const serviceWorker: PwaServiceWorkerLike = {
      controller: {},
      addEventListener: (type, listener) => workerListeners.set(type, listener),
      removeEventListener: (type) => workerListeners.delete(type),
      getRegistration: vi.fn().mockResolvedValue({ update }),
    };
    const visibilityTarget: PwaVisibilityTargetLike = {
      visibilityState: "visible",
      addEventListener: (type, listener) =>
        visibilityListeners.set(type, listener),
      removeEventListener: (type) => visibilityListeners.delete(type),
    };

    const dispose = installPwaFreshnessGuard({
      serviceWorker,
      visibilityTarget,
      onUpdateReady,
      updateIntervalMs: 60_000,
    });
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);

    workerListeners.get("controllerchange")?.(new Event("controllerchange"));
    workerListeners.get("controllerchange")?.(new Event("controllerchange"));
    expect(onUpdateReady).toHaveBeenCalledTimes(1);

    visibilityTarget.visibilityState = "hidden";
    visibilityListeners.get("visibilitychange")?.(
      new Event("visibilitychange"),
    );
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(1);

    visibilityTarget.visibilityState = "visible";
    visibilityListeners.get("visibilitychange")?.(
      new Event("visibilitychange"),
    );
    await flushPromises();
    expect(update).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(update).toHaveBeenCalledTimes(3);

    dispose();
    expect(workerListeners.size).toBe(0);
    expect(visibilityListeners.size).toBe(0);
  });

  it("does not announce the first controller acquired on a fresh install", () => {
    const workerListeners = new Map<string, EventListener>();
    const onUpdateReady = vi.fn();
    const serviceWorker: PwaServiceWorkerLike = {
      controller: null,
      addEventListener: (type, listener) => workerListeners.set(type, listener),
      removeEventListener: (type) => workerListeners.delete(type),
      getRegistration: vi.fn().mockResolvedValue(undefined),
    };

    const dispose = installPwaFreshnessGuard({
      serviceWorker,
      onUpdateReady,
    });
    workerListeners.get("controllerchange")?.(new Event("controllerchange"));
    expect(onUpdateReady).not.toHaveBeenCalled();

    workerListeners.get("controllerchange")?.(new Event("controllerchange"));
    expect(onUpdateReady).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("is inert when service workers are unavailable", () => {
    const dispose = installPwaFreshnessGuard({ serviceWorker: null });
    expect(dispose).toEqual(expect.any(Function));
    expect(() => dispose()).not.toThrow();
  });
});
