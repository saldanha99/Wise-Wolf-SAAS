import React, { useEffect, useRef, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { DND_INDEX, DND_VIEW, badgeOf, groupBySection, shortLabel, type NavItem } from '../../lib/navModel';
import { MAX_SHORTCUTS } from '../../lib/shortcuts';
import { NavBadge } from './NavDropdown';
import { useShortcuts } from './useShortcuts';

const MIN_SILHOUETTES = 3;

interface ShortcutRailProps {
  userId: string;
  role: string;
  items: NavItem[];
  currentView: string;
  onChangeView: (view: string) => void;
  pendingCounts: Record<string, number>;
}

/**
 * Trilho de atalhos do layout de topo (64 px à esquerda, copiado do MotoFix).
 * Recebe item arrastado do menu do topo, reordena arrastando o próprio ladrilho,
 * remove pelo "×" (ou Delete/Backspace com foco) e escolhe pelo "+".
 * É irmão do <main> na linha flex do App — sem offset por variável CSS.
 */
export const ShortcutRail: React.FC<ShortcutRailProps> = ({ userId, role, items, currentView, onChangeView, pendingCounts }) => {
  const { shortcuts, isFull, add, move, remove, toggle } = useShortcuts(userId, role, items);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const isOver = insertAt !== null;
  const shortcutIds = new Set(shortcuts.map(it => it.id));

  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [pickerOpen]);

  const computeInsertAt = (clientY: number) => {
    const idx = tileRefs.current.slice(0, shortcuts.length).findIndex(el => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return clientY < r.top + r.height / 2;
    });
    return idx === -1 ? shortcuts.length : idx;
  };

  const handleDragOver = (e: React.DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes(DND_VIEW)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = types.includes(DND_INDEX) ? 'move' : 'copy';
    const at = computeInsertAt(e.clientY);
    if (at !== insertAt) setInsertAt(at);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const at = computeInsertAt(e.clientY);
    setInsertAt(null);
    const fromIdx = e.dataTransfer.getData(DND_INDEX);
    if (fromIdx !== '') { move(Number(fromIdx), at); return; }
    add(e.dataTransfer.getData(DND_VIEW), at);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setInsertAt(null);
  };

  const silhouettes = Math.max(0, MIN_SILHOUETTES - shortcuts.length);

  return (
    <aside
      aria-label="Atalhos"
      data-tour="shortcut-rail"
      className={`hidden lg:flex h-full w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden border-r border-brand-border bg-brand-surface py-3 [scrollbar-width:none] ${
        isOver ? 'ring-2 ring-inset ring-brand-accent' : ''
      }`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onDragLeave={handleDragLeave}
    >
      {shortcuts.map((item, index) => {
        const active = item.id === currentView;
        const badge = badgeOf(item, pendingCounts);
        return (
          <React.Fragment key={item.id}>
            {isOver && insertAt === index && <InsertMark />}
            {/* O "×" é irmão do ladrilho, não filho: controle dentro de <button> é
                inválido e o leitor de tela juntaria os dois nomes. */}
            <div className="group relative w-14 shrink-0">
              <button
                ref={el => { tileRefs.current[index] = el; }}
                type="button"
                draggable
                onDragStart={e => {
                  e.dataTransfer.setData(DND_INDEX, String(index));
                  e.dataTransfer.setData(DND_VIEW, item.id);
                  e.dataTransfer.setData('text/plain', item.label);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => onChangeView(item.id)}
                onKeyDown={e => {
                  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(item.id); }
                }}
                title={item.label}
                aria-label={typeof badge === 'number' && badge > 0 ? `${item.label}, ${badge} ${badge === 1 ? 'pendência' : 'pendências'}` : item.label}
                aria-current={active ? 'page' : undefined}
                className="flex w-14 flex-col items-center gap-1 rounded-xl py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent"
              >
                <span className={`relative grid h-12 w-12 place-items-center rounded-xl border transition-colors motion-reduce:transition-none ${
                  active
                    ? 'border-brand-accent bg-brand-accent text-white shadow-md'
                    : 'border-brand-border bg-brand-surface-2 text-brand-muted group-hover:border-brand-accent group-hover:text-brand-accent'
                }`}>
                  <item.icon size={22} aria-hidden="true" />
                  <NavBadge value={badge} className="absolute -right-1.5 -top-1.5" />
                </span>
                {/* Rótulo nunca sai dos 64 px do trilho: quebra em até 2 linhas e corta o excesso. */}
                <span className={`w-full max-w-full break-words px-0.5 text-center text-[10px] font-bold leading-[1.1] line-clamp-2 ${active ? 'text-brand-accent' : 'text-brand-muted'}`}>
                  {shortLabel(item)}
                </span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Remover atalho ${item.label}`}
                onClick={() => remove(item.id)}
                className="absolute -left-0.5 -top-0.5 grid h-5 w-5 place-items-center rounded-full border border-brand-border bg-brand-surface text-brand-muted opacity-0 shadow-sm transition-opacity hover:text-red-500 group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          </React.Fragment>
        );
      })}
      {isOver && insertAt === shortcuts.length && <InsertMark />}

      {Array.from({ length: silhouettes }, (_, i) => (
        <span key={`s${i}`} aria-hidden="true" className="my-1 h-12 w-12 shrink-0 rounded-xl border-2 border-dashed border-brand-border" />
      ))}
      {shortcuts.length === 0 && (
        <p className="px-1 text-center text-[10px] font-bold leading-tight text-brand-muted">Arraste itens do menu para cá</p>
      )}

      <div ref={pickerRef} className="relative mt-1 shrink-0">
        <button
          type="button"
          onClick={() => setPickerOpen(o => !o)}
          aria-expanded={pickerOpen}
          aria-haspopup="true"
          aria-label="Escolher atalhos"
          title="Escolher atalhos"
          className="grid h-12 w-12 place-items-center rounded-xl border-2 border-dashed border-brand-border text-brand-muted hover:border-brand-accent hover:text-brand-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-accent"
        >
          <Plus size={20} aria-hidden="true" />
        </button>
        {pickerOpen && (
          <div
            role="group"
            aria-label="Atalhos do trilho"
            className="fixed left-[4.5rem] top-16 z-50 max-h-[calc(100vh-5rem)] w-64 overflow-y-auto rounded-2xl border border-brand-border bg-brand-surface p-2 shadow-2xl"
          >
            <p className="px-3 pb-1 pt-1 text-xs font-black text-brand-text">Atalhos do trilho</p>
            {isFull && <p className="px-3 pb-1 text-[11px] text-amber-600">Limite de {MAX_SHORTCUTS} atalhos atingido.</p>}
            {groupBySection(items).map(g => (
              <div key={g.section}>
                <p className="px-3 pb-1 pt-2 text-[10px] font-black uppercase tracking-widest text-brand-muted">{g.section}</p>
                {g.items.map(item => {
                  const checked = shortcutIds.has(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      disabled={!checked && isFull}
                      onClick={() => toggle(item.id)}
                      className="flex h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-bold text-brand-text hover:bg-brand-surface-2 disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-accent"
                    >
                      <item.icon size={17} aria-hidden="true" className="shrink-0 text-brand-muted" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {checked && <Check size={16} aria-hidden="true" className="shrink-0 text-brand-accent" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
};

const InsertMark = () => <span aria-hidden="true" className="h-0.5 w-10 shrink-0 rounded-full bg-brand-accent" />;
