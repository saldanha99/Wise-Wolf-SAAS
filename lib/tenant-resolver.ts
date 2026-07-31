/**
 * tenant-resolver.ts
 * Detecta o tenant a partir do hostname antes do login.
 *
 * Lógica de resolução (em ordem):
 *  1. localhost / *.vercel.app / *.local → null (portal master)
 *  2. wisewolflanguage.com.br ou www.wisewolflanguage.com.br → null (portal master)
 *  3. <slug>.wisewolflanguage.com.br → busca por tenants.slug = "<slug>"
 *  4. qualquer outro hostname → busca por tenants.custom_domain = hostname
 */

import { supabase } from './supabase';

export const BASE_DOMAIN = 'wisewolflanguage.com.br';

export interface ResolvedTenant {
    id: string;
    name: string;
    slug: string | null;
    custom_domain: string | null;
    custom_domain_verified: boolean;
    branding: {
        primaryColor: string;
        secondaryColor: string;
        logoUrl: string;
        faviconUrl: string;
    } | null;
    school_info: Record<string, string> | null;
}

let _cache: ResolvedTenant | null | false = false; // false = não resolvido ainda

/** Resolve o tenant a partir do hostname atual. Resultado é cacheado em memória. */
export async function resolveTenantFromHostname(): Promise<ResolvedTenant | null> {
    if (_cache !== false) return _cache;

    const hostname = window.location.hostname;

    // Ambientes de desenvolvimento e deploy preview → portal master
    if (
        hostname === 'localhost' ||
        hostname.startsWith('127.') ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.vercel.app')
    ) {
        _cache = null;
        return null;
    }

    // Domínio raiz Wise Wolf → portal master
    if (hostname === BASE_DOMAIN || hostname === `www.${BASE_DOMAIN}`) {
        _cache = null;
        return null;
    }

    try {
        // A resolução pré-login passa por uma RPC que devolve somente branding
        // público. A tabela tenants contém credenciais e nunca deve ser exposta
        // diretamente ao papel anônimo.
        const { data, error } = await supabase.rpc('resolve_public_tenant', {
            p_hostname: hostname,
        });
        if (error) throw error;

        const tenant = Array.isArray(data) ? data[0] : data;
        _cache = (tenant as ResolvedTenant | undefined) ?? null;
    } catch {
        _cache = null;
    }

    return _cache === false ? null : _cache;
}

/** Retorna a URL pública do tenant (subdomínio ou domínio próprio verificado). */
export function getTenantPublicUrl(tenant: { slug?: string | null; custom_domain?: string | null; custom_domain_verified?: boolean }): string {
    if (tenant.custom_domain && tenant.custom_domain_verified) {
        return `https://${tenant.custom_domain}`;
    }
    if (tenant.slug) {
        return `https://${tenant.slug}.${BASE_DOMAIN}`;
    }
    return window.location.origin;
}

/** Gera um slug a partir do nome da escola. */
export function slugify(name: string): string {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // remove acentos
        .replace(/[^a-z0-9\s-]/g, '')      // só alfanumérico, espaço, hífen
        .trim()
        .replace(/\s+/g, '-')              // espaços → hífen
        .replace(/-+/g, '-')               // hífens duplos → simples
        .slice(0, 40);                     // máximo 40 chars
}

/** Invalida o cache (útil após salvar novo slug/domínio). */
export function clearTenantCache(): void {
    _cache = false;
}
