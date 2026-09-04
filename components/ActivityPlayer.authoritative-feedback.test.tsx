import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ActivityPlayer from './ActivityPlayer';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    rpc: vi.fn(),
    getHearts: vi.fn(),
    loseHeart: vi.fn(),
    updateStreak: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
    supabase: {
        from: mocks.from,
        rpc: mocks.rpc,
    },
}));

vi.mock('../services/gamificationService', () => ({
    gamificationService: {
        getHearts: mocks.getHearts,
        loseHeart: mocks.loseHeart,
        updateStreak: mocks.updateStreak,
    },
}));

vi.mock('canvas-confetti', () => ({ default: vi.fn() }));

vi.mock('./WolfieTutor', () => ({
    default: ({ onClose }: { onClose: (summary: any) => void }) => (
        <button
            type="button"
            onClick={() => onClose({
                learnerTurns: 2,
                sessionCompleted: true,
                sessionScore: 88,
                conversationId: 'conversation-wolfie-1',
            })}
        >
            Encerrar Wolfie confirmado
        </button>
    ),
}));

const activity = {
    id: 'activity-1',
    unit_id: 'unit-1',
    type: 'quiz',
    title: 'Quiz de segurança',
    description: 'Uma tentativa verificada pelo servidor.',
    xp_reward: 40,
    content: {
        questions: [{
            q: 'Choose the correct answer.',
            options: ['Correct', 'Wrong'],
            correct: 0,
            exp: 'A primeira alternativa é a correta.',
        }],
    },
};

const vocabActivity = {
    id: 'activity-vocab-1',
    unit_id: 'unit-1',
    type: 'vocab_cards',
    title: 'Vocabulário verificado',
    description: 'Revisão de vocabulário registrada pelo servidor.',
    xp_reward: 20,
    content: {
        cards: [{
            term: 'reliable',
            translation: 'confiável',
            example: 'This source is reliable.',
        }],
    },
};

const sanitizedQuizActivity = {
    ...activity,
    id: 'activity-sanitized-quiz-1',
    title: 'Quiz sem gabarito no navegador',
    content: {
        questions: [{
            id: 'question-1',
            q: 'Choose the best option.',
            options: ['Option A', 'Option B'],
        }],
    },
};

const speakingActivity = {
    id: 'activity-speaking-1',
    unit_id: 'unit-1',
    type: 'speaking_wolfie',
    title: 'Conversa verificada',
    description: 'Prática oral vinculada à sessão do Wolfie.',
    xp_reward: 30,
    content: {
        scenario: 'job_interview',
        instructions_pt: 'Responda com exemplos concretos.',
        target_phrases: ['I was responsible for'],
    },
};

const answerWrongAndFinish = async () => {
    fireEvent.click(screen.getByRole('button', { name: /B\. Wrong/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirmar resposta/i }));
    fireEvent.click(screen.getByRole('button', { name: /concluir/i }));
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.getHearts.mockResolvedValue(5);
    mocks.loseHeart.mockResolvedValue(4);
    mocks.updateStreak.mockResolvedValue(1);

    mocks.from.mockImplementation((table: string) => {
        const query: any = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.maybeSingle = vi.fn().mockResolvedValue({
            data: table === 'learning_units' ? { skill_focus: [] } : null,
            error: null,
        });
        query.upsert = vi.fn().mockResolvedValue({ data: null, error: null });
        return query;
    });
});

afterEach(() => vi.restoreAllMocks());

