// Verificação da assinatura dos webhooks do Resend (enviados pelo Svix).
//
// Conteúdo assinado: `${svix-id}.${svix-timestamp}.${corpo cru}`, HMAC-SHA256
// com a chave = base64 decodificado da parte depois de `whsec_`. O cabeçalho
// `svix-signature` traz uma lista separada por espaço de `v1,<base64>`.
// Referência: https://docs.svix.com/receiving/verifying-payloads/how-manual
// (Resend: https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests).

/** Janela contra replay: 5 minutos para cada lado. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySvixSignature(input: {
  secret: string | undefined;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const secret = input.secret?.trim() || "";
  const id = input.id?.trim() || "";
  const timestamp = input.timestamp?.trim() || "";
  const header = input.signature?.trim() || "";
  if (!secret.startsWith("whsec_") || !id || !header) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > SVIX_TOLERANCE_SECONDS) return false;
  const keyBytes = base64ToBytes(secret.slice("whsec_".length));
  if (!keyBytes || keyBytes.length === 0) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${input.body}`),
  );
  const expected = bytesToBase64(new Uint8Array(signed));
  let matched = false;
  for (const entry of header.split(" ")) {
    const [version, candidate] = entry.split(",", 2);
    if (
      version === "v1" && candidate && constantTimeEqual(candidate, expected)
    ) {
      matched = true;
    }
  }
  return matched;
}
