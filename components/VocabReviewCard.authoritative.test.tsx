import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VocabReviewCard from './VocabReviewCard';

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

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.from.mockImplementation(() => {
        const query: any = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.lte = vi.fn(() => query);
        query.order = vi.fn(() => query);
        query.limit = vi.fn().mockResolvedValue({
            data: [{
                id: 'review-1',
                term: 'reliable',
                translation: 'confiável',
                example: 'This source is reliable.',
                interval_days: 1,
                consecutive_correct: 0,
                total_reviews: 0,
                next_review_at: '2026-08-30T00:00:00.000Z',
            }],
            error: null,
        });
        return query;
    });
});

afterEach(() => vi.restoreAllMocks());

describe('<VocabReviewCard /> — repetição espaçada autoritativa', () => {
    it('preserva a resposta e a mesma chave ao repetir uma gravação que falhou', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: null, error: { message: 'temporarily unavailable' } })
            .mockResolvedValueOnce({ data: { intervalDays: 3 }, error: null });

        render(<VocabReviewCard userId="student-1" />);

        const card = await screen.findByRole('button', { name: /reliable/i });
        fireEvent.click(card);
        fireEvent.click(screen.getByRole('button', { name: /acertei/i }));

        expect(await screen.findByRole('alert')).toHaveTextContent(/resposta continua aqui/i);
        expect(screen.getByText('confiável')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /acertei/i }));
        expect(await screen.findByText(/sessão de revisão concluída/i)).toBeInTheDocument();

        await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
        expect(mocks.rpc.mock.calls[0][0]).toBe('submit_student_vocab_review');
        expect(mocks.rpc.mock.calls[1][0]).toBe('submit_student_vocab_review');
        expect(mocks.rpc.mock.calls[1][1].p_request_key).toBe(
            mocks.rpc.mock.calls[0][1].p_request_key,
        );
    });
});
