import { supabase } from './supabase';
import type { SchoolInfo } from '../components/ContractDocument';

// ─────────────────────────────────────────────────────────────────────────────
// Carrega os dados da escola (tenants.school_info) para preencher o contrato.
// Memoiza por tenant para evitar buscas repetidas durante a sessão.
// Quando o tenant não tem school_info, retorna null → ContractDocument usa os
// defaults/placeholders. Configurável em Configurações → Dados da Escola.
// ─────────────────────────────────────────────────────────────────────────────

const cache = new Map<string, SchoolInfo | null>();

export async function getSchoolInfo(tenantId?: string | null): Promise<SchoolInfo | null> {
    if (!tenantId) return null;
    if (cache.has(tenantId)) return cache.get(tenantId) ?? null;

    try {
        const { data } = await supabase
            .rpc('get_my_tenant_config')
            .maybeSingle();

        const tenantConfig = data as { school_info?: SchoolInfo | null } | null;
        const info: SchoolInfo | null =
            tenantConfig?.school_info && Object.keys(tenantConfig.school_info).length > 0
                ? tenantConfig.school_info
                : null;

        cache.set(tenantId, info);
        return info;
    } catch (_) {
        // Silencioso — contrato cai nos defaults da Wise Wolf
        cache.set(tenantId, null);
        return null;
    }
}
