const TRANSIENT_PROVIDER_STATUSES = new Set([0, 408, 425, 500, 502, 503, 504]);

function retryAfterSeconds(value: string | null, nowMs: number): number | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const retryAt = Date.parse(normalized);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, (retryAt - nowMs) / 1_000);
}

export function providerRetryDelayMs(
  status: number,
  retryAfterHeader: string | null,
  attempt: number,
  maxWaitMs: number,
  nowMs = Date.now(),
): number | null {
  if (
    !Number.isInteger(attempt) || attempt < 0 ||
    !Number.isFinite(maxWaitMs) || maxWaitMs < 0
  ) return null;
  if (status === 429) {
    if (attempt >= 4) return null;
    const requestedSeconds = retryAfterSeconds(retryAfterHeader, nowMs) ?? 65;
    // Never retry before the provider's requested instant. If it does not fit
    // inside this repair request's deadline, fail now and let the next bounded
    // repair resume from the facts already persisted.
    const delayMs = Math.ceil(Math.max(1, requestedSeconds) * 1_000) +
      attempt * 250;
    return delayMs <= maxWaitMs ? delayMs : null;
  }
  if (!TRANSIENT_PROVIDER_STATUSES.has(status) || attempt >= 3) return null;
  const delayMs = 1_000 * (2 ** attempt);
  return delayMs <= maxWaitMs ? delayMs : null;
}

export function waitForProvider(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
