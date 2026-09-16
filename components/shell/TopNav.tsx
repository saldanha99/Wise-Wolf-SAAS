import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NAV_TRIGGER_CLASS, NavBadge, NavDropdown, type FocusTarget } from './NavDropdown';
import { badgeOf, groupBadge, groupBySection, type NavItem } from '../../lib/navModel';

const OPEN_DELAY_MS = 120;
const CLOSE_GRACE_MS = 180;
/** Rótulo/chave do dropdown que agrupa as categorias que não couberam na barra. */
const MORE_SECTION = 'Mais';
/** Largura estimada do gatilho "Mais" antes da primeira medição. */
const MORE_FALLBACK_PX = 84;
/** gap-1 do <nav>, somado à largura de cada gatilho. */
const NAV_GAP_PX = 4;

/** Uma posição da barra: uma seção do menu ou o dropdown "Mais". */
interface NavSlot { key: string; section: string; items: NavItem[] }

interface TopNavProps {
  items: NavItem[];
  /** Id do item aceso (para o diretor já é o GRUPO da sub-aba, via activeMenuIdFor). */
  currentView: string;
  onChangeView: (view: string) => void;
  pendingCounts: Record<string, number>;
  className?: string;
}

/**
 * Barra de categorias do layout de topo (o menu do MotoFix). Renderiza só o
 * <nav>: quem o hospeda é o header que o App já tem, no lugar do título da
 * página — o bloco da direita (busca, sino, tema, avatar) continua o mesmo.
 *
 * Priority+: mede cada gatilho e manda para "Mais" as categorias que não cabem.
 */
