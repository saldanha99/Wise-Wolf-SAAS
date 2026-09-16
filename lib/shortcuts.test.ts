import { describe, expect, it } from 'vitest';
import { LayoutDashboard } from 'lucide-react';
import type { NavItem } from './navModel';
import { MAX_SHORTCUTS, addShortcut, defaultShortcutsFor, moveShortcut, sanitizeShortcutIds } from './shortcuts';
import { UserRole } from '../types';

const item = (id: string): NavItem => ({ id, label: id, icon: LayoutDashboard, section: 'S' });
const allowed = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(item);

describe('sanitizeShortcutIds', () => {
  it('descarta lixo do storage: não-array, não-string, id desconhecido e repetido', () => {
    expect(sanitizeShortcutIds('nope', allowed)).toEqual([]);
    expect(sanitizeShortcutIds(['a', 42, 'zzz', 'b', 'a', null], allowed)).toEqual(['a', 'b']);
  });

  it('corta no teto', () => {
    const ids = allowed.map(it => it.id);
    expect(sanitizeShortcutIds(ids, allowed)).toHaveLength(MAX_SHORTCUTS);
  });

  it('tela que o papel deixou de ter some sem apagar o resto', () => {
    expect(sanitizeShortcutIds(['a', 'x', 'b'], allowed.slice(0, 2))).toEqual(['a', 'b']);
  });
});

describe('moveShortcut', () => {
  it('move para frente e para trás pelo índice da lista original', () => {
    expect(moveShortcut(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveShortcut(['a', 'b', 'c', 'd'], 0, 4)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveShortcut(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('soltar no próprio lugar não muda nada', () => {
    expect(moveShortcut(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
    expect(moveShortcut(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'b', 'c']);
  });

  it('índice de origem inválido devolve a lista intacta', () => {
    const ids = ['a', 'b'];
    expect(moveShortcut(ids, 5, 0)).toBe(ids);
  });
});

describe('addShortcut', () => {
  it('insere no fim por padrão ou na posição pedida', () => {
    expect(addShortcut(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
    expect(addShortcut(['a', 'b'], 'c', 0)).toEqual(['c', 'a', 'b']);
  });

  it('id já presente é movido, nunca duplicado', () => {
    expect(addShortcut(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(addShortcut(['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('cheio recusa item novo', () => {
    const full = allowed.slice(0, MAX_SHORTCUTS).map(it => it.id);
    expect(addShortcut(full, 'k')).toBe(full);
  });
});

describe('defaultShortcutsFor', () => {
  it('diretor e professor têm atalhos iniciais; os outros papéis começam vazios', () => {
    expect(defaultShortcutsFor(UserRole.SCHOOL_ADMIN).length).toBeGreaterThan(0);
    expect(defaultShortcutsFor(UserRole.TEACHER).length).toBeGreaterThan(0);
    expect(defaultShortcutsFor(UserRole.STUDENT)).toEqual([]);
  });
});
