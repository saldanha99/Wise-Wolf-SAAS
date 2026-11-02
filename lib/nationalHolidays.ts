/** Próximo feriado nacional devolvido por my_upcoming_national_holiday(). */
export interface UpcomingNationalHoliday {
  date: string; // YYYY-MM-DD
  name: string;
  daysUntil: number;
}

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

/** Resposta estranha vira null: sem pop-up é melhor que pop-up errado. */
export function parseUpcomingNationalHoliday(value: unknown): UpcomingNationalHoliday | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const daysUntil = typeof raw.days_until === 'number' && Number.isInteger(raw.days_until) ? raw.days_until : null;
  if (!date || !name || daysUntil === null || daysUntil < 0 || daysUntil > 7) return null;
  return { date, name, daysUntil };
}

/** Textos do pop-up. A data é lida como data civil, sem fuso. */
export function describeNationalHoliday(holiday: UpcomingNationalHoliday) {
  const [year, month, day] = holiday.date.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
  const ddmm = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}`;
  const dayLabel = holiday.daysUntil === 0 ? 'hoje' : holiday.daysUntil === 1 ? 'amanhã' : `na ${weekday}, ${ddmm}`;
  const when = holiday.daysUntil === 0 ? 'hoje' : holiday.daysUntil === 1 ? 'amanhã' : `em ${holiday.daysUntil} dias`;
  const dateLabel = holiday.daysUntil <= 1 ? `${dayLabel[0].toUpperCase()}${dayLabel.slice(1)} (${weekday}, ${ddmm})` : `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${ddmm},`;
  return { weekday, ddmm, dayLabel, when, dateLabel };
}
