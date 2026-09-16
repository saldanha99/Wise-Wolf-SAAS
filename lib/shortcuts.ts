import { UserRole } from '../types';
import type { NavItem } from './navModel';

/**
 * Regras dos atalhos do trilho lateral — puras, sem DOM nem storage, para
 * serem testadas sem montar componente. O hook (`components/shell/useShortcuts`)
 * só liga isto ao localStorage.
 */

export const MAX_SHORTCUTS = 10;

/** Atalhos iniciais por papel: o trabalho do dia, na ordem em que se abre. */
export const DEFAULT_SHORTCUTS: Record<string, string[]> = {
  [UserRole.SCHOOL_ADMIN]: ['dashboard', 'schedule_explorer', 'students', 'student-payments', 'whatsapp'],
  [UserRole.TEACHER]: ['dashboard', 'schedule', 'lessons', 'pending', 'students'],
};

export const defaultShortcutsFor = (role: UserRole | string): string[] => DEFAULT_SHORTCUTS[role] ?? [];

/** Mantém só ids permitidos, sem repetição, até o teto. */
export function sanitizeShortcutIds(ids: unknown, allowed: NavItem[]): string[] {
  if (!Array.isArray(ids)) return [];
  const allowedIds = new Set(allowed.map(it => it.id));
  const seen = new Set<string>();
  return ids
    .filter((id): id is string => typeof id === 'string' && allowedIds.has(id) && !seen.has(id) && !!seen.add(id))
    .slice(0, MAX_SHORTCUTS);
}

/** Move o item da posição `from` para antes da posição `to` (índice na lista original). */
export function moveShortcut(ids: string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return ids;
  const target = Math.max(0, Math.min(to, ids.length));
  const without = ids.filter((_, i) => i !== from);
  const at = target > from ? target - 1 : target;
  return [...without.slice(0, at), ids[from], ...without.slice(at)];
}

/** Insere em `atIndex` (fim por padrão). Id já presente é MOVIDO, nunca duplicado. */
export function addShortcut(ids: string[], id: string, atIndex?: number): string[] {
  const existing = ids.indexOf(id);
  if (existing >= 0) return atIndex === undefined ? ids : moveShortcut(ids, existing, atIndex);
  if (ids.length >= MAX_SHORTCUTS) return ids;
  const at = atIndex === undefined ? ids.length : Math.max(0, Math.min(atIndex, ids.length));
  return [...ids.slice(0, at), id, ...ids.slice(at)];
}