describe('<ActivityPlayer /> — falhas e reprovação verificadas', () => {
    it('abre uma atividade concluída em revisão sem controles que possam gravar outra tentativa', () => {
        const onClose = vi.fn();
        render(
            <ActivityPlayer
                activity={sanitizedQuizActivity}
                userId="student-1"
                reviewOnly
                onComplete={vi.fn()}
                onClose={onClose}
            />,
        );

        expect(screen.getByText(/revisão sem alterar seu progresso/i)).toBeInTheDocument();
        expect(screen.getByText(/Choose the best option\./i)).toBeInTheDocument();
        expect(screen.getByText(/A\. Option A/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /confirmar|concluir|tentar|sei essa|não sei/i })).not.toBeInTheDocument();
        expect(mocks.rpc).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /fechar atividade/i }));
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('aceita atividade sanitizada e só revela a correção depois da resposta autoritativa', async () => {
        mocks.rpc.mockImplementation((name: string, payload: Record<string, unknown>) => {
            if (name === 'grade_quiz') {
                return Promise.resolve({
                    data: {
                        score: 100,
                        passed: true,
                        status: 'COMPLETED',
                        xpEarned: 40,
                        alreadyAwarded: false,
                        leveledUp: false,
                        newLevel: 1,
                        questionResults: [{
                            questionId: 'question-1',
                            selectedIndex: 1,
                            correctIndex: 1,
                            correct: true,
                            explanation: 'Option B is correct.',
                        }],
                    },
                    error: null,
                });
            }
            if (name === 'consume_student_heart') {
                return Promise.resolve({ data: { hearts: 4 }, error: null });
            }
            return Promise.resolve({ data: payload, error: null });
        });

        const onComplete = vi.fn();
        const onClose = vi.fn();
        render(
            <ActivityPlayer
                activity={sanitizedQuizActivity}
                userId="student-1"
                onComplete={onComplete}
                onClose={onClose}
            />,
        );

        expect(JSON.stringify(sanitizedQuizActivity.content)).not.toMatch(
            /correct|correctIndex|correct_option_index|\bexp\b/i,
        );
        fireEvent.click(screen.getByRole('button', { name: /B\. Option B/i }));
        fireEvent.click(screen.getByRole('button', { name: /confirmar resposta/i }));

        expect(mocks.rpc.mock.calls.filter(([name]) => name === 'consume_student_heart')).toHaveLength(0);
        expect(mocks.rpc.mock.calls.filter(([name]) => name === 'grade_quiz')).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: /concluir/i }));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('grade_quiz', {
                p_activity_id: 'activity-sanitized-quiz-1',
                p_answers: [1],
                p_request_key: expect.any(String),
            });
        });
        expect(await screen.findByText(/100%/)).toBeInTheDocument();
        expect(screen.getByText(/feedback da correção/i)).toBeInTheDocument();
        expect(screen.getByText(/sua resposta B/i)).toBeInTheDocument();
        expect(screen.getByText('Option B is correct.')).toBeInTheDocument();
        expect(mocks.rpc.mock.calls.filter(([name]) => name === 'consume_student_heart')).toHaveLength(0);

        fireEvent.click(screen.getByRole('button', { name: /fechar atividade/i }));
        expect(onComplete).toHaveBeenCalledWith(100);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('mantém a atividade aberta e mostra um erro acionável quando a correção falha', async () => {
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'grade_quiz') {
                return Promise.resolve({
                    data: null,
                    error: { message: 'grade service unavailable' },
                });
            }
            if (name === 'consume_student_heart') {
                return Promise.resolve({ data: { hearts: 4 }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
        });
        const onComplete = vi.fn();
        const onClose = vi.fn();

        render(
            <ActivityPlayer
                activity={activity}
                userId="student-1"
                onComplete={onComplete}
                onClose={onClose}
            />,
        );

        await answerWrongAndFinish();

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('grade_quiz', {
                p_activity_id: 'activity-1',
                p_answers: [1],
                p_request_key: expect.any(String),
            });
        });
        expect(mocks.rpc.mock.calls.filter(([name]) => name === 'consume_student_heart')).toHaveLength(0);

        expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível.*(corrigir|finalizar|registrar)/i);
        expect(screen.getByText('Quiz de segurança')).toBeInTheDocument();
        expect(onComplete).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('bloqueia Escape, fundo e botão fechar enquanto a tentativa está sendo salva', async () => {
        let resolveGrade: ((value: {
            data: Record<string, unknown>;
            error: null;
        }) => void) | undefined;
        const pendingGrade = new Promise<{
            data: Record<string, unknown>;
            error: null;
        }>(resolve => {
            resolveGrade = resolve;
        });
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'grade_quiz') return pendingGrade;
            return Promise.resolve({ data: null, error: null });
        });
        const onClose = vi.fn();

        render(
            <ActivityPlayer
                activity={activity}
                userId="student-1"
                onComplete={vi.fn()}
                onClose={onClose}
            />,
        );

        await answerWrongAndFinish();

        const savingClose = await screen.findByRole('button', { name: /salvando atividade/i });
        expect(savingClose).toBeDisabled();
        fireEvent.keyDown(document, { key: 'Escape' });
        const dialog = screen.getByRole('dialog', { name: 'Quiz de segurança' });
        fireEvent.mouseDown(dialog.parentElement!);
        fireEvent.click(savingClose);
        expect(onClose).not.toHaveBeenCalled();

        resolveGrade?.({
            data: {
                score: 100,
                passed: true,
                status: 'COMPLETED',
                xpEarned: 40,
                leveledUp: false,
                newLevel: 1,
            },
            error: null,
        });
        expect(await screen.findByText(/100%/)).toBeInTheDocument();
    });

    it('não trata nota abaixo de 60 como conclusão e oferece nova tentativa', async () => {
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'grade_quiz') {
                return Promise.resolve({
                    data: {
                        score: 0,
                        passed: false,
                        status: 'FAILED',
                        xpEarned: 0,
                        alreadyAwarded: false,
                        leveledUp: false,
                        newLevel: 1,
                        hearts: 4,
                        heartsConsumed: 1,
                    },
                    error: null,
                });
            }
            return Promise.resolve({ data: null, error: null });
        });
        const onComplete = vi.fn();
        const onHeartsChange = vi.fn();

        render(
            <ActivityPlayer
                activity={activity}
                userId="student-1"
                onComplete={onComplete}
                onClose={vi.fn()}
                hearts={2}
                onHeartsChange={onHeartsChange}
            />,
        );

        await answerWrongAndFinish();

        const retry = await screen.findByRole('button', { name: /tentar novamente/i });
        expect(screen.getByText(/0%/)).toBeInTheDocument();
        expect(onComplete).not.toHaveBeenCalled();

        expect(mocks.rpc.mock.calls.filter(([name]) => name === 'consume_student_heart')).toHaveLength(0);
        expect(onHeartsChange).toHaveBeenCalledWith(4);

        fireEvent.click(retry);

        await waitFor(() => {
            expect(screen.getByText(/pergunta 1 de 1/i)).toBeInTheDocument();
        });
        expect(mocks.rpc.mock.calls.filter(([name]) => name === 'grade_quiz')).toHaveLength(1);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('registra atividade não-quiz pelo RPC e não fecha o player quando o servidor rejeita', async () => {
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'complete_learning_activity') {
                return Promise.resolve({
                    data: null,
                    error: { message: 'completion unavailable' },
                });
            }
            return Promise.resolve({ data: null, error: null });
        });
        const onComplete = vi.fn();
        const onClose = vi.fn();

        render(
            <ActivityPlayer
                activity={vocabActivity}
                userId="student-1"
                onComplete={onComplete}
                onClose={onClose}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: /sei essa/i }));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith(
                'complete_learning_activity',
                expect.objectContaining({
                    p_activity_id: 'activity-vocab-1',
                    p_score: 100,
                    p_evidence: expect.any(Object),
                    p_request_key: expect.any(String),
                }),
            );
        });

        expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível.*(finalizar|registrar|atividade)/i);
        expect(screen.getByText('Vocabulário verificado')).toBeInTheDocument();
        expect(onComplete).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('repete a mesma nota e a mesma chave ao reenviar a conclusão do último card', async () => {
        let completionCalls = 0;
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'complete_learning_activity') {
                completionCalls += 1;
                return completionCalls === 1
                    ? Promise.resolve({ data: null, error: { message: 'response lost' } })
                    : Promise.resolve({
                        data: {
                            score: 100,
                            passed: true,
                            status: 'COMPLETED',
                            xpEarned: 20,
                        },
                        error: null,
                    });
            }
            return Promise.resolve({ data: null, error: null });
        });

        render(
            <ActivityPlayer
                activity={vocabActivity}
                userId="student-1"
                onComplete={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: /sei essa/i }));
        expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível.*registrar/i);
        fireEvent.click(screen.getByRole('button', { name: /tentar registrar novamente/i }));

        expect(await screen.findByText(/100%/)).toBeInTheDocument();
        const calls = mocks.rpc.mock.calls.filter(([name]) => name === 'complete_learning_activity');
        expect(calls).toHaveLength(2);
        expect(calls.map(([, payload]) => payload.p_score)).toEqual([100, 100]);
        expect(calls[1][1].p_request_key).toBe(calls[0][1].p_request_key);
        expect(calls[1][1].p_evidence).toEqual(expect.objectContaining({ score: 100 }));
    });

    it('vincula a conclusão de speaking à conversa confirmada pelo Wolfie', async () => {
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'complete_learning_activity') {
                return Promise.resolve({
                    data: { score: 88, passed: true, status: 'COMPLETED', xpEarned: 30 },
                    error: null,
                });
            }
            return Promise.resolve({ data: null, error: null });
        });

        render(
            <ActivityPlayer
                activity={speakingActivity}
                userId="student-1"
                onComplete={vi.fn()}
                onClose={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: /começar com wolfie/i }));
        fireEvent.click(await screen.findByRole('button', { name: /encerrar wolfie confirmado/i }));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith(
                'complete_learning_activity',
                expect.objectContaining({
                    p_activity_id: 'activity-speaking-1',
                    p_score: 88,
                    p_evidence: expect.objectContaining({
                        learnerTurns: 2,
                        sessionCompleted: true,
                        wolfieSessionScore: 88,
                        wolfieConversationId: 'conversation-wolfie-1',
                    }),
                }),
            );
        });
    });

    it('também mantém uma prática não-quiz abaixo de 60 aberta para nova tentativa', async () => {
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'complete_learning_activity') {
                return Promise.resolve({
                    data: {
                        score: 0,
                        passed: false,
                        status: 'IN_PROGRESS',
                        xpEarned: 0,
                    },
                    error: null,
                });
            }
            return Promise.resolve({ data: null, error: null });
        });
        const onComplete = vi.fn();

        render(
            <ActivityPlayer
                activity={vocabActivity}
                userId="student-1"
                onComplete={onComplete}
                onClose={vi.fn()}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: /não sei ainda/i }));

        expect(await screen.findByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
        expect(screen.getByText(/0%/)).toBeInTheDocument();
        expect(onComplete).not.toHaveBeenCalled();
    });
});
