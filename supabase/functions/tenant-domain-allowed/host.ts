/** Normaliza o host pedido pelo Caddy; null = recusa sem ir ao banco. */
export function normalizeAskHost(value: string | null): string | null {
  if (!value) return null;
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.length < 4 || host.length > 253) return null;
  if (
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/
      .test(host)
  ) {
    return null;
  }
  return host;
}
