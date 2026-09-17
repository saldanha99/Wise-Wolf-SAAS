import { describe, expect, it } from 'vitest';
import { buildMenuItems } from './navModel';
import { searchTeacherSupportGuides, TEACHER_SUPPORT_GUIDES, whatsappLink } from './teacherSupportGuides';

describe('central de ajuda do professor', () => {
  it('toda ação de navegação aponta para uma tela do menu do professor', () => {
    const teacherTabs = new Set(
      buildMenuItems('TEACHER', { pendingLessonsCount: 0 }).map(item => item.id),
    );
    for (const guide of TEACHER_SUPPORT_GUIDES) {
      for (const action of guide.actions || []) {
        if (action.kind === 'navigate') {
          expect(teacherTabs.has(action.tab), `${guide.id} → ${action.tab}`).toBe(true);
        }
      }
    }
  });

  it('ids são únicos e todo guia tem passos', () => {
    const ids = TEACHER_SUPPORT_GUIDES.map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const guide of TEACHER_SUPPORT_GUIDES) expect(guide.steps.length).toBeGreaterThan(0);
  });

  it('a busca ignora acento e acha pela situação, não só pelo título', () => {
    expect(searchTeacherSupportGuides('nao vou dar aula').map(g => g.id)).toContain('ausencia');
    expect(searchTeacherSupportGuides('doente').map(g => g.id)).toContain('ausencia');
    expect(searchTeacherSupportGuides('QR').map(g => g.id)).toEqual(['smart']);
    expect(searchTeacherSupportGuides('pix').map(g => g.id)).toEqual(['pagamento']);
    expect(searchTeacherSupportGuides('').length).toBe(TEACHER_SUPPORT_GUIDES.length);
    expect(searchTeacherSupportGuides('xyzzy')).toEqual([]);
  });

  it('link do WhatsApp só com número completo e texto codificado', () => {
    expect(whatsappLink('5512996405414', 'Não vou conseguir dar aula hoje')).toBe(
      'https://wa.me/5512996405414?text=N%C3%A3o%20vou%20conseguir%20dar%20aula%20hoje',
    );
    expect(whatsappLink('(11) 97168-1451')).toBe('https://wa.me/5511971681451');
    expect(whatsappLink('123')).toBe(null);
    expect(whatsappLink('')).toBe(null);
  });
});
