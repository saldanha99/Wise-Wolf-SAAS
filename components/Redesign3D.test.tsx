import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Banco de mentira: qualquer cadeia do supabase-js (.select().eq().in()…)
// devolve as linhas da tabela pedida.
const { tables, rpc } = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  rpc: vi.fn(async () => ({ data: [], error: null })),
}));
vi.mock('../lib/supabase', () => {
  const chain = (table: string): unknown => new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve({ data: tables[table] || [], error: null });
      return () => chain(table);
    },
  });
  return { supabase: { from: (table: string) => chain(table), rpc }, FUNCTIONS_URL: 'http://fixture' };
});

import TeacherScheduleExplorer from './TeacherScheduleExplorer';
import TeacherAvailabilityEditor from './TeacherAvailabilityEditor';
import AdminPaymentsList from './AdminPaymentsList';

afterEach(cleanup);

const teacher = {
  id: 't1', name: 'Bruna fixture', email: 'bruna@fixture.test', module: 'Inglês', tenantId: 'school',
  avatar: '', specializations: [], studentsCount: 1, tpi: 95,
} as never;

describe('Mapa de Aulas', () => {
  it('recolhe as horas vazias, mostra a carga e onde cabe aluno novo', async () => {
    tables.bookings = [
      { id: 'b1', teacher_id: 't1', day_of_week: 'Segunda', time_slot: '10:00:00', type: 'regular', module: 'A1', student: { id: 's1', full_name: 'Theo Fixture' } },
    ];
    tables.teacher_availability = ['08:00', '08:30', '09:00', '09:30', '10:00'].map(start_time => ({ teacher_id: 't1', day_of_week: 1, start_time }));
    tables.appointments = [];
    tables.profiles = [];

    render(<TeacherScheduleExplorer user={{ role: 'SCHOOL_ADMIN' }} teachers={[teacher]} />);

    // Sem aula nem horário livre antes das 08:00: o paredão escuro sumiu.
    expect(await screen.findAllByText('Theo Fixture')).not.toHaveLength(0);
    const grid = screen.getByRole('table');
    expect(within(grid).queryByText('06:00')).toBeNull();
    expect(within(grid).getByText('08:00')).toBeTruthy();
    // Quatro slots livres seguidos na segunda = 2 h.
    expect(screen.getByText('Seg 08:00–10:00')).toBeTruthy();
    expect(screen.getByText('2h seguidas')).toBeTruthy();
    // A lista lateral já sabe quem está ocupado sem abrir a agenda.
    expect(await screen.findByText('1 aulas · 4 livres')).toBeTruthy();

    // Mostrar tudo devolve as 37 linhas.
    fireEvent.click(screen.getByLabelText('Esconder horas sem agenda'));
    expect(within(screen.getByRole('table')).getByText('06:00')).toBeTruthy();
  });
});

describe('Horário à espera do termo', () => {
  const termSlots = async (name: string) => ({
    data: name === 'list_term_reserved_slots'
      ? [{ slot_id: 's1', teacher_id: 't1', student_label: 'Aluno Reservado', day_of_week: 1, class_time: '12:30', starts_on: '2026-11-04', waiting_school: true, waiting_teacher: false, waiting_family: false }]
      : [],
    error: null,
  });

  afterEach(() => { rpc.mockImplementation(async () => ({ data: [], error: null })); });

  const seed = () => {
    rpc.mockImplementation(termSlots as never);
    tables.bookings = [];
    tables.teacher_availability = ['12:30', '13:00'].map(start_time => ({ teacher_id: 't1', day_of_week: 1, start_time }));
    tables.appointments = [];
    tables.profiles = [];
  };

  it('no Mapa de Aulas aparece reservado, não livre', async () => {
    seed();
    render(<TeacherScheduleExplorer user={{ role: 'SCHOOL_ADMIN' }} teachers={[teacher]} />);
    const grid = await screen.findByRole('table');
    expect(await within(grid).findByText('Aluno Reservado')).toBeTruthy();
    expect(within(grid).getByText('Aguardando termo')).toBeTruthy();
    expect(within(grid).getAllByText('livre')).toHaveLength(1);
  });

  it('na agenda do professor aparece com o aluno e o selo de reservado', async () => {
    seed();
    render(<TeacherAvailabilityEditor teacherId="t1" tenantId="school" />);
    const grid = await screen.findByRole('table');
    // A célula da agenda mostra só o primeiro nome.
    expect(await within(grid).findByText('Aluno')).toBeTruthy();
    expect(within(grid).getByText('aguarda termo')).toBeTruthy();
    expect(within(grid).getByText('RES')).toBeTruthy();
    expect(within(grid).getByTitle(/Falta: assinatura da escola/)).toBeTruthy();
    expect(within(grid).getAllByText('livre')).toHaveLength(1);
  });
});

