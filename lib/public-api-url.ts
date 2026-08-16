const LOCAL_API_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LEGACY_AUTH_PATHS = new Set(['/', '/auth/v1', '/auth/v1/']);

/**
 * Converts the public Supabase/Kong URL to the origin expected by supabase-js.
 * Older VPS configurations exposed the same origin with an `/auth/v1` suffix;
 * passing that suffix to createClient duplicates every service path.
 */
export function normalizePublicApiUrl(value: string): string {
  const url = new URL(value.trim());
  const isLocalHttp = url.protocol === 'http:' && LOCAL_API_HOSTS.has(url.hostname);

  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('A API pública deve usar HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('A URL da API pública não pode conter credenciais, consulta ou fragmento.');
  }
  if (!LEGACY_AUTH_PATHS.has(url.pathname)) {
    throw new Error('A URL da API pública deve apontar para a origem ou para o caminho legado /auth/v1.');
  }

  return url.origin;
}