export const TopNav: React.FC<TopNavProps> = ({ items, currentView, onChangeView, pendingCounts, className = '' }) => {
  const groups = groupBySection(items);

  const [openSection, setOpenSection] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);
  // Quantas categorias ficam na barra; as demais vão para o dropdown "Mais".
  const [visibleCount, setVisibleCount] = useState(groups.length);
  const navRef = useRef<HTMLElement>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const triggerWidths = useRef<Record<string, number>>({});
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const shown = groups.slice(0, visibleCount);
  const overflowItems = groups.slice(visibleCount).flatMap(g => g.items);
  const slots: NavSlot[] = [
    ...shown.map(g => ({ key: g.section, section: g.section, items: g.items })),
    ...(overflowItems.length ? [{ key: MORE_SECTION, section: MORE_SECTION, items: overflowItems }] : []),
  ];
  const groupKey = groups.map(g => `${g.section}:${g.items.length}`).join('|');

  // Mede os gatilhos renderizados, guarda a largura natural de cada categoria e
  // decide quantas cabem no <nav>. Roda antes da pintura (sem piscar) e de novo a
  // cada mudança de largura da barra.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const fit = () => {
      const widths = triggerWidths.current;
      groups.forEach((g, i) => {
        const el = i < visibleCount ? triggerRefs.current[i] : null;
        if (el) widths[g.section] = el.offsetWidth + NAV_GAP_PX;
      });
      const moreEl = overflowItems.length ? triggerRefs.current[visibleCount] : null;
      if (moreEl) widths[MORE_SECTION] = moreEl.offsetWidth + NAV_GAP_PX;
      // Categoria nunca medida: mostra tudo para medir.
      if (groups.some(g => widths[g.section] === undefined)) {
        if (visibleCount !== groups.length) setVisibleCount(groups.length);
        return;
      }
      const avail = nav.clientWidth;
      // jsdom e nav ainda sem layout devolvem 0 — aí não há o que caber.
      if (avail <= 0) return;
      const total = groups.reduce((sum, g) => sum + widths[g.section], 0);
      let next = groups.length;
      if (total > avail) {
        let used = widths[MORE_SECTION] ?? MORE_FALLBACK_PX;
        next = 0;
        for (const g of groups) {
          if (used + widths[g.section] > avail) break;
          used += widths[g.section];
          next += 1;
        }
      }
      if (next !== visibleCount) setVisibleCount(next);
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(fit);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [groupKey, visibleCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const clearTimers = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };

  const close = (returnFocusTo?: number) => {
    clearTimers();
    setOpenSection(null);
    setPinned(false);
    setFocusTarget(null);
    if (returnFocusTo !== undefined) triggerRefs.current[returnFocusTo]?.focus();
  };

  const openNow = (section: string, opts: { pin?: boolean; focus?: FocusTarget } = {}) => {
    clearTimers();
    setOpenSection(section);
    setPinned(!!opts.pin);
    setFocusTarget(opts.focus ?? null);
  };

  // Menubar: com algo aberto a troca é imediata; do zero, 120 ms de intenção.
  const hoverEnter = (section: string) => {
    clearTimers();
    if (openSection === section) return;
    if (openSection) { setOpenSection(section); setFocusTarget(null); return; }
    openTimer.current = window.setTimeout(() => setOpenSection(section), OPEN_DELAY_MS);
  };

  const hoverLeave = () => {
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (pinned || !openSection) return;
    closeTimer.current = window.setTimeout(() => close(), CLOSE_GRACE_MS);
  };

  const triggerClick = (section: string) => {
    if (openSection !== section) { openNow(section, { pin: true }); return; }
    if (pinned) close(); else { clearTimers(); setPinned(true); }
  };

  const sibling = (idx: number, dir: -1 | 1, openWithFocus: boolean) => {
    const n = slots.length;
    const next = (idx + dir + n) % n;
    const section = slots[next].section;
    if (openWithFocus && slots[next].items.length > 1) openNow(section, { pin: true, focus: 'first' });
    else { close(); triggerRefs.current[next]?.focus(); }
  };

  const select = (id: string) => { close(); onChangeView(id); };

  useEffect(() => { close(); }, [currentView]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!openSection) return;
    const onDoc = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [openSection]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => clearTimers, []);

  return (
    // min-w-0: sem isso o flex-1 herda min-width:auto e as categorias empurram o
    // bloco da direita para fora da viewport em vez de irem para o "Mais".
    <nav
      ref={navRef}
      aria-label="Navegação principal"
      data-tour="sidebar-nav"
      className={`flex min-w-0 flex-1 items-center gap-1 ${className}`}
      onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close(); }}
    >
      {slots.map((slot, idx) => {
        if (slot.items.length === 1) {
          const only = slot.items[0];
          const active = only.id === currentView;
          const badge = badgeOf(only, pendingCounts);
          return (
            <button
              key={slot.key}
              ref={el => { triggerRefs.current[idx] = el; }}
              type="button"
              onClick={() => select(only.id)}
              aria-current={active ? 'page' : undefined}
              onKeyDown={e => {
                if (e.key === 'ArrowRight') { e.preventDefault(); sibling(idx, 1, false); }
                if (e.key === 'ArrowLeft') { e.preventDefault(); sibling(idx, -1, false); }
              }}
              className={`${NAV_TRIGGER_CLASS} gap-1.5 ${
                active ? 'text-brand-accent' : 'text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text'
              }`}
            >
              {only.label}
              <NavBadge value={badge} />
              {active && <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 rounded-t bg-brand-accent" />}
            </button>
          );
        }
        return (
          <NavDropdown
            key={slot.key}
            section={slot.section}
            items={slot.items}
            currentView={currentView}
            pendingCounts={pendingCounts}
            badge={groupBadge(slot.items, pendingCounts)}
            isOpen={openSection === slot.section}
            focusTarget={openSection === slot.section ? focusTarget : null}
            triggerRef={el => { triggerRefs.current[idx] = el; }}
            onHoverEnter={() => hoverEnter(slot.section)}
            onHoverLeave={hoverLeave}
            onTriggerClick={() => triggerClick(slot.section)}
            onOpenWithFocus={target => openNow(slot.section, { pin: true, focus: target })}
            onClose={returnFocus => close(returnFocus ? idx : undefined)}
            onSibling={(dir, withFocus) => sibling(idx, dir, withFocus)}
            onSelect={select}
            onDragStart={() => { clearTimers(); setPinned(true); }}
            onDragEnd={() => close()}
          />
        );
      })}
    </nav>
  );
};
