/**
 * A OpenAI rejeita o cabeçalho `OpenAI-Safety-Identifier` acima de 64
 * caracteres com 400 `invalid_value`. O digest SHA-256 completo em hexadecimal
 * já ocupa 64, então o prefixo estourava o limite e derrubava toda chamada ao
 * vivo. Mantemos 128 bits (32 caracteres hex), o mesmo corte usado pelo
 * lesson-planner: continua estável por (tenant, usuário) e não reversível.
 */
export const OPENAI_SAFETY_IDENTIFIER_MAX_LENGTH = 64;

const IDENTIFIER_PREFIX = "ww_";
const DIGEST_HEX_LENGTH = 32;

export async function buildSafetyIdentifier(
  salt: string,
  tenantId: string,
  userId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${tenantId}:${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("").slice(0, DIGEST_HEX_LENGTH);
  return `${IDENTIFIER_PREFIX}${hex}`.slice(
    0,
    OPENAI_SAFETY_IDENTIFIER_MAX_LENGTH,
  );
}
