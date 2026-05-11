/**
 * resolve-offer — Validates JWT token and returns offer payload
 *
 * Called by frontend pages (/matricula, /teacher-onboarding, /commercial-onboarding)
 * to resolve a signed token into the actual offer data.
 *
 * Also handles legacy Base64 links during migration window (LEGACY_OFFER_DECODE=true).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";
import { jwtVerify } from "https://deno.land/x/jose@v5.2.0/index.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const OFFER_JWT_SECRET = Deno.env.get('OFFER_JWT_SECRET') || '';
const LEGACY_OFFER_DECODE = Deno.env.get('LEGACY_OFFER_DECODE') !== 'false'; // Default: true (during migration)

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        );

        const body = await req.json();
        const { token, legacy_data, legacy_offer, route } = body;

        // ── PATH 1: JWT TOKEN ────────────────────────────────────────
        if (token) {
            if (!OFFER_JWT_SECRET) {
                return new Response(
                    JSON.stringify({ error: 'Server misconfigured: missing JWT secret' }),
                    { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }

            try {
                const secret = new TextEncoder().encode(OFFER_JWT_SECRET);
                const { payload: jwtPayload } = await jwtVerify(token, secret);

                const offerId = jwtPayload.offer_id as string;
                const oppId = jwtPayload.opp_id as string;

                if (!offerId && !oppId) {
                    return new Response(
                        JSON.stringify({ error: 'Invalid token: missing offer_id or opp_id' }),
                        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    );
                }

                // ── CASE A: Opportunity Claim Token (opp_id) ──────────────────
                if (oppId) {
                    const { data: opp, error: oppError } = await supabaseAdmin
                        .from('opportunities')
                        .select('id, student_name, student_phone, interests, slots_proposed')
                        .eq('id', oppId)
                        .single();

                    if (oppError || !opp) {
                        return new Response(
                            JSON.stringify({ error: 'OPPORTUNITY_NOT_FOUND', message: 'Vaga não encontrada ou expirada.' }),
                            { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                        );
                    }

                    const slot = (opp.slots_proposed as any[])?.[0] || {};

                    return new Response(
                        JSON.stringify({
                            success: true,
                            source: 'jwt',
                            opp_id: opp.id,
                            student_name: opp.student_name,
                            student_phone: opp.student_phone,
                            interests: opp.interests,
                            date: slot.date,
                            time: slot.time
                        }),
                        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    );
                }

                // ── CASE B: Offer Token (offer_id) ────────────────────────────
                // Validate offer in database
                const { data: result } = await supabaseAdmin.rpc('validate_offer', {
                    p_offer_id: offerId,
                });

                if (!result?.valid) {
                    return new Response(
                        JSON.stringify({
                            error: result?.error || 'OFFER_INVALID',
                            message: getErrorMessage(result?.error),
                        }),
                        { status: 410, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                    );
                }

                return new Response(
                    JSON.stringify({
                        success: true,
                        source: 'jwt',
                        offer_id: offerId,
                        kind: result.kind,
                        payload: result.payload,
                        tenant_id: result.tenant_id,
                        requires_enrollment: result.requires_enrollment,
                        enrollment_fee: result.enrollment_fee,
                        consumed: !!result.consumed_at,
                    }),
                    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );

            } catch (jwtError: any) {
                // JWT verification failed
                const isExpired = jwtError.code === 'ERR_JWT_EXPIRED';
                return new Response(
                    JSON.stringify({
                        error: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
                        message: isExpired
                            ? 'Este link expirou. Solicite um novo à escola.'
                            : 'Link inválido ou adulterado.',
                    }),
                    { status: isExpired ? 410 : 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }
        }

        // ── PATH 2: LEGACY BASE64 (migration window) ─────────────────
        if ((legacy_data || legacy_offer) && LEGACY_OFFER_DECODE) {
            const encodedStr = legacy_data || legacy_offer;
            const paramName = legacy_data ? 'data' : 'offer';

            try {
                let jsonStr: string;
                if (paramName === 'data') {
                    // Matrícula format: btoa(unescape(encodeURIComponent(json)))
                    jsonStr = decodeURIComponent(escape(atob(encodedStr)));
                } else {
                    // Teacher/Commercial format: btoa(encodeURIComponent(json).replace(...))
                    jsonStr = decodeURIComponent(
                        atob(encodedStr).split('').map((c: string) =>
                            '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
                        ).join('')
                    );
                }

                const payload = JSON.parse(jsonStr);

                // Track legacy usage for migration monitoring
                await supabaseAdmin.from('legacy_offer_usage').insert({
                    route: route || 'unknown',
                    raw_param: paramName,
                    decoded_ok: true,
                    tenant_id: payload.unitId || payload.tenantId || null,
                }).catch(() => {}); // Non-blocking

                return new Response(
                    JSON.stringify({
                        success: true,
                        source: 'legacy',
                        payload,
                        _warning: 'This link uses a legacy format. It will stop working after the migration window.',
                    }),
                    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );

            } catch (decodeError) {
                // Track failed decode
                await supabaseAdmin.from('legacy_offer_usage').insert({
                    route: route || 'unknown',
                    raw_param: paramName,
                    decoded_ok: false,
                }).catch(() => {});

                return new Response(
                    JSON.stringify({ error: 'LEGACY_DECODE_FAILED', message: 'Link inválido ou corrompido.' }),
                    { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
                );
            }
        }

        // ── No valid input ───────────────────────────────────────────
        return new Response(
            JSON.stringify({ error: 'MISSING_TOKEN', message: 'Nenhum token ou dado de oferta fornecido.' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        console.error('resolve-offer error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});

function getErrorMessage(code: string | undefined): string {
    switch (code) {
        case 'OFFER_NOT_FOUND': return 'Este link não é válido. Solicite um novo.';
        case 'OFFER_REVOKED': return 'Este link foi revogado pela escola.';
        case 'OFFER_EXPIRED': return 'Este link expirou. Solicite um novo à escola.';
        default: return 'Link inválido.';
    }
}
