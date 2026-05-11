/**
 * sign-offer — Creates a signed offer link
 *
 * 1. Receives offer payload from admin (price, plan, professor, etc.)
 * 2. Stores payload in `offers` table (PII stays server-side)
 * 3. Returns JWT containing only { offer_id, kind, exp }
 * 4. Frontend builds URL with JWT token instead of raw Base64
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";
import { SignJWT } from "https://deno.land/x/jose@v5.2.0/index.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token',
};

const OFFER_JWT_SECRET = Deno.env.get('OFFER_JWT_SECRET') || '';
const APP_BASE_URL = Deno.env.get('APP_BASE_URL') || 'https://system.wisewolflanguage.com.br';

// Offer kind → route mapping
const ROUTE_MAP: Record<string, string> = {
    'ENROLLMENT': '/matricula',
    'TEACHER_INVITE': '/teacher-onboarding',
    'COMMERCIAL_INVITE': '/commercial-onboarding',
};

// Default expiration per kind
const EXPIRATION_MAP: Record<string, string> = {
    'ENROLLMENT': '30d',        // Enrollment links valid for 30 days
    'TEACHER_INVITE': '7d',     // Teacher invites valid for 7 days
    'COMMERCIAL_INVITE': '7d',  // Commercial invites valid for 7 days
};

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

        // ── AUTH ──────────────────────────────────────────────────────
        const xUserToken = req.headers.get('x-user-token');
        const authHeader = req.headers.get('Authorization');
        const token = xUserToken || authHeader?.replace('Bearer ', '') || '';

        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) {
            return new Response(
                JSON.stringify({ error: 'Unauthorized' }),
                { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // ── PARSE BODY ───────────────────────────────────────────────
        const body = await req.json();
        const { kind, payload, tenant_id, expires_in } = body;

        if (!kind || !payload || !tenant_id) {
            return new Response(
                JSON.stringify({ error: 'Missing required fields: kind, payload, tenant_id' }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        if (!['ENROLLMENT', 'TEACHER_INVITE', 'COMMERCIAL_INVITE'].includes(kind)) {
            return new Response(
                JSON.stringify({ error: `Invalid kind: ${kind}` }),
                { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // ── CALCULATE EXPIRATION ─────────────────────────────────────
        const expDuration = expires_in || EXPIRATION_MAP[kind] || '30d';
        const expMs = parseDuration(expDuration);
        const expiresAt = new Date(Date.now() + expMs);

        // ── ENFORCE ENROLLMENT FEE INVARIANT ────────────────────────
        let requires_enrollment = false;
        let enrollment_fee = 0;

        if (kind === 'ENROLLMENT') {
            const planDuration = payload.planDuration !== undefined ? Number(payload.planDuration) : 1;
            requires_enrollment = planDuration !== 0; // Avulso (0) never requires enrollment
            enrollment_fee = Number(payload.enrollmentFee) || 0;

            if (!requires_enrollment && enrollment_fee > 0) {
                // If plan is avulso, we must force enrollment_fee to 0 to respect DB check
                enrollment_fee = 0;
            }
        }

        // ── INSERT OFFER ─────────────────────────────────────────────
        const { data: offer, error: insertError } = await supabaseAdmin
            .from('offers')
            .insert({
                kind,
                tenant_id,
                payload,
                requires_enrollment,
                enrollment_fee,
                expires_at: expiresAt.toISOString(),
                created_by: user.id,
            })
            .select('id')
            .single();

        if (insertError || !offer) {
            console.error('Insert offer error:', insertError);
            return new Response(
                JSON.stringify({ error: 'Failed to create offer' }),
                { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        // ── SIGN JWT ─────────────────────────────────────────────────
        if (!OFFER_JWT_SECRET) {
            return new Response(
                JSON.stringify({ error: 'OFFER_JWT_SECRET not configured' }),
                { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
        }

        const secret = new TextEncoder().encode(OFFER_JWT_SECRET);
        const jwt = await new SignJWT({
            offer_id: offer.id,
            kind,
            tenant_id,
        })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime(expiresAt.getTime() / 1000)
            .sign(secret);

        // ── BUILD URL ────────────────────────────────────────────────
        const route = ROUTE_MAP[kind] || '/matricula';
        const signedUrl = `${APP_BASE_URL}${route}?token=${jwt}`;

        return new Response(
            JSON.stringify({
                success: true,
                offer_id: offer.id,
                token: jwt,
                url: signedUrl,
                expires_at: expiresAt.toISOString(),
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error: any) {
        console.error('sign-offer error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
});

/**
 * Parse duration string like '30d', '7d', '24h', '15m' to milliseconds
 */
function parseDuration(dur: string): number {
    const match = dur.match(/^(\d+)([smhd])$/);
    if (!match) return 30 * 24 * 60 * 60 * 1000; // default 30d

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return 30 * 24 * 60 * 1000;
    }
}
