/// <reference lib="deno.ns" />

/**
 * Feriados nacionais brasileiros — só os FERIADOS, nunca ponto facultativo
 * (Carnaval, Corpus Christi, Dia do Servidor têm aula normal). Mesma lista de
 * public.national_holidays no banco. Utilizada para garantir que o SDR IA e o
 * despachante de experimentais NUNCA ofereçam nem agendem aulas nesses dias.
 */
export const BRAZILIAN_NATIONAL_HOLIDAYS_MAP: Record<string, string> = {
  // 2026 Móveis e Fixos
  "2026-01-01": "Confraternização Universal",
  "2026-04-03": "Paixão de Cristo",
  "2026-04-21": "Tiradentes",
  "2026-05-01": "Dia do Trabalho",
  "2026-09-07": "Independência do Brasil",
  "2026-10-12": "Nossa Senhora Aparecida",
  "2026-11-02": "Finados",
  "2026-11-15": "Proclamação da República",
  "2026-11-20": "Dia da Consciência Negra",
  "2026-12-25": "Natal",
  // 2027 Móveis e Fixos
  "2027-01-01": "Confraternização Universal",
  "2027-03-26": "Paixão de Cristo",
  "2027-04-21": "Tiradentes",
  "2027-05-01": "Dia do Trabalho",
  "2027-09-07": "Independência do Brasil",
  "2027-10-12": "Nossa Senhora Aparecida",
  "2027-11-02": "Finados",
  "2027-11-15": "Proclamação da República",
  "2027-11-20": "Dia da Consciência Negra",
  "2027-12-25": "Natal",
};

const FIXED_ANNUAL_HOLIDAYS: Record<string, string> = {
  "01-01": "Confraternização Universal",
  "04-21": "Tiradentes",
  "05-01": "Dia do Trabalho",
  "09-07": "Independência do Brasil",
  "10-12": "Nossa Senhora Aparecida",
  "11-02": "Finados",
  "11-15": "Proclamação da República",
  "11-20": "Dia da Consciência Negra",
  "12-25": "Natal",
};

export function getHolidayBR(dateStr: string): string | null {
  if (!dateStr || dateStr.length < 10) return null;
  const direct = BRAZILIAN_NATIONAL_HOLIDAYS_MAP[dateStr];
  if (direct) return direct;
  const mmdd = dateStr.slice(5, 10);
  return FIXED_ANNUAL_HOLIDAYS[mmdd] || null;
}

export function isHolidayBR(dateStr: string): boolean {
  return getHolidayBR(dateStr) !== null;
}
