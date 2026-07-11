import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// Diagnostico temporario ja usado (checagem de credito OpenRouter, 06/07/2026 - CONFIRMADO OK: is_free_tier=false). Desativado.
serve(() => new Response(JSON.stringify({ status: "disabled" }), { status: 200, headers: { "Content-Type": "application/json" } }));
