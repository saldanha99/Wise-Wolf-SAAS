import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ComplementaryActivityPlayer, {
  type ComplementaryActivity,
} from './ComplementaryActivityPlayer';

const legacyReading: ComplementaryActivity = {
  id: 'activity-reading-legacy',
  type: 'reading',
  title: 'Leitura sobre viagens',
  description: 'Leia e registre o que aprendeu.',
  content: 'Leia o texto indicado com atenção.\nAnote três palavras novas.\nExplique a ideia principal.',
  estimated_minutes: 8,
};

const completedResult = (activityId: string) => ({
  activityId,
  status: 'COMPLETED' as const,
  passed: true,
  scorePercentage: null,
  questionResults: [],
  completedAt: '2026-08-31T12:00:00.000Z',
  alreadyApplied: false,
  evidenceAccepted: true,
  streakCount: 1,
  xpEarned: 0,
});

describe('ComplementaryActivityPlayer', () => {
  it('turns legacy content into evidence instead of allowing blind completion', async () => {
    const onSubmit = vi.fn().mockResolvedValue(completedResult(legacyReading.id));
    render(
      <ComplementaryActivityPlayer
        activity={legacyReading}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Leitura sobre viagens' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Leitura sobre viagens' })).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByText('~8 min')).toBeInTheDocument();

    const conclude = screen.getByRole('button', { name: /concluir atividade/i });
    expect(conclude).toBeDisabled();
    screen.getAllByRole('checkbox').forEach(checkbox => fireEvent.click(checkbox));
    fireEvent.change(screen.getByLabelText('Sua reflexão'), {
      target: { value: 'Curta demais' },
    });
    expect(conclude).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Sua reflexão'), {
      target: { value: 'Aprendi novas palavras e preciso revisar a ideia principal.' },
    });
    expect(conclude).toBeEnabled();
    fireEvent.click(conclude);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      activityId: legacyReading.id,
      activityType: 'reading',
      contentMode: 'legacy',
      checklistCompleted: [
        'Leia o texto indicado com atenção.',
        'Anote três palavras novas.',
        'Explique a ideia principal.',
      ],
      reflection: 'Aprendi novas palavras e preciso revisar a ideia principal.',
    }));
    await waitFor(() => (
      expect(screen.getByRole('heading', { name: 'Atividade concluída' })).toHaveFocus()
    ));
    expect(screen.getByText(/sem inventar uma avaliação automática/i)).toBeInTheDocument();
  });

  it('renders a sanitized quiz and only shows authoritative feedback after submission', async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      activityId: 'activity-quiz-json',
      status: 'PENDING',
      passed: false,
      scorePercentage: 50,
      questionResults: [
        {
          questionId: 'q-one',
          selectedIndex: 1,
          correct: false,
          correctIndex: 0,
          explanation: 'Com I, usamos drink no presente simples.',
        },
        {
          questionId: 'q-two',
          selectedIndex: 1,
          correct: true,
          correctIndex: 1,
          explanation: 'Na terceira pessoa, acrescentamos s.',
        },
      ],
      completedAt: null,
      alreadyApplied: false,
      evidenceAccepted: true,
      streakCount: 1,
      xpEarned: 0,
    });
    const activity: ComplementaryActivity = {
      id: 'activity-quiz-json',
      type: 'quiz',
      title: 'Quiz de rotina',
      content: JSON.stringify({
        instructions: 'Escolha a melhor alternativa.',
        questions: [
          {
            id: 'q-one',
            q: 'Complete: I ___ coffee every morning.',
            options: ['drink', 'drinks', 'drank'],
          },
          {
            id: 'q-two',
            q: 'Complete: She ___ at eight.',
            options: ['start', 'starts', 'starting'],
          },
        ],
      }),
      estimated_minutes: 5,
    };

    render(
      <ComplementaryActivityPlayer
        activity={activity}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    const checkButton = screen.getByRole('button', { name: /conferir respostas/i });
    expect(checkButton).toBeDisabled();
    const questions = screen.getAllByRole('group');
    fireEvent.click(within(questions[0]).getByRole('radio', { name: /b\. drinks/i }));
    expect(checkButton).toBeDisabled();
    fireEvent.click(within(questions[1]).getByRole('radio', { name: /b\. starts/i }));
    expect(checkButton).toBeEnabled();
    expect(screen.queryByText(/você acertou/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/resposta correta/i)).not.toBeInTheDocument();
    fireEvent.click(checkButton);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      activityId: 'activity-quiz-json',
      activityType: 'quiz',
      contentMode: 'structured',
      answers: [1, 1],
      questionIds: ['q-one', 'q-two'],
      completedAt: expect.any(String),
    }));
    const submittedEvidence = onSubmit.mock.calls[0][0];
    expect(submittedEvidence).not.toHaveProperty('scorePercentage');
    expect(submittedEvidence).not.toHaveProperty('questionResults');
    expect(JSON.stringify(submittedEvidence)).not.toMatch(/correct(?:Index|_option_index)?/i);

    expect(await screen.findByText(/você acertou 1 de 2.*50%/i)).toBeInTheDocument();
    expect(screen.getByText('Com I, usamos drink no presente simples.')).toBeInTheDocument();
    expect(screen.getAllByText('Resposta correta')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Atividade concluída' })).not.toBeInTheDocument();
  });

  it('is honest about conversation evidence and requires preparation plus reflection', () => {
    const activity: ComplementaryActivity = {
      id: 'activity-conversation-json',
      type: 'conversation',
      title: 'Apresentação em reunião',
      content: JSON.stringify({
        scenario: 'Abra uma reunião e apresente a pauta em inglês.',
        checklist: ['Defini meu objetivo.', 'Pratiquei em voz alta.'],
        reflection_prompt: 'Qual trecho você quer deixar mais natural?',
      }),
    };
    render(
      <ComplementaryActivityPlayer
        activity={activity}
        onClose={vi.fn()}
        onSubmit={vi.fn().mockResolvedValue(completedResult(activity.id))}
      />,
    );

    expect(screen.getByText(/não grava nem avalia áudio, fluência ou pronúncia automaticamente/i)).toBeInTheDocument();
    expect(screen.getByText('Qual trecho você quer deixar mais natural?')).toBeInTheDocument();
    expect(screen.getByText('~10 min')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /concluir atividade/i })).toBeDisabled();
  });

  it('keeps evidence after a failed submit and offers a visible retry', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(completedResult(legacyReading.id));
    render(
      <ComplementaryActivityPlayer
        activity={legacyReading}
        onClose={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    screen.getAllByRole('checkbox').forEach(checkbox => fireEvent.click(checkbox));
    const reflection = screen.getByLabelText('Sua reflexão');
    fireEvent.change(reflection, {
      target: { value: 'Eu entendi a leitura e vou revisar as palavras novas amanhã.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /concluir atividade/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível registrar/i);
    expect(reflection).toHaveValue('Eu entendi a leitura e vou revisar as palavras novas amanhã.');
    const retry = screen.getByRole('button', { name: /tentar novamente/i });
    fireEvent.click(retry);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading', { name: 'Atividade concluída' })).toBeInTheDocument();
  });

  it('closes with Escape, restores focus and unlocks page scrolling', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'Abrir atividade';
    document.body.appendChild(opener);
    opener.focus();

    const Harness = () => {
      const [open, setOpen] = useState(true);
      return open ? (
        <ComplementaryActivityPlayer
          activity={legacyReading}
          onClose={() => setOpen(false)}
          onSubmit={vi.fn().mockResolvedValue(completedResult(legacyReading.id))}
        />
      ) : null;
    };
    render(<Harness />);
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    opener.remove();
  });
});
