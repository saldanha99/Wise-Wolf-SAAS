import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEATURE_TOURS, flattenFeatureTour, latestFeatureTourFor, pendingFeatureTours } from './featureTours';

/**
 * O tour de novidade nasce amarrado à tela: todo alvo (`target`) precisa
 * existir como `data-tour="..."` em algum componente. Sem isto, um passo
 * apontaria para nada e seria pulado em silêncio — o tutorial "subiu" e
 * ninguém veria.
 */
const ROOT = join(__dirname, '..');
const SOURCE_DIRS = ['components', 'App.tsx'];

function* tsxFiles(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) { if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) yield path; return; }
  for (const entry of readdirSync(path)) yield* tsxFiles(join(path, entry));
}

const targetsInSource = (): Set<string> => {
  const found = new Set<string>();
  for (const dir of SOURCE_DIRS) {
    for (const file of tsxFiles(join(ROOT, dir))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/data-tour="([^"$]+)"/g)) found.add(m[1]);
    }
  }
  return found;
};

describe('catálogo de tours de novidade', () => {
  it('a varredura enxerga os alvos do próprio menu (âncora do teste)', () => {
    const targets = targetsInSource();
    expect(targets.has('sidebar-nav')).toBe(true);
    expect(targets.has('shortcut-rail')).toBe(true);
  });

  it('todo alvo de todo passo existe como data-tour no código', () => {
    const targets = targetsInSource();
    for (const tour of FEATURE_TOURS) {
      for (const step of tour.steps) {
        if (step.target === null) continue;
        expect(targets.has(step.target), `${tour.id}: alvo "${step.target}" não existe em nenhum componente`).toBe(true);
      }
    }
  });

  it('ids são únicos, datados (AAAA-MM-DD-slug) e em ordem cronológica', () => {
    const ids = FEATURE_TOURS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(-[a-z0-9]+)*$/);
    expect([...ids].sort()).toEqual(ids);
  });

  it('todo tour tem papel, título e ao menos um passo com view', () => {
    for (const tour of FEATURE_TOURS) {
      expect(tour.roles.length, tour.id).toBeGreaterThan(0);
      expect(tour.title.trim(), tour.id).not.toBe('');
      expect(tour.steps.length, tour.id).toBeGreaterThan(0);
      for (const step of tour.steps) expect(step.view, `${tour.id}: passo sem view`).toBeTruthy();
    }
  });
});

describe('pendingFeatureTours / latestFeatureTourFor', () => {
  it('filtra por papel e pelo que já foi visto, mantendo a ordem', () => {
    const all = pendingFeatureTours('SCHOOL_ADMIN', []);
    expect(all.map(t => t.id)).toEqual(FEATURE_TOURS.filter(t => t.roles.includes('SCHOOL_ADMIN')).map(t => t.id));
    expect(pendingFeatureTours('SCHOOL_ADMIN', all.map(t => t.id))).toEqual([]);
    expect(pendingFeatureTours('STUDENT', [])).toEqual(FEATURE_TOURS.filter(t => t.roles.includes('STUDENT')));
  });

  it('"Novidades" reabre o tour mais recente do papel; papel sem novidade não tem entrada', () => {
    expect(latestFeatureTourFor('TEACHER')?.id).toBe('2026-09-26-registro-das-aulas-professor');
    expect(latestFeatureTourFor('SCHOOL_ADMIN')?.id).toBe('2026-09-26-registro-das-aulas');
    expect(latestFeatureTourFor('SALESPERSON')).toBeUndefined();
  });

  it('achatar põe todos os passos sob o capítulo "Novidade"', () => {
    const flat = flattenFeatureTour(FEATURE_TOURS[0]);
    expect(flat).toHaveLength(FEATURE_TOURS[0].steps.length);
    expect(new Set(flat.map(s => s.chapterTitle))).toEqual(new Set(['Novidade']));
  });
});
