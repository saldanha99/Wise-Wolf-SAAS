import { authorizeRequest, type RequestAuthContext } from "./request-auth.ts";

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
  lifecycle_status: string | null;
};

export type ActiveStudentMembership = {
  tenant_id: string;
  role: "STUDENT";
};

export type PaymentTargetScopeDecision =
  | { ok: true; tenantId: string }
  | {
    ok: false;
    error:
      | "forbidden"
      | "tenant_context_required"
      | "target_membership_inactive"
      | "target_tenant_ambiguous";
    status: 403 | 409;
  };

export type PaymentAuthorization = {
  // O projeto ainda não gera tipos de banco para as Edge Functions; o cliente
  // permanece sem Database genérico, mas sem perder a tipagem do SDK.
  admin: PaymentAdminClient;
  callerId: string | null;
  callerProfile: Profile | null;
  targetProfile: Profile;
  tenantId: string;
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

export function resolvePaymentTargetScope(input: {
  context: Pick<RequestAuthContext, "isService" | "profile" | "userId">;
  targetUserId: string;
  authorizedTenantId: string | null;
  activeStudentMemberships: ActiveStudentMembership[];
}): PaymentTargetScopeDecision {
  const { context, targetUserId, authorizedTenantId } = input;
  const memberships = input.activeStudentMemberships.filter((membership) =>
    Boolean(membership.tenant_id) && membership.role === "STUDENT"
  );

  if (context.profile?.role === "SUPER_ADMIN") {
    if (!authorizedTenantId) {
      return {
        ok: false,
        error: "tenant_context_required",
        status: 403,
      };
    }
    const targetMembership = memberships.find((membership) =>
      membership.tenant_id === authorizedTenantId
    );
    if (!targetMembership) {
      return {
        ok: false,
        error: "target_membership_inactive",
        status: 403,
      };
    }
    return { ok: true, tenantId: targetMembership.tenant_id };
  }

  if (context.isService) {
    if (memberships.length === 0) {
      return {
        ok: false,
        error: "target_membership_inactive",
        status: 403,
      };
    }
    if (memberships.length === 1) {
      return { ok: true, tenantId: memberships[0].tenant_id };
    }
    return {
      ok: false,
      error: "target_tenant_ambiguous",
      status: 409,
    };
  }

  const callerProfile = context.profile;
  if (!callerProfile?.tenant_id) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const isOwner = context.userId === targetUserId;
  const isStaff = STAFF_ROLES.has(callerProfile.role || "");
  if (
    (!isOwner && !isStaff) ||
    (isOwner && callerProfile.role !== "STUDENT" && !isStaff)
  ) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const activeMembership = memberships.find((membership) =>
    membership.tenant_id === callerProfile.tenant_id
  );
  if (!activeMembership) {
    return {
      ok: false,
      error: "target_membership_inactive",
      status: 403,
    };
  }
  return { ok: true, tenantId: activeMembership.tenant_id };
}

async function loadActiveStudentMemberships(
  admin: PaymentAdminClient,
  targetUserId: string,
): Promise<
  { memberships?: ActiveStudentMembership[]; failed?: true }
> {
  const { data, error } = await admin
    .from("tenant_memberships")
    .select("tenant_id, role")
    .eq("user_id", targetUserId)
    .eq("status", "ACTIVE")
    .eq("role", "STUDENT")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Payment target membership lookup failed", {
      code: error.code,
    });
    return { failed: true };
  }
  return { memberships: (data || []) as ActiveStudentMembership[] };
}

async function loadExplicitSuperAdminTenant(
  admin: PaymentAdminClient,
  userId: string,
  corsHeaders: Record<string, string>,
): Promise<{ tenantId?: string; error?: Response }> {
  const { data: selectedContext, error: contextError } = await admin
    .from("tenant_user_contexts")
    .select("tenant_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (contextError) {
    console.error("Payment super admin tenant context lookup failed", {
      code: contextError.code,
    });
    return { error: errorResponse("auth_unavailable", 503, corsHeaders) };
  }
  const tenantId = typeof selectedContext?.tenant_id === "string"
    ? selectedContext.tenant_id.trim()
    : "";
  if (!tenantId) {
    return {
      error: errorResponse("tenant_context_required", 403, corsHeaders),
    };
  }

  const { data: membership, error: membershipError } = await admin
    .from("tenant_memberships")
    .select("tenant_id")
    .eq("user_id", userId)
    .eq("tenant_id", tenantId)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (membershipError) {
    console.error("Payment super admin membership lookup failed", {
      code: membershipError.code,
    });
    return { error: errorResponse("auth_unavailable", 503, corsHeaders) };
  }
  if (!membership) {
    return {
      error: errorResponse(
        "active_tenant_membership_required",
        403,
        corsHeaders,
      ),
    };
  }
  return { tenantId };
}

