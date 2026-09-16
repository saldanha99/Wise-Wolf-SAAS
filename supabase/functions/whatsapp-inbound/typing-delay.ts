/**
 * Quanto tempo o "digitando…" aparece antes de a mensagem da atendente sair.
 *
 * Pedido da direção em 15/09/2026: resposta instantânea entrega que é robô. O
 * piso é de 10 s e o tempo cresce com o tamanho do texto (~25 caracteres por
 * segundo, que é gente digitando rápido), com teto para ninguém ficar
 * esperando meio minuto por uma frase. A Evolution mostra o "digitando"
 * enquanto segura a mensagem pelo `delay`.
 */

export const TYPING_MIN_MS = 10_000;
export const TYPING_MAX_MS = 25_000;
const MS_POR_CARACTERE = 40;

export function typingDelayMs(text: string): number {
  const caracteres = String(text ?? "").length;
  return Math.min(
    TYPING_MAX_MS,
    Math.max(TYPING_MIN_MS, Math.round(caracteres * MS_POR_CARACTERE)),
  );
}
