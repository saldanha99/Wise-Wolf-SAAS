/// <reference lib="deno.ns" />

// Vencimento da 1ª cobrança da assinatura do Hub.
//
// A Asaas fixa o dia do mês da assinatura pelo `nextDueDate` da criação, e
// todas as cobranças seguintes caem nesse mesmo dia. Antes ele saía da data
// UTC de `hub_checkout_sessions.created_at`: compra feita depois das 21h de
// Brasília (já "amanhã" em UTC) vencia no dia seguinte e carregava esse dia
// para sempre. O calendário que vale é o do cliente, em America/Sao_Paulo.
//
// A data tem de ser estável entre tentativas (a mesma compra reabre o mesmo
// checkout e confere a cobrança pelo vencimento), por isso deriva só do
// `created_at` gravado, nunca do relógio de agora.

export const HUB_BILLING_TIME_ZONE = "America/Sao_Paulo";

const brasiliaDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: HUB_BILLING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Data (YYYY-MM-DD) do calendário de Brasília em que o checkout foi criado.
 * Devolve null para valor ausente ou que não é instante válido.
 */
export function hubFirstDueDate(createdAt: unknown): string | null {
  if (typeof createdAt !== "string") return null;
  const raw = createdAt.trim();
  if (!raw) return null;
  // Exige data completa e hora: "2026-11-03" sozinho seria lido como meia-noite
  // UTC (21h do dia anterior em Brasília) e trocaria o dia em silêncio.
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(raw)) return null;
  // Sem fuso explícito o instante dependeria do relógio do servidor; o
  // timestamptz do Postgres sempre traz o deslocamento.
  if (!/(Z|[+-]\d{2}(:?\d{2})?)$/i.test(raw)) return null;
  // O Postgres pode devolver espaço no lugar do "T" e o fuso como "+00".
  const normalized = raw
    .replace(" ", "T")
    .replace(/([+-]\d{2})$/, "$1:00");
  const instant = new Date(normalized);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = brasiliaDateFormatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}
