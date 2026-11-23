// Atividade por link/QR (Fase 1 do Hub): partes puras, testadas.

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_HUB_URL = "https://hub.wisewolflanguage.com.br";

/** Token aleatório de 32 bytes em base64url (o banco guarda só o sha256). */
export function newShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(
    /\//g,
    "_",
  ).replace(/=+$/, "");
}

export const isShareToken = (value: unknown): value is string =>
  typeof value === "string" && TOKEN_PATTERN.test(value);

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** Link público da atividade. Só https (ou localhost no desenvolvimento). */
export function shareUrl(token: string, configured?: string): string {
  let base = DEFAULT_HUB_URL;
  try {
    const parsed = new URL((configured ?? "").trim() || DEFAULT_HUB_URL);
    const safe = parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(parsed.hostname));
    if (safe && !parsed.username && !parsed.password) base = parsed.origin;
  } catch {
    base = DEFAULT_HUB_URL;
  }
  return `${base}/?atividade=${encodeURIComponent(token)}`;
}

export function statusForCode(code: string): number {
  if (code === "LINK_EXPIRED") return 410;
  if (code === "LINK_INVALID" || code === "MATERIAL_NOT_FOUND") return 404;
  if (code === "SUBSCRIPTION_REQUIRED") return 402;
  if (code === "SHARE_LIMIT_REACHED") return 429;
  return 403;
}
