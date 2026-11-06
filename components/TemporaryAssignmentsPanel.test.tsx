import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TemporaryAssignmentsPanel from './TemporaryAssignmentsPanel';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const OPTIONS = {
  students: [{ id: 'student', name: 'Aluno Teste', titular_id: 'titular', titular_name: 'Titular' }],
  teachers: [
    { id: 'origem', name: 'Professor Origem', lifecycle_status: 'suspended', can_assign: false },
    { id: 'assume', name: 'Professora Assume', lifecycle_status: 'active', can_assign: true },
  ],
};

const saturdays = ['2026-11-07', '2026-11-14'];
const PREVIEW = {
  occurrences: [
    ...saturdays.flatMap(date => ['10:30', '11:00'].map(time => ({ date, time, status: 'OK', detail: null }))),
    { date: '2026-11-21', time: '10:30', status: 'PROFESSOR_OCUPADO', detail: 'reposição de Ana' },
  ],
  generated: 4,
  owed: 22,
  limit: 22,
  pool: { distribuidas: 0, owed: 22, pendentes: 22, sem_professor: 22 },
  open_credits: 0,
  open_credits_teacher_fault: 0,
  term_pending: false,
  slots_text: 'sábado das 10:30 às 11:30',
};

const ASSIGNMENT = {
  id: 'a1',
  status: 'ACTIVE',
  student_id: 'student',
  student_name: 'Aluno Teste',
  original_teacher_name: 'Professor Origem',
  temporary_teacher_name: 'Professora Assume',
  slots_text: 'sábado das 10:30 às 11:30',
  starts_on: '2026-11-07',
  ends_on: '2026-12-31',
  lessons_owed: 22,
  reason: 'Motivo interno',
  created_by_name: 'Direção',
  ended_at: null,
  ended_by_name: null,
  end_reason: null,
  ended_automatically: false,
  participants_active: true,
  counts: { total: 16, agendadas: 14, a_lancar: 1, sem_data: 0, realizadas: 1, aluno_faltou: 0, professor_faltou: 0, canceladas: 0 },
  pool: { total: 16, agendadas: 14, a_lancar: 1, sem_data: 0, realizadas: 1, aluno_faltou: 0, professor_faltou: 0, canceladas: 0, owed: 22, distribuidas: 16, pendentes: 21, sem_professor: 6 },
  occurrences: [{ id: 'r1', date: '2026-11-07', time: '10:30', state: 'realizada' }],
};

const mockRpc = (overrides: Record<string, { data?: unknown; error?: { message: string } }> = {}) => {
  rpc.mockImplementation(async (name: string) => {
    if (overrides[name]) return { data: null, error: null, ...overrides[name] };
    if (name === 'temporary_assignment_options') return { data: OPTIONS, error: null };
    if (name === 'list_temporary_assignments') return { data: [], error: null };
    if (name === 'preview_temporary_assignment') return { data: PREVIEW, error: null };
    if (name === 'create_temporary_assignment') return { data: { generated: 4, absorbed_credits: 0 }, error: null };
    if (name === 'end_temporary_assignment') return { data: { closed: 14 }, error: null };
    return { data: null, error: null };
  });
};

const fillForm = async () => {
  fireEvent.change(await screen.findByLabelText('Aluno'), { target: { value: 'student' } });
  fireEvent.change(screen.getByLabelText('Professor original'), { target: { value: 'origem' } });
  fireEvent.change(screen.getByLabelText('Professor temporário'), { target: { value: 'assume' } });
  fireEvent.change(screen.getByLabelText('Início do período'), { target: { value: '2026-11-07' } });
  fireEvent.change(screen.getByLabelText('Fim do período'), { target: { value: '2026-12-31' } });
};

const callOf = (name: string) => rpc.mock.calls.find(call => call[0] === name)?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  mockRpc();
});

