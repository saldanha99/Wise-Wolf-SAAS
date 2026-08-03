/// <reference lib="deno.ns" />

import type { RequestAuthContext } from "./request-auth.ts";

const DIRECT_TENANT_ID = "wolfie-direct";

type WolfieAccess = {
  allowed?: boolean;
  code?: string;
  accessKind?: "SCHOOL" | "STANDALONE";
  planCode?: string | null;
  planName?: string | null;
};

const jsonError = (
  corsHeaders: Record<string, string>,
  status: number,
  code: string,
) =>
  new Response(
    JSON.stringify({
      error: code,
      code,
      upgradeUrl: "https://wolfie.wisewolflanguage.com.br/planos",
    }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    },
  );

/**
 * School memberships keep their established billing path. The isolated
 * direct tenant, however, fails closed unless Postgres confirms a live paid
 * Wolfie subscription for the authenticated user.
 */
export async function requireWolfieProductAccess(
  context: RequestAuthContext,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (context.profile?.tenant_id !== DIRECT_TENANT_ID) return null;
  if (!context.userId) {
    return jsonError(corsHeaders, 401, "AUTHENTICATION_REQUIRED");
  }

  const { data, error } = await context.admin.rpc("wolfie_access_for_user", {
    p_user_id: context.userId,
  });
  if (error) {
    console.error("Wolfie product access lookup failed", { code: error.code });
    return jsonError(corsHeaders, 503, "WOLFIE_ACCESS_UNAVAILABLE");
  }

  const access = data && typeof data === "object" && !Array.isArray(data)
    ? data as WolfieAccess
    : null;
  if (access?.allowed === true && access.accessKind === "STANDALONE") {
    return null;
  }
  return jsonError(
    corsHeaders,
    402,
    access?.code || "WOLFIE_SUBSCRIPTION_REQUIRED",
  );
}
