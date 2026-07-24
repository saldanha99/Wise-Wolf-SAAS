
import { createClient } from '@supabase/supabase-js';

const requirePublicEnv = (name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY', value?: string) => {
    const normalized = value?.trim();

    if (!normalized) {
        throw new Error(`[Configuração] ${name} não foi definida no build do frontend.`);
    }

    return normalized;
};

// Não use fallback para outro projeto: um build mal configurado deve falhar antes
// de autenticar ou gravar dados no ambiente anterior.
export const SUPABASE_URL = requirePublicEnv('VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL)
    .replace(/\/+$/, '');
export const SUPABASE_ANON_KEY = requirePublicEnv('VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY);
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
    },
});
