export interface RealtimeProviderFallback {
  status: number;
  code: string;
  message: string;
}

const PROVIDER_BILLING_BLOCK_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

export function realtimeProviderFallback(
  status: number,
  providerErrorCode: string,
): RealtimeProviderFallback {
  if (status === 429 && PROVIDER_BILLING_BLOCK_CODES.has(providerErrorCode)) {
    return {
      status: 503,
      code: "REALTIME_PROVIDER_BILLING_BLOCKED",
      message:
        "A conversa por voz está indisponível no momento. Você ainda pode praticar digitando.",
    };
  }
  if (status === 429) {
    return {
      status: 429,
      code: "REALTIME_RATE_LIMITED",
      message:
        "O modo em tempo real está ocupado. Tente novamente em instantes.",
    };
  }
  return {
    status: status === 401 || status === 403 || status >= 500 ? 503 : 502,
    code: "REALTIME_PROVIDER_UNAVAILABLE",
    message:
      "O modo em tempo real não pôde ser iniciado. Use o modo de voz atual.",
  };
}
