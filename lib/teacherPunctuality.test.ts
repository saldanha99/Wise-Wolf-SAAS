import { describe, expect, it } from 'vitest';
import {
  currentMonthInput,
  lessonLine,
  monthParam,
  notMeasuredItems,
  qualityCaseLabel,
  summaryItems,
  type PunctualityLesson,
  type PunctualitySummary,
} from './teacherPunctuality';

// Aula das 10:00 (BRT) = 13:00Z, 30 min.
const lesson = (overrides: Partial<PunctualityLesson> = {}): PunctualityLesson => ({
  class_date: '2026-09-24',
  scheduled_start_at: '2026-09-24T13:00:00Z',
  scheduled_minutes: 30,
  first_join_at: '2026-09-24T13:07:00Z',
  late_minutes: 7,
  minutes_in_room: 21,
  left_early_minutes: 2,
  status: 'FOUND',
  ...overrides,
});

const summary = (overrides: Partial<PunctualitySummary> = {}): PunctualitySummary => ({
  planned: 8, in_school_room: 7, measured: 3, on_time: 1, late_5: 2, late_10: 1, not_in_report: 0,
  joined_after_end: 0, minutes_in_room: 62, scheduled_minutes: 90, left_early: 1,
  not_measured: { NOT_FOUND: 2, UNPARSED: 1, NO_CONFERENCE: 1, NO_ROOM: 1 },
  ...overrides,
});

describe('extrato de pontualidade — linhas de aula', () => {
  it('aula medida: horário de entrada no fuso da escola, atraso e minutos na sala', () => {
    expect(lessonLine(lesson())).toEqual({
      when: '24/09 · 10:00 (30 min)',
      detail: 'Entrou às 10:07 (7 min de atraso) · 21 min na sala',
    });
    expect(lessonLine(lesson({ first_join_at: '2026-09-24T12:58:00Z', late_minutes: 0, left_early_minutes: 0 })).detail)
      .toBe('Entrou às 09:58 (no horário) · 21 min na sala');
    expect(lessonLine(lesson({ first_join_at: '2026-09-24T13:03:00Z', late_minutes: 3 })).detail)
      .toBe('Entrou às 10:03 (3 min depois do início) · 21 min na sala');
  });

  it('saída antecipada só aparece com 5 min ou mais', () => {
    expect(lessonLine(lesson({ left_early_minutes: 10 })).detail).toContain('saiu 10 min antes do fim');
    expect(lessonLine(lesson({ left_early_minutes: 4 })).detail).not.toContain('saiu');
  });

  it('professor fora da planilha e entrada depois do fim não viram atraso', () => {
    expect(lessonLine(lesson({ first_join_at: null, late_minutes: null, minutes_in_room: 0 })).detail)
      .toBe('Você não aparece no relatório de presença desta aula');
    expect(lessonLine(lesson({ first_join_at: null, late_minutes: null }), 'school').detail)
      .toBe('O professor não aparece no relatório de presença desta aula');
    expect(lessonLine(lesson({ first_join_at: '2026-09-24T14:00:00Z', late_minutes: null, left_early_minutes: null })).detail)
      .toBe('Entrou às 11:00, depois do fim previsto (aula remarcada no dia?) · 21 min na sala');
  });

  it('aula sem medição diz o motivo', () => {
    const empty = { first_join_at: null, late_minutes: null, minutes_in_room: null, left_early_minutes: null };
    expect(lessonLine(lesson({ ...empty, status: 'NOT_FOUND' })).detail).toBe('Relatório de presença não encontrado');
    expect(lessonLine(lesson({ ...empty, status: 'UNPARSED' })).detail).toBe('Relatório de presença ilegível');
    expect(lessonLine(lesson({ ...empty, status: 'NO_CONFERENCE' })).detail).toBe('A sala da escola não foi aberta');
    expect(lessonLine(lesson({ ...empty, status: 'NO_ROOM' })).detail).toBe('Aula sem sala da escola (link de sempre)');
  });
});

describe('extrato de pontualidade — resumo', () => {
  it('quadro sem nota nem média: contagens e minutos contra previstos', () => {
    const items = summaryItems(summary());
    expect(items.map(item => item.value)).toEqual(['8', '7', '3', '1', '2', '1', '62 / 90', '1']);
    const labels = items.map(item => item.label).join(' ').toLowerCase();
    expect(labels).not.toMatch(/nota|média|ranking|posição|%/);
  });

  it('sem medição com motivo; zero não aparece', () => {
    expect(notMeasuredItems(summary()).map(item => [item.status, item.count])).toEqual([
      ['NOT_FOUND', 2], ['UNPARSED', 1], ['NO_CONFERENCE', 1], ['NO_ROOM', 1],
    ]);
    expect(notMeasuredItems(summary({ not_measured: { NO_ROOM: 3 }, not_in_report: 1 })).map(item => item.status))
      .toEqual(['NO_ROOM', 'NOT_IN_REPORT']);
  });
});

describe('extrato de pontualidade — mês e rótulo do caso', () => {
  it('mês do seletor vira o primeiro dia; mês atual no fuso da escola', () => {
    expect(monthParam('2026-09')).toBe('2026-09-01');
    expect(monthParam('lixo')).toBeNull();
    // 01/10 00:30 UTC ainda é 30/09 em São Paulo.
    expect(currentMonthInput(new Date('2026-10-01T00:30:00Z'))).toBe('2026-09');
  });

  it('LATE_START do sistema é o atraso detectado pelo Meet; o da família continua relato', () => {
    const labels = { LATE_START: 'Atraso relatado', OTHER: 'Relato da família' };
    expect(qualityCaseLabel('LATE_START', 'SYSTEM', labels)).toBe('Atraso detectado pelo Meet');
    expect(qualityCaseLabel('LATE_START', 'FAMILY', labels)).toBe('Atraso relatado');
    expect(qualityCaseLabel('LATE_START', 'WHATSAPP', labels)).toBe('Atraso relatado');
    expect(qualityCaseLabel('OUTSIDE_ROOM', 'SYSTEM', labels)).toBe('OUTSIDE_ROOM');
  });
});
