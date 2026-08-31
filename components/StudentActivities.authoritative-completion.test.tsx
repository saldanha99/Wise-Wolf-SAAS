import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudentActivities from './StudentActivities';

const mocks = vi.hoisted(() => {
    class MockActivityGenerationError extends Error {
        readonly code: string;
        readonly retryable: boolean;

        constructor(message: string, details: { code: string; retryable: boolean }) {
            super(message);
            this.code = details.code;
            this.retryable = details.retryable;
        }
    }
    return {
        from: vi.fn(),
        rpc: vi.fn(),
        generateActivities: vi.fn(),
        ActivityGenerationError: MockActivityGenerationError,
    };
});

vi.mock('../lib/supabase', () => ({
    supabase: {
        from: mocks.from,
        rpc: mocks.rpc,
    },
}));

vi.mock('../services/geminiService', () => ({
    ActivityGenerationError: mocks.ActivityGenerationError,
    generateActivities: mocks.generateActivities,
}));

const pendingActivities = [
    {
        id: 'activity-1',
        student_id: 'student-1',
        tenant_id: 'tenant-1',
        type: 'reading',
        title: 'Leitura segura',
        description: 'Leia e registre sua compreensão.',
        content: 'Leia o texto com atenção.\nAnote as palavras novas.\nResuma a ideia principal.',
        difficulty: 'BEGINNER',
        status: 'PENDING',
        estimated_minutes: 8,
    },
    {
        id: 'activity-2',
        student_id: 'student-1',
        tenant_id: 'tenant-1',
        type: 'grammar',
        title: 'Gramática contextual',
        description: 'Prática guiada.',
        content: 'Revise o presente simples.',
        difficulty: 'BEGINNER',
        status: 'PENDING',
    },
    {
        id: 'activity-3',
        student_id: 'student-1',
        tenant_id: 'tenant-1',
        type: 'conversation',
        title: 'Conversação guiada',
        description: 'Pratique em voz alta.',
        content: 'Apresente-se em inglês.',
        difficulty: 'BEGINNER',
        status: 'PENDING',
    },
];

const sanitizedQuizActivity = {
    id: 'activity-secure-quiz',
    student_id: 'student-1',
    tenant_id: 'tenant-1',
    type: 'quiz',
    title: 'Quiz complementar seguro',
    description: 'A correção vem apenas do servidor.',
    content: {
        instructions_pt: 'Escolha uma alternativa.',
        questions: [{
            id: 'secure-q1',
            q: 'Choose the first option.',
            options: ['Right', 'Wrong'],
        }],
    },
    difficulty: 'BEGINNER',
    status: 'PENDING' as const,
    estimated_minutes: 5,
};

const activitiesQuery = (activities = pendingActivities) => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.order = vi.fn(() => query);
    query.limit = vi.fn().mockResolvedValue({
        data: activities,
        error: null,
    });
    return query;
};

const profileQuery = () => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.single = vi.fn().mockResolvedValue({
        data: {
            english_for: 'Travel',
            student_category: 'ADULT',
            personality: 'PRACTICAL',
            preferred_topics: ['airports'],
            avoided_topics: [],
            short_term_goal: 'Check in confidently',
            module: 'A2',
        },
        error: null,
    });
    return query;
};

const wolfQuery = () => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.maybeSingle = vi.fn().mockResolvedValue({
        data: {
            accumulated_context: 'Praticando situações de viagem.',
            weak_points: ['listening'],
            recommended_approach: 'Frases curtas e contextualizadas.',
        },
        error: null,
    });
    return query;
};

