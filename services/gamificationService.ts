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
     * Updates the streak count if the user logs in on a new day
     */
    async updateStreak(userId: string) {
        try {
            const { data: profile, error: fetchError } = await supabase
                .from('profiles')
                .select('streak_count, last_activity')
                .eq('id', userId)
                .single();

            if (fetchError) throw fetchError;

            const lastActivity = profile.last_activity ? new Date(profile.last_activity) : null;
            const now = new Date();

            if (!lastActivity) {
                // First time
                await supabase.from('profiles').update({ streak_count: 1, last_activity: now.toISOString() }).eq('id', userId);
                return 1;
            }

            const diffDays = Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));

            if (diffDays === 1) {
                // Consecutive day
                const newStreak = (profile.streak_count || 0) + 1;
                await supabase.from('profiles').update({ streak_count: newStreak, last_activity: now.toISOString() }).eq('id', userId);
                return newStreak;
            } else if (diffDays > 1) {
                // Broke streak
                await supabase.from('profiles').update({ streak_count: 1, last_activity: now.toISOString() }).eq('id', userId);
                return 1;
            }

            return profile.streak_count;
        } catch (err) {
            console.error('Error updating streak:', err);
            return null;
        }
    }
};
