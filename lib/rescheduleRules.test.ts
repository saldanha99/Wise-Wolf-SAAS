import { describe, expect, it } from 'vitest';
import { describeRescheduleEvent, hasSlot, isSoon, reasonRequired, slotStart } from './rescheduleRules';

describe('hasSlot / slotStart', () => {
  it('Pendente não é slot; data+hora válidas viram início no fuso da escola', () => {
    expect(hasSlot('Pendente', 'Pendente')).toBe(false);
    expect(hasSlot('2026-09-21', '20:00')).toBe(true);
    expect(slotStart('2026-09-21', '20:00')?.toISOString()).toBe('2026-09-21T23:00:00.000Z');
    expect(slotStart('21/09/2026', '20:00')).toBeNull();
  });
});

describe('isSoon — em cima da hora (< 3 h)', () => {
  const now = new Date('2026-09-18T15:00:00-03:00');
  it('reposição das 17:00 é em cima da hora às 15:00; a das 19:00 não', () => {
    expect(isSoon('2026-09-18', '17:00', now)).toBe(true);
    expect(isSoon('2026-09-18', '19:00', now)).toBe(false);
  });
  it('a que começou há menos de 3 h ainda conta; a de ontem não', () => {
    expect(isSoon('2026-09-18', '13:00', now)).toBe(true);
    expect(isSoon('2026-09-17', '13:00', now)).toBe(false);
    expect(isSoon('Pendente', 'Pendente', now)).toBe(false);
  });
});

describe('reasonRequired — igual ao servidor', () => {
  it('marcar uma Pendente não exige motivo; remarcar para outra data/hora exige', () => {
    expect(reasonRequired({ date: 'Pendente', time: 'Pendente' }, { date: '2026-09-21', time: '20:00' })).toBe(false);
    expect(reasonRequired({ date: '2026-09-18', time: '20:00' }, { date: '2026-09-21', time: '20:00' })).toBe(true);
    expect(reasonRequired({ date: '2026-09-18', time: '20:00' }, { date: '2026-09-18', time: '20:30' })).toBe(true);
  });
  it('salvar a mesma data/hora não é remarcação', () => {
    expect(reasonRequired({ date: '2026-09-18', time: '20:00:00' }, { date: '2026-09-18', time: '20:00' })).toBe(false);
  });
});

describe('describeRescheduleEvent', () => {
  const base = { id: 'e', reschedule_id: 'r', from_date: null, from_time: null, to_date: null, to_time: null, reason: null, em_cima_da_hora: false, created_at: '2026-09-18T15:00:00Z' };
  it('remarcada mostra de → para, origem, quem e motivo', () => {
    expect(describeRescheduleEvent({ ...base, action: 'remarcada', from_date: '2026-09-18', from_time: '20:00', to_date: '2026-09-21', to_time: '20:00', source: 'app', reason: 'aluna pediu', actor: { full_name: 'Bruna Barros Feitosa' } }))
      .toBe('remarcada 18/09/26 20:00 → 21/09/26 20:00 · pela plataforma · Bruna · motivo: aluna pediu');
  });
  it('marcada pelo aluno no WhatsApp e desmarcada em cima da hora', () => {
    expect(describeRescheduleEvent({ ...base, action: 'marcada', to_date: '2026-09-21', to_time: '08:00', source: 'whatsapp_aluno', reason: 'aluno escolheu o horário pelo WhatsApp' }))
      .toBe('marcada para 21/09/26 08:00 · pelo aluno no WhatsApp · motivo: aluno escolheu o horário pelo WhatsApp');
    expect(describeRescheduleEvent({ ...base, action: 'desmarcada', from_date: '2026-09-18', from_time: '20:00', source: 'app', em_cima_da_hora: true, reason: 'aluna cancelou' }))
      .toBe('desmarcada (era 18/09/26 20:00) ⚠️ em cima da hora · pela plataforma · motivo: aluna cancelou');
  });
  it('atestada pela direção', () => {
    expect(describeRescheduleEvent({ ...base, action: 'atestada', source: 'direcao', reason: 'Flávio doente' }))
      .toBe('atestada pela direção · pela direção · motivo: Flávio doente');
  });
});
