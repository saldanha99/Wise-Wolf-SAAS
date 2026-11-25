import { describe, expect, it } from 'vitest';
import { EMPTY_HUB_CATALOG_FILTERS, filterHubCatalog } from './HubLibraryFilters';
import type { HubContentItem } from './types';

const item = (id: string, extra: Partial<HubContentItem>): HubContentItem => ({
  id, slug: id, title: id, description: null, content_type: 'PDF', level_tag: 'A1', niche: 'GENERAL',
  collection_name: null, collection_id: null, part_number: null, cover_url: null, preview_enabled: true,
  license_summary: 'x', author_name: null, metadata: {}, ...extra,
});

const items = [
  item('kids', { skills: ['vocabulary', 'speaking'], theme: 'infantil', age_group: 'kids', duration_minutes: 60 }),
  item('book', { skills: ['reading', 'vocabulary', 'speaking', 'writing', 'grammar'], theme: 'dia_a_dia', age_group: 'all', duration_minutes: 90 }),
  item('office', { skills: ['writing', 'speaking'], theme: 'trabalho', age_group: 'adults', duration_minutes: 60 }),
  item('trial', { skills: ['speaking'], theme: 'dia_a_dia', age_group: 'all', duration_minutes: 45 }),
  item('untagged', {}),
];

describe('filtros da biblioteca', () => {
  it('sem filtro mostra tudo, inclusive item sem tag', () => {
    expect(filterHubCatalog(items, EMPTY_HUB_CATALOG_FILTERS)).toHaveLength(5);
  });
  it('habilidade, tema e duração', () => {
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, skill: 'writing' }).map((i) => i.id)).toEqual(['book', 'office']);
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, theme: 'dia_a_dia' }).map((i) => i.id)).toEqual(['book', 'trial']);
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, duration: '45' }).map((i) => i.id)).toEqual(['trial']);
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, duration: '60' }).map((i) => i.id)).toEqual(['kids', 'office', 'trial']);
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, duration: '90' }).map((i) => i.id)).toEqual(['book']);
  });
  it('idade: "todas" serve para adolescente e adulto, não para criança', () => {
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, age: 'teens' }).map((i) => i.id)).toEqual(['book', 'trial']);
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, age: 'adults' }).map((i) => i.id)).toEqual(['book', 'office', 'trial']);
    expect(filterHubCatalog(items, { ...EMPTY_HUB_CATALOG_FILTERS, age: 'kids' }).map((i) => i.id)).toEqual(['kids']);
  });
});
