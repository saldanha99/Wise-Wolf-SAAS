import {
  createClient,
  type SupabaseClient,
  type User,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";

export interface AuthProfile {
  id: string;
  role: string;
  tenant_id: string | null;
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
  allowedRoles?: readonly string[];
  corsHeaders: Record<string, string>;
}

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
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";

  if (!supabaseUrl || !serviceRoleKey) {
    return {
      ok: false,
      response: jsonError(options.corsHeaders, 503, "Authentication is unavailable"),
    };
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const bearer = bearerToken(req);
  const apiKey = req.headers.get("apikey")?.trim() ?? "";
  const presentedServiceKey = bearer === serviceRoleKey || apiKey === serviceRoleKey;

  if (presentedServiceKey) {
    if (!options.allowService) {
      return {
        ok: false,
        response: jsonError(options.corsHeaders, 403, "Service access is not allowed"),
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
    .select("id, role, tenant_id")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError) {
    console.error("Request authorization profile lookup failed", {
      code: profileError.code,
    });
    return {
      ok: false,
      response: jsonError(options.corsHeaders, 503, "Authentication is unavailable"),
    };
  }

  if (!profile) {
    return {
      ok: false,
      response: jsonError(options.corsHeaders, 403, "User profile is not authorized"),
    };
  }

  if (options.allowedRoles && !options.allowedRoles.includes(profile.role)) {
    return {
      ok: false,
      response: jsonError(options.corsHeaders, 403, "Insufficient permissions"),
    };
  }

  return {
    ok: true,
    context: {
      admin,
      isService: false,
      profile: profile as AuthProfile,
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
