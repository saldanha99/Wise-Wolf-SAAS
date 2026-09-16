import { useEffect, useMemo, useState } from 'react';
import type { NavItem } from '../../lib/navModel';
import { MAX_SHORTCUTS, addShortcut, defaultShortcutsFor, moveShortcut, sanitizeShortcutIds } from '../../lib/shortcuts';

const STORAGE_PREFIX = 'wisewolf.shortcuts.';

function readStored(userId: string, role: string, allowed: NavItem[]): string[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (raw === null) return sanitizeShortcutIds(defaultShortcutsFor(role), allowed);
    return sanitizeShortcutIds(JSON.parse(raw), allowed);
  } catch {
    return sanitizeShortcutIds(defaultShortcutsFor(role), allowed);
  }
}

/**
 * Atalhos do trilho lateral, por usuário e por aparelho (localStorage).
 * Preferência de layout não é dado de negócio — não vai para `profiles`, onde
 * campo novo exige mexer em `lib/profileColumns.ts` e na auditoria.
 */
export function useShortcuts(userId: string, role: string, allowed: NavItem[]): {
  shortcuts: NavItem[];
  isFull: boolean;
  add: (id: string, atIndex?: number) => void;
  move: (fromIndex: number, toIndex: number) => void;
  remove: (id: string) => void;
  toggle: (id: string) => void;
} {
  const [ids, setIds] = useState<string[]>(() => readStored(userId, role, allowed));

  useEffect(() => {
    try { localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(ids)); } catch { /* storage indisponível */ }
  }, [ids, userId]);

  // Tela que o papel deixou de ter some do trilho sem apagar a preferência.
  const byId = useMemo(() => new Map(allowed.map(it => [it.id, it])), [allowed]);
  const shortcuts = ids.map(id => byId.get(id)).filter((it): it is NavItem => !!it);
  const isAllowed = (id: string) => byId.has(id);

  return {
    shortcuts,
    isFull: shortcuts.length >= MAX_SHORTCUTS,
    add: (id, atIndex) => { if (isAllowed(id)) setIds(prev => addShortcut(prev, id, atIndex)); },
    move: (from, to) => setIds(prev => moveShortcut(prev, from, to)),
    remove: id => setIds(prev => prev.filter(x => x !== id)),
    toggle: id => {
      if (!isAllowed(id)) return;
      setIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : addShortcut(prev, id)));
    },
  };
}
