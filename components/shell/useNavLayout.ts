import { useMemo, useState } from 'react';
import { NAV_LAYOUT_ROLES } from '../../lib/navModel';

export type NavLayout = 'top' | 'side';

const PREFIX = 'wisewolf.navLayout.';
/** Quem nunca escolheu fica na lateral: é o que a equipe conhece hoje. */
const DEFAULT_LAYOUT: NavLayout = 'side';

function readPreferred(userId: string): NavLayout {
  try {
    const raw = localStorage.getItem(`${PREFIX}${userId}`);
    return raw === 'top' || raw === 'side' ? raw : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/**
 * Posição do menu (lateral clássica x barra no topo + trilho de atalhos).
 * Tolera user=null: é chamado junto dos hooks do topo do App, antes dos early
 * returns. Só diretor e professor escolhem; os outros papéis têm menu curto.
 */
export function useNavLayout(user: { id: string; role: string } | null): {
  navLayout: NavLayout;
  setNavLayout: (layout: NavLayout) => void;
  canToggle: boolean;
} {
  const userId = user?.id ?? null;
  // Troca de usuário na mesma sessão relê a preferência dele; o useMemo evita
  // um getItem por render do App.
  const saved = useMemo(() => (userId ? readPreferred(userId) : DEFAULT_LAYOUT), [userId]);
  const [stored, setStored] = useState<{ userId: string; layout: NavLayout } | null>(null);
  const preferred = stored && stored.userId === userId ? stored.layout : saved;

  const setNavLayout = (layout: NavLayout) => {
    if (!userId) return;
    try { localStorage.setItem(`${PREFIX}${userId}`, layout); } catch { /* storage indisponível */ }
    setStored({ userId, layout });
  };

  const canToggle = !!user && NAV_LAYOUT_ROLES.includes(user.role);
  return { navLayout: canToggle ? preferred : 'side', setNavLayout, canToggle };
}
