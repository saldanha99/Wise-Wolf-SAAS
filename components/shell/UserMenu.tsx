import React, { useEffect, useRef, useState } from 'react';
import { Compass, LogOut, Settings, Sparkles } from 'lucide-react';

interface UserMenuProps {
  name: string;
  roleLabel: string;
  avatarUrl?: string;
  onProfile: () => void;
  onLogout: () => void;
  /** Reabre o tour de boas-vindas. Ausente = papel sem roteiro. */
  onOpenTour?: () => void;
  /** Reabre o tour de novidade mais recente. Ausente = papel sem novidade. */
  onOpenNews?: () => void;
}

/**
 * Menu do avatar no header: Perfil · Tour guiado · Novidades · Sair.
 *
 * Existe porque, no layout de topo, a sidebar some no desktop — e com ela o
 * rodapé onde moravam "Meu Perfil", "Sair" e "Tour guiado". Fica visível nos
 * dois layouts: repetir Perfil/Sair no rodapé da lateral é barato, e um lugar
 * fixo para sair é o que a pessoa procura primeiro.
 */
export const UserMenu: React.FC<UserMenuProps> = ({ name, roleLabel, avatarUrl, onProfile, onLogout, onOpenTour, onOpenNews }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const initials = name.trim().slice(0, 2).toUpperCase() || '?';

  return (
    <div ref={ref} className="relative flex items-center gap-3">
      <div className="text-right hidden md:block">
        <p className="text-sm font-bold text-gray-900 dark:text-gray-100 leading-none">{name}</p>
        <p className="text-left text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-wide mt-1">{roleLabel}</p>
      </div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Menu do usuário"
        data-tour="user-menu"
        className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 p-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-offset-2"
      >
        {avatarUrl
          ? <img src={avatarUrl} className="w-full h-full rounded-full object-cover border-2 border-white dark:border-slate-900" alt="" />
          : <span className="grid w-full h-full place-items-center rounded-full bg-brand-surface text-xs font-black text-brand-text">{initials}</span>}
      </button>
      {open && (
        <div role="menu" aria-label="Menu do usuário" className="absolute right-0 top-11 z-50 w-60 rounded-2xl border border-brand-border bg-brand-surface p-2 shadow-2xl">
          <div className="px-3 pb-2 pt-1 md:hidden">
            <p className="truncate text-sm font-bold text-brand-text">{name}</p>
            <p className="truncate text-[10px] uppercase tracking-wide text-brand-muted">{roleLabel}</p>
          </div>
          <Item icon={Settings} label="Meu Perfil" onClick={run(onProfile)} />
          {onOpenTour && <Item icon={Compass} label="Tour guiado" onClick={run(onOpenTour)} />}
          {onOpenNews && <Item icon={Sparkles} label="Novidades" onClick={run(onOpenNews)} />}
          <div className="my-1 border-t border-brand-border" />
          <Item icon={LogOut} label="Sair" danger onClick={run(onLogout)} />
        </div>
      )}
    </div>
  );
};

const Item: React.FC<{ icon: React.ElementType; label: string; onClick: () => void; danger?: boolean }> = ({ icon: Icon, label, onClick, danger }) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    className={`flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-accent ${
      danger ? 'text-red-500 hover:bg-red-500/10' : 'text-brand-text hover:bg-brand-surface-2'
    }`}
  >
    <Icon size={16} aria-hidden="true" /> {label}
  </button>
);
