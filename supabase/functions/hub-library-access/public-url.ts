/// <reference lib="deno.ns" />

/**
 * O cliente admin da edge fala com o Storage pela rede interna do Docker
 * (SUPABASE_URL = http://kong:8000), então a URL assinada sai com esse host,
 * que o navegador do professor não alcança. Troca só a origem pela pública
 * (SUPABASE_PUBLIC_URL), mantendo caminho e token. Mesma regra de
 * `_shared/tenant-legal-assets.ts`.
 */
export function publicHubSignedUrl(
  signedUrl: string,
  configuredPublicBaseUrl?: string,
): string {
  const publicBaseUrl = configuredPublicBaseUrl?.trim() || "";
  if (!publicBaseUrl) return signedUrl;

  const signed = new URL(signedUrl);
  const publicBase = new URL(publicBaseUrl);
  const publicIsSafe = publicBase.protocol === "https:" ||
    (publicBase.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(publicBase.hostname));
  if (
    !publicIsSafe || publicBase.username || publicBase.password ||
    publicBase.hash
  ) {
    throw new Error("hub_library_public_url_invalid");
  }

  return new URL(`${signed.pathname}${signed.search}`, publicBase.origin)
    .toString();
}
