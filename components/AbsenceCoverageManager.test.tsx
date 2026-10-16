import React from 'react';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AbsenceCoverageManager from './AbsenceCoverageManager';
const { invoke, from, state } = vi.hoisted(() => ({ invoke: vi.fn(), from: vi.fn(), state: { director: true, fail: false, partial: false, uncertain: false } }));
vi.mock('../lib/supabase', () => ({ supabase: { functions: { invoke }, from } }));
const classes = [
  { bookingId: 'monday', studentId: 'student', studentName: 'Gabriela fixture', classDate: '2026-10-19', classTime: '09:30', dow: 1 },
  { bookingId: 'wednesday', studentId: 'student', studentName: 'Gabriela fixture', classDate: '2026-10-21', classTime: '09:30', dow: 3 },
];
afterEach(cleanup);
beforeEach(() => {
  state.director = true; state.fail = false; state.partial = false; state.uncertain = false;
  invoke.mockReset(); from.mockReset();
  invoke.mockImplementation(async (_: string, { body }: { body: Record<string, unknown> }) => {
    if (state.fail) return { data: null, error: new Error('Agenda indisponível') };
    if (body.action === 'previewAbsence') return { data: { ok: true, classes, canSetRate: state.director }, error: null };
    if (body.action === 'createAbsence') return { data: { ok: true, absence: { id: 'absence' } }, error: null };
    if (body.action === 'searchSubstitutes') return { data: { ok: true, slots: [{ teacher_id: 'cover', teacher_name: 'Substituto fixture' }] }, error: null };
    if (body.action === 'requestCoverage') {
      if (state.uncertain) return { data: null, error: { context: new Response(JSON.stringify({ ok: false, error: 'Nenhuma cobertura concluída', results: [{ item: classes[0], error: 'Envio ainda não confirmado', warning: 'O registro permanece pendente para conferência' }] }), { status: 502 }) } };
      const items = body.items as typeof classes;
      return { data: { ok: true, results: items.map((c, i) => state.partial && i === 1
        ? { item: c, error: 'Substituto indisponível' }
        : { coverage: { booking_id: c.bookingId, class_date: c.classDate } }) }, error: null };
    }
    throw new Error('unexpected action');
  });
});
function open() { render(<AbsenceCoverageManager teacher={{ id: 'teacher', name: 'Débora fixture' }} onClose={vi.fn()} />); }
async function list() {
  fireEvent.change(screen.getByLabelText('Início'), { target: { value: '2026-10-19' } });
  fireEvent.change(screen.getByLabelText('Fim'), { target: { value: '2026-10-23' } });
  fireEvent.click(screen.getByRole('button', { name: 'Listar aulas do período' }));
  await screen.findByText(/2 aula\(s\), com horários vigentes/);
}
async function choose(index = 0) {
  fireEvent.click(screen.getAllByRole('button', { name: /Buscar substitutos/ })[index]);
  await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(index + 1));
  fireEvent.change(screen.getAllByRole('combobox')[index], { target: { value: 'cover' } });
}
describe('ausência e cobertura por ocorrência efetiva', () => {
  it('mostra segunda e quarta da consulta, sem criar ausência na prévia', async () => {
    open(); await list();
    expect(screen.getByText(/seg\., 19\/10/)).toBeTruthy();
    expect(screen.getByText(/qua\., 21\/10/)).toBeTruthy();
    expect(invoke.mock.calls.some(([, arg]) => arg.body.action === 'createAbsence')).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
  it('erro da agenda não usa fallback nem grava ausência', async () => {
    state.fail = true; open();
    fireEvent.click(screen.getByRole('button', { name: 'Listar aulas do período' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agenda indisponível');
    expect(from).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('somente diretor vê o valor e o envia com a ocorrência correta', async () => {
    open(); await list(); await choose();
    fireEvent.change(screen.getAllByLabelText(/Valor da cobertura/)[0], { target: { value: '12,50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedidos de cobertura' }));
    await screen.findByText('1 cobertura(s) enviada(s)');
    const request = invoke.mock.calls.find(([, arg]) => arg.body.action === 'requestCoverage')![1].body;
    expect(request.items[0]).toMatchObject({ bookingId: 'monday', classDate: '2026-10-19', classTime: '09:30', offeredRate: 12.5 });
  });
  it('coordenação não recebe campo e mantém tarifa normal', async () => {
    state.director = false; open(); await list(); await choose();
    expect(screen.queryByLabelText(/Valor da cobertura/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedidos de cobertura' }));
    await screen.findByText('1 cobertura(s) enviada(s)');
    expect(invoke.mock.calls.find(([, arg]) => arg.body.action === 'requestCoverage')![1].body.items[0]).not.toHaveProperty('offeredRate');
  });
  it('recusa valor inválido antes de registrar ausência ou enviar', async () => {
    open(); await list(); await choose();
    fireEvent.change(screen.getAllByLabelText(/Valor da cobertura/)[0], { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedidos de cobertura' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe um valor');
    expect(invoke.mock.calls.some(([, arg]) => arg.body.action === 'createAbsence')).toBe(false);
  });
  it('alterar período limpa seleção e valor anteriores', async () => {
    open(); await list(); await choose();
    fireEvent.change(screen.getByLabelText('Fim'), { target: { value: '2026-10-22' } });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enviar pedidos de cobertura' })).toBeNull();
  });
  it('falha parcial mantém pendências sem declarar sucesso completo', async () => {
    state.partial = true; open(); await list(); await choose(); await choose(1);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedidos de cobertura' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Substituto indisponível'));
    expect(screen.queryByText('2 cobertura(s) enviada(s)')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Buscar substitutos/ })).toHaveLength(1);
  });
  it('mostra o envio incerto retornado em HTTP 502 e não declara entrega', async () => {
    state.uncertain = true; open(); await list(); await choose();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar pedidos de cobertura' }));
    await screen.findByText(/O registro permanece pendente para conferência/);
    expect(screen.getByText(/Envio ainda não confirmado/)).toBeTruthy();
    expect(screen.queryByText('1 cobertura(s) enviada(s)')).toBeNull();
  });

});
