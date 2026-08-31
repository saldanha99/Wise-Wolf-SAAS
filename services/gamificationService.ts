import { supabase } from '../lib/supabase';

export type VerifiedXpSource =
    | 'CLASS_LOG_CONFIRM';

export const gamificationService = {
    /**
     * Awards XP only after Postgres verifies the owned, completed source.
     * Amounts, daily caps and idempotency are authoritative on the server.
     */
    async awardVerifiedXP(sourceType: VerifiedXpSource, sourceId: string) {
        try {
            const { data, error } = await supabase.rpc('award_verified_student_xp', {
                p_source_type: sourceType,
                p_source_id: sourceId,
            });
            if (error) throw error;
            return {
                newXP: Number(data?.newXP ?? 0),
                newLevel: Number(data?.newLevel ?? 1),
                leveledUp: data?.leveledUp === true,
                xpEarned: Number(data?.xpEarned ?? 0),
                alreadyAwarded: data?.alreadyAwarded === true,
            };
        } catch (err) {
            console.error('Verified XP award failed:', err);
            return null;
        }
    },

    /** Divisão da liga a partir do XP total (estilo Duolingo). */
    leagueDivision(xp: number): { tier: string; emoji: string; cor: string; min: number; next: number | null } {
        const tiers = [
            { tier: 'Bronze',   emoji: '🥉', cor: '#cd7f32', min: 0 },
            { tier: 'Prata',    emoji: '🥈', cor: '#9ca3af', min: 500 },
            { tier: 'Ouro',     emoji: '🥇', cor: '#f59e0b', min: 1500 },
            { tier: 'Platina',  emoji: '💎', cor: '#22d3ee', min: 3000 },
            { tier: 'Diamante', emoji: '👑', cor: '#a78bfa', min: 6000 },
        ];
        let atual = tiers[0];
        for (const t of tiers) if (xp >= t.min) atual = t;
        const idx = tiers.indexOf(atual);
        const next = idx < tiers.length - 1 ? tiers[idx + 1].min : null;
        return { ...atual, next };
    }
};
