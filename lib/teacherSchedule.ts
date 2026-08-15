import type { Reschedule } from '../types';

function scheduleDayIndex(date: string): number {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    const [day, month, year] = date.split('/').map(Number);
    const weekday = new Date(year, month - 1, day).getDay();
    return weekday === 0 ? -1 : weekday - 1;
  }

  const isoDate = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const parsed = isoDate
    ? new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]))
    : new Date(date);
  if (Number.isNaN(parsed.getTime())) return -1;
  const weekday = parsed.getDay();
  return weekday === 0 ? -1 : weekday - 1;
}

export function findTeacherRescheduleForSlot(
  reschedules: Reschedule[],
  teacherId: string | number | undefined,
  dayIndex: number,
  time: string,
): Reschedule | null {
  if (teacherId === undefined || teacherId === null) return null;
  const normalizedTime = time.substring(0, 5);

  return reschedules.find((reschedule) => (
    String(reschedule.teacherId) === String(teacherId)
    && scheduleDayIndex(reschedule.date) === dayIndex
    && typeof reschedule.time === 'string'
    && reschedule.time.substring(0, 5) === normalizedTime
  )) ?? null;
}
