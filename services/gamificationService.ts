import { supabase } from '../lib/supabase';

export const gamificationService = {
    /**
     * Adds XP to a user via the new event-driven gamification system
     */
    async addXP(userId: string, tenantId: string, amount: number, source: string = 'ATTENDANCE', refId?: string) {
        try {
            const { data, error } = await supabase.rpc('record_xp_event', {
                p_student_id: userId,
                p_tenant_id: tenantId,
                p_source: source,
                p_amount: amount,
                p_ref_id: refId
            });

            if (error) throw error;

            // Simple level logic for immediate UI feedback: Level = floor(total_xp / 1000) + 1
            // We fetch the current total from the matview or use daily_xp fallback
            const { data: xpTotals } = await supabase
                .from('student_xp_totals')
                .select('total_xp')
                .eq('student_id', userId)
                .single();

            const newXP = xpTotals?.total_xp || data?.daily_xp || amount;
            const newLevel = Math.floor(newXP / 1000) + 1;

            return { newXP, newLevel, leveledUp: data?.goal_met || false };
        } catch (err) {
            console.error('Error adding XP:', err);
            return null;
        }
    },

    /**
     * Streak update is now handled implicitly by `record_xp_event` and `validate-streaks` cron.
     * Stubbed to prevent breaking legacy imports.
     */
    async updateStreak(userId: string) {
        console.warn('gamificationService.updateStreak is deprecated. Streaks are updated via record_xp_event.');
        return null;
    }
};
