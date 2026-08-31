import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const retiredResponse = () =>
  new Response(
    JSON.stringify({
      error: "sync_payments_retired",
      detail:
        "A geração manual legada foi desativada. Use o fluxo autoritativo de cobrança por competência.",
    }),
    {
      status: 410,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  // Mantém o endpoint protegido durante a aposentadoria: chamadas anônimas
  // continuam recebendo 401, enquanto qualquer chamador antes autorizado recebe
  // 410. Não há cliente administrativo, consulta financeira ou mutação abaixo.
  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowService: true,
    allowedRoles: ["SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  return retiredResponse();
});