const generatedActivities = [
    {
        type: 'reading',
        title: 'Reading at the airport',
        description: 'Leia uma placa de embarque.',
        content: { instructions_pt: 'Leia com atenção.', text: 'Your flight boards at gate twelve.', checklist: ['Localizei o portão.'], reflection_prompt: 'O que você entendeu?' },
        difficulty: 'BEGINNER',
        xp_reward: 50,
    },
    {
        type: 'grammar',
        title: 'Grammar for check-in',
        description: 'Pratique perguntas no balcão.',
        content: { rule_pt: 'Use do/does em perguntas.', exercises: [{ sentence: '___ you have a passport?', options: ['Do', 'Does'], correct: 0, exp: 'You pede do.' }] },
        difficulty: 'BEGINNER',
        xp_reward: 50,
    },
    {
        type: 'quiz',
        title: 'Airport quick quiz',
        description: 'Confira o vocabulário da viagem.',
        content: { instructions_pt: 'Escolha a resposta.', questions: [{ q: 'Where do you board?', options: ['At the gate', 'At baggage claim'], correct: 0, exp: 'Boarding happens at the gate.' }] },
        difficulty: 'BEGINNER',
        xp_reward: 50,
    },
    {
        type: 'conversation',
        title: 'Check-in conversation',
        description: 'Simule uma conversa no aeroporto.',
        content: { scenario: 'Airport check-in', instructions_pt: 'Fale em voz alta.', preparation: ['Separe seu passaporte.'], target_phrases: ['Here is my passport.'], reflection_prompt: 'Como foi a prática?' },
        difficulty: 'BEGINNER',
        xp_reward: 50,
    },
];

const savedActivities = generatedActivities.map((activity, index) => ({
    type: activity.type,
    title: activity.title,
    description: activity.description,
    difficulty: activity.difficulty,
    id: `generated-${index + 1}`,
    student_id: 'student-1',
    tenant_id: 'tenant-1',
    content: activity.type === 'grammar'
        ? {
            rule_pt: activity.content.rule_pt,
            exercises: activity.content.exercises.map((exercise: any) => ({
                sentence: exercise.sentence,
                options: exercise.options,
            })),
        }
        : activity.type === 'quiz'
            ? {
                instructions_pt: activity.content.instructions_pt,
                questions: activity.content.questions.map((question: any) => ({
                    q: question.q,
                    options: question.options,
                })),
            }
            : activity.content,
    xp_reward: 0,
    status: 'PENDING' as const,
    generated_by_ai: true,
}));

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.from.mockImplementation((table: string) => {
        if (table === 'student_activities') return activitiesQuery();
        if (table === 'profiles') return profileQuery();
        if (table === 'wolf_intelligence') return wolfQuery();
        throw new Error(`Unexpected table in test: ${table}`);
    });
    mocks.rpc.mockImplementation((name: string) => {
        if (name === 'get_student_complementary_activities') {
            return Promise.resolve({ data: pendingActivities, error: null });
        }
        return Promise.resolve({
            data: null,
            error: { message: 'completion unavailable' },
        });
    });
});

afterEach(() => vi.restoreAllMocks());

