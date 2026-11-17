/// <reference lib="deno.ns" />
/**
 * Números de OUTRAS instâncias do mesmo servidor de WhatsApp não falam com a IA.
 *
 * O servidor Evolution é compartilhado com a MotoFix (motofix-master e as
 * instâncias das oficinas). Em 16/11/2026 um vigia de outro projeto mandou um
 * alerta pela instância da Wise Wolf para o número da motofix-master: a
 * atendente da MotoFix respondeu como se fosse lead, a Michelle (RH) respondeu
 * de volta, e os dois robôs trocaram 19 mensagens até alguém digitar "Parar".
 * A MotoFix ainda abriu um lead "Wise Wolf".
 *
 * Regra: mensagem cujo remetente é o número conectado a qualquer OUTRA
 * instância do servidor é de máquina, não de gente. Fica na inbox (quem quiser
 * lê), mas nenhum agente responde. Falha ao consultar o servidor não bloqueia
 * ninguém: o atendimento de leads continua (a trava é defesa, não porteiro).
 */

/** DDD + últimos 8 dígitos: casa número com e sem o 9º dígito. */
export function phoneKey(raw: string): string | null {
  let digits = String(raw || "").split("@")[0].replace(/\D/g, "");
  if (digits.startsWith("55") && digits.length >= 12) digits = digits.slice(2);
  if (digits.length < 10) return null;
  return digits.slice(0, 2) + digits.slice(-8);
}

/** Números (chave) das instâncias do servidor, menos a própria. */
export function ownerPhoneKeys(
  instances: unknown,
  ownInstance: string,
): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(instances)) return keys;
  for (const row of instances as Array<Record<string, any>>) {
    const name = String(row?.name ?? row?.instance?.instanceName ?? "");
    if (!name || name === ownInstance) continue;
    const owner = String(
      row?.ownerJid ?? row?.owner ?? row?.instance?.owner ?? "",
    );
    const key = phoneKey(owner);
    if (key) keys.add(key);
  }
  return keys;
}

export function isInternalNumber(phone: string, keys: Set<string>): boolean {
  const key = phoneKey(phone);
  return !!key && keys.has(key);
}

const CACHE_TTL_MS = 10 * 60_000;
let cache: { at: number; base: string; own: string; keys: Set<string> } | null =
  null;

/** Lista os números do servidor (cache de 10 min). Erro → conjunto vazio. */
export async function loadInternalNumberKeys(
  baseUrl: string,
  apiKey: string,
  ownInstance: string,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<Set<string>> {
  if (
    cache && cache.base === baseUrl && cache.own === ownInstance &&
    now - cache.at < CACHE_TTL_MS
  ) {
    return cache.keys;
  }
  try {
    const resp = await fetcher(`${baseUrl}/instance/fetchInstances`, {
      headers: { apikey: apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const keys = ownerPhoneKeys(await resp.json(), ownInstance);
    cache = { at: now, base: baseUrl, own: ownInstance, keys };
    return keys;
  } catch (e) {
    console.error("[internal-numbers] lista de instâncias indisponível", {
      erro: (e as Error).message.slice(0, 80),
    });
    return cache?.keys ?? new Set();
  }
}

export function resetInternalNumberCacheForTests(): void {
  cache = null;
}
