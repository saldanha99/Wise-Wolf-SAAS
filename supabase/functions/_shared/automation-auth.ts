/// <reference lib="deno.ns" />

import { authorizeRequest, type RequestAuthContext } from "./request-auth.ts";

type AuthorizationOptions = {
  allowAdmin?: boolean;
};

export interface AutomationAuthorizationContext {
  admin: RequestAuthContext["admin"];
  isService: boolean;
  tenantId: string | null;
  userId: string | null;
}

export type AutomationAuthorizationResult =
  | { ok: true; context: AutomationAuthorizationContext }
  | { ok: false; response: Response };

export type ManualAutomationScopeResolution =
  | { ok: true; tenantId: string }
  | {
    ok: false;
    error:
      | "tenant_context_required"
      | "active_tenant_membership_required"
      | "school_admin_membership_required";
  };

interface ManualAutomationScopeInput {
  activeRole: string;
  selectedTenantId: string | null;
  membershipTenantId: string | null;
  membershipRole: string | null;
}

function jsonError(
  message: string,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function resolveManualAutomationScope(
  input: ManualAutomationScopeInput,
): ManualAutomationScopeResolution {
  const selectedTenantId = input.selectedTenantId?.trim() || null;
  if (!selectedTenantId) {
    return { ok: false, error: "tenant_context_required" };
  }

  if (
    input.membershipTenantId !== selectedTenantId ||
    !input.membershipRole
  ) {
    return { ok: false, error: "active_tenant_membership_required" };
  }

  if (
    input.activeRole === "SCHOOL_ADMIN" &&
    input.membershipRole !== "SCHOOL_ADMIN"
  ) {
    return { ok: false, error: "school_admin_membership_required" };
  }

  return { ok: true, tenantId: selectedTenantId };
}

export function scopeAutomationRows<T>(
  rows: unknown,
  tenantId: string | null,
): T[] {
  const safeRows = Array.isArray(rows)
    ? rows.filter((row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row)
    )
    : [];
  const scopedRows = tenantId === null
    ? safeRows
    : safeRows.filter((row) => String(row.tenant_id ?? "") === tenantId);
  return scopedRows as T[];
}

export async function authorizeScopedAutomation(
  req: Request,
  corsHeaders: Record<string, string>,
  options: AuthorizationOptions = {},
): Promise<AutomationAuthorizationResult> {
  const auth = await authorizeRequest(req, {
    allowService: true,
    allowedRoles: options.allowAdmin ? ["SCHOOL_ADMIN", "SUPER_ADMIN"] : [],
    corsHeaders,
  });
  if (auth.ok === false) return auth;

  if (auth.context.isService) {
    return {
      ok: true,
      context: {
        admin: auth.context.admin,
        isService: true,
        tenantId: null,
        userId: null,
      },
    };
  }

  if (!options.allowAdmin || !auth.context.userId || !auth.context.profile) {
    return {
      ok: false,
      response: jsonError("forbidden", 403, corsHeaders),
    };
  }

  const { data: selectedContext, error: contextError } = await auth.context
    .admin
    .from("tenant_user_contexts")
    .select("tenant_id")
    .eq("user_id", auth.context.userId)
    .maybeSingle();
  if (contextError) {
    console.error("Automation tenant context lookup failed", {
      code: contextError.code,
    });
    return {
      ok: false,
      response: jsonError("auth_unavailable", 503, corsHeaders),
    };
  }

  const selectedTenantId = typeof selectedContext?.tenant_id === "string"
    ? selectedContext.tenant_id.trim()
    : "";
  if (!selectedTenantId) {
    return {
      ok: false,
      response: jsonError("tenant_context_required", 403, corsHeaders),
    };
  }

  const { data: membership, error: membershipError } = await auth.context.admin
    .from("tenant_memberships")
    .select("tenant_id, role")
    .eq("user_id", auth.context.userId)
    .eq("tenant_id", selectedTenantId)
    .eq("status", "ACTIVE")
    .maybeSingle();
  if (membershipError) {
    console.error("Automation tenant membership lookup failed", {
      code: membershipError.code,
    });
    return {
      ok: false,
      response: jsonError("auth_unavailable", 503, corsHeaders),
    };
  }

  const scope = resolveManualAutomationScope({
    activeRole: auth.context.profile.role,
    selectedTenantId,
    membershipTenantId: typeof membership?.tenant_id === "string"
      ? membership.tenant_id
      : null,
    membershipRole: typeof membership?.role === "string"
      ? membership.role
      : null,
  });
  if (scope.ok === false) {
    return {
      ok: false,
      response: jsonError(scope.error, 403, corsHeaders),
    };
  }

  return {
    ok: true,
    context: {
      admin: auth.context.admin,
      isService: false,
      tenantId: scope.tenantId,
      userId: auth.context.userId,
    },
  };
}

export async function authorizeAutomation(
  req: Request,
  corsHeaders: Record<string, string>,
  options: AuthorizationOptions = {},
): Promise<Response | null> {
  const auth = await authorizeRequest(req, {
    allowService: true,
    allowedRoles: options.allowAdmin ? ["SCHOOL_ADMIN", "SUPER_ADMIN"] : [],
    corsHeaders,
  });
  return auth.ok === false ? auth.response : null;
}
