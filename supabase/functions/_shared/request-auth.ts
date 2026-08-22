/// <reference lib="deno.ns" />

import {
  createClient,
  type SupabaseClient,
  type User,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";

export interface AuthProfile {
  id: string;
  role: string;
  tenant_id: string | null;
  lifecycle_status: string | null;
}

export interface RequestAuthContext {
  admin: SupabaseClient;
  isService: boolean;
  profile: AuthProfile | null;
  user: User | null;
  userId: string | null;
}

interface AuthorizeRequestOptions {
  allowService?: boolean;
  /**
   * The direct-to-consumer Wolfie tenant is denied by default even though its
   * membership role is STUDENT. Only product-scoped endpoints may opt in, and
   * they must still verify the paid Wolfie entitlement before doing work.
   */
  allowWolfieDirect?: boolean;
  allowedRoles?: readonly string[];
  corsHeaders: Record<string, string>;
}

const TENANT_SCOPED_ROLES = new Set([
  "STUDENT",
  "TEACHER",
  "SCHOOL_ADMIN",
  "COORDINATOR",
  "COMMERCIAL",
  "SALESPERSON",
  "NON_STUDENT",
]);

interface ActiveTenantMembership {
  tenant_id: string;
  role: string;
}

export function isAuthorizedTenantMembership(
  membership: ActiveTenantMembership | null,
): membership is ActiveTenantMembership {
  return Boolean(
    membership &&
      membership.tenant_id &&
      TENANT_SCOPED_ROLES.has(membership.role),
  );
}

export function isAuthorizedTenantlessProfile(
  profile: AuthProfile,
): boolean {
  return profile.role === "NON_STUDENT" && profile.tenant_id === null;
}

export function isActiveLifecycleProfile(profile: AuthProfile): boolean {
  return String(profile.lifecycle_status || "").trim().toLowerCase() ===
    "active";
}

/**
 * ⚠️ Escreva sempre `if (auth.ok === false) return auth.response`.
 *
 * `if (!auth.ok)` NÃO estreita o tipo no TypeScript que o Deno usa aqui, e o
 * type-check morre com «Property 'response' does not exist on type
 * 'RequestAuthResult'». Sete funções carregavam esse erro e, por causa dele,
 * ficavam de fora do `deno check` do release — ou seja, subiam sem validação
 * nenhuma. A comparação explícita custa três caracteres e resolve.
 */
export type RequestAuthResult =
  | { ok: true; context: RequestAuthContext }
  | { ok: false; response: Response };

function jsonError(
  corsHeaders: Record<string, string>,
  status: number,
  error: string,
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bearerToken(req: Request): string | null {
  const authorization = req.headers.get("authorization")?.trim() ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

/**
 * Authenticates the caller inside the function. This guard is required when the
 * Edge Functions gateway is deployed with VERIFY_JWT=false.
 *
 * User authorization is based exclusively on the profile stored in Postgres;
 * editable JWT user_metadata is never trusted for roles or tenant membership.
 * Service-role access is opt-in and accepts either the `apikey` header (current
 * Supabase recommendation) or a Bearer token for existing internal jobs.
 */
export async function authorizeRequest(
  req: Request,
  options: AuthorizeRequestOptions,
): Promise<RequestAuthResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ??
    "";

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      ok: false,
      response: jsonError(
        options.corsHeaders,
        503,
        "Authentication is unavailable",
      ),
    };
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const bearer = bearerToken(req);
  const apiKey = req.headers.get("apikey")?.trim() ?? "";
  const presentedServiceKey = bearer === serviceRoleKey ||
    apiKey === serviceRoleKey;

  if (presentedServiceKey) {
    if (!options.allowService) {
      return {
        ok: false,
        response: jsonError(
          options.corsHeaders,
          403,
          "Service access is not allowed",
        ),
      };
    }

    return {
      ok: true,
      context: {
        admin,
        isService: true,
        profile: null,
        user: null,
        userId: null,
      },
    };
  }

  if (!bearer) {
    return {
      ok: false,
      response: jsonError(options.corsHeaders, 401, "Authentication required"),
    };
  }

  const { data: userData, error: userError } = await admin.auth.getUser(bearer);
  if (userError || !userData.user) {
    return {
      ok: false,
      response: jsonError(options.corsHeaders, 401, "Invalid or expired token"),
    };
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, role, tenant_id, lifecycle_status")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Request authorization profile lookup failed", {
      code: profileError.code,
    });
    return {
      ok: false,
      response: jsonError(
        options.corsHeaders,
        503,
        "Authentication is unavailable",
      ),
    };
  }

  if (!profile) {
    return {
      ok: false,
      response: jsonError(
        options.corsHeaders,
        403,
        "User profile is not authorized",
      ),
    };
  }

  let activeProfile = profile as AuthProfile;
  if (!isActiveLifecycleProfile(activeProfile)) {
    return {
      ok: false,
      response: jsonError(
        options.corsHeaders,
        403,
        "User lifecycle is not active",
      ),
    };
  }
  if (activeProfile.role !== "SUPER_ADMIN") {
    const { data: selectedContext, error: contextError } = await admin
      .from("tenant_user_contexts")
      .select("tenant_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (contextError) {
      console.error("Request authorization tenant context lookup failed", {
        code: contextError.code,
      });
      return {
        ok: false,
        response: jsonError(
          options.corsHeaders,
          503,
          "Authentication is unavailable",
        ),
      };
    }

    const preferredTenantId = selectedContext?.tenant_id ||
      activeProfile.tenant_id;
    let membership: ActiveTenantMembership | null = null;
    if (preferredTenantId) {
      const { data: preferredMembership, error: membershipError } = await admin
        .from("tenant_memberships")
        .select("tenant_id, role")
        .eq("user_id", userData.user.id)
        .eq("tenant_id", preferredTenantId)
        .eq("status", "ACTIVE")
        .maybeSingle();
      if (membershipError) {
        console.error("Request authorization membership lookup failed", {
          code: membershipError.code,
        });
        return {
          ok: false,
          response: jsonError(
            options.corsHeaders,
            503,
            "Authentication is unavailable",
          ),
        };
      }
      membership = preferredMembership;
    }

    if (!membership) {
      const { data: fallbackMembership, error: fallbackError } = await admin
        .from("tenant_memberships")
        .select("tenant_id, role")
        .eq("user_id", userData.user.id)
        .eq("status", "ACTIVE")
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (fallbackError) {
        console.error(
          "Request authorization fallback membership lookup failed",
          {
            code: fallbackError.code,
          },
        );
        return {
          ok: false,
          response: jsonError(
            options.corsHeaders,
            503,
            "Authentication is unavailable",
          ),
        };
      }
      membership = fallbackMembership;
    }

    // The membership foundation migration backfills every tenant profile and
    // keeps new profiles synchronized. No ACTIVE row therefore means access
    // was suspended/revoked; never fall back to the legacy profile tenant.
    if (!membership && !isAuthorizedTenantlessProfile(activeProfile)) {
      return {
        ok: false,
        response: jsonError(
          options.corsHeaders,
          403,
          "Tenant membership is not active",
        ),
      };
    }
    if (!membership) {
      // Hub learners intentionally start without a school tenant. They remain
      // tenantless and cannot pass hasTenantAccess until they join a school.
      activeProfile = {
        id: activeProfile.id,
        role: "NON_STUDENT",
        tenant_id: null,
        lifecycle_status: activeProfile.lifecycle_status,
      };
    } else {
      // SUPER_ADMIN is global authority and may only come from the canonical
      // profile above. A tenant membership can never grant it (or an unknown
      // future role), even if a malformed row reaches the database.
      if (!isAuthorizedTenantMembership(membership)) {
        console.error("Request authorization rejected invalid membership role");
        return {
          ok: false,
          response: jsonError(
            options.corsHeaders,
            403,
            "Tenant membership role is not authorized",
          ),
        };
      }
      activeProfile = {
        id: activeProfile.id,
        role: membership.role,
        tenant_id: membership.tenant_id,
        lifecycle_status: activeProfile.lifecycle_status,
      };
    }
  }

  if (
    options.allowedRoles && !options.allowedRoles.includes(activeProfile.role)
  ) {
    return {
      ok: false,
      response: jsonError(options.corsHeaders, 403, "Insufficient permissions"),
    };
  }

  if (
    activeProfile.tenant_id === "wolfie-direct" &&
    options.allowWolfieDirect !== true
  ) {
    return {
      ok: false,
      response: jsonError(
        options.corsHeaders,
        403,
        "This account is restricted to Wolfie AI Tutor",
      ),
    };
  }

  return {
    ok: true,
    context: {
      admin,
      isService: false,
      profile: activeProfile,
      user: userData.user,
      userId: userData.user.id,
    },
  };
}

export function hasTenantAccess(
  context: RequestAuthContext,
  tenantId: string,
): boolean {
  return context.isService ||
    context.profile?.role === "SUPER_ADMIN" ||
    context.profile?.tenant_id === tenantId;
}

export function methodNotAllowed(
  corsHeaders: Record<string, string>,
  allowed = "POST",
): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      ...corsHeaders,
      "Allow": allowed,
      "Content-Type": "application/json",
    },
  });
}
