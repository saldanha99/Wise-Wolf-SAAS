import type { SchoolInfo } from '../components/ContractDocument';
import { tenantLegalAssetsService } from '../services/tenantLegalAssetsService';

// ─────────────────────────────────────────────────────────────────────────────
// Carrega os dados da escola (tenants.school_info) para preencher o contrato.
// Memoiza por tenant para evitar buscas repetidas durante a sessão.
// Quando o tenant não tem school_info, retorna null e o contrato falha fechado
// com placeholders neutros. Nunca há fallback jurídico da plataforma.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 12 * 60 * 1000;
const cache = new Map<string, { value: SchoolInfo | null; expiresAt: number }>();

export function clearSchoolInfoCache(tenantId?: string | null) {
    if (tenantId) cache.delete(tenantId);
    else cache.clear();
}

export async function getSchoolInfo(tenantId?: string | null): Promise<SchoolInfo | null> {
    if (!tenantId) return null;
    const cached = cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) cache.delete(tenantId);

    try {
        const tenantConfig = await tenantLegalAssetsService.current();
        if (!tenantConfig?.tenantId || tenantConfig.tenantId !== tenantId) {
            cache.set(tenantId, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
            return null;
        }
        const info: SchoolInfo | null =
            tenantConfig.schoolInfo && Object.keys(tenantConfig.schoolInfo).length > 0
                ? tenantConfig.schoolInfo
                : null;

        cache.set(tenantId, { value: info, expiresAt: Date.now() + CACHE_TTL_MS });
        return info;
    } catch (_) {
        // Silencioso: a camada de contrato exibe o bloqueio de configuração.
        cache.set(tenantId, { value: null, expiresAt: Date.now() + 30_000 });
        return null;
    }
}
