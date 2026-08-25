import { describe, expect, it } from 'vitest';
import {
  calculateDaysWithoutAbsence,
  calculateTeacherStreak,
  filterTeachersByView,
  getTeacherLifecycle,
} from './teacherManagement';

const teachers = [
  { id: '1', name: 'Ana Ativa', email: 'ana@example.com', lifecycle_status: 'active' as const },
  { id: '2', name: 'Bruno Suspenso', email: 'bruno@example.com', lifecycle_status: 'suspended' as const },
  { id: '3', name: 'Carla Desligada', email: 'carla@example.com', lifecycle_status: 'offboarded' as const },
];

describe('teacherManagement', () => {
  it('mantém somente professores ativos na visão inicial', () => {
    expect(filterTeachersByView(teachers, 'active', '').map((teacher) => teacher.id)).toEqual(['1']);
  });

  it('agrupa suspensos e desligados na visão separada e preserva a busca', () => {
    expect(filterTeachersByView(teachers, 'inactive', 'carla').map((teacher) => teacher.id)).toEqual(['3']);
  });

  it('respeita a atualização otimista de ciclo de vida', () => {
    expect(getTeacherLifecycle(teachers[0], 'suspended')).toBe('suspended');
    expect(filterTeachersByView(teachers, 'inactive', '', { 1: 'suspended' }).map((teacher) => teacher.id))
      .toEqual(['1', '2', '3']);
  });

  it('calcula a ofensiva desde a última falta ou desde o cadastro', () => {
    const now = new Date('2026-08-15T18:00:00.000Z');
    expect(calculateDaysWithoutAbsence('2026-07-01', '2026-08-10', now)).toBe(5);
    expect(calculateDaysWithoutAbsence('2026-08-01', null, now)).toBe(14);
  });

  it('calcula a ofensiva consecutiva e elegibilidade do Modo Turbo (meta 30 dias)', () => {
    const now = new Date('2026-08-16T12:00:00.000Z');
    // Professor com 7 dias consecutivos sem falta (falta em 2026-08-09)
    const teacher7Days = calculateTeacherStreak('2026-06-01', '2026-08-09', now);
    expect(teacher7Days.consecutiveDays).toBe(7);
    expect(teacher7Days.isEligibleForTurbo).toBe(false);
    expect(teacher7Days.daysRemainingForTurbo).toBe(23);
    expect(teacher7Days.turboProgressPct).toBe(23);
    expect(teacher7Days.hasAbsenceReset).toBe(true);

    // Professor com 35 dias consecutivos sem falta
    const teacher35Days = calculateTeacherStreak('2026-07-12', null, now);
    expect(teacher35Days.consecutiveDays).toBe(35);
    expect(teacher35Days.isEligibleForTurbo).toBe(true);
    expect(teacher35Days.daysRemainingForTurbo).toBe(0);
    expect(teacher35Days.turboProgressPct).toBe(100);
  });
});
