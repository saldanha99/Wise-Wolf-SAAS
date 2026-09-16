import { describe, expect, it } from 'vitest';
import { UserRole } from '../types';
import { ADMIN_NAV } from './adminNav';
import { activeMenuIdFor, badgeOf, buildMenuItems, groupBadge, groupBySection, shortLabel } from './navModel';
import { defaultShortcutsFor } from './shortcuts';

describe('buildMenuItems', () => {
  it('o menu do diretor é o ADMIN_NAV, na mesma ordem', () => {
    expect(buildMenuItems(UserRole.SCHOOL_ADMIN, { pendingLessonsCount: 0 }).map(i => i.id))
      .toEqual(ADMIN_NAV.map(g => g.id));
  });

  it('o contador de pendentes do professor entra como badge do item "Pendentes"', () => {
    const pending = buildMenuItems(UserRole.TEACHER, { pendingLessonsCount: 7 }).find(i => i.id === 'pending');
    expect(pending?.badge).toBe(7);
  });

  it('todo atalho padrão aponta para um item real do papel', () => {
    for (const role of [UserRole.SCHOOL_ADMIN, UserRole.TEACHER]) {
      const ids = new Set(buildMenuItems(role, { pendingLessonsCount: 0 }).map(i => i.id));
      for (const id of defaultShortcutsFor(role)) expect(ids.has(id), `${role}: ${id}`).toBe(true);
    }
  });

  it('diretor e professor têm seção em todo item (o layout de topo agrupa por seção)', () => {
    for (const role of [UserRole.SCHOOL_ADMIN, UserRole.TEACHER]) {
      for (const it of buildMenuItems(role, { pendingLessonsCount: 0 })) expect(it.section, it.id).toBeTruthy();
    }
  });
});

describe('groupBySection', () => {
  it('agrupa na ordem de aparição, sem juntar seções separadas por outra', () => {
    const items = buildMenuItems(UserRole.SCHOOL_ADMIN, { pendingLessonsCount: 0 });
    const sections = groupBySection(items).map(g => g.section);
    expect(sections).toEqual(Array.from(new Set(items.map(i => i.section))));
  });

  it('item sem seção cai em "Menu" em vez de explodir', () => {
    expect(groupBySection(buildMenuItems(UserRole.STUDENT, { pendingLessonsCount: 0 }))).toHaveLength(1);
  });
});

describe('activeMenuIdFor', () => {
  it('sub-aba do diretor acende o grupo dela', () => {
    expect(activeMenuIdFor(UserRole.SCHOOL_ADMIN, 'balancete')).toBe('dre');
    expect(activeMenuIdFor(UserRole.SCHOOL_ADMIN, 'approvals')).toBe('teachers');
  });

  it('professor, override e aba desconhecida ficam na própria aba', () => {
    expect(activeMenuIdFor(UserRole.TEACHER, 'lessons')).toBe('lessons');
    expect(activeMenuIdFor(UserRole.SCHOOL_ADMIN, 'balancete', true)).toBe('balancete');
    expect(activeMenuIdFor(UserRole.SCHOOL_ADMIN, 'profile')).toBe('profile');
  });
});

describe('badges', () => {
  const items = buildMenuItems(UserRole.SCHOOL_ADMIN, { pendingLessonsCount: 0 });
  const counts = { acolhimento: 2, presenca: 3, trials: 1 };

  it('badgeOf lê o contador pela badgeKey', () => {
    expect(badgeOf(items.find(i => i.id === 'teachers')!, counts)).toBe(2);
    expect(badgeOf(items.find(i => i.id === 'dashboard')!, counts)).toBeUndefined();
  });

  it('groupBadge soma só números positivos', () => {
    const aulas = groupBySection(items).find(g => g.section === 'Aulas')!;
    expect(groupBadge(aulas.items, counts)).toBe(4);
    expect(groupBadge(aulas.items, {})).toBe(0);
  });

  it('shortLabel cai no label quando não há rótulo curto', () => {
    expect(shortLabel({ id: 'x', label: 'Agenda', icon: () => null })).toBe('Agenda');
    expect(shortLabel({ id: 'x', label: 'Experimentais e Treinos', icon: () => null, short: 'Experim.' })).toBe('Experim.');
  });
});
