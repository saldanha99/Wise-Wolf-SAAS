import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attentionReasons, lastClassLabel, matchesQuickFilter, quickFilterOptions, rosterPermissions,
  rosterStage, scheduleLabel, scheduleSlotsFromBookings, sortRoster, type RosterStudent,
} from './studentRoster';

const student = (over: Partial<RosterStudent> = {}): RosterStudent => ({
  id: 's1', name: 'Ana', levelBadge: 'A1', status: 'Ativo', lifecycle_status: 'active',
  professor_id: 't1', assignedTeacherIds: ['t1'], assignedTeachers: ['Débora'],
  scheduleSlots: [{ day: 'Seg', time: '10:00' }], ...over,
});

describe('situação da matrícula', () => {
  it('lifecycle_status manda; status legado só como reserva', () => {
    expect(rosterStage(student())).toBe('active');
    expect(rosterStage(student({ lifecycle_status: 'suspended' }))).toBe('paused');
    expect(rosterStage(student({ lifecycle_status: 'offboarded', status: 'Ativo' }))).toBe('offboarded');
    expect(rosterStage(student({ lifecycle_status: null, status: 'Inativo' }))).toBe('paused');
  });
});

describe('permissões por papel', () => {
  it('direção edita, decide pausa/encerramento, vê dinheiro e cria aluno', () => {
    expect(rosterPermissions('SCHOOL_ADMIN', 'd1', student())).toEqual({
      canEdit: true, canManageLifecycle: true, canSeeMoney: true, canChangeSchedule: false, canCreate: true,
    });
  });

  it('professor do aluno edita o pedagógico e troca horário, sem dinheiro nem matrícula', () => {
    expect(rosterPermissions('TEACHER', 't1', student())).toEqual({
      canEdit: true, canManageLifecycle: false, canSeeMoney: false, canChangeSchedule: true, canCreate: false,
    });
  });

  it('professor que só cobre o aluno não edita nem troca horário', () => {
    const p = rosterPermissions('TEACHER', 't2', student());
    expect(p.canEdit).toBe(false);
    expect(p.canChangeSchedule).toBe(false);
  });

  it('titular sem agenda nenhuma continua responsável; titular antigo com agenda de outro não', () => {
    expect(rosterPermissions('TEACHER', 't1', student({ assignedTeacherIds: [] })).canEdit).toBe(true);
    expect(rosterPermissions('TEACHER', 't1', student({ assignedTeacherIds: ['t9'] })).canEdit).toBe(false);
  });
});

describe('atalhos de filtro', () => {
  const students = [
    student({ id: 'a' }),
    student({ id: 'b', scheduleSlots: [] }),
    student({ id: 'c', lifecycle_status: 'suspended' }),
    student({ id: 'd', lifecycle_status: 'offboarded' }),
  ];
  const ov = {
    a: { risk_level: 'HIGH', days_since_last: 40, overdue_count: 1 },
    b: { risk_level: 'LOW', days_since_last: 2 },
    c: { risk_level: 'HIGH', days_since_last: 90 },
  };

  it('conta cada atalho e só considera ativo em "atenção"', () => {
    const counts = Object.fromEntries(quickFilterOptions(students, ov, true).map(o => [o.id, o.count]));
    expect(counts).toMatchObject({ ACTIVE: 2, ATTENTION: 1, IDLE: 1, NO_SCHEDULE: 1, OVERDUE: 1, PAUSED: 1, OFFBOARDED: 1 });
  });

  it('professor não recebe os atalhos de atraso, pausa e encerramento', () => {
    expect(quickFilterOptions(students, ov, false).map(o => o.id)).toEqual(['ACTIVE', 'ATTENTION', 'IDLE', 'NO_SCHEDULE']);
    expect(matchesQuickFilter(students[0], ov.a, 'ATTENTION')).toBe(true);
  });

  it('motivo financeiro some para o professor', () => {
    const o = { risk_reasons: ['Pagamento em atraso', '2 faltas recentes'] };
    expect(attentionReasons(o, false)).toEqual(['2 faltas recentes']);
    expect(attentionReasons(o, true)).toHaveLength(2);
  });

  it('prioridade: ativos em risco primeiro, encerrados por último', () => {
    expect(sortRoster(students, ov, 'PRIORITY').map(s => s.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(sortRoster([student({ id: 'z', name: 'Zé' }), student({ id: 'y', name: 'Ana' })], {}, 'NAME').map(s => s.id)).toEqual(['y', 'z']);
  });
});

describe('agenda fixa', () => {
  it('um chip por dia e horário, em ordem, aceitando nome sem acento', () => {
    const slots = scheduleSlotsFromBookings([
      { day_of_week: 'Quarta', time_slot: '10:00:00' },
      { day_of_week: 'Segunda', time_slot: '10:00:00' },
      { day_of_week: 'Segunda', time_slot: '10:00:00' },
      { day_of_week: 'Terca', time_slot: '19:30:00' },
    ]);
    expect(slots).toEqual([{ day: 'Seg', time: '10:00' }, { day: 'Ter', time: '19:30' }, { day: 'Qua', time: '10:00' }]);
    expect(scheduleLabel(slots)).toBe('Seg 10:00 · Ter 19:30 · Qua 10:00');
    expect(scheduleLabel(slots.filter(s => s.time === '10:00'))).toBe('Seg/Qua · 10:00');
  });

  it('texto da última aula', () => {
    expect(lastClassLabel(null)).toBe('Sem aula lançada');
    expect(lastClassLabel(1)).toBe('Última aula ontem');
    expect(lastClassLabel(31)).toBe('Última aula há 31 dias');
  });
});

describe('tela de alunos', () => {
  const source = readFileSync(resolve(process.cwd(), 'components/StudentsList.tsx'), 'utf8');

  it('não oferece ao professor o que o servidor recusa', () => {
    // create-student-account só aceita a direção; pausa/reativação idem.
    expect(source).toContain('permissionsFor(undefined).canCreate &&');
    expect(source).not.toContain("'set_student_academic_status'");
  });

  it('não manda link pessoal de sala pelo WhatsApp', () => {
    expect(source).not.toContain('Segue o link da sua sala de aula');
  });
});
