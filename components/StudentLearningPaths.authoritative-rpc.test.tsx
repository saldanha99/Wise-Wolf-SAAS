import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import StudentLearningPaths from './StudentLearningPaths';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
    supabase: {
        from: mocks.from,
        rpc: mocks.rpc,
    },
}));

vi.mock('./ActivityPlayer', () => ({
    default: ({ activity, onComplete, reviewOnly }: { activity: any; onComplete: (score: number) => Promise<void> | void; reviewOnly?: boolean }) => (
        <div role="dialog" aria-label={`Player ${activity.title}`}>
            <span data-testid="active-activity-content">{JSON.stringify(activity.content)}</span>
            <span data-testid="player-mode">{reviewOnly ? 'review-only' : 'interactive'}</span>
            {!reviewOnly && <button type="button" onClick={() => void onComplete(100)}>Concluir player simulado</button>}
        </div>
    ),
}));

vi.mock('./StreakModal', () => ({
    default: () => null,
}));

vi.mock('../services/gamificationService', () => ({
    gamificationService: {},
}));

const availablePath = {
    id: 'path-1',
    name: 'Inglês para viagens',
    description: 'Uma trilha segura para praticar em contexto.',
    target_level: 'A2',
    category: 'TRAVEL',
    estimated_hours: 8,
};

const queryFor = (table: string) => {
    const query: any = {};
    query.select = vi.fn(() => query);
    query.eq = vi.fn(() => query);
    query.or = vi.fn(() => query);
    query.is = vi.fn(() => query);
    query.in = vi.fn(() => query);

    if (table === 'learning_paths') {
        query.order = vi.fn().mockResolvedValue({ data: [availablePath], error: null });
        query.limit = vi.fn().mockResolvedValue({ data: [availablePath], error: null });
        return query;
    }

    if (table === 'student_path_enrollments') {
        query.order = vi.fn(() => query);
        query.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        return query;
    }

    if (table === 'profiles') {
        query.order = vi.fn(() => query);
        query.limit = vi.fn().mockResolvedValue({ data: [], error: null });
        query.maybeSingle = vi.fn().mockResolvedValue({
            data: {
                xp: 0,
                streak_count: 0,
                hearts: 5,
                daily_xp: 0,
                daily_xp_date: null,
                daily_xp_goal: 30,
            },
            error: null,
        });
        return query;
    }

    query.order = vi.fn().mockResolvedValue({ data: [], error: null });
    query.limit = vi.fn().mockResolvedValue({ data: [], error: null });
    query.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    return query;
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.from.mockImplementation(queryFor);
});

afterEach(() => vi.restoreAllMocks());

