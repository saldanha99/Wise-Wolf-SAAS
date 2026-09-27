import React, { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));
vi.mock('./LessonPedagogicalSummary', () => ({ default: () => null }));
vi.mock('./LessonRecordingTeacherCard', () => ({ default: () => null }));
vi.mock('./LessonReviewQueue', () => ({ default: () => null }));
vi.mock('./StudentLearningCard', () => ({ default: () => null }));

import LessonSessionsPanel from './LessonSessionsPanel';
import GuidedTour from './tour/GuidedTour';
import { DOSSIER_LINK_DENIED, STUDENT_DOSSIER_PATH, useStudentDossierLink } from '../lib/studentDossierLink';
import type { FlatStep } from '../lib/tours';

const STUDENT = '00000000-0000-4000-8000-000000009e11';

function answer(handover: { data: unknown; error: unknown }) {
  rpc.mockImplementation((name: string) => Promise.resolve(
    name === 'get_lesson_sessions'
      ? { data: { ok: true, sessions: [] }, error: null }
      : name === 'get_student_handover'
        ? handover
        : { data: null, error: { message: 'inesperado' } },
  ));
}

const APPROVED = {
  data: {
    ok: true, student_name: 'Ana Coberta', learning_card: null, logs: [],
    memories: [{ id: 'm1', occurred_at: '2026-09-25T13:00:00Z', lesson_objective: 'Objetivo aprovado', recommended_next_step: 'Próximo passo aprovado' }],
  },
  error: null,
};

const handoverCalls = () => rpc.mock.calls.filter(([name]) => name === 'get_student_handover').length;

beforeEach(() => rpc.mockReset());
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('Dossiê aberto pelo link com login (substituto e novo titular)', () => {
  it('abre o dossiê do aluno do link, explica o prazo e só solta o foco quando a pessoa fecha', async () => {
    answer(APPROVED);
    const closed = vi.fn();
    render(<LessonSessionsPanel focusStudentId={STUDENT} onFocusClosed={closed} />);
    await screen.findByText('Próximo passo aprovado');
    expect(rpc).toHaveBeenCalledWith('get_student_handover', { p_student_id: STUDENT, p_acknowledge: false });
    expect(screen.getByRole('note').textContent).toMatch(/dia anterior ao dia seguinte da aula/);
    // Abrir não consome o link: um tour ou uma troca de tela ainda pode desmontar o painel.
    expect(closed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Fechar dossiê'));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Próximo passo aprovado')).toBeNull();
  });

  it('o painel montado de novo com o link ainda em foco reabre o dossiê', async () => {
    answer(APPROVED);
    const first = render(<LessonSessionsPanel focusStudentId={STUDENT} />);
    await screen.findByText('Próximo passo aprovado');
    first.unmount();
    render(<LessonSessionsPanel focusStudentId={STUDENT} />);
    await screen.findByText('Próximo passo aprovado');
    expect(handoverCalls()).toBe(2);
  });

  it('fora da janela, a recusa do servidor diz o prazo em vez de "vinculação"', async () => {
    answer({ data: null, error: { message: 'sem_permissao' } });
    render(<LessonSessionsPanel focusStudentId={STUDENT} />);
    await screen.findByText(DOSSIER_LINK_DENIED);
  });

  it('sem link, o painel não abre dossiê nenhum', async () => {
    answer({ data: null, error: { message: 'sem_permissao' } });
    render(<LessonSessionsPanel />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_lesson_sessions', { p_student_id: null }));
    expect(rpc).not.toHaveBeenCalledWith('get_student_handover', expect.anything());
    expect(screen.queryByRole('note')).toBeNull();
  });
});

// O App em miniatura: o mesmo hook, o mesmo painel e o mesmo motor de tour. O
// tour pendente (boas-vindas ou novidade) começa em OUTRA tela — como o de
// boas-vindas ('dashboard'), o do cartão do aluno ('students') e o do Planner.
const PENDING_TOUR: FlatStep[] = [
  { target: null, view: 'students', title: 'Tour pendente na tela de alunos', text: 'Passo que troca de aba.', chapterTitle: 'Novidade' },
];

