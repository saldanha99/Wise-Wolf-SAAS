import React from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import type { HubContentItem } from './types';

// Filtros da biblioteca do Hub (Fase 2): habilidade, tema, idade e duração.
// As tags vêm do banco (regra + curadoria, migration 20261123110000). Item sem
// tag não some quando o filtro está em "Todos".

export interface HubCatalogFilters {
  skill: string;
  theme: string;
  age: string;
  duration: string;
}

export const EMPTY_HUB_CATALOG_FILTERS: HubCatalogFilters = { skill: '', theme: '', age: '', duration: '' };

export const SKILL_OPTIONS = [
  ['reading', 'Leitura'],
  ['vocabulary', 'Vocabulário'],
  ['speaking', 'Fala'],
  ['writing', 'Escrita'],
  ['grammar', 'Gramática'],
  ['listening', 'Compreensão oral'],
] as const;

export const THEME_OPTIONS = [
  ['dia_a_dia', 'Dia a dia'],
  ['trabalho', 'Trabalho'],
  ['tecnologia', 'Tecnologia'],
  ['viagem', 'Viagem'],
  ['saude', 'Saúde'],
  ['provas', 'Provas (TOEFL/IELTS)'],
  ['conversacao', 'Conversação'],
  ['sociedade', 'Sociedade e opinião'],
  ['infantil', 'Infantil'],
] as const;

export const AGE_OPTIONS = [
  ['kids', 'Crianças'],
  ['teens', 'Adolescentes'],
  ['adults', 'Adultos'],
] as const;

export const DURATION_OPTIONS = [
  ['45', 'Até 45 min'],
  ['60', 'Até 1 h'],
  ['90', '1 h 30 ou mais'],
] as const;

export function filterHubCatalog(items: HubContentItem[], filters: HubCatalogFilters): HubContentItem[] {
  return items.filter((item) => {
    if (filters.skill && !(item.skills ?? []).includes(filters.skill)) return false;
    if (filters.theme && item.theme !== filters.theme) return false;
    // "Todas as idades" serve para adolescente e adulto; criança só o infantil.
    if (filters.age && item.age_group !== filters.age && !(item.age_group === 'all' && filters.age !== 'kids')) return false;
    if (filters.duration) {
      const minutes = item.duration_minutes;
      if (minutes == null) return false;
      if (filters.duration === '90' ? minutes < 90 : minutes > Number(filters.duration)) return false;
    }
    return true;
  });
}

const selectClass = 'w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-xs font-bold text-brand-text outline-hidden';

const HubLibraryFilters: React.FC<{ value: HubCatalogFilters; onChange: (next: HubCatalogFilters) => void; total: number; shown: number }> = ({ value, onChange, total, shown }) => {
  const active = Object.values(value).some(Boolean);
  const set = (key: keyof HubCatalogFilters) => (event: React.ChangeEvent<HTMLSelectElement>) => onChange({ ...value, [key]: event.target.value });
  return (
    <section data-tour="hub-library-filters" aria-label="Filtros da biblioteca" className="rounded-3xl border border-brand-border bg-brand-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary"><SlidersHorizontal size={13} />Filtrar</p>
        <p className="text-xs font-bold text-brand-muted" aria-live="polite">{shown} de {total} materiais</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label><span className="sr-only">Habilidade</span>
          <select value={value.skill} onChange={set('skill')} className={selectClass}><option value="">Toda habilidade</option>{SKILL_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </label>
        <label><span className="sr-only">Tema</span>
          <select value={value.theme} onChange={set('theme')} className={selectClass}><option value="">Todo tema</option>{THEME_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </label>
        <label><span className="sr-only">Idade</span>
          <select value={value.age} onChange={set('age')} className={selectClass}><option value="">Toda idade</option>{AGE_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </label>
        <label><span className="sr-only">Duração</span>
          <select value={value.duration} onChange={set('duration')} className={selectClass}><option value="">Toda duração</option>{DURATION_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        </label>
      </div>
      {active && (
        <button type="button" onClick={() => onChange(EMPTY_HUB_CATALOG_FILTERS)} className="mt-2 inline-flex items-center gap-1 text-xs font-black text-brand-muted"><X size={13} />Limpar filtros</button>
      )}
      <p className="mt-2 text-[11px] text-brand-muted">Duração estimada de uso em aula.</p>
    </section>
  );
};

export default HubLibraryFilters;
