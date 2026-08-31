import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudentMaterials from './StudentMaterials';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    refresh: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
    supabase: {
        functions: { invoke: mocks.invoke },
    },
}));

vi.mock('./contexts/StudentContext', () => ({
    useStudentContext: () => ({
        loading: false,
        refresh: mocks.refresh,
        data: {
            profile: {
                module: 'A1',
                current_book_part: 'A1-1',
                evaluation_unlocked: true,
            },
            gamification: { xp: 0, level: 1, streak: 0 },
        },
    }),
}));

vi.mock('./GamificationHeader', () => ({
    default: () => <div>Resumo de evolução</div>,
}));

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.invoke.mockImplementation((_functionName: string, request: any) => {
        if (request?.body?.action === 'load') {
            return Promise.resolve({
                data: {
                    questions: [{
                        id: 'A1-1-1',
                        question: 'Choose the greeting.',
                        options: ['Hello', 'Goodbye'],
                    }],
                },
                error: null,
            });
        }
        return Promise.resolve({
            data: null,
            error: { message: 'submission unavailable' },
        });
    });
});

afterEach(() => vi.restoreAllMocks());

describe('<StudentMaterials /> — avaliação protegida', () => {
    it('carrega questões sem gabarito e mantém respostas/modal quando o servidor não registra', async () => {
        render(<StudentMaterials user={{ id: 'student-1' } as never} />);

        fireEvent.click(screen.getByRole('button', { name: /iniciar avaliação/i }));

        expect(await screen.findByText('Choose the greeting.')).toBeInTheDocument();
        expect(mocks.invoke).toHaveBeenCalledWith('submit-quiz', {
            body: { action: 'load', bookPart: 'A1-1' },
        });

        const selectedAnswer = screen.getByRole('radio', { name: /hello/i });
        fireEvent.click(selectedAnswer);
        fireEvent.click(screen.getByRole('button', { name: /enviar com segurança/i }));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith('submit-quiz', {
                body: {
                    action: 'submit',
                    bookPart: 'A1-1',
                    answers: [0],
                    requestKey: expect.any(String),
                },
            });
        });

        expect(await screen.findByRole('alert')).toHaveTextContent(/respostas.*continuam aqui/i);
        expect(screen.getByRole('dialog', { name: /marco a1-1/i })).toBeInTheDocument();
        expect(selectedAnswer).toHaveAttribute('aria-checked', 'true');
        expect(mocks.refresh).not.toHaveBeenCalled();

        const firstSubmission = mocks.invoke.mock.calls.find(([, request]) => (
            request?.body?.action === 'submit'
        ));
        fireEvent.click(screen.getByRole('button', { name: /enviar com segurança/i }));
        await waitFor(() => {
            expect(mocks.invoke.mock.calls.filter(([, request]) => (
                request?.body?.action === 'submit'
            ))).toHaveLength(2);
        });
        const submissions = mocks.invoke.mock.calls.filter(([, request]) => (
            request?.body?.action === 'submit'
        ));
        expect(submissions[1][1].body.requestKey).toBe(firstSubmission![1].body.requestKey);
    });
});
