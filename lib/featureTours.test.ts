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

  it('tour do cartão do aluno não promete filtro que o servidor não faz e diz a régua inteira de menor', () => {
    // O servidor só limita tamanho (migration 20260926220000): assunto proibido
    // é aviso ao professor, não bloqueio. E responsável cadastrado conta como
    // menor (private.student_learning_card_minor_reason).
    const cardSteps = FEATURE_TOURS.flatMap(tour => tour.steps.map(step => ({ id: tour.id, text: step.text })))
      .filter(step => /cart[ãa]o/i.test(step.text) && /menor de idade/i.test(step.text));
    expect(cardSteps.length).toBeGreaterThan(0);
    for (const step of cardSteps) {
      expect(step.text, step.id).toMatch(/responsável cadastrado/);
      expect(step.text, step.id).not.toMatch(/nunca entram/i);
    }
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
    expect(latestFeatureTourFor('TEACHER')?.id).toBe('2026-09-30-google-e-contrato-do-professor');
    expect(latestFeatureTourFor('SCHOOL_ADMIN')?.id).toBe('2026-09-29-registro-autorizado-pela-escola');
    expect(latestFeatureTourFor('STUDENT')?.id).toBe('2026-09-27-minhas-aulas-registradas');
    expect(latestFeatureTourFor('SALESPERSON')).toBeUndefined();
  });

  it('o tour da lixeira dos originais sobe com a lixeira desligada: não a dá como ligada nem manda reconectar', () => {
    // A flag GOOGLE_MEET_DELETE_ORIGINALS_ENABLED nasce desligada; o tour é visto
    // uma vez só. Reconectar só muda algo com a flag ligada — isso é o cartão
    // que diz, pela configuração da instalação.
    const tour = FEATURE_TOURS.find(t => t.id === '2026-09-27-retencao-dos-originais');
    const text = (tour?.steps || []).map(step => step.text).join(' ');
    expect(text).toContain('Quando a lixeira automática está ligada');
    expect(text.toLowerCase()).not.toContain('reconect');
  });

  it('o tour do extrato de pontualidade sobe com o extrato desligado: só para a direção, e diz que depende do jurídico', () => {
    // O extrato nasce desligado por escola (20260928120000); o professor não vê
    // nada até ligar — um tour para ele seria pulado e marcado como visto.
    const tour = FEATURE_TOURS.find(t => t.id === '2026-09-28-tempo-na-sala');
    expect(tour?.roles).toEqual(['SCHOOL_ADMIN']);
    const text = (tour?.steps || []).map(step => step.text).join(' ');
    expect(text).toContain('liberação do jurídico');
    expect(text).toContain('sem ranking');
    expect(text).toContain('Atraso detectado pelo Meet');
    expect(text.toLowerCase()).not.toContain('já está ligado');
  });

  it('os tours do registro autorizado pela escola não pedem aceite e dizem como pedir para não registrar', () => {
    // Migration 20260929100000: a escola autoriza o registro; ninguém precisa
    // de link, código ou "Li e autorizo" — mas a conta Google continua exigida.
    const admin = FEATURE_TOURS.find(t => t.id === '2026-09-29-registro-autorizado-pela-escola');
    const teacher = FEATURE_TOURS.find(t => t.id === '2026-09-29-registro-autorizado-pela-escola-professor');
    expect(admin?.roles).toEqual(['SCHOOL_ADMIN']);
    expect(teacher?.roles).toEqual(['TEACHER']);
    const adminText = (admin?.steps || []).map(step => step.text).join(' ');
    const teacherText = (teacher?.steps || []).map(step => step.text).join(' ');
    expect(adminText).toContain('Registrar pedido para não registrar');
    expect(adminText).toContain('inclusive os menores de idade');
    expect(adminText).toContain('conta Google');
    expect(teacherText).toContain('Não quero que minhas aulas sejam registradas');
    expect(teacherText).toContain('conta Google');
    expect(teacherText).toContain('não precisa mais tocar em "Li e autorizo"');
  });

  it('cada escola vê os tours do seu modo de registro das aulas (termo x autorizado pela escola)', () => {
    // Migration 20260929100000. A Wise Wolf passou ao modo da escola com 6 dos 7
    // professores sem ter visto os tours do termo: sem o filtro, o próximo login
    // abriria "Leia o termo e responda aqui" num cartão que não tem mais aceite.
    const school = { recordingMode: 'SCHOOL_DEFAULT' as const };
    const individual = { recordingMode: 'INDIVIDUAL_CONSENT' as const };
    const unknown = { recordingMode: null };
    const termTours = FEATURE_TOURS.filter(t => t.recordingMode === 'INDIVIDUAL_CONSENT').map(t => t.id);
    const schoolTours = FEATURE_TOURS.filter(t => t.recordingMode === 'SCHOOL_DEFAULT').map(t => t.id);
    expect(termTours).toEqual(expect.arrayContaining([
      '2026-09-26-registro-das-aulas', '2026-09-26-registro-das-aulas-professor', '2026-09-26-termo-seguro',
      '2026-09-26-termo-seguro-envio', '2026-09-26-termo-seguro-professor', '2026-09-27-termo-v3',
      '2026-09-27-termo-v3-professor',
    ]));
    expect(schoolTours).toEqual(['2026-09-29-registro-autorizado-pela-escola', '2026-09-29-registro-autorizado-pela-escola-professor', '2026-09-30-conta-google-na-contratacao', '2026-09-30-google-e-contrato-do-professor']);

    for (const role of ['TEACHER', 'SCHOOL_ADMIN']) {
      const inSchool = pendingFeatureTours(role, [], school).map(t => t.id);
      const inIndividual = pendingFeatureTours(role, [], individual).map(t => t.id);
      const inUnknown = pendingFeatureTours(role, [], unknown).map(t => t.id);
      expect(inSchool.some(id => termTours.includes(id)), role).toBe(false);
      expect(inSchool.some(id => schoolTours.includes(id)), role).toBe(true);
      expect(inIndividual.some(id => schoolTours.includes(id)), role).toBe(false);
      expect(inIndividual.some(id => termTours.includes(id)), role).toBe(true);
      expect(inUnknown.some(id => termTours.includes(id) || schoolTours.includes(id)), role).toBe(false);
      // O que não depende do modo aparece nos três.
      expect(inUnknown.length).toBeGreaterThan(0);
      for (const id of inUnknown) expect(inSchool).toContain(id);
    }

    // O professor da Wise Wolf que só viu o primeiro tour do termo recebe, no
    // próximo login, o do modo da escola — não os do termo.
    const next = pendingFeatureTours('TEACHER', FEATURE_TOURS
      .filter(t => t.roles.includes('TEACHER') && !t.recordingMode && t.id < '2026-09-29')
      .map(t => t.id).concat('2026-09-26-registro-das-aulas-professor'), school)[0];
    expect(next?.id).toBe('2026-09-29-registro-autorizado-pela-escola-professor');

    // "Novidades" também segue o modo.
    expect(latestFeatureTourFor('TEACHER', school)?.id).toBe('2026-09-30-google-e-contrato-do-professor');
    expect(latestFeatureTourFor('TEACHER', individual)?.id).toBe('2026-09-28-sugestoes-do-cartao');
    expect(latestFeatureTourFor('SCHOOL_ADMIN', individual)?.id).toBe('2026-09-28-tempo-na-sala');
    expect(latestFeatureTourFor('SCHOOL_ADMIN', unknown)?.id).toBe('2026-09-28-tempo-na-sala');
  });

  it('tour que pede aceite, link ou envio do termo é só do aceite individual', () => {
    // Texto que só faz sentido com o termo por pessoa não pode abrir para quem
    // está no registro autorizado pela escola.
    const termOnly = /link do termo|Enviar termo|Leia o termo e responda|botão de autorizar|precisa aceitar o texto novo|ler e autorizar de novo/;
    for (const tour of FEATURE_TOURS) {
      const text = tour.steps.map(step => step.text).join(' ');
      if (termOnly.test(text)) expect(tour.recordingMode, tour.id).toBe('INDIVIDUAL_CONSENT');
    }
    const student = FEATURE_TOURS.find(t => t.id === '2026-09-27-minhas-aulas-registradas');
    expect(student?.recordingMode).toBeUndefined();
    expect(student?.steps.map(step => step.text).join(' ')).toContain('pedir para não ser registrado');
  });

  it('achatar põe todos os passos sob o capítulo "Novidade"', () => {
    const flat = flattenFeatureTour(FEATURE_TOURS[0]);
    expect(flat).toHaveLength(FEATURE_TOURS[0].steps.length);
    expect(new Set(flat.map(s => s.chapterTitle))).toEqual(new Set(['Novidade']));
  });
});