function MiniApp() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [tourPending, setTourPending] = useState(true);
  const dossierLink = useStudentDossierLink({ id: 'bruna', role: 'TEACHER' }, activeTab, setActiveTab);
  return <>
    <p data-testid="tab">{activeTab}</p>
    {activeTab === 'lesson-sessions' && <LessonSessionsPanel focusStudentId={dossierLink.focusStudentId} onFocusClosed={dossierLink.release} />}
    {activeTab === 'students' && <p>Tela de alunos</p>}
    {tourPending && !dossierLink.holdsTours && (
      <GuidedTour steps={PENDING_TOUR} activeTab={activeTab} setActiveTab={setActiveTab}
        onFinish={() => undefined} onClose={() => setTourPending(false)} />
    )}
  </>;
}

describe('link do dossiê com um tour pendente no login', () => {
  it('o dossiê fica aberto; o tour espera a pessoa fechar o dossiê', async () => {
    answer(APPROVED);
    window.history.replaceState(null, '', `${STUDENT_DOSSIER_PATH}?aluno=${STUDENT}`);
    render(<MiniApp />);
    await screen.findByText('Próximo passo aprovado');
    expect(screen.getByTestId('tab').textContent).toBe('lesson-sessions');
    expect(window.location.pathname).toBe('/');
    // O tour não tirou a pessoa do dossiê.
    await new Promise((done) => setTimeout(done, 50));
    expect(screen.queryByText('Tour pendente na tela de alunos')).toBeNull();
    expect(screen.getByText('Próximo passo aprovado')).toBeTruthy();

    fireEvent.click(screen.getByText('Fechar dossiê'));
    await screen.findByText('Tour pendente na tela de alunos');
    await waitFor(() => expect(screen.getByTestId('tab').textContent).toBe('students'));
  });

  it('trocar de tela pelo menu com o dossiê aberto solta o link (e o tour segue)', async () => {
    answer(APPROVED);
    window.history.replaceState(null, '', `${STUDENT_DOSSIER_PATH}?aluno=${STUDENT}`);
    function MenuApp() {
      const [activeTab, setActiveTab] = useState('dashboard');
      const dossierLink = useStudentDossierLink({ id: 'bruna', role: 'TEACHER' }, activeTab, setActiveTab);
      return <>
        <button onClick={() => setActiveTab('students')}>Menu: alunos</button>
        <button onClick={() => setActiveTab('lesson-sessions')}>Menu: salas</button>
        {activeTab === 'lesson-sessions' && <LessonSessionsPanel focusStudentId={dossierLink.focusStudentId} onFocusClosed={dossierLink.release} />}
        <p data-testid="hold">{String(dossierLink.holdsTours)}</p>
      </>;
    }
    render(<MenuApp />);
    await screen.findByText('Próximo passo aprovado');
    expect(screen.getByTestId('hold').textContent).toBe('true');
    fireEvent.click(screen.getByText('Menu: alunos'));
    await waitFor(() => expect(screen.getByTestId('hold').textContent).toBe('false'));
    // Voltar à tela não reabre o dossiê do link: ele já foi usado.
    fireEvent.click(screen.getByText('Menu: salas'));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith('get_lesson_sessions', { p_student_id: null }));
    expect(handoverCalls()).toBe(1);
  });

  it('o App segura os dois tours pelo link e solta o foco quando a pessoa sai do dossiê', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toContain('useStudentDossierLink(user, activeTab, setActiveTab)');
    expect(app).toContain('{tourOpen && !dossierLink.holdsTours &&');
    expect(app).toContain('{featureTour && !tourOpen && !dossierLink.holdsTours &&');
    expect(app).toContain('focusStudentId={dossierLink.focusStudentId} onFocusClosed={dossierLink.release}');
    expect(app).not.toMatch(/onFocusConsumed/);
  });
});