describe('<StudentActivities /> — conclusão com evidência', () => {
    it('não conclui às cegas, envia evidência pelo RPC e preserva a mesma chave no retry', async () => {
        render(<StudentActivities userId="student-1" tenantId="tenant-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /leitura segura/i }));

        const dialog = await screen.findByRole('dialog', { name: 'Leitura segura' });
        const conclude = screen.getByRole('button', { name: /concluir atividade/i });
        expect(conclude).toBeDisabled();
        expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'complete_student_complementary_activity',
        )).toHaveLength(0);

        screen.getAllByRole('checkbox').forEach(checkbox => fireEvent.click(checkbox));
        fireEvent.change(screen.getByLabelText('Sua reflexão'), {
            target: {
                value: 'Eu entendi a ideia principal e anotei as palavras que preciso revisar.',
            },
        });
        expect(conclude).toBeEnabled();
        fireEvent.click(conclude);

        await waitFor(() => expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'complete_student_complementary_activity',
        )).toHaveLength(1));
        expect(mocks.rpc).toHaveBeenCalledWith(
            'complete_student_complementary_activity',
            expect.objectContaining({
                p_activity_id: 'activity-1',
                p_evidence: expect.objectContaining({
                    activityId: 'activity-1',
                    activityType: 'reading',
                    contentMode: 'legacy',
                    checklistCompleted: expect.any(Array),
                    reflection: expect.stringMatching(/ideia principal/i),
                    completedAt: expect.any(String),
                }),
                p_request_key: expect.any(String),
            }),
        );

        expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível registrar/i);
        expect(dialog).toBeInTheDocument();
        expect(screen.getByText(/3 pendentes/i)).toBeInTheDocument();

        const firstCompletion = mocks.rpc.mock.calls.find(
            ([name]) => name === 'complete_student_complementary_activity',
        );
        expect(firstCompletion).toBeDefined();
        const firstRequestKey = firstCompletion![1].p_request_key;
        fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));
        await waitFor(() => expect(mocks.rpc.mock.calls.filter(
            ([name]) => name === 'complete_student_complementary_activity',
        )).toHaveLength(2));
        const completionCalls = mocks.rpc.mock.calls.filter(
            ([name]) => name === 'complete_student_complementary_activity',
        );
        expect(completionCalls[1][1].p_request_key).toBe(firstRequestKey);
    });

    it('não reintroduz update direto que transforma falha em falso sucesso', () => {
        const componentsDir = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.join(componentsDir, 'StudentActivities.tsx'), 'utf8');
        const compactSource = source.replace(/\s+/g, ' ');

        expect(source).toContain("rpc('complete_student_complementary_activity'");
        expect(compactSource).not.toMatch(/from\(['"]student_activities['"]\)\s*\.update/);
    });

    it('mantém quiz reprovado pendente e usa nova chave somente na nova tentativa', async () => {
        let completionAttempt = 0;
        mocks.rpc.mockImplementation((name: string, payload: Record<string, any>) => {
            if (name === 'get_student_complementary_activities') {
                return Promise.resolve({ data: [sanitizedQuizActivity], error: null });
            }
            if (name === 'complete_student_complementary_activity') {
                completionAttempt += 1;
                const selectedIndex = payload.p_evidence.answers[0];
                const passed = completionAttempt === 2;
                return Promise.resolve({
                    data: {
                        activityId: 'activity-secure-quiz',
                        status: passed ? 'COMPLETED' : 'PENDING',
                        passed,
                        scorePercentage: passed ? 100 : 0,
                        questionResults: [{
                            questionId: 'secure-q1',
                            selectedIndex,
                            correct: passed,
                            correctIndex: 0,
                            explanation: 'A primeira alternativa é a correta.',
                        }],
                        completedAt: passed ? '2026-08-31T12:00:00.000Z' : null,
                        alreadyApplied: false,
                        evidenceAccepted: true,
                        streakCount: 1,
                        xpEarned: 0,
                    },
                    error: null,
                });
            }
            return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
        });

        render(<StudentActivities userId="student-1" tenantId="tenant-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /quiz complementar seguro/i }));
        fireEvent.click(screen.getByRole('radio', { name: /b\. wrong/i }));
        fireEvent.click(screen.getByRole('button', { name: /conferir respostas/i }));

        expect(await screen.findByText(/você acertou 0 de 1.*0%/i)).toBeInTheDocument();
        expect(screen.getByText(/1 pendente/i)).toBeInTheDocument();
        expect(screen.getByText(/0 concluída/i)).toBeInTheDocument();

        const firstCall = mocks.rpc.mock.calls.find(
            ([name]) => name === 'complete_student_complementary_activity',
        );
        expect(firstCall).toBeDefined();
        expect(firstCall![1].p_evidence).toEqual(expect.objectContaining({
            activityId: 'activity-secure-quiz',
            activityType: 'quiz',
            contentMode: 'structured',
            answers: [1],
            questionIds: ['secure-q1'],
        }));
        expect(firstCall![1].p_evidence).not.toHaveProperty('scorePercentage');
        expect(firstCall![1].p_evidence).not.toHaveProperty('questionResults');
        expect(JSON.stringify(firstCall![1].p_evidence)).not.toMatch(
            /correct(?:Index|_option_index)?/i,
        );

        fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));
        fireEvent.click(screen.getByRole('radio', { name: /a\. right/i }));
        fireEvent.click(screen.getByRole('button', { name: /conferir respostas/i }));

        expect(await screen.findByText(/aprendizado consolidado/i)).toBeInTheDocument();
        const completionCalls = mocks.rpc.mock.calls.filter(
            ([name]) => name === 'complete_student_complementary_activity',
        );
        expect(completionCalls).toHaveLength(2);
        expect(completionCalls[1][1].p_request_key).not.toBe(
            completionCalls[0][1].p_request_key,
        );
        expect(screen.getByText(/0 pendentes/i)).toBeInTheDocument();
        expect(screen.getByText(/1 concluída/i)).toBeInTheDocument();
    });

    it('carrega atividades pelo runtime sanitizado sem baixar o gabarito bruto', () => {
        const componentsDir = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.join(componentsDir, 'StudentActivities.tsx'), 'utf8');
        const compactSource = source.replace(/\s+/g, ' ');

        expect(compactSource).toMatch(/\.rpc\(\s*['"]get_student_complementary_activities['"]/);
        expect(compactSource).not.toMatch(
            /from\(['"]student_activities['"]\)\s*\.select/,
        );
    });

    it('reaproveita a mesma chave do pedido depois de uma falha ambígua', async () => {
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'get_student_complementary_activities') {
                return Promise.resolve({ data: [], error: null });
            }
            return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
        });
        mocks.generateActivities
            .mockRejectedValueOnce(new mocks.ActivityGenerationError(
                'A resposta da primeira tentativa se perdeu.',
                { code: 'ACTIVITY_GENERATOR_UNREACHABLE', retryable: true },
            ))
            .mockResolvedValueOnce({
                activities: savedActivities,
                source: 'replay',
                requestKey: 'replayed-by-server',
            });

        render(<StudentActivities userId="student-1" tenantId="tenant-1" />);
        fireEvent.click(await screen.findByRole('button', { name: /criar novo pacote/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/primeira tentativa se perdeu/i);
        expect(mocks.generateActivities).toHaveBeenCalledTimes(1);
        const firstRequestKey = mocks.generateActivities.mock.calls[0][0];
        expect(firstRequestKey).toMatch(/^[0-9a-f-]{36}$/i);
        fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));

        await waitFor(() => expect(mocks.generateActivities).toHaveBeenCalledTimes(2));
        expect(mocks.generateActivities.mock.calls[1][0]).toBe(firstRequestKey);
        expect(await screen.findByText('Reading at the airport')).toBeInTheDocument();
    });

    it('usa uma nova chave após rejeição definitiva do servidor', async () => {
        mocks.generateActivities
            .mockRejectedValueOnce(new mocks.ActivityGenerationError(
                'O pacote não passou pela validação pedagógica.',
                { code: 'INVALID_ACTIVITY_RESPONSE', retryable: false },
            ))
            .mockResolvedValueOnce({
                activities: savedActivities,
                source: 'server',
                requestKey: 'new-server-request',
            });
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'get_student_complementary_activities') {
                return Promise.resolve({ data: [], error: null });
            }
            return Promise.resolve({ data: null, error: { message: 'unexpected rpc' } });
        });

        render(<StudentActivities userId="student-1" tenantId="tenant-1" />);
        fireEvent.click(await screen.findByRole('button', { name: /criar novo pacote/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/não passou pela validação pedagógica/i);
        expect(mocks.generateActivities).toHaveBeenCalledTimes(1);
        const rejectedRequestKey = mocks.generateActivities.mock.calls[0][0];

        fireEvent.click(screen.getByRole('button', { name: /tentar novamente/i }));

        await waitFor(() => expect(mocks.generateActivities).toHaveBeenCalledTimes(2));
        expect(mocks.generateActivities.mock.calls[1][0]).not.toBe(rejectedRequestKey);
        expect(await screen.findByText('Reading at the airport')).toBeInTheDocument();
    });

    it('não baixa perfil, memória ou gabarito para gerar o pacote no navegador', () => {
        const componentsDir = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.join(componentsDir, 'StudentActivities.tsx'), 'utf8');
        const compactSource = source.replace(/\s+/g, ' ');

        expect(source).toContain('generateActivities(generationRequest.requestKey)');
        expect(source).not.toContain('save_student_generated_activities');
        expect(source).not.toContain('get_student_complementary_generation_status');
        expect(compactSource).not.toMatch(/from\(['"]profiles['"]\)/);
        expect(compactSource).not.toMatch(/from\(['"]wolf_intelligence['"]\)/);
        expect(compactSource).not.toMatch(/from\(['"]student_activities['"]\)\s*\.insert/);
    });
});
