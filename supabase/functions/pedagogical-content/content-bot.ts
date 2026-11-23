// Acesso do agente de conteúdo (sem login): header `x-content-bot-token`, o mesmo do
// `gamma-book-generator`. O token resolve para a conta do Hub do acervo
// (`content_bot_hub_identity`), nunca para a conta de teste da escola — a trava de IA das
// contas `is_test_account` não muda. Só a geração de material (`hubMode` + `action=material`)
// passa por aqui; a conta e a cota são as do acervo, o que vier no corpo é ignorado.

export const CONTENT_BOT_HEADER = "x-content-bot-token";
const BOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

export type ContentBotIdentity = { hubUserId: string; hubAccountId: string };

export type ContentBotRpc = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
};

export function contentBotTokenFrom(req: Request): string | null {
  const value = req.headers.get(CONTENT_BOT_HEADER)?.trim() ?? "";
  return value ? value : null;
}

/** Corpo aceito no caminho do agente: só geração de material, com a conta do acervo por cima. */
export function contentBotMaterialBody(
  body: JsonObject,
  identity: ContentBotIdentity,
): JsonObject | null {
  if (body.hubMode !== true || body.action !== "material") return null;
  const { account_id: _ignored, ...rest } = body;
  return { ...rest, accountId: identity.hubAccountId };
}

export async function resolveContentBotIdentity(
  admin: ContentBotRpc,
  token: string,
  sha256Hex: (value: string) => Promise<string>,
): Promise<ContentBotIdentity | null> {
  if (!BOT_TOKEN_PATTERN.test(token)) return null;
  const { data, error } = await admin.rpc("content_bot_hub_identity", {
    p_token_sha256: await sha256Hex(token),
  });
  if (error) {
    console.error("Content bot identity lookup failed", { code: error.code });
    return null;
  }
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") return null;
  const { hub_user_id: hubUserId, hub_account_id: hubAccountId } =
    row as JsonObject;
  if (
    typeof hubUserId !== "string" || !UUID.test(hubUserId) ||
    typeof hubAccountId !== "string" || !UUID.test(hubAccountId)
  ) {
    return null;
  }
  return { hubUserId, hubAccountId };
}
