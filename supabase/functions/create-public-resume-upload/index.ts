import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

const allowedOrigins = new Set([
  "https://wisewolflanguage.com.br",
  "https://www.wisewolflanguage.com.br",
]);

const allowedFiles = new Map([
  ["pdf", "application/pdf"],
  ["doc", "application/msword"],
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
]);

const maxFileSize = 10 * 1024 * 1024;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://wisewolflanguage.com.br",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

function clientAddress(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return req.headers.get("x-real-ip")?.trim() ||
    req.headers.get("cf-connecting-ip")?.trim() ||
    forwarded ||
    "unknown";
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  const origin = req.headers.get("origin") ?? "";
  if (!allowedOrigins.has(origin)) return json(req, { error: "Origin not allowed" }, 403);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      return json(req, { error: "Upload service unavailable" }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const fileName = typeof body?.file_name === "string" ? body.file_name.trim() : "";
    const contentType = typeof body?.content_type === "string" ? body.content_type.trim() : "";
    const fileSize = Number(body?.file_size);
    const extension = fileName.split(".").pop()?.toLowerCase() ?? "";

    if (!fileName || fileName.length > 180 || !allowedFiles.has(extension)) {
      return json(req, { error: "Unsupported file" }, 400);
    }
    if (allowedFiles.get(extension) !== contentType) {
      return json(req, { error: "File type does not match its extension" }, 400);
    }
    if (!Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > maxFileSize) {
      return json(req, { error: "File must be between 1 byte and 10 MB" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const clientHash = await sha256(clientAddress(req));
    const { data: quotaAllowed, error: quotaError } = await admin.rpc(
      "claim_public_intake_quota",
      {
        p_intake_kind: "resume_upload",
        p_client_hash: clientHash,
        p_request_limit: 3,
      },
    );

    if (quotaError) {
      console.error("Resume upload quota check failed", { code: quotaError.code });
      return json(req, { error: "Upload service unavailable" }, 503);
    }
    if (!quotaAllowed) return json(req, { error: "Upload limit exceeded" }, 429);

    const path = `school-wise-wolf/${crypto.randomUUID()}.${extension}`;
    const { data, error } = await admin.storage
      .from("resumes")
      .createSignedUploadUrl(path, { upsert: false });

    if (error || !data?.token) {
      console.error("Signed resume upload creation failed", { message: error?.message });
      return json(req, { error: "Unable to create upload" }, 503);
    }

    return json(req, {
      path,
      token: data.token,
      content_type: contentType,
    });
  } catch (error) {
    console.error("Public resume upload failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json(req, { error: "Upload service unavailable" }, 500);
  }
});
