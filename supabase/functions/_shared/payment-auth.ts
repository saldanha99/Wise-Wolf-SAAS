import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// O projeto ainda não gera Database types para as Edge Functions. Centralizar
// este escape mantém o restante do fluxo tipado e evita inferência `never`.
// deno-lint-ignore no-explicit-any
export type PaymentAdminClient = any;

const STAFF_ROLES = new Set([
  "SCHOOL_ADMIN",
  "SUPER_ADMIN",
  "COORDINATOR",
]);

type Profile = Record<string, unknown> & {
  id: string;
  role: string | null;
  tenant_id: string | null;
};

export type PaymentAuthorization = {
  // O projeto ainda não gera tipos de banco para as Edge Functions; o cliente
  // permanece sem Database genérico, mas sem perder a tipagem do SDK.
  admin: PaymentAdminClient;
  callerId: string | null;
  callerProfile: Profile | null;
  targetProfile: Profile;
  isService: boolean;
  isStaff: boolean;
};

export type ClaimedEnrollmentOffer = {
  id: string;
  tenant_id: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  enrollment_fee: number | string | null;
  requires_enrollment: boolean | null;
  processing_state?: string | null;
  processing_correlation_id?: string | null;
};

function errorResponse(
  message: string,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export async function authenticatedPaymentUserId(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<{ userId?: string; error?: Response }> {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const bearer = (req.headers.get("Authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();

  if (!url || !serviceKey) return { error: errorResponse("auth_unavailable", 503, corsHeaders) };
  if (!bearer || bearer === serviceKey) return { error: errorResponse("unauthorized", 401, corsHeaders) };

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.auth.getUser(bearer);
  if (error || !data.user) return { error: errorResponse("unauthorized", 401, corsHeaders) };
  return { userId: data.user.id };
}

/** Autoriza o proprio aluno, funcionarios do mesmo tenant ou a service key exata. */
export async function authorizePaymentTarget(
  req: Request,
  targetUserId: string,
  corsHeaders: Record<string, string>,
): Promise<{ authorization?: PaymentAuthorization; error?: Response }> {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authHeader = req.headers.get("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!url || !serviceKey) {
    return { error: errorResponse("auth_unavailable", 503, corsHeaders) };
  }
  if (!targetUserId) {
    return { error: errorResponse("target_user_required", 400, corsHeaders) };
  }
  if (!bearer) {
    return { error: errorResponse("unauthorized", 401, corsHeaders) };
  }

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: targetProfile, error: targetError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", targetUserId)
    .maybeSingle();

  if (targetError || !targetProfile) {
    return { error: errorResponse("profile_not_found", 404, corsHeaders) };
  }

  if (bearer === serviceKey) {
    return {
      authorization: {
        admin,
        callerId: null,
        callerProfile: null,
        targetProfile: targetProfile as Profile,
        isService: true,
        isStaff: true,
      },
    };
  }

  const { data: authData, error: authError } = await admin.auth.getUser(bearer);
  if (authError || !authData.user) {
    return { error: errorResponse("unauthorized", 401, corsHeaders) };
  }

  const { data: callerProfile, error: callerError } = await admin
    .from("profiles")
    .select("id, role, tenant_id")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (callerError || !callerProfile) {
    return { error: errorResponse("forbidden", 403, corsHeaders) };
  }

  const isOwner = authData.user.id === targetUserId;
  const isStaff = STAFF_ROLES.has(callerProfile.role || "");
  const sameTenant = callerProfile.tenant_id === targetProfile.tenant_id;
  const isSuperAdmin = callerProfile.role === "SUPER_ADMIN";

  if (!isOwner && (!isStaff || (!sameTenant && !isSuperAdmin))) {
    return { error: errorResponse("forbidden", 403, corsHeaders) };
  }

  return {
    authorization: {
      admin,
      callerId: authData.user.id,
      callerProfile: callerProfile as Profile,
      targetProfile: targetProfile as Profile,
      isService: false,
      isStaff,
    },
  };
}

export async function loadClaimedEnrollmentOffer(
  admin: PaymentAdminClient,
  userId: string,
): Promise<ClaimedEnrollmentOffer | null> {
  // Fluxo atual: a oferta fica ligada ao aluno por processing_by e só é
  // consumida quando cobrança/taxa obrigatória estiver pronta. A busca por
  // consumed_by permanece como compatibilidade com matrículas anteriores.
  const { data: processing, error: processingError } = await admin
    .from("offers")
    .select(
      "id, tenant_id, payload, metadata, enrollment_fee, requires_enrollment, processing_state, processing_correlation_id",
    )
    .eq("kind", "ENROLLMENT")
    .eq("processing_by", userId)
    .not("processing_state", "in", '("NOT_STARTED","COMPLETED")')
    .order("processing_updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (processingError) {
    throw new Error(`offer_processing_lookup_failed: ${processingError.message}`);
  }
  if (processing) return processing as ClaimedEnrollmentOffer;

  const { data, error } = await admin
    .from("offers")
    .select(
      "id, tenant_id, payload, metadata, enrollment_fee, requires_enrollment, processing_state, processing_correlation_id",
    )
    .eq("kind", "ENROLLMENT")
    .eq("consumed_by", userId)
    .not("consumed_at", "is", null)
    .order("consumed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`offer_lookup_failed: ${error.message}`);
  return data as ClaimedEnrollmentOffer | null;
}
