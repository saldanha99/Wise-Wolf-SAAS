import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TeacherStudentTermsGate from './TeacherStudentTermsGate';
import { teacherTermsNeedingAction, type IndividualTermsData } from '../lib/teacherStudentTerms';

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../lib/supabase', () => ({ supabase: { rpc } }));

const base = { id: 't1', version: 1, student_name: 'Amábile Fixture', teacher_name: 'Professora Fixture', mode: 'RECURRING' as const, starts_on: '2026-10-29', ends_on: null, slots: [{ day: 1, time: '15:30', date: null }], status: 'PROPOSED' };
const data = (phase: string, role = 'TEACHER'): IndividualTermsData => ({ ok: true, enabled: true, role, actor_name: 'Professora Fixture', terms: [{ ...base, phase }] });

beforeEach(() => {
  rpc.mockReset();
  // jsdom não implementa showModal.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});

describe('pendência do termo por aluno do professor', () => {
  it('só conta o que o próprio professor tem a fazer', () => {
    expect(teacherTermsNeedingAction(data('IDENTITY_PENDING'))).toHaveLength(1);
    expect(teacherTermsNeedingAction(data('TEACHER_PENDING'))).toHaveLength(1);
    expect(teacherTermsNeedingAction(data('SCHOOL_PENDING'))).toHaveLength(0);
    expect(teacherTermsNeedingAction(data('IDENTITY_PENDING', 'SCHOOL_ADMIN'))).toHaveLength(0);
    expect(teacherTermsNeedingAction(null)).toHaveLength(0);
  });

  it('abre o pop-up obrigatório com o aluno e o formulário de dados', async () => {
    rpc.mockResolvedValue({ data: data('IDENTITY_PENDING'), error: null });
    const onActive = vi.fn();
    render(<TeacherStudentTermsGate blocked={false} onActiveChange={onActive} onLogout={() => {}} />);
    expect(await screen.findByText(/Você tem um aluno novo: Amábile Fixture/)).toBeInTheDocument();
    expect(await screen.findByText(/Tenho CNPJ \(empresa ou MEI\)/)).toBeInTheDocument();
    await waitFor(() => expect(onActive).toHaveBeenLastCalledWith(true));
  });

  it('não abre enquanto só falta a escola, nem quando a leitura falha', async () => {
    rpc.mockResolvedValue({ data: data('SCHOOL_PENDING'), error: null });
    const { unmount } = render(<TeacherStudentTermsGate blocked={false} onActiveChange={() => {}} onLogout={() => {}} />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByText(/aluno novo/)).not.toBeInTheDocument();
    unmount();
    rpc.mockResolvedValue({ data: null, error: { message: 'x' } });
    render(<TeacherStudentTermsGate blocked={false} onActiveChange={() => {}} onLogout={() => {}} />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/aluno novo/)).not.toBeInTheDocument();
  });

  it('espera o pop-up da conta Google', async () => {
    rpc.mockResolvedValue({ data: data('TEACHER_PENDING'), error: null });
    render(<TeacherStudentTermsGate blocked onActiveChange={() => {}} onLogout={() => {}} />);
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(screen.queryByText(/aluno novo/)).not.toBeInTheDocument();
  });
});
