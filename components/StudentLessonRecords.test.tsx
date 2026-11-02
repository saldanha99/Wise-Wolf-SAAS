import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StudentLessonRecords from './StudentLessonRecords';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const response = {
  ok: true,
  school_name: 'Escola Fixture',
  school_whatsapp: '11988887777',
  consent: {
    status: 'AUTHORIZED', decided_at: '2026-09-20T15:00:00Z', signer_relation: 'GUARDIAN',
    requires_guardian: true, guardian_reason: 'AGE_UNKNOWN', link_expires_at: '2026-10-05T12:00:00Z',
  },
  term: { version: 'v2', body: 'Texto do termo vigente.' },
  pending_review: 1,
  records: [
    {
      session_id: 's1', class_date: '2026-09-23', scheduled_start_at: '2026-09-23T17:00:00Z',
      teacher_name: 'Teacher Lais', approved_at: '2026-09-23T19:00:00Z',
      lesson_objective: 'Pedir comida no restaurante', content_practiced: ['would like', 'menu vocabulary'],
      recommended_next_step: 'Praticar reclamação educada', homework_assigned: 'Gravar um áudio',
      transcript_until: '2026-12-12T17:30:00Z', notes_until: null, attendance_until: '2026-12-22T17:30:00Z',
    },
    {
      session_id: 's2', class_date: '2026-09-16', scheduled_start_at: '2026-09-16T17:00:00Z',
      teacher_name: 'Teacher Lais', lesson_objective: 'Past simple', content_practiced: [],
      recommended_next_step: 'Verbos irregulares', homework_assigned: null,
      transcript_until: null, notes_until: null, attendance_until: null,
    },
  ],
};

beforeEach(() => {
  rpc.mockReset();
});

describe('<StudentLessonRecords />', () => {
  it('lista só os resumos aprovados que o servidor devolve, com o que é guardado', async () => {
    rpc.mockResolvedValue({ data: response, error: null });
    render(<StudentLessonRecords />);

    const first = (await screen.findByText('Pedir comida no restaurante')).closest('li')!;
    expect(rpc).toHaveBeenCalledWith('get_my_lesson_records');
    expect(within(first).getByText(/23\/09\/2026/)).toBeInTheDocument();
    expect(within(first).getByText('would like')).toBeInTheDocument();
    expect(within(first).getByText('Praticar reclamação educada')).toBeInTheDocument();
    expect(within(first).getByText('Gravar um áudio')).toBeInTheDocument();
    expect(within(first).getByText(/transcrição até 12\/12\/2026 e relatório de presença até 22\/12\/2026/)).toBeInTheDocument();

    const second = screen.getByText('Past simple').closest('li')!;
    expect(within(second).queryByText(/Lição:/)).toBeNull();
    expect(within(second).getByText(/Nenhuma cópia da transcrição, das anotações ou da presença/)).toBeInTheDocument();

    expect(screen.getByText(/1 aula registrada está esperando a revisão do professor/)).toBeInTheDocument();
    expect(screen.getByText('Texto do termo vigente.')).toBeInTheDocument();
  });

  it('o que é guardado: não promete que "fica só o resumo" nem acesso exclusivo às anotações', async () => {
    rpc.mockResolvedValue({ data: response, error: null });
    const { container } = render(<StudentLessonRecords />);
    await screen.findByText('Pedir comida no restaurante');
    const text = container.textContent || '';

    // O resumo aprovado guarda mais do que a tela mostra e é lido pelos
    // professores do aluno — a tela diz isso, com os prazos do termo v3 que a
    // retenção do banco cumpre (trechos em 90 dias; o resto até 90 dias
    // depois de sair da escola).
    expect(text).toMatch(/até 90 dias depois da aula, pode trazer o texto das anotações da aula revisado por ele/);
    expect(text).toMatch(/visto pelos seus professores, pela coordenação e pela direção/);
    expect(text).toMatch(/suporte do fornecedor do sistema/);
    expect(text).toMatch(/apagado 90 dias depois que você deixar a escola/);
    expect(text).toMatch(/A transcrição completa e a presença são vistas só pelo professor da aula/);
    expect(text).not.toMatch(/fica só (este|o) resumo/);
    expect(text).not.toMatch(/pelo prazo descrito no termo/);
    // Exclusão: o fluxo real — o aluno pede pelo WhatsApp e a direção apaga
    // pelo botão da ficha (erase_student_lesson_records). A tela lista o que
    // aquela RPC apaga e o que fica; nada de "a escola responde".
    expect(text).toMatch(/A direção confere o pedido e apaga, de uma vez/);
    expect(text).toMatch(/os resumos \(aprovados e rascunhos\), as cópias da transcrição, das anotações e da presença, a memória das aulas usada para planejar e o seu cartão de aluno/);
    expect(text).toMatch(/Os arquivos originais na conta Google da escola também são apagados/);
    expect(text).toMatch(/Continuam a presença e os pagamentos lançados e o registro das suas respostas ao termo/);
    expect(text).not.toMatch(/a escola responde ao seu pedido/);
  });

  it('diz como revogar e leva o pedido de exclusão pronto ao WhatsApp da escola', async () => {
    rpc.mockResolvedValue({ data: response, error: null });
    render(<StudentLessonRecords />);

    expect(await screen.findByText(/Sua autorização: Autorizado/)).toBeInTheDocument();
    expect(screen.getByText(/abra o link do termo .* \(vale até 05\/10\/2026\) e escolha "Não autorizo"/)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /pedir pelo whatsapp da escola/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/5511988887777\?text=/);
  });

  it('sem WhatsApp da escola: mostra o nome e manda falar com a escola', async () => {
    rpc.mockResolvedValue({ data: { ...response, school_whatsapp: null, records: [], pending_review: 0 }, error: null });
    render(<StudentLessonRecords />);

    expect(await screen.findByText(/Ainda não há resumo aprovado/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /whatsapp/i })).toBeNull();
    expect(screen.getByText('Para pedir a exclusão, fale com a escola (Escola Fixture) pelo WhatsApp.')).toBeInTheDocument();
  });

  it('servidor recusa (não é aluno) ou rota ainda não publicada: avisa sem quebrar', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'somente_o_aluno' } });
    const { unmount } = render(<StudentLessonRecords />);
    expect(await screen.findByRole('alert')).toHaveTextContent('do próprio aluno');
    unmount();

    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.get_my_lesson_records' } });
    render(<StudentLessonRecords />);
    expect(await screen.findByRole('alert')).toHaveTextContent('ainda não está disponível');
  });
});