describe('<StudentLearningPaths /> — gravações autoritativas', () => {
    it('abre nós concluídos somente em revisão e não oferece uma nova conclusão', async () => {
        const units = [{
            id: 'unit-1',
            path_id: 'path-1',
            order_index: 1,
            title: 'Unidade revisável',
            description: 'Conteúdo concluído continua disponível.',
            estimated_minutes: 10,
            skill_focus: ['vocabulary'],
        }];
        const completedActivity = {
            id: 'activity-completed',
            unit_id: 'unit-1',
            order_index: 1,
            type: 'vocab_cards',
            title: 'Atividade concluída',
            description: 'Disponível apenas para consulta.',
            content: { cards: [{ term: 'safe', translation: 'seguro' }] },
            xp_reward: 20,
            estimated_minutes: 5,
            locked: false,
        };
        const currentActivity = {
            id: 'activity-current',
            unit_id: 'unit-1',
            order_index: 2,
            type: 'quiz',
            title: 'Atividade atual',
            description: 'Próxima tentativa válida.',
            content: { questions: [{ id: 'q1', q: 'Continue?', options: ['A', 'B'] }] },
            xp_reward: 20,
            estimated_minutes: 5,
            locked: false,
        };

        mocks.from.mockImplementation((table: string) => {
            const query = queryFor(table);
            if (table === 'student_path_enrollments') {
                query.limit = vi.fn().mockResolvedValue({
                    data: [{ path_id: 'path-1', current_unit_id: 'unit-1' }],
                    error: null,
                });
            }
            return query;
        });
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'get_student_practice_status') {
                return Promise.resolve({
                    data: { xp: 20, streakCount: 1, hearts: 5, dailyXp: 20, dailyXpGoal: 30 },
                    error: null,
                });
            }
            if (name === 'get_student_learning_path_runtime') {
                return Promise.resolve({
                    data: {
                        units,
                        activities: [completedActivity, currentActivity],
                        progress: [{ activity_id: 'activity-completed', status: 'COMPLETED', score: 100 }],
                    },
                    error: null,
                });
            }
            return Promise.resolve({ data: [], error: null });
        });

        render(<StudentLearningPaths userId="student-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /revisar atividade concluída/i }));
        expect(screen.getByRole('dialog', { name: /player atividade concluída/i })).toBeInTheDocument();
        expect(screen.getByTestId('player-mode')).toHaveTextContent('review-only');
        expect(screen.queryByRole('button', { name: /concluir player simulado/i })).not.toBeInTheDocument();
        expect(mocks.rpc.mock.calls.filter(([name]) => name === 'complete_learning_activity')).toHaveLength(0);
    });

    it('não entra visualmente na trilha quando a matrícula segura falha e permite tentar novamente', async () => {
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'enroll_student_learning_path') {
                return Promise.resolve({
                    data: null,
                    error: { message: 'enrollment unavailable' },
                });
            }
            if (name === 'get_student_practice_status') {
                return Promise.resolve({
                    data: {
                        xp: 0,
                        streakCount: 0,
                        hearts: 5,
                        dailyXp: 0,
                        dailyXpGoal: 30,
                    },
                    error: null,
                });
            }
            return Promise.resolve({ data: null, error: null });
        });

        render(<StudentLearningPaths userId="student-1" />);

        fireEvent.click(await screen.findByRole('button', { name: /inglês para viagens/i }));

        await waitFor(() => {
            expect(mocks.rpc).toHaveBeenCalledWith('enroll_student_learning_path', {
                p_path_id: 'path-1',
                p_switch_current: false,
                p_reason: null,
                p_student_id: null,
            });
        });

        expect(await screen.findByRole('alert')).toHaveTextContent(/não foi possível.*(iniciar|matricular|trilha)/i);
        expect(screen.getByRole('button', { name: /inglês para viagens/i })).toBeInTheDocument();
        expect(screen.queryByText(/unidade 1/i)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /tentar novamente/i })).toBeInTheDocument();
    });

    it('não reintroduz escrita direta de matrícula ou conclusão no navegador', () => {
        const componentsDir = path.dirname(fileURLToPath(import.meta.url));
        const pathsSource = readFileSync(path.join(componentsDir, 'StudentLearningPaths.tsx'), 'utf8');
        const playerSource = readFileSync(path.join(componentsDir, 'ActivityPlayer.tsx'), 'utf8');
        const compactPaths = pathsSource.replace(/\s+/g, ' ');
        const compactPlayer = playerSource.replace(/\s+/g, ' ');

        expect(pathsSource).toContain("rpc('enroll_student_learning_path'");
        expect(compactPaths).not.toMatch(/from\(['"]student_path_enrollments['"]\)\s*\.upsert/);

        expect(playerSource).toContain("rpc('complete_learning_activity'");
        expect(compactPlayer).not.toMatch(/from\(['"]student_activity_progress['"]\)\s*\.upsert/);
        expect(playerSource).not.toContain('gamificationService.getHearts');
    });

    it('carrega a trilha pelo runtime sanitizado sem baixar catálogo, progresso ou gabarito bruto', () => {
        const componentsDir = path.dirname(fileURLToPath(import.meta.url));
        const pathsSource = readFileSync(path.join(componentsDir, 'StudentLearningPaths.tsx'), 'utf8');
        const playerSource = readFileSync(path.join(componentsDir, 'ActivityPlayer.tsx'), 'utf8');
        const compactPaths = pathsSource.replace(/\s+/g, ' ');

        expect(compactPaths).toMatch(/\.rpc\(\s*['"]get_student_learning_path_runtime['"]/);
        expect(compactPaths).not.toMatch(/from\(['"]learning_units['"]\)/);
        expect(compactPaths).not.toMatch(/from\(['"]unit_activities['"]\)/);
        expect(compactPaths).not.toMatch(/from\(['"]student_activity_progress['"]\)/);
        expect(compactPaths).not.toMatch(/\.select\(['"]\*['"]\)[\s\S]{0,180}unit_activities/);
        // Feedback autoritativo pode conter `correct`/`correctIndex` somente
        // depois da submissão. O runner não pode corrigir usando o conteúdo
        // sanitizado recebido antes da tentativa.
        expect(playerSource).not.toMatch(/\bq\.(?:correct|correctIndex|correct_option_index)\b/);
        expect(playerSource).not.toMatch(/\bactivity\.content\??\.(?:correct|correctIndex|correct_option_index)\b/);
        expect(playerSource).not.toContain('q.exp');
    });

    it('recarrega o runtime antes de liberar a próxima atividade que veio sem conteúdo', async () => {
        const units = [{
            id: 'unit-1',
            path_id: 'path-1',
            order_index: 1,
            title: 'Unidade segura',
            description: 'Duas etapas ordenadas.',
            estimated_minutes: 10,
            skill_focus: ['grammar'],
        }];
        const firstActivity = {
            id: 'activity-current',
            unit_id: 'unit-1',
            order_index: 1,
            type: 'quiz',
            title: 'Atividade atual',
            description: 'Disponível agora.',
            content: { questions: [{ id: 'q1', q: 'First?', options: ['A', 'B'] }] },
            xp_reward: 30,
            estimated_minutes: 5,
            locked: false,
        };
        const lockedActivity = {
            id: 'activity-next',
            unit_id: 'unit-1',
            order_index: 2,
            type: 'quiz',
            title: 'Próxima atividade',
            description: 'Só abre após confirmação do servidor.',
            content: null,
            xp_reward: 30,
            estimated_minutes: 5,
            locked: true,
        };
        const unlockedActivity = {
            ...lockedActivity,
            content: { questions: [{ id: 'q2', q: 'Second?', options: ['A', 'B'] }] },
            locked: false,
        };

        mocks.from.mockImplementation((table: string) => {
            const query = queryFor(table);
            if (table === 'student_path_enrollments') {
                query.limit = vi.fn().mockResolvedValue({
                    data: [{ path_id: 'path-1', current_unit_id: 'unit-1' }],
                    error: null,
                });
            }
            return query;
        });

        let resolveRefreshedRuntime: ((value: { data: any; error: null }) => void) | undefined;
        const refreshedRuntime = new Promise<{ data: any; error: null }>(resolve => {
            resolveRefreshedRuntime = resolve;
        });
        let runtimeCalls = 0;
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'get_student_practice_status') {
                return Promise.resolve({
                    data: { xp: 0, streakCount: 0, hearts: 5, dailyXp: 0, dailyXpGoal: 30 },
                    error: null,
                });
            }
            if (name === 'get_student_learning_path_runtime') {
                runtimeCalls += 1;
                if (runtimeCalls === 1) {
                    return Promise.resolve({
                        data: { units, activities: [firstActivity, lockedActivity], progress: [] },
                        error: null,
                    });
                }
                return refreshedRuntime;
            }
            return Promise.resolve({ data: null, error: null });
        });

        render(<StudentLearningPaths userId="student-1" />);

        fireEvent.click(await screen.findByTitle('Atividade atual'));
        expect(screen.getByTestId('active-activity-content')).toHaveTextContent('First?');
        fireEvent.click(screen.getByRole('button', { name: /concluir player simulado/i }));

        await waitFor(() => {
            expect(
                mocks.rpc.mock.calls.filter(([name]) => name === 'get_student_learning_path_runtime'),
            ).toHaveLength(2);
        });
        const nextWhileRefreshing = screen.queryByTitle('Próxima atividade');
        if (nextWhileRefreshing) expect(nextWhileRefreshing).toBeDisabled();
        expect(screen.queryByRole('dialog', { name: /player próxima atividade/i })).not.toBeInTheDocument();

        resolveRefreshedRuntime?.({
            data: {
                units,
                activities: [firstActivity, unlockedActivity],
                progress: [{ activity_id: 'activity-current', status: 'COMPLETED', score: 100 }],
            },
            error: null,
        });

        const nextButton = await screen.findByTitle('Próxima atividade');
        expect(nextButton).toBeEnabled();
        fireEvent.click(nextButton);
        expect(screen.getByTestId('active-activity-content')).toHaveTextContent('Second?');
        expect(screen.getByTestId('active-activity-content')).not.toHaveTextContent(/correct|exp/i);
    });

    it('mantém a próxima etapa bloqueada e mostra aviso quando o runtime não atualiza após a conclusão', async () => {
        const units = [{
            id: 'unit-1',
            path_id: 'path-1',
            order_index: 1,
            title: 'Unidade resiliente',
            description: 'O aluno não fica sem resposta em uma falha de rede.',
            estimated_minutes: 10,
            skill_focus: ['grammar'],
        }];
        const currentActivity = {
            id: 'activity-current',
            unit_id: 'unit-1',
            order_index: 1,
            type: 'quiz',
            title: 'Etapa atual',
            description: 'Disponível agora.',
            content: { questions: [{ id: 'q1', q: 'First?', options: ['A', 'B'] }] },
            xp_reward: 30,
            estimated_minutes: 5,
            locked: false,
        };
        const lockedActivity = {
            id: 'activity-next',
            unit_id: 'unit-1',
            order_index: 2,
            type: 'quiz',
            title: 'Etapa futura',
            description: 'Continua protegida durante a falha.',
            content: null,
            xp_reward: 30,
            estimated_minutes: 5,
            locked: true,
        };

        mocks.from.mockImplementation((table: string) => {
            const query = queryFor(table);
            if (table === 'student_path_enrollments') {
                query.limit = vi.fn().mockResolvedValue({
                    data: [{ path_id: 'path-1', current_unit_id: 'unit-1' }],
                    error: null,
                });
            }
            return query;
        });

        let runtimeCalls = 0;
        mocks.rpc.mockImplementation((name: string) => {
            if (name === 'get_student_practice_status') {
                return Promise.resolve({
                    data: { xp: 0, streakCount: 0, hearts: 5, dailyXp: 0, dailyXpGoal: 30 },
                    error: null,
                });
            }
            if (name === 'get_student_learning_path_runtime') {
                runtimeCalls += 1;
                return runtimeCalls === 1
                    ? Promise.resolve({
                        data: { units, activities: [currentActivity, lockedActivity], progress: [] },
                        error: null,
                    })
                    : Promise.resolve({ data: null, error: { message: 'runtime unavailable' } });
            }
            return Promise.resolve({ data: null, error: null });
        });

        render(<StudentLearningPaths userId="student-1" />);

        fireEvent.click(await screen.findByTitle('Etapa atual'));
        fireEvent.click(screen.getByRole('button', { name: /concluir player simulado/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            /atividade foi registrada.*próxima etapa.*não pôde ser carregada/i,
        );
        const futureAfterFailure = screen.queryByTitle('Etapa futura');
        if (futureAfterFailure) expect(futureAfterFailure).toBeDisabled();
        expect(screen.queryByRole('dialog', { name: /player etapa futura/i })).not.toBeInTheDocument();
    });
});
