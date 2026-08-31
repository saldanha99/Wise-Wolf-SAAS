import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    generateActivities,
    getPedagogicalSuggestion,
} from '../services/geminiService';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
    supabase: {
        functions: { invoke: mocks.invoke },
    },
}));

const requestKey = '00000000-0000-4000-8000-000000000321';
const savedActivities = [
    {
        id: 'activity-reading',
        type: 'reading',
        title: 'Reading practice',
        description: 'Read and reflect.',
        content: {
            instructions_pt: 'Leia com atenção.',
            text: 'A sufficiently long English passage for a safe server response.',
            checklist: ['Li o texto.'],
            reflection_prompt: 'O que você entendeu?',
        },
        difficulty: 'BEGINNER',
        status: 'PENDING',
    },
    {
        id: 'activity-grammar',
        type: 'grammar',
        title: 'Grammar practice',
        description: 'Choose the best option.',
        content: {
            rule_pt: 'Use o presente simples.',
            exercises: [{ sentence: 'She ___ daily.', options: ['studies', 'study'] }],
        },
        difficulty: 'BEGINNER',
        status: 'PENDING',
    },
    {
        id: 'activity-quiz',
        type: 'quiz',
        title: 'Vocabulary quiz',
        description: 'Review useful vocabulary.',
        content: {
            instructions_pt: 'Escolha uma opção.',
            questions: [{ q: 'Choose one.', options: ['First', 'Second'] }],
        },
        difficulty: 'BEGINNER',
        status: 'PENDING',
    },
    {
        id: 'activity-conversation',
        type: 'conversation',
        title: 'Speaking practice',
        description: 'Speak about your routine.',
        content: {
            scenario: 'daily_routine',
            instructions_pt: 'Fale em voz alta.',
            preparation: ['Organize suas ideias.'],
            target_phrases: ['Every morning I'],
            reflection_prompt: 'Como foi a prática?',
        },
        difficulty: 'BEGINNER',
        status: 'PENDING',
    },
];

beforeEach(() => {
    vi.clearAllMocks();
});

describe('generateActivities — contrato complementar seguro', () => {
    it('envia somente ação dedicada e chave idempotente', async () => {
        mocks.invoke.mockResolvedValue({
            data: { activities: savedActivities, requestKey, replay: false },
            error: null,
        });

        const result = await generateActivities(requestKey);

        expect(mocks.invoke).toHaveBeenCalledWith('pedagogical-content', {
            body: {
                action: 'student_complementary_pack',
                requestKey,
            },
        });
        const body = mocks.invoke.mock.calls[0][1].body;
        expect(Object.keys(body).sort()).toEqual(['action', 'requestKey']);
        expect(JSON.stringify(body)).not.toMatch(/prompt|profile|wolf|correct|answer/i);
        expect(result.activities).toHaveLength(4);
        expect(result.source).toBe('server');
    });

    it('recusa resposta que volte a expor gabarito ou explicação', async () => {
        const leaked = structuredClone(savedActivities);
        (leaked[2].content.questions[0] as Record<string, unknown>).correct = 0;
        mocks.invoke.mockResolvedValue({
            data: { activities: leaked, requestKey },
            error: null,
        });

        await expect(generateActivities(requestKey)).rejects.toMatchObject({
            code: 'INVALID_ACTIVITY_RESPONSE',
            retryable: false,
        });
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    it('não mantém fallback, perfil ou prompt complementar no bundle cliente', () => {
        const componentsDir = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.join(componentsDir, '../services/geminiService.ts'), 'utf8');
        const activitySection = source.slice(
            source.indexOf('export const generateActivities'),
            source.indexOf('export const getPedagogicalSuggestion'),
        );

        expect(activitySection).toContain("action: STUDENT_COMPLEMENTARY_ACTION");
        expect(activitySection).not.toMatch(/prompt|profile|wolfIntelligence|getFallbackActivities/);
        expect(source).not.toContain('getFallbackActivities');
    });

    it('entrega dica pedagógica determinística sem reabrir prompt de aluno', async () => {
        await expect(getPedagogicalSuggestion('B1', 'qualquer conteúdo')).resolves.toMatch(
            /opinião.*exemplo.*conclusão/i,
        );
        expect(mocks.invoke).not.toHaveBeenCalled();

        const componentsDir = path.dirname(fileURLToPath(import.meta.url));
        const source = readFileSync(path.join(componentsDir, '../services/geminiService.ts'), 'utf8');
        const tipSection = source.slice(
            source.indexOf('export const getPedagogicalSuggestion'),
            source.indexOf('// =============================================================', source.indexOf('export const getPedagogicalSuggestion')),
        );
        expect(tipSection).not.toContain('functions.invoke');
        expect(tipSection).not.toContain('prompt');
    });
});
