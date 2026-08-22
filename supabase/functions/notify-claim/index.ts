/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const authorization = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["TEACHER", "SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (authorization.ok === false) return authorization.response;

  return new Response(
    JSON.stringify({
      ok: false,
      error: "ENDPOINT_RETIRED",
      message: "A confirmação agora é processada de forma atômica.",
    }),
    {
      status: 410,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
