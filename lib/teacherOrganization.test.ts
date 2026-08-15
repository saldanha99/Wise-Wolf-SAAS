import { describe, expect, it } from 'vitest';
import {
  effectiveTeacherLifecycle,
  parseTeacherOrganizationSnapshot,
  teacherMatchesListView,
} from './teacherOrganization';

describe('organização de professores', () => {
  it('considera active quando lifecycle_status ainda não foi preenchido', () => {
    expect(effectiveTeacherLifecycle({})).toBe('active');
    expect(teacherMatchesListView({}, 'active')).toBe(true);
    expect(teacherMatchesListView({}, 'inactive')).toBe(false);
  });

  it('separa somente suspended e offboarded na aba de inativos', () => {
    expect(teacherMatchesListView({ lifecycle_status: 'suspended' }, 'inactive')).toBe(true);
    expect(teacherMatchesListView({ lifecycle_status: 'offboarded' }, 'inactive')).toBe(true);
    expect(teacherMatchesListView({ lifecycle_status: 'active' }, 'inactive')).toBe(false);
  });

  it('prioriza o lifecycle otimista após uma ação do diretor', () => {
    expect(effectiveTeacherLifecycle({ lifecycle_status: 'active' }, 'suspended')).toBe('suspended');
  });

  it('lê active e current_streak do contrato canônico da RPC', () => {
    expect(parseTeacherOrganizationSnapshot({ active: true, current_streak: 37 })).toEqual({
      enabled: true,
      currentStreak: 37,
    });
  });

  it('aceita days_clean durante a compatibilidade de rollout e normaliza a contagem', () => {
    expect(parseTeacherOrganizationSnapshot([{ active: false, days_clean: '12.9' }])).toEqual({
      enabled: false,
      currentStreak: 12,
    });
  });

  it('não inventa status quando a RPC devolve um contrato inválido', () => {
    expect(parseTeacherOrganizationSnapshot({ enabled: true, current_streak: 10 })).toBeNull();
    expect(parseTeacherOrganizationSnapshot(null)).toBeNull();
  });
});
