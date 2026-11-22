// Marca da plataforma (decisão do Vinícius, 22/11/2026): a plataforma é a WiseCore;
// a Wise Wolf é a escola que a criou, usa e licencia. White label: escola cliente
// nunca vê "WiseCore" nem "Wise Wolf" — a assinatura só aparece para a própria
// Wise Wolf (e no login sem marca de escola, que é o dela).
export const PLATFORM_NAME = 'WiseCore';
export const PLATFORM_SIGNATURE = 'WiseCore — criada pela Wise Wolf';
export const PLATFORM_OWNER_TENANT_ID = 'school-wise-wolf';

export const showsPlatformSignature = (tenantId?: string | null): boolean =>
  tenantId === PLATFORM_OWNER_TENANT_ID;

/** Título da aba: só o nome da escola (white label); sem nome, o da plataforma. */
export const documentTitleFor = (tenantName?: string | null): string =>
  (tenantName || '').trim() || PLATFORM_NAME;