describe('atribuição temporária', () => {
  it('quem está inativo pode ser a origem, mas não assume aula', async () => {
    render(<TemporaryAssignmentsPanel />);
    await screen.findByLabelText('Aluno');
    await waitFor(() => expect(screen.getByLabelText('Professor original').textContent).toContain('Professor Origem (inativo)'));
    expect(screen.getByLabelText('Professor temporário').textContent).not.toContain('Professor Origem');
  });

  it('mostra o plano do servidor antes de gravar e só grava depois de confirmar', async () => {
    render(<TemporaryAssignmentsPanel />);
    await fillForm();
    fireEvent.change(screen.getByLabelText('Total de aulas pendentes'), { target: { value: '22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ver as aulas' }));

    await screen.findByText('Professor ocupado: reposição de Ana');
    expect(callOf('preview_temporary_assignment')).toMatchObject({
      p_student_id: 'student', p_original_teacher_id: 'origem', p_temporary_teacher_id: 'assume',
      p_lessons_owed: 22, p_slots: [{ day_of_week: 6, start: '10:30', end: '11:30' }],
    });
    expect(callOf('create_temporary_assignment')).toBeUndefined();

    // Sem motivo não grava.
    fireEvent.click(screen.getByRole('button', { name: 'Gerar 4 aulas na agenda' }));
    await screen.findByRole('alert');
    expect(callOf('create_temporary_assignment')).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'Aulas deixadas pelo professor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Gerar 4 aulas na agenda' }));
    await screen.findByText(/4 aulas na agenda/);
    const payload = callOf('create_temporary_assignment');
    expect(payload).toMatchObject({ p_reason: 'Aulas deixadas pelo professor', p_lessons_owed: 22, p_notify: true });
    expect(payload.p_request_id).toEqual(expect.any(String));
  });

  it('mudar um campo depois da prévia exige ver as aulas de novo', async () => {
    render(<TemporaryAssignmentsPanel />);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Ver as aulas' }));
    await screen.findByRole('button', { name: 'Gerar 4 aulas na agenda' });
    // O saldo sugerido pelo servidor preenche o campo sem derrubar a prévia.
    expect(screen.getByLabelText('Total de aulas pendentes')).toHaveValue(22);

    fireEvent.change(screen.getByLabelText('Fim do período'), { target: { value: '2026-11-30' } });
    expect(screen.queryByRole('button', { name: 'Gerar 4 aulas na agenda' })).not.toBeInTheDocument();
  });

  it('não chama o servidor com horário inválido', async () => {
    render(<TemporaryAssignmentsPanel />);
    await fillForm();
    fireEvent.change(screen.getByLabelText('Fim do horário 1'), { target: { value: '09:00' } });
    await screen.findByText(/depois do início/);
    expect(screen.getByRole('button', { name: 'Ver as aulas' })).toBeDisabled();
  });

  it('avisa quando falta o termo individual e traduz a recusa do servidor', async () => {
    mockRpc({ preview_temporary_assignment: { data: { ...PREVIEW, term_pending: true } } });
    render(<TemporaryAssignmentsPanel />);
    await fillForm();
    fireEvent.click(screen.getByRole('button', { name: 'Ver as aulas' }));
    await screen.findByText(/Falta o termo individual/);

    mockRpc({ preview_temporary_assignment: { error: { message: 'saldo_ja_distribuido' } } });
    fireEvent.change(screen.getByLabelText('Total de aulas pendentes'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ver as aulas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Todo o saldo já foi distribuído/);
  });

  it('mostra realizadas, pendentes e sem professor, e encerra com motivo', async () => {
    mockRpc({ list_temporary_assignments: { data: [ASSIGNMENT] } });
    render(<TemporaryAssignmentsPanel />);
    await screen.findByText(/21 de 22 ainda pendentes, 6 sem professor definido/);

    fireEvent.click(screen.getByRole('button', { name: 'Encerrar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar atribuição' }));
    await screen.findByRole('alert');
    expect(callOf('end_temporary_assignment')).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Motivo do encerramento'), { target: { value: 'Direção redistribuiu' } });
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar atribuição' }));
    await screen.findByText(/14 aulas futuras saíram da agenda/);
    expect(callOf('end_temporary_assignment')).toMatchObject({ p_id: 'a1', p_reason: 'Direção redistribuiu' });
  });

  it('na ficha do aluno, o aluno já vem escolhido e a lista é só dele', async () => {
    render(<TemporaryAssignmentsPanel lockedStudentId="student" />);
    await screen.findByLabelText('Professor original');
    expect(screen.queryByLabelText('Aluno')).not.toBeInTheDocument();
    expect(callOf('list_temporary_assignments')).toEqual({ p_student_id: 'student' });
  });
});
