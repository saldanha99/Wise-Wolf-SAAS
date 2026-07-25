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

    /**
     * Vidas (hearts) estilo Duolingo.
     * Máx 5. Regenera +1 a cada 30 min a partir de hearts_updated_at.
     */
    HEART_MAX: 5,
    HEART_REGEN_MS: 30 * 60 * 1000, // 30 min por vida

    /** Lê as vidas aplicando regeneração temporal e persiste se mudou */
    async getHearts(userId: string): Promise<number> {
        try {
            const { data: p } = await supabase
                .from('profiles')
                .select('hearts, hearts_updated_at')
                .eq('id', userId)
                .maybeSingle();

            let hearts = p?.hearts ?? this.HEART_MAX;
            const updatedAt = p?.hearts_updated_at ? new Date(p.hearts_updated_at) : null;

            if (hearts < this.HEART_MAX && updatedAt) {
                const elapsed = Date.now() - updatedAt.getTime();
                const regenerated = Math.floor(elapsed / this.HEART_REGEN_MS);
                if (regenerated > 0) {
                    const novo = Math.min(this.HEART_MAX, hearts + regenerated);
                    if (novo !== hearts) {
                        // Mantém o "resto" do tempo para não perder progresso de regen
                        const consumido = (novo - hearts) * this.HEART_REGEN_MS;
                        const novoTimestamp = novo >= this.HEART_MAX
                            ? new Date().toISOString()
                            : new Date(updatedAt.getTime() + consumido).toISOString();
                        await supabase.from('profiles')
                            .update({ hearts: novo, hearts_updated_at: novoTimestamp })
                            .eq('id', userId);
                        hearts = novo;
                    }
                }
            }
            return hearts;
        } catch (err) {
            console.error('getHearts error:', err);
            return this.HEART_MAX;
        }
    },

    /** Perde 1 vida (ao errar). Retorna o novo total. */
    async loseHeart(userId: string): Promise<number> {
        try {
            const atual = await this.getHearts(userId);
            const novo = Math.max(0, atual - 1);
            await supabase.from('profiles')
                // hearts_full_notified=false: ao perder vida, habilita o aviso de "vidas cheias" quando regenerar
                .update({ hearts: novo, hearts_updated_at: new Date().toISOString(), hearts_full_notified: false })
                .eq('id', userId);
            return novo;
        } catch (err) {
            console.error('loseHeart error:', err);
            return 5;
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
    },

    /**
     * Atualiza a ofensiva (streak) por DIA DE CALENDÁRIO.
     * Usa coluna própria `last_streak_date` (date) para não conflitar com
     * `last_activity` (que o addXP sobrescreve). Idempotente no mesmo dia.
     */
    async updateStreak(userId: string) {
        try {
            const { data: profile, error: fetchError } = await supabase
                .from('profiles')
                .select('streak_count, last_streak_date')
                .eq('id', userId)
                .single();

            if (fetchError) throw fetchError;

            // Data de hoje em formato YYYY-MM-DD (dia de calendário, fuso local)
            const hoje = new Date();
            const toDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const hojeStr = toDateStr(hoje);

            const ultimoStr: string | null = profile.last_streak_date
                ? (typeof profile.last_streak_date === 'string'
                    ? profile.last_streak_date.slice(0, 10)
                    : toDateStr(new Date(profile.last_streak_date)))
                : null;

            // Já praticou hoje → não mexe (idempotente)
            if (ultimoStr === hojeStr) {
                return profile.streak_count || 1;
            }

            let novoStreak: number;
            if (!ultimoStr) {
                novoStreak = 1; // primeira vez
            } else {
                const ontem = new Date(hoje);
                ontem.setDate(ontem.getDate() - 1);
                novoStreak = ultimoStr === toDateStr(ontem)
                    ? (profile.streak_count || 0) + 1 // dia consecutivo
                    : 1;                                // quebrou a ofensiva
            }

            await supabase.from('profiles')
                .update({ streak_count: novoStreak, last_streak_date: hojeStr })
                .eq('id', userId);

            return novoStreak;
        } catch (err) {
            console.error('Error updating streak:', err);
            return null;
        }
    }
};
