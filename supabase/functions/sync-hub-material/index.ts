/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH = 10;

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const safeExtension = (url: URL, contentType: string) => {
  const candidate = url.pathname.split("/").pop()?.split(".").pop()?.toLowerCase() || "";
  if (/^[a-z0-9]{1,8}$/.test(candidate)) return candidate;
  const byType: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  return byType[contentType.split(";", 1)[0].toLowerCase()] || "bin";
};

const encodeStoragePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowService: true,
    allowedRoles: ["TEACHER", "SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json(503, { error: "MATERIAL_SYNC_UNAVAILABLE", code: "MATERIAL_SYNC_UNAVAILABLE" });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const requestedIds = Array.isArray(body.materialIds)
      ? body.materialIds.filter((value): value is string => typeof value === "string" && UUID_PATTERN.test(value)).slice(0, MAX_BATCH)
      : typeof body.materialId === "string" && UUID_PATTERN.test(body.materialId)
        ? [body.materialId]
        : [];
    const bulk = body.allApproved === true;
    if (bulk && !auth.context.isService) {
      return json(403, { error: "SERVICE_ACCESS_REQUIRED", code: "SERVICE_ACCESS_REQUIRED" });
    }
    if (!bulk && requestedIds.length === 0) {
      return json(400, { error: "MATERIAL_ID_REQUIRED", code: "MATERIAL_ID_REQUIRED" });
    }

    let query = auth.context.admin
      .from("pedagogical_materials")
      .select("id, tenant_id, title, file_url, type, uploaded_by, approval_status, hub_object_path")
      .eq("approval_status", "APPROVED")
      .order("created_at", { ascending: true })
      .limit(MAX_BATCH);
    if (bulk) query = query.in("hub_sync_status", ["PENDING", "FAILED"]);
    else query = query.in("id", requestedIds);
    const { data: materials, error: materialsError } = await query;
    if (materialsError) throw materialsError;

    const results: Array<Record<string, unknown>> = [];
    for (const material of materials || []) {
      if (!auth.context.isService && auth.context.profile?.role !== "SUPER_ADMIN") {
        const sameTenant = auth.context.profile?.tenant_id === material.tenant_id;
        const ownsUpload = auth.context.userId === material.uploaded_by;
        const canSync = auth.context.profile?.role === "SCHOOL_ADMIN" ? sameTenant : ownsUpload && sameTenant;
        if (!canSync) {
          results.push({ materialId: material.id, ok: false, code: "MATERIAL_ACCESS_DENIED" });
          continue;
        }
      }

      try {
        const sourceUrl = new URL(material.file_url);
        if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('INVALID_MATERIAL_URL');
        const publicStorageMarker = '/storage/v1/object/public/materials/';
        const markerIndex = sourceUrl.pathname.indexOf(publicStorageMarker);
        const encodedSourcePath = markerIndex >= 0
          ? sourceUrl.pathname.slice(markerIndex + publicStorageMarker.length)
          : '';
        const isPrivateCopySource = encodedSourcePath.length > 0;
        if (String(material.type).toUpperCase() === 'LINK' || !isPrivateCopySource) {
          const { error: externalError } = await auth.context.admin.from('pedagogical_materials').update({
            hub_object_path: null,
            hub_sync_status: 'NOT_APPLICABLE',
            hub_sync_error: null,
            hub_synced_at: new Date().toISOString(),
          }).eq('id', material.id);
          if (externalError) throw externalError;
          results.push({ materialId: material.id, ok: true, external: true });
          continue;
        }

        await auth.context.admin.from("pedagogical_materials").update({
          hub_sync_status: "SYNCING",
          hub_sync_error: null,
        }).eq("id", material.id);

        // Resolve the known object path against the internal Supabase URL. This
        // works in self-hosted deployments where SUPABASE_URL is an internal
        // hostname while stored public URLs use the customer-facing API domain.
        const internalSourceUrl = `${supabaseUrl}/storage/v1/object/public/materials/${encodedSourcePath}`;
        const source = await fetch(internalSourceUrl, { signal: AbortSignal.timeout(120_000) });
        if (!source.ok || !source.body) throw new Error("SOURCE_DOWNLOAD_FAILED");
        const contentType = source.headers.get("content-type") || "application/octet-stream";
        const extension = safeExtension(sourceUrl, contentType);
        const objectPath = `pedagogical/${material.id}/material.${extension}`;

        const upload = await fetch(
          `${supabaseUrl}/storage/v1/object/hub-library/${encodeStoragePath(objectPath)}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              apikey: serviceRoleKey,
              "Content-Type": contentType,
              "x-upsert": "true",
            },
            body: source.body,
            signal: AbortSignal.timeout(300_000),
          },
        );
        if (!upload.ok) {
          console.error("Hub material private upload failed", { materialId: material.id, status: upload.status });
          throw new Error("PRIVATE_UPLOAD_FAILED");
        }

        const { error: updateError } = await auth.context.admin.from("pedagogical_materials").update({
          hub_object_path: objectPath,
          hub_sync_status: "SYNCED",
          hub_sync_error: null,
          hub_synced_at: new Date().toISOString(),
        }).eq("id", material.id);
        if (updateError) throw updateError;
        results.push({ materialId: material.id, ok: true, objectPath });
      } catch (error) {
        const code = error instanceof Error ? error.message.slice(0, 120) : "MATERIAL_SYNC_FAILED";
        await auth.context.admin.from("pedagogical_materials").update({
          hub_sync_status: "FAILED",
          hub_sync_error: code,
        }).eq("id", material.id);
        results.push({ materialId: material.id, ok: false, code });
      }
    }

    const synced = results.filter((result) => result.ok === true).length;
    return json(200, {
      ok: synced === results.length,
      processed: results.length,
      synced,
      failed: results.length - synced,
      results,
    });
  } catch (error) {
    console.error("Hub material synchronization failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return json(500, { error: "MATERIAL_SYNC_FAILED", code: "MATERIAL_SYNC_FAILED" });
  }
});
