/**
 * offerService — Client-side service for creating and resolving signed offers
 *
 * Used by:
 *  - RegistrationLinkGenerator (kind: ENROLLMENT)
 *  - TeacherInviteGenerator (kind: TEACHER_INVITE)
 *  - CommercialInviteGenerator (kind: COMMERCIAL_INVITE)
 *  - PublicRegistration, TeacherOnboarding, CommercialOnboarding (consumers)
 */

import { supabase, supabaseUrl, supabaseAnonKey } from '../lib/supabase';

const FUNCTION_BASE = `${supabaseUrl}/functions/v1`;

/**
 * Create a signed offer link via the sign-offer Edge Function.
 * Falls back to legacy Base64 if the Edge Function is unavailable.
 */
export async function createSignedOffer(params: {
    kind: 'ENROLLMENT' | 'TEACHER_INVITE' | 'COMMERCIAL_INVITE';
    payload: Record<string, any>;
    tenantId: string;
    expiresIn?: string;
}): Promise<{ url: string; offerId?: string; source: 'jwt' | 'legacy' }> {
    try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || supabaseAnonKey;

        if (!accessToken) {
            throw new Error('No session');
        }

        const response = await fetch(`${FUNCTION_BASE}/sign-offer`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${anonKey}`,
                'x-user-token': accessToken,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                kind: params.kind,
                payload: params.payload,
                tenant_id: params.tenantId,
                expires_in: params.expiresIn,
            }),
        });

        if (!response.ok) {
            const errBody = await response.text();
            console.warn('[offerService] sign-offer failed, falling back to legacy:', errBody);
            throw new Error(errBody);
        }

        const result = await response.json();

        if (result.success && result.url) {
            return { url: result.url, offerId: result.offer_id, source: 'jwt' };
        }

        throw new Error(result.error || 'Unknown sign-offer error');

    } catch (error) {
        // Fallback to legacy Base64 encoding
        console.warn('[offerService] Using legacy Base64 fallback:', error);
        return createLegacyLink(params);
    }
}

/**
 * Resolve an offer from URL parameters (JWT token or legacy Base64).
 * Called by consumer pages on mount.
 */
export async function resolveOffer(params: {
    token?: string | null;
    legacyData?: string | null;
    legacyOffer?: string | null;
    route: string;
}): Promise<{
    success: boolean;
    payload?: Record<string, any>;
    source?: 'jwt' | 'legacy';
    offerId?: string;
    error?: string;
    message?: string;
}> {
    // If no params at all, return error
    if (!params.token && !params.legacyData && !params.legacyOffer) {
        return { success: false, error: 'NO_PARAMS', message: 'Link inválido. Solicite um novo à escola.' };
    }

    try {
        const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || supabaseAnonKey;

        const response = await fetch(`${FUNCTION_BASE}/resolve-offer`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${anonKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                token: params.token || undefined,
                legacy_data: params.legacyData || undefined,
                legacy_offer: params.legacyOffer || undefined,
                route: params.route,
            }),
        });

        const result = await response.json();

        if (result.success) {
            return {
                success: true,
                payload: {
                    ...result.payload,
                    // Inject these explicitly at the top level of payload for easy access,
                    // or just pass them along. We merge them into payload for backward compatibility.
                    requiresEnrollment: result.requires_enrollment,
                    enrollmentFee: result.enrollment_fee,
                },
                source: result.source,
                offerId: result.offer_id,
            };
        }

        return {
            success: false,
            error: result.error,
            message: result.message || 'Link inválido ou expirado.',
        };

    } catch (networkError) {
        // If resolve-offer is unreachable, try local legacy decode as last resort
        console.warn('[offerService] resolve-offer unreachable, trying local decode');
        return localLegacyDecode(params);
    }
}

// ─── PRIVATE HELPERS ────────────────────────────────────────────────────────

function createLegacyLink(params: {
    kind: string;
    payload: Record<string, any>;
    tenantId: string;
}): { url: string; source: 'legacy' } {
    const { APP_BASE_URL } = getBaseUrl();
    const jsonStr = JSON.stringify(params.payload);

    let url: string;
    if (params.kind === 'ENROLLMENT') {
        const base64 = btoa(unescape(encodeURIComponent(jsonStr)));
        url = `${APP_BASE_URL}/matricula?data=${base64}`;
    } else if (params.kind === 'TEACHER_INVITE') {
        const base64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g,
            (_match, p1) => String.fromCharCode(parseInt(p1, 16))));
        url = `${APP_BASE_URL}/teacher-onboarding?offer=${base64}`;
    } else {
        const base64 = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g,
            (_match, p1) => String.fromCharCode(parseInt(p1, 16))));
        url = `${APP_BASE_URL}/commercial-onboarding?offer=${base64}`;
    }

    return { url, source: 'legacy' };
}

function localLegacyDecode(params: {
    legacyData?: string | null;
    legacyOffer?: string | null;
}): { success: boolean; payload?: Record<string, any>; source?: 'legacy'; error?: string; message?: string } {
    try {
        if (params.legacyData) {
            const jsonStr = decodeURIComponent(escape(atob(params.legacyData)));
            return { success: true, payload: JSON.parse(jsonStr), source: 'legacy' };
        }
        if (params.legacyOffer) {
            const jsonStr = decodeURIComponent(
                atob(params.legacyOffer).split('').map((c: string) =>
                    '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
                ).join('')
            );
            return { success: true, payload: JSON.parse(jsonStr), source: 'legacy' };
        }
        return { success: false, error: 'NO_DATA' };
    } catch {
        return { success: false, error: 'DECODE_FAILED', message: 'Link inválido ou corrompido.' };
    }
}

function getBaseUrl(): { APP_BASE_URL: string } {
    // Dynamic import of constants
    try {
        return { APP_BASE_URL: (window as any).__APP_BASE_URL || 'https://system.wisewolflanguage.com.br' };
    } catch {
        return { APP_BASE_URL: 'https://system.wisewolflanguage.com.br' };
    }
}
