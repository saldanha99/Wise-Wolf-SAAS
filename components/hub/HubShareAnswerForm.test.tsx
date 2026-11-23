import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const submit = vi.fn();
vi.mock('./hubService', () => ({ submitHubSharedAnswers: (...args: unknown[]) => submit(...args) }));

import HubShareAnswerForm from './HubShareAnswerForm';

const material = {
  questions: [{ prompt: 'I ___ a ticket.', options: ['have', 'has'] }],
  fill_blanks: [{ prompt: 'We ___ at 9.' }],
  open_questions: [{ prompt: 'Describe your trip.' }],
};

describe('respostas do aluno na atividade do link', () => {
  it('envia só as respostas (sem gabarito no navegador) e mostra a correção', async () => {
    submit.mockResolvedValue({
      right: 1, total: 2, keyMode: 'after_submit',
      items: [
        { section: 'questions', index: 0, kind: 'mcq', given: 'have', correct: true, expected: 'have', explanation_pt: 'I pede have.' },
        { section: 'fill_blanks', index: 0, kind: 'gap', given: 'arive', correct: false, expected: 'arrive' },
        { section: 'open_questions', index: 0, kind: 'open', given: 'I go Rio', correct: null, feedback_pt: 'Use o passado: went.', corrected_en: 'I went to Rio.' },
      ],
    });
    render(<HubShareAnswerForm token={'t'.repeat(43)} material={material} />);
    fireEvent.change(screen.getByLabelText(/Seu nome/i), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByLabelText(/a\) have/));
    fireEvent.change(screen.getByLabelText(/We ___ at 9/), { target: { value: 'arive' } });
    fireEvent.change(screen.getByLabelText(/Describe your trip/), { target: { value: 'I go Rio' } });
    fireEvent.click(screen.getByRole('button', { name: /Enviar respostas/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith('t'.repeat(43), 'Ana', { questions: [0], fill_blanks: ['arive'], open_questions: ['I go Rio'] });
    expect(await screen.findByText(/Você acertou 1 de 2/)).toBeTruthy();
    expect(screen.getByText('Use o passado: went.')).toBeTruthy();
    expect(screen.getByText('arrive')).toBeTruthy();
  });
});
