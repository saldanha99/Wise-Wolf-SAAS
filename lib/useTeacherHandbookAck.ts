import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';
import { TEACHER_HANDBOOK_ACK_ID } from './teacherHandbook';

/**
 * Leu e confirmou o manual? `null` enquanto carrega ou se a leitura falhou —
 * quem usa só mostra o lembrete com `false` confirmado, nunca por erro.
 */
export function useTeacherHandbookAck(userId: string | undefined) {
    const [acknowledged, setAcknowledged] = useState<boolean | null>(null);

    useEffect(() => {
        if (!userId) return;
        let active = true;
        supabase
            .from('feature_tour_views')
            .select('tour_id')
            .eq('user_id', userId)
            .eq('tour_id', TEACHER_HANDBOOK_ACK_ID)
            .maybeSingle()
            .then(({ data, error }) => {
                if (!active) return;
                setAcknowledged(error ? null : Boolean(data));
            });
        return () => { active = false; };
    }, [userId]);

    const acknowledge = useCallback(async (): Promise<boolean> => {
        if (!userId) return false;
        const { error } = await supabase
            .from('feature_tour_views')
            .upsert({ user_id: userId, tour_id: TEACHER_HANDBOOK_ACK_ID }, { onConflict: 'user_id,tour_id', ignoreDuplicates: true });
        if (error) return false;
        setAcknowledged(true);
        return true;
    }, [userId]);

    return { acknowledged, acknowledge };
}