export async function authenticatedPaymentUserId(
  req: Request,
  corsHeaders: Record<string, string>,
): Promise<{ userId?: string; error?: Response }> {
  const auth = await authorizeRequest(req, {
    allowService: false,
    allowedRoles: ["STUDENT"],
    corsHeaders,
  });
  if (auth.ok === false) return { error: auth.response };
  if (!auth.context.userId) {
    return { error: errorResponse("unauthorized", 401, corsHeaders) };
  }
  return { userId: auth.context.userId };
}

/** Autoriza o proprio aluno, funcionarios do mesmo tenant ou a service key exata. */
export async function authorizePaymentTarget(
  req: Request,
  targetUserId: string,
  corsHeaders: Record<string, string>,
): Promise<{ authorization?: PaymentAuthorization; error?: Response }> {
  if (!targetUserId) {
    return { error: errorResponse("target_user_required", 400, corsHeaders) };
  }

  const auth = await authorizeRequest(req, {
    allowService: true,
    allowedRoles: [
      "STUDENT",
      "SCHOOL_ADMIN",
      "SUPER_ADMIN",
      "COORDINATOR",
    ],
    corsHeaders,
  });
  if (auth.ok === false) return { error: auth.response };

  const { context } = auth;
  const { admin } = context;
  let authorizedTenantId = context.isService
    ? null
    : context.profile?.tenant_id || null;
  if (context.profile?.role === "SUPER_ADMIN") {
    if (!context.userId) {
      return { error: errorResponse("forbidden", 403, corsHeaders) };
    }
    const selectedTenant = await loadExplicitSuperAdminTenant(
      admin,
      context.userId,
      corsHeaders,
    );
    if (selectedTenant.error) return { error: selectedTenant.error };
    authorizedTenantId = selectedTenant.tenantId || null;
  }
  const isGlobalCaller = context.isService ||
    context.profile?.role === "SUPER_ADMIN";
  const isTenantStaff = STAFF_ROLES.has(context.profile?.role || "");
  if (
    !isGlobalCaller && context.userId !== targetUserId && !isTenantStaff
  ) {
    return { error: errorResponse("forbidden", 403, corsHeaders) };
  }

  const { data: targetProfile, error: targetError } = await admin
    .from("profiles")
    .select("*")
    .eq("id", targetUserId)
    .maybeSingle();

  if (targetError) {
    console.error("Payment target profile lookup failed", {
      code: targetError.code,
    });
    return { error: errorResponse("auth_unavailable", 503, corsHeaders) };
  }
  if (!targetProfile) {
    return { error: errorResponse("profile_not_found", 404, corsHeaders) };
  }

  const membershipResult = await loadActiveStudentMemberships(
    admin,
    targetUserId,
  );
  if (membershipResult.failed) {
    return {
      error: errorResponse("auth_unavailable", 503, corsHeaders),
    };
  }
  const scope = resolvePaymentTargetScope({
    context,
    targetUserId,
    authorizedTenantId,
    activeStudentMemberships: membershipResult.memberships || [],
  });
  if (scope.ok === false) {
    return {
      error: errorResponse(scope.error, scope.status, corsHeaders),
    };
  }

  const callerProfile: Profile | null = context.profile
    ? { ...context.profile }
    : null;
  const isStaff = context.isService ||
    callerProfile?.role === "SUPER_ADMIN" ||
    STAFF_ROLES.has(callerProfile?.role || "");
  const scopedTargetProfile = {
    ...(targetProfile as Profile),
    role: "STUDENT",
    tenant_id: scope.tenantId,
  };

  return {
    authorization: {
      admin,
      callerId: context.userId,
      callerProfile,
      targetProfile: scopedTargetProfile,
      tenantId: scope.tenantId,
      isService: context.isService,
      isStaff,
    },
  };
}

export async function loadClaimedEnrollmentOffer(
  admin: PaymentAdminClient,
  userId: string,
  tenantId: string,
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
    .eq("tenant_id", tenantId)
    .eq("processing_by", userId)
    .not("processing_state", "in", '("NOT_STARTED","COMPLETED")')
    .order("processing_updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (processingError) {
    throw new Error(
      `offer_processing_lookup_failed: ${processingError.message}`,
    );
  }
  if (processing) return processing as ClaimedEnrollmentOffer;

  const { data, error } = await admin
    .from("offers")
    .select(
      "id, tenant_id, payload, metadata, enrollment_fee, requires_enrollment, processing_state, processing_correlation_id",
    )
    .eq("kind", "ENROLLMENT")
    .eq("tenant_id", tenantId)
    .eq("consumed_by", userId)
    .not("consumed_at", "is", null)
    .order("consumed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`offer_lookup_failed: ${error.message}`);
  return data as ClaimedEnrollmentOffer | null;
}
