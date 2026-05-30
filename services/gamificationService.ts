import { supabase } from '../lib/supabase';

export const gamificationService = {
    /**
     * Adds XP to a user and handles leveling up
     */
    async addXP(userId: string, amount: number) {
        try {
            // 1. Get current stats
            const { data: profile, error: fetchError } = await supabase
                .from('profiles')
                .select('xp, level')
                .eq('id', userId)
                .single();

            if (fetchError) throw fetchError;

            const currentXP = profile.xp || 0;
            const currentLevel = profile.level || 1;
            const newXP = currentXP + amount;

            // Simple leveling logic: Level = floor(XP / 1000) + 1
            const newLevel = Math.floor(newXP / 1000) + 1;

            // 2. Update profile
            const { error: updateError } = await supabase
                .from('profiles')
                .update({
                    xp: newXP,
                    level: newLevel,
                    last_activity: new Date().toISOString()
                })
                .eq('id', userId);

            if (updateError) throw updateError;

            return { newXP, newLevel, leveledUp: newLevel > currentLevel };
        } catch (err) {
            console.error('Error adding XP:', err);
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
                .update({ hearts: novo, hearts_updated_at: new Date().toISOString() })
                .eq('id', userId);
            return novo;
        } catch (err) {
            console.error('loseHeart error:', err);
            return 5;
        }
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
