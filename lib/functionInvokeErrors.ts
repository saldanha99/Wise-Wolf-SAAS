export type SupabaseFunctionErrorContext = Record<string, unknown> & {
  status?: number;
  statusText?: string;
  body?: unknown;
  responseBody?: unknown;
  responseText?: string;
  error?: string;
  error_code?: string;
  code?: string;
};

export interface ParsedFunctionError {
  message: string;
  status?: number;
  code?: string;
  details?: string;
  providerError?: string;
  retryable?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const pickCode = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const parseJsonBody = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
};

const extractBody = (context?: SupabaseFunctionErrorContext | null): unknown => {
  if (!context) return undefined;
  return context.body ??
    context.responseBody ??
    context.responseText ??
    (typeof context.error === 'string' ? context.error : undefined);
};

const pickErrorText = (payload: unknown, candidates: string[]): string | undefined => {
  if (!isRecord(payload)) return undefined;
  for (const key of candidates) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
    }
    if (isRecord(value) && typeof (value as Record<string, unknown>).message === 'string') {
      const nested = (value as Record<string, unknown>).message;
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  return undefined;
};

export const parseFunctionError = (params: {
  error?: unknown;
  data?: unknown;
  fallbackMessage: string;
}): ParsedFunctionError => {
  const context = isRecord(params.error)
    ? (params.error.context as SupabaseFunctionErrorContext) ?? {}
    : {};
  const status =
    asNumber((params.error as { status?: unknown } | undefined)?.status) ??
    asNumber(context.status);
  const rawBody = parseJsonBody(
    params.data !== undefined ? params.data : extractBody(context),
  );
  const source = isRecord(rawBody) ? rawBody : null;
  const fallback = params.fallbackMessage;
  const code = pickCode(source?.error_code) ?? pickCode(context.error_code) ?? pickCode(context.code);

  const providerError =
    pickErrorText(source, [
      'provider_error',
      'providerStatus',
      'provider-status',
    ]) ??
    pickErrorText(source?.['error'], ['provider_error']);

  let message = pickErrorText(source, ['error', 'message']) ??
    pickErrorText(context, ['error', 'message']) ??
    (typeof (params.error as { message?: unknown } | undefined)?.message === 'string'
      ? String((params.error as { message?: string }).message)
      : undefined) ??
    fallback;

  const details = pickErrorText(source, ['details']) ?? pickErrorText(context, ['details']);

  const retryable = source?.retryable === true ||
    status === 502 ||
    status === 503;

  if (source?.success === false && message === fallback && source?.error_code) {
    message = source.error_code === 'targeted_opportunity'
      ? 'Esta oportunidade foi direcionada e não pode ser reenviada para todos.'
      : 'Não foi possível disparar a oportunidade com segurança.';
  }

  if (
    source === null &&
    status === 409 &&
    message.toLowerCase().includes('permission denied')
  ) {
    message =
      'Sem permissão para executar a função de oportunidade no momento. Verifique a sessão e tente novamente.';
  }

  return {
    message,
    status,
    code,
    details,
    providerError,
    retryable,
  };
};

export const buildBroadcastErrorMessage = (error: ParsedFunctionError): string => {
  const map: Record<string, string> = {
    targeted_opportunity:
      'Esta oportunidade foi direcionada e não pode ser reenviada para todos.\n\nUse "Remarcar com mesmo professor" quando aplicável.',
    dispatch_guard_failed:
      'A segurança da oportunidade está inconsistente. Consulte o histórico da oportunidade e tente reenviar novamente.',
    reopen_failed:
      'Não foi possível reabrir esta experimental para redisparo. Verifique se ela ainda permite reabertura (estado, data e vínculo com o professor).',
    missing_instance_connection:
      'Conexão institucional de WhatsApp não configurada para esta escola.',
    missing_group_route:
      'Modo grupo está ativo, mas o grupo de professores não foi configurado.',
    no_active_teacher_recipient:
      'Não há professores ativos elegíveis para receber o convite no momento.',
    missing_portal_url:
      'A escola não possui URL de portal configurada.',
  };

  if (error.code && map[error.code]) {
    return map[error.code];
  }

  if (error.status === 409) {
    return 'Solicitação rejeitada pela regra de negócio da escola. Revise os dados e tente novamente.';
  }
  if (error.status && error.status >= 500) {
    return 'Falha temporária no envio. Tente novamente em alguns segundos.';
  }
  if (error.status === 502) {
    return 'Falha no envio do WhatsApp. Verifique a conexão e tente novamente.';
  }

  return error.message;
};
