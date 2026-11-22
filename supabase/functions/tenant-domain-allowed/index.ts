/// <reference lib="deno.ns" />

// "Porteiro" do On-Demand TLS do Caddy (white label, 22/11/2026).
// GET ?domain=<host> → 200 se o host é <slug>.wisewolflanguage.com.br de escola
// operacional ou custom_domain verificado; 404 em qualquer outro caso.
// Sem JWT e sem dado no corpo: o Caddy só olha o status.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { normalizeAskHost } from "./host.ts";

const headers = { "Content-Type": "text/plain", "Cache-Control": "no-store" };
const cache = new Map<string, { ok: boolean; at: number }>();
const CACHE_MS = 60_000;

serve(async (req) => {
  if (req.method !== "GET") {
    return new Response("method", { status: 405, headers });
  }
  const host = normalizeAskHost(new URL(req.url).searchParams.get("domain"));
  if (!host) return new Response("no", { status: 404, headers });

  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return new Response(hit.ok ? "ok" : "no", {
      status: hit.ok ? 200 : 404,
      headers,
    });
  }

  const url = (Deno.env.get("SUPABASE_URL") ?? "").trim();
  const key = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  if (!url || !key) return new Response("no", { status: 404, headers });
  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.rpc("tenant_domain_allowed", {
    p_host: host,
  });
  if (error) {
    console.error("[tenant-domain-allowed] rpc", { code: error.code });
    return new Response("no", { status: 404, headers });
  }
  const ok = data === true;
  if (cache.size > 500) cache.clear();
  cache.set(host, { ok, at: Date.now() });
  return new Response(ok ? "ok" : "no", { status: ok ? 200 : 404, headers });
});
