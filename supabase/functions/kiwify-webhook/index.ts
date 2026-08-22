/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const jsonHeaders = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json",
};

serve((req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
      status: 405,
      headers: { ...jsonHeaders, "Allow": "POST" },
    });
  }

  return new Response(JSON.stringify({ error: "LEGACY_WEBHOOK_DISABLED" }), {
    status: 410,
    headers: jsonHeaders,
  });
});
