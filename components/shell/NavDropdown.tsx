import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, GripVertical } from 'lucide-react';
import { DND_VIEW, badgeOf, type NavItem } from '../../lib/navModel';

export type FocusTarget = 'first' | 'last' | null;

/** Folga mínima entre o painel e a borda direita da viewport. */
const EDGE_GAP_PX = 8;

/**
 * Classes do gatilho de categoria (compartilhadas com o botão de seção única do
 * TopNav). Abaixo de 1280 px o padding e a fonte encolhem para as 7 categorias
 * do diretor caberem sem invadir o bloco da direita do header.
 */
export const NAV_TRIGGER_CLASS =
  'relative h-16 shrink-0 whitespace-nowrap px-2 xl:px-3 inline-flex items-center text-[13px] xl:text-sm font-bold transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-inset';

/** Selo de contagem usado no gatilho, no item do painel e no trilho. */
export const NavBadge: React.FC<{ value: number | string | undefined; className?: string }> = ({ value, className = '' }) => {
  const show = typeof value === 'number' ? value > 0 : Boolean(value);
  if (!show) return null;
  return (
    <span
      aria-hidden="true"
      className={`inline-flex min-h-[18px] min-w-[18px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none text-white shadow-[0_0_8px_rgba(239,68,68,0.5)] ${className}`}
    >
      {value}
    </span>
  );
};

