// Webhook do Resend: abertura (provável) e clique dos e-mails de cobrança.
// Sem assinatura Svix válida (RESEND_WEBHOOK_SECRET), responde 401 e não lê
// nada. Eventos que não são de e-mail de cobrança são aceitos e ignorados.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifySvixSignature } from "./signature.ts";
import { recordEmailEngagement } from "./engagement.ts";

const MAX_BODY_BYTES = 256 * 1024;
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const body = await req.text().catch(() => "");
  if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return json(413, { error: "payload_too_large" });
  }
  const valid = await verifySvixSignature({
    secret: Deno.env.get("RESEND_WEBHOOK_SECRET"),
    id: req.headers.get("svix-id"),
    timestamp: req.headers.get("svix-timestamp"),
    signature: req.headers.get("svix-signature"),
    body,
  });
  if (!valid) return json(401, { error: "invalid_signature" });

  let event: unknown;
  try {
    event = JSON.parse(body);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return json(400, { error: "invalid_event" });
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json(503, { error: "persistence_unavailable" });
  try {
    const outcome = await recordEmailEngagement(
      createClient(url, key),
      event as Parameters<typeof recordEmailEngagement>[1],
    );
    return json(200, { received: true, outcome });
  } catch (error) {
    // 5xx faz o Svix reenviar; a gravação é idempotente.
    console.error("[resend-webhook] falha ao gravar abertura/clique", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return json(503, { error: "persistence_retry_required" });
  }
});
