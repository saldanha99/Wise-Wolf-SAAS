/**
 * Cliente desatualizado: o bundle antigo continua rodando depois de o servidor
 * mudar.
 *
 * O caso real (Flávio, 11/09/2026): o celular dele rodava o app de antes de
 * 25/08. Esse bundle pede em `profiles` colunas que a migration de PII de 24/08
 * revogou de `authenticated` (cpf, rg, pix, mensalidade…). O PostgREST devolve
 * 42501 (`permission denied for table profiles`) para a linha do PRÓPRIO
 * usuário, e a tela lia isso como conta inválida: com sessão viva, todos os
 * alunos sumiam (as queries que embutem o perfil falhavam em silêncio); ao
 * relogar, aparecia "Conta desativada ou perfil não encontrado". Um reload
 * resolvia — mas ninguém sabia disso, porque a mensagem falava de conta.
 *
 * Regra: 42501 no select do próprio perfil com `PROFILE_SAFE_COLS` só acontece
 * quando o cliente pede coluna que não existe mais no grant — ou seja, quando
 * o cliente é antigo. Aí a resposta certa é recarregar, uma vez, e nunca dizer
 * que a conta está desativada.
 */

/** Chave em sessionStorage: quando foi o último reload por cliente antigo. */
const RELOAD_MARK_KEY = 'ww:stale-client-reload-at';

/** Um reload por minuto. Se o segundo login ainda dá 42501, o reload não
 * trouxe bundle novo (offline, precache velho) — mostrar a mensagem é melhor
 * que recarregar em loop. */
const RELOAD_COOLDOWN_MS = 60_000;

export const STALE_CLIENT_MESSAGE =
  'Seu aplicativo está desatualizado. Feche e abra novamente para carregar a versão atual.';

type ErrorLike = { code?: unknown; message?: unknown; status?: unknown } | null | undefined;

/**
 * `true` quando o erro é o PostgREST recusando o select por falta de privilégio
 * (42501 / "permission denied"). Em nossa API isso, no perfil do próprio
 * usuário, é sinônimo de bundle antigo.
 */
export function isStaleClientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ErrorLike;
  if (e?.code === '42501') return true;
  const message = typeof e?.message === 'string' ? e.message.toLowerCase() : '';
  return message.includes('permission denied');
}

const readMark = (): number => {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_MARK_KEY);
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
};

const writeMark = (value: number) => {
  try {
    window.sessionStorage.setItem(RELOAD_MARK_KEY, String(value));
  } catch {
    // sessionStorage indisponível (modo privado, iframe): só perde a trava de loop.
  }
};

export interface StaleClientReloadRuntime {
  now?: () => number;
  reload?: () => void;
}

/**
 * Recarrega a página para buscar o bundle atual. Devolve `false` (sem
 * recarregar) quando já recarregou há menos de um minuto — cabe ao chamador
 * mostrar `STALE_CLIENT_MESSAGE`.
 */
export function reloadStaleClient(runtime: StaleClientReloadRuntime = {}): boolean {
  if (typeof window === 'undefined') return false;
  const now = runtime.now ?? (() => Date.now());
  const reload = runtime.reload ?? (() => window.location.reload());
  const current = now();
  if (current - readMark() < RELOAD_COOLDOWN_MS) return false;
  writeMark(current);
  reload();
  return true;
}
