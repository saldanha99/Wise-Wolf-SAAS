const PRESENT_STATUSES = new Set([
  'COMPLETED',
  'PRESENT',
  'PRESENCA',
  'PRESENÇA',
]);

export const isCompletedClassPresence = (value: unknown): boolean =>
  PRESENT_STATUSES.has(String(value || '').trim().toUpperCase());

export const formatClassLogDate = (log: {
  class_date?: unknown;
  start_time?: unknown;
  created_at?: unknown;
}): string => {
  const civilDate = String(log.class_date || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(civilDate)) {
    const [year, month, day] = civilDate.split('-');
    return `${day}/${month}/${year}`;
  }

  const timestamp = log.start_time || log.created_at;
  const parsed = new Date(String(timestamp || ''));
  return Number.isNaN(parsed.getTime())
    ? 'Data indisponível'
    : parsed.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
};