interface NavDropdownProps {
  /** Rótulo do gatilho e do cabeçalho do painel (uma seção ou "Mais"). */
  section: string;
  items: NavItem[];
  currentView: string;
  pendingCounts: Record<string, number>;
  /** Soma dos badges dos itens — aparece no gatilho quando o painel está fechado. */
  badge: number;
  isOpen: boolean;
  /** Ao abrir por teclado, qual item recebe o foco. */
  focusTarget: FocusTarget;
  triggerRef: (el: HTMLButtonElement | null) => void;
  onHoverEnter: () => void;
  onHoverLeave: () => void;
  onTriggerClick: () => void;
  onOpenWithFocus: (target: Exclude<FocusTarget, null>) => void;
  /** Fecha o painel; `returnFocus` devolve o foco ao gatilho. */
  onClose: (returnFocus: boolean) => void;
  onSibling: (dir: -1 | 1, openWithFocus: boolean) => void;
  onSelect: (id: string) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

const slugOf = (s: string) => s.normalize('NFD').replace(/[^a-zA-Z]/g, '').toLowerCase();

export const NavDropdown: React.FC<NavDropdownProps> = ({
  section, items, currentView, pendingCounts, badge, isOpen, focusTarget, triggerRef,
  onHoverEnter, onHoverLeave, onTriggerClick, onOpenWithFocus, onClose, onSibling, onSelect,
  onDragStart, onDragEnd,
}) => {
  const slug = slugOf(section);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const ownTrigger = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [alignRight, setAlignRight] = useState(false);
  const hasActiveChild = items.some(it => it.id === currentView);
  const lit = isOpen || hasActiveChild;

  useEffect(() => {
    if (!isOpen || !focusTarget) return;
    const idx = focusTarget === 'first' ? 0 : items.length - 1;
    itemRefs.current[idx]?.focus();
  }, [isOpen, focusTarget, items.length]);

  // O painel abre alinhado à esquerda do gatilho; se isso o levaria para fora da
  // borda direita da viewport (gatilhos mais à direita, "Mais"), alinha à direita.
  useLayoutEffect(() => {
    if (!isOpen) return;
    const trigger = ownTrigger.current;
    const panelWidth = panelRef.current?.offsetWidth ?? 0;
    if (!trigger || !panelWidth) return;
    setAlignRight(trigger.getBoundingClientRect().left + panelWidth + EDGE_GAP_PX > window.innerWidth);
  }, [isOpen]);

  const handleTriggerKey = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'Enter': case ' ': case 'ArrowDown':
        e.preventDefault(); onOpenWithFocus('first'); break;
      case 'ArrowUp':
        e.preventDefault(); onOpenWithFocus('last'); break;
      case 'ArrowRight':
        e.preventDefault(); onSibling(1, false); break;
      case 'ArrowLeft':
        e.preventDefault(); onSibling(-1, false); break;
      case 'Escape':
        if (isOpen) { e.preventDefault(); onClose(true); }
        break;
    }
  };

  const focusItem = (idx: number) => {
    const n = items.length;
    itemRefs.current[((idx % n) + n) % n]?.focus();
  };

  const handleItemKey = (e: React.KeyboardEvent, idx: number) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusItem(idx + 1); break;
      case 'ArrowUp': e.preventDefault(); focusItem(idx - 1); break;
      case 'Home': e.preventDefault(); focusItem(0); break;
      case 'End': e.preventDefault(); focusItem(items.length - 1); break;
      case 'ArrowRight': e.preventDefault(); onSibling(1, true); break;
      case 'ArrowLeft': e.preventDefault(); onSibling(-1, true); break;
      case 'Escape': e.preventDefault(); onClose(true); break;
      // O painel vira `inert` ao fechar: se o foco continuasse no item, o navegador
      // o descartaria e o Tab recomeçaria do topo do documento. Devolver ao gatilho
      // faz o Tab seguir dali (e o Shift+Tab voltar) como em qualquer menubar.
      case 'Tab': onClose(true); break;
    }
  };

  return (
    <div className="relative" onPointerEnter={onHoverEnter} onPointerLeave={onHoverLeave}>
      <button
        ref={el => { ownTrigger.current = el; triggerRef(el); }}
        type="button"
        id={`nav-cat-${slug}`}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-controls={`nav-panel-${slug}`}
        aria-label={badge > 0 ? `${section}, ${badge} ${badge === 1 ? 'pendência' : 'pendências'}` : undefined}
        onClick={onTriggerClick}
        onKeyDown={handleTriggerKey}
        className={`${NAV_TRIGGER_CLASS} gap-1.5 ${
          lit ? 'text-brand-accent' : 'text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text'
        }`}
      >
        {section}
        <NavBadge value={badge} />
        <ChevronDown size={14} aria-hidden="true" className={`transition-transform duration-150 motion-reduce:transition-none ${isOpen ? 'rotate-180' : ''}`} />
        {lit && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-brand-accent" />}
      </button>

      <div
        ref={panelRef}
        id={`nav-panel-${slug}`}
        role="menu"
        aria-labelledby={`nav-cat-${slug}`}
        aria-hidden={!isOpen}
        inert={!isOpen}
        data-state={isOpen ? 'open' : 'closed'}
        className={`absolute ${alignRight ? 'right-0' : 'left-0'} top-16 z-50 min-w-[268px] rounded-2xl border border-brand-border bg-brand-surface p-2 shadow-2xl transition duration-150 ease-out motion-reduce:transition-none motion-reduce:transform-none data-[state=closed]:pointer-events-none data-[state=closed]:-translate-y-1 data-[state=closed]:opacity-0`}
      >
        <p className="px-3 pb-1.5 pt-1 text-[10px] font-black uppercase tracking-widest text-brand-muted">{section}</p>
        {items.map((item, idx) => {
          const active = item.id === currentView;
          const itemBadge = badgeOf(item, pendingCounts);
          return (
            <button
              key={item.id}
              ref={el => { itemRefs.current[idx] = el; }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData(DND_VIEW, item.id);
                e.dataTransfer.setData('text/plain', item.label);
                e.dataTransfer.effectAllowed = 'copy';
                onDragStart();
              }}
              onDragEnd={onDragEnd}
              onKeyDown={e => handleItemKey(e, idx)}
              onClick={() => onSelect(item.id)}
              title="Arraste para o trilho de atalhos"
              className={`group flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent focus-visible:ring-inset ${
                active ? 'bg-brand-accent text-white' : 'text-brand-text hover:bg-brand-surface-2'
              }`}
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${
                active ? 'bg-white/15 text-white' : 'bg-brand-surface-2 text-brand-muted group-hover:text-brand-accent'
              }`}>
                <item.icon size={17} aria-hidden="true" />
              </span>
              <span className="truncate">{item.label}</span>
              <NavBadge value={itemBadge} className="ml-auto" />
              <GripVertical size={14} aria-hidden="true" className={`shrink-0 opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none ${itemBadge ? '' : 'ml-auto'} ${active ? 'text-white/60' : 'text-brand-muted'}`} />
            </button>
          );
        })}
      </div>
    </div>
  );
};
