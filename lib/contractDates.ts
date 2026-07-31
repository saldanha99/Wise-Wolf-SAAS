/**
 * Cálculo da vigência do contrato.
 *
 * Existia duplicado em ContractManagement e ContractView. Um dos dois tinha
 * fallback para data ausente e o outro não, e o que não tinha imprimiu
 * "Vigência: 10/01/1970 a 10/01/1971" em contrato de aluno novo:
 * `accepted_at` é NULO até o aluno assinar, `new Date(null)` vira o epoch, e
 * no fuso de Brasília (UTC-3) o epoch é 31/12/1969. Como 31 > dia de
 * vencimento, a conta ainda pulava um mês e fechava 12 meses depois em 1971.
 */

/**
 * Data de referência do contrato, sempre válida. Aceita o que vem do banco
 * (ISO string, Date, null) e cai para "agora" quando o valor está ausente ou
 * não é uma data real — nunca devolve Invalid Date nem o epoch.
 */
export function contractReferenceDate(
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
): Date {
  if (value === null || value === undefined || value === "") return now;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? now : parsed;
}

export interface ContractPeriod {
  start: Date;
  end: Date;
}

/**
 * Vigência a partir da data de referência: começa no próximo vencimento e
 * termina `months` meses depois. Se a matrícula caiu depois do dia de
 * vencimento no mês, o primeiro ciclo é o do mês seguinte.
 */
export function contractPeriod(
  reference: Date,
  dueDay: number,
  months: number,
): ContractPeriod {
  // Vencimento fora da faixa geraria "dia 0" ou vazaria para o mês seguinte.
  const safeDueDay = Math.min(31, Math.max(1, Math.trunc(dueDay) || 1));
  const safeMonths = Math.max(0, Math.trunc(months) || 0);

  const startMonthOffset = reference.getDate() > safeDueDay ? 1 : 0;
  const start = new Date(
    reference.getFullYear(),
    reference.getMonth() + startMonthOffset,
    safeDueDay,
  );
  const end = new Date(
    start.getFullYear(),
    start.getMonth() + safeMonths,
    safeDueDay,
  );
  return { start, end };
}

/** Vigência já formatada em pt-BR, pronta para o documento. */
export function formatContractPeriod(
  reference: Date,
  dueDay: number,
  months: number,
): { startDate: string; endDate: string } {
  const { start, end } = contractPeriod(reference, dueDay, months);
  return {
    startDate: start.toLocaleDateString("pt-BR"),
    endDate: end.toLocaleDateString("pt-BR"),
  };
}
