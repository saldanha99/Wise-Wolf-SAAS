import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type AuthorizationOptions = {
  allowAdmin?: boolean;
};

function jsonError(message: string, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Autoriza crons pela service key exata e, opcionalmente, diretores autenticados. */
export async function authorizeAutomation(
  req: Request,
  corsHeaders: Record<string, string>,
  options: AuthorizationOptions = {},
): Promise<Response | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return jsonError("unauthorized", 401, corsHeaders);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

  if (serviceKey && bearer === serviceKey) return null;
  if (!options.allowAdmin) return jsonError("forbidden", 403, corsHeaders);
  if (!url || !anonKey || !serviceKey) return jsonError("auth_unavailable", 503, corsHeaders);

  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: auth, error: authError } = await userClient.auth.getUser();
  if (authError || !auth.user) return jsonError("unauthorized", 401, corsHeaders);

  const adminClient = createClient(url, serviceKey);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .maybeSingle();

  if (profileError || !profile || !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(profile.role)) {
    return jsonError("forbidden", 403, corsHeaders);
  }

  return null;
}
