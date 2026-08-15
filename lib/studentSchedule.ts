export type StudentScheduleSlot = {
  day_of_week: string;
  time_slot: string;
  teacher_id: string;
};

export function hasDuplicateStudentSchedule(slots: StudentScheduleSlot[]): boolean {
  const seen = new Set<string>();
  for (const slot of slots) {
    const key = `${slot.teacher_id}|${slot.day_of_week}|${slot.time_slot.slice(0, 5)}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export function studentScheduleErrorMessage(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown }
    : null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error || 'Erro desconhecido.');

  if (code === '23505' || /duplicate|uq_bookings_no_dup_active/i.test(message)) {
    return 'Este aluno já possui uma aula com o mesmo professor, dia e horário.';
  }
  return message;
}