describe('Rolagem da agenda', () => {
  // Uma caixa de altura fixa ou uma rolagem interna deixam o retrato da semana preso
  // em cima, com duas linhas de grade numa tela de notebook. E overflow-x-auto faz
  // os dias da semana pararem de grudar no topo da página.
  const expectPageScroll = (table: HTMLElement, stage: Element) => {
    expect(stage.className).not.toMatch(/(^|\s|:)h-\[/);
    for (let el = table.parentElement; el && el !== stage.parentElement; el = el.parentElement) {
      expect(el.className, el.tagName).not.toMatch(/overflow-(auto|scroll|hidden|y-auto|x-auto)|(^|\s|:)h-\[calc/);
    }
    expect(table.querySelector('thead')!.className).toMatch(/top-\[65px\]/);
  };

  it('Mapa de Aulas rola com a página', async () => {
    tables.bookings = [];
    tables.teacher_availability = [{ teacher_id: 't1', day_of_week: 1, start_time: '08:00' }];
    tables.appointments = [];
    tables.profiles = [];
    const { container } = render(<TeacherScheduleExplorer user={{ role: 'SCHOOL_ADMIN' }} teachers={[teacher]} />);
    const table = await screen.findByRole('table');
    expectPageScroll(table, container.querySelector('[data-tour="director-schedule-change"]')!);
  });

  it('Minha agenda rola com a página', async () => {
    tables.bookings = [];
    tables.teacher_availability = [{ teacher_id: 't1', day_of_week: 1, start_time: '08:00' }];
    tables.appointments = [];
    tables.profiles = [];
    const { container } = render(<TeacherAvailabilityEditor teacherId="t1" tenantId="school" />);
    const table = await screen.findByRole('table');
    expectPageScroll(table, container.firstElementChild!);
  });
});

describe('Mensalidades', () => {
  it('soma o mês e filtra na tela sem esconder os números do topo', async () => {
    tables.student_payments = [
      { id: 'p1', status: 'RECEIVED', value: 198, due_date: '2026-11-05', payment_date: '2026-11-05', billing_type: 'PIX', profiles: { full_name: 'Ana Paga', email: 'ana@x.test' } },
      { id: 'p2', status: 'OVERDUE', value: 169, due_date: '2026-11-02', billing_type: 'BOLETO', profiles: { full_name: 'Bia Atrasada', email: 'bia@x.test' } },
      { id: 'p3', status: 'PENDING', value: 389, due_date: '2026-11-30', billing_type: 'CREDIT_CARD', profiles: null },
    ];
    render(<AdminPaymentsList tenantId="school" />);

    expect(await screen.findAllByText('Ana Paga')).not.toHaveLength(0);
    expect(screen.getAllByText('Sem aluno vinculado').length).toBeGreaterThan(0);
    expect(screen.getByText('26% de R$ 756,00 previstos')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Atrasados · 1' }));
    expect(screen.queryAllByText('Ana Paga')).toHaveLength(0);
    expect(screen.getAllByText('Bia Atrasada').length).toBeGreaterThan(0);
    // O topo continua sendo o mês inteiro.
    expect(screen.getByText('26% de R$ 756,00 previstos')).toBeTruthy();
  });
});
