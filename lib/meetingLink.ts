/**
 * Link da sala de aula online.
 *
 * Havia um gerador que INVENTAVA links do Meet com letras aleatórias
 * (`meet.google.com/xyz-abcd-efg`). Aquilo não cria reunião nenhuma: quem
 * clicasse recebia "código de reunião inválido" do Google, e nem o aluno nem
 * o professor tinham como saber que o link nunca existiu.
 *
 * A regra passa a ser: ou existe um link REAL informado por uma pessoa, ou não
 * existe link. Um campo vazio é honesto; um link morto é pior que nada, porque
 * parece que está tudo certo.
 */

export type MeetingProvider = "meet" | "zoom" | "teams" | "whereby" | "outro";

export interface MeetingLinkInfo {
  url: string;
  provider: MeetingProvider;
}

const PROVIDER_HOSTS: Array<[MeetingProvider, RegExp]> = [
  ["meet", /(^|\.)meet\.google\.com$/i],
  ["meet", /(^|\.)calendar\.app\.google$/i],
  ["zoom", /(^|\.)zoom\.us$/i],
  ["teams", /(^|\.)teams\.(microsoft|live)\.com$/i],
  ["whereby", /(^|\.)whereby\.com$/i],
];

/**
 * Valida e normaliza. Devolve null para qualquer coisa que não seja uma URL
 * de reunião utilizável — incluindo texto solto que o usuário digitou achando
 * que era link.
 */
export function normalizeMeetingLink(
  value: string | null | undefined,
): MeetingLinkInfo | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  // Aceita "meet.google.com/abc" sem protocolo, que é como as pessoas copiam.
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname.includes(".")) return null;

  const provider =
    PROVIDER_HOSTS.find(([, pattern]) => pattern.test(url.hostname))?.[0] ??
      "outro";

  // Sala do Meet sem código é a página inicial: não leva a lugar nenhum.
  if (provider === "meet" && /(^|\.)meet\.google\.com$/i.test(url.hostname)) {
    const code = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!code || code === "new") return null;
  }

  return { url: url.toString(), provider };
}

/** Só a URL, para uso direto em href. */
export function safeMeetingLink(
  value: string | null | undefined,
): string | null {
  return normalizeMeetingLink(value)?.url ?? null;
}

/**
 * O aluno tem uma sala utilizável? Usado para avisar o diretor em vez de
 * deixar o aluno descobrir na hora da aula.
 */
export function hasUsableMeetingLink(
  value: string | null | undefined,
): boolean {
  return normalizeMeetingLink(value) !== null;
}
