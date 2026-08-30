export type WeekdayInput = unknown;

const WEEKDAY_MAP: Record<string, number> = {
  segunda: 0,
  terca: 1,
  terça: 1,
  quarta: 2,
  quinta: 3,
  sexta: 4,
  sabado: 5,
  sábado: 5,
  domingo: -1,
  sunday: -1,
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
};

export const normalizeWeekdayToIndex = (value: WeekdayInput): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value) - 1;
    return normalized >= 0 && normalized <= 5 ? normalized : -1;
  }

  if (typeof value !== 'string') return -1;

  const trimmed = value.trim();
  if (!trimmed) return -1;

  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) {
    const normalized = Math.trunc(parsed) - 1;
    return normalized >= 0 && normalized <= 5 ? normalized : -1;
  }

  const canonical = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .split('-')[0]
    .replace(/\bfeira\b/g, '')
    .trim();

  if (!canonical) return -1;
  return Object.prototype.hasOwnProperty.call(WEEKDAY_MAP, canonical) ? WEEKDAY_MAP[canonical] : -1;
};
