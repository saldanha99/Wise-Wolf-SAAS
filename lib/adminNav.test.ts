import { describe, it, expect } from 'vitest';
import { ADMIN_NAV, ALL_ADMIN_TAB_IDS, groupForTab } from './adminNav';

/**
 * Trava do menu do diretor.
 *
 * O bug que originou a reorganização: o cabeçalho de seção é decidido comparando
 * com o item ANTERIOR, então uma entrada fora de ordem faz a mesma seção aparecer
 * duas vezes na tela. Aconteceu com Financeiro/Aulas/Financeiro. É um erro de
 * ORDEM dos dados, invisível em typecheck e fácil de reintroduzir ao adicionar
 * uma tela no fim da lista — daí o teste.
 */

/** Telas anteriores, exceto a duplicata avançada consolidada na central. */
const TELAS_ANTERIORES = [
  'dashboard', 'wolfie-lab', 'students', 'student-insights', 'teachers', 'teacher-insights',
  'approvals', 'recruiting', 'hr', 'schedule_explorer', 'attendance-disputes', 'trials',
  'trial-settlement', 'coverage', 'pedagogical', 'material-approvals', 'learning_paths_builder',
  'class_skills', 'training', 'oral-tests', 'payments', 'student-payments', 'cashflow', 'dre',
  'balancete', 'margin', 'ai-costs', 'verify-rooms', 'financial', 'crm', 'marketing',
  'referral-admin', 'vendors-mgmt', 'contracts', 'settings_school', 'automation', 'automations',
  'admin_workflows', 'whatsapp',
];

describe('navegação do diretor', () => {
  it('não repete seção: cada seção aparece num bloco contíguo', () => {
    const vistas = new Set<string>();
    let anterior = '';
    for (const g of ADMIN_NAV) {
      if (g.section !== anterior) {
        expect(vistas.has(g.section), `seção "${g.section}" reaparece depois de "${anterior}"`).toBe(false);
        vistas.add(g.section);
        anterior = g.section;
      }
    }
  });

  it('toda entrada tem seção', () => {
    for (const g of ADMIN_NAV) {
      expect(g.section, `"${g.label}" está sem seção`).toBeTruthy();
    }
  });

  it('nenhuma tela anterior foi perdida', () => {
    const perdidas = TELAS_ANTERIORES.filter(id => !ALL_ADMIN_TAB_IDS.includes(id));
    expect(perdidas, `telas fora do menu: ${perdidas.join(', ')}`).toEqual([]);
  });

  it('todo id navegável resolve para um grupo (senão o menu não destaca nada)', () => {
    for (const id of ALL_ADMIN_TAB_IDS) {
      expect(groupForTab(id), `id "${id}" não pertence a grupo nenhum`).toBeDefined();
    }
  });

  it('a primeira aba de um grupo é o id do próprio grupo', () => {
    // Clicar no menu abre `g.id`; se ele não fosse a primeira aba, a tela abriria
    // com a aba errada em destaque.
    for (const g of ADMIN_NAV) {
      if (g.tabs.length > 0) {
        expect(g.tabs[0].id, `grupo "${g.label}" abre em aba que não é a primeira`).toBe(g.id);
      }
    }
  });

  it('não há id duplicado entre grupos', () => {
    const todos = ADMIN_NAV.flatMap(g => [g.id, ...g.tabs.map(t => t.id)]);
    const dup = todos.filter((id, i) => todos.indexOf(id) !== i && !ADMIN_NAV.some(g => g.id === id && g.tabs[0]?.id === id));
    expect(dup, `ids repetidos: ${dup.join(', ')}`).toEqual([]);
  });

  it('o menu cabe na cabeça: no máximo 20 entradas', () => {
    expect(ADMIN_NAV.length).toBeLessThanOrEqual(20);
  });

  it('a barra do celular tem entre 3 e 5 itens', () => {
    const primary = ADMIN_NAV.filter(g => g.primary);
    expect(primary.length).toBeGreaterThanOrEqual(3);
    expect(primary.length).toBeLessThanOrEqual(5);
  });

  it('agrupa conversas, conexão e disparos sem lotar a barra móvel', () => {
    const whatsapp = groupForTab('whatsapp');
    expect(whatsapp?.section).toBe('Comunicação');
    expect(whatsapp?.primary).not.toBe(true);
    expect(whatsapp?.tabs.map(tab => tab.id)).toEqual(['whatsapp', 'automation', 'automations']);
    expect(groupForTab('automation')?.id).toBe('whatsapp');
  });
});
