/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BATCH = 10;
const SOURCE_BUCKET = "materials";
const DESTINATION_BUCKET = "hub-library";

interface PublicationCandidate {
  id: string;
  tenant_id: string | null;
  type: string;
  approval_status: string;
  storage_object_path: string | null;
  hub_preview_source_path: string | null;
  hub_catalog_opt_in: boolean;
  hub_commercial_approved: boolean;
  hub_rights_basis: string | null;
  hub_rights_declaration: string | null;
  hub_publication_requested_by: string | null;
  hub_publication_requested_at: string | null;
  hub_rights_verified_by: string | null;
  hub_rights_verified_at: string | null;
  hub_sync_status: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const parsePublicationCandidate = (
  value: unknown,
): PublicationCandidate | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    !nullableString(value.tenant_id) ||
    typeof value.type !== "string" ||
    typeof value.approval_status !== "string" ||
    !nullableString(value.storage_object_path) ||
    !nullableString(value.hub_preview_source_path) ||
    typeof value.hub_catalog_opt_in !== "boolean" ||
    typeof value.hub_commercial_approved !== "boolean" ||
    !nullableString(value.hub_rights_basis) ||
    !nullableString(value.hub_rights_declaration) ||
    !nullableString(value.hub_publication_requested_by) ||
    !nullableString(value.hub_publication_requested_at) ||
    !nullableString(value.hub_rights_verified_by) ||
    !nullableString(value.hub_rights_verified_at) ||
    typeof value.hub_sync_status !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    tenant_id: value.tenant_id,
    type: value.type,
    approval_status: value.approval_status,
    storage_object_path: value.storage_object_path,
    hub_preview_source_path: value.hub_preview_source_path,
    hub_catalog_opt_in: value.hub_catalog_opt_in,
    hub_commercial_approved: value.hub_commercial_approved,
    hub_rights_basis: value.hub_rights_basis,
    hub_rights_declaration: value.hub_rights_declaration,
    hub_publication_requested_by: value.hub_publication_requested_by,
    hub_publication_requested_at: value.hub_publication_requested_at,
    hub_rights_verified_by: value.hub_rights_verified_by,
    hub_rights_verified_at: value.hub_rights_verified_at,
    hub_sync_status: value.hub_sync_status,
  };
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const safeExtensionForContentType = (contentType: string) => {
  const byType: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
  };
  const normalizedContentType = contentType.split(";", 1)[0].trim()
    .toLowerCase();
  const extension = byType[normalizedContentType];
  if (!extension) throw new Error("SOURCE_CONTENT_TYPE_NOT_ALLOWED");
  return extension;
};

const encodeStoragePath = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

const isSafeObjectPath = (path: string | null): path is string => {
  if (!path || path.length < 3 || path.length > 1024 || path.startsWith("/")) {
    return false;
  }
  return !path.split("/").some((segment) =>
    segment === "" || segment === "." || segment === ".."
  );
};

const publicationEligibilityError = (
  material: PublicationCandidate,
): string | null => {
  if (material.approval_status !== "APPROVED") {
    return "PEDAGOGICAL_APPROVAL_REQUIRED";
  }
  if (!material.hub_catalog_opt_in) return "HUB_PUBLICATION_CONSENT_REQUIRED";
  if (!material.hub_commercial_approved) {
    return "HUB_COMMERCIAL_APPROVAL_REQUIRED";
  }
  if (
    !material.hub_publication_requested_by ||
    !material.hub_publication_requested_at
  ) {
    return "HUB_PUBLICATION_AUDIT_MISSING";
  }
  if (!material.hub_rights_verified_by || !material.hub_rights_verified_at) {
    return "HUB_RIGHTS_VERIFICATION_REQUIRED";
  }
  if (
    material.hub_rights_verified_by === material.hub_publication_requested_by
  ) {
    return "HUB_SECOND_APPROVER_REQUIRED";
  }
  if (
    !["OWNED", "LICENSED", "PUBLIC_DOMAIN"].includes(
      material.hub_rights_basis || "",
    )
  ) {
    return "HUB_RIGHTS_BASIS_REQUIRED";
  }
  const declarationLength = material.hub_rights_declaration?.trim().length || 0;
  if (declarationLength < 20 || declarationLength > 2000) {
    return "HUB_RIGHTS_DECLARATION_REQUIRED";
  }
  if (String(material.type).toUpperCase() === "LINK") {
    return "HUB_EXTERNAL_SOURCE_NOT_ALLOWED";
  }
  if (!isSafeObjectPath(material.storage_object_path)) {
    return "HUB_FULL_SOURCE_INVALID";
  }
  if (!isSafeObjectPath(material.hub_preview_source_path)) {
    return "HUB_PREVIEW_SOURCE_INVALID";
  }
  if (material.storage_object_path === material.hub_preview_source_path) {
    return "HUB_PREVIEW_MUST_BE_DISTINCT";
  }
  return null;
};

async function copyPrivateObject(
  supabaseUrl: string,
  serviceRoleKey: string,
  sourcePath: string,
  destinationPathWithoutExtension: string,
): Promise<string> {
  const source = await fetch(
    `${supabaseUrl}/storage/v1/object/authenticated/${SOURCE_BUCKET}/${
      encodeStoragePath(sourcePath)
    }`,
    {
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      signal: AbortSignal.timeout(120_000),
    },
  );
  if (!source.ok || !source.body) {
    if (source.status === 404) throw new Error("SOURCE_OBJECT_NOT_FOUND");
    throw new Error("SOURCE_DOWNLOAD_FAILED");
  }

  const contentType = source.headers.get("content-type") ||
    "application/octet-stream";
  const destinationPath = `${destinationPathWithoutExtension}.${
    safeExtensionForContentType(contentType)
  }`;
  const upload = await fetch(
    `${supabaseUrl}/storage/v1/object/${DESTINATION_BUCKET}/${
      encodeStoragePath(destinationPath)
    }`,
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
  if (!upload.ok) throw new Error("PRIVATE_UPLOAD_FAILED");
  return destinationPath;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowService: true,
    allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
  });
  if (auth.ok === false) return auth.response;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ??
    "";
  if (!supabaseUrl || !serviceRoleKey) {
    return json(503, {
      error: "MATERIAL_SYNC_UNAVAILABLE",
      code: "MATERIAL_SYNC_UNAVAILABLE",
    });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const requestedIds = Array.isArray(body.materialIds)
      ? body.materialIds
        .filter((value): value is string =>
          typeof value === "string" && UUID_PATTERN.test(value)
        )
        .slice(0, MAX_BATCH)
      : typeof body.materialId === "string" &&
          UUID_PATTERN.test(body.materialId)
      ? [body.materialId]
      : [];
    const bulk = body.allApproved === true;
    if (bulk && !auth.context.isService) {
      return json(403, {
        error: "SERVICE_ACCESS_REQUIRED",
        code: "SERVICE_ACCESS_REQUIRED",
      });
    }
    if (!bulk && requestedIds.length === 0) {
      return json(400, {
        error: "MATERIAL_ID_REQUIRED",
        code: "MATERIAL_ID_REQUIRED",
      });
    }

    let query = auth.context.admin
      .from("pedagogical_materials")
      .select(
        "id, tenant_id, type, approval_status, " +
          "storage_object_path, hub_preview_source_path, hub_catalog_opt_in, " +
          "hub_commercial_approved, hub_rights_basis, hub_rights_declaration, " +
          "hub_publication_requested_by, hub_publication_requested_at, " +
          "hub_rights_verified_by, hub_rights_verified_at, hub_sync_status",
      )
      .eq("approval_status", "APPROVED")
      .order("created_at", { ascending: true })
      .limit(MAX_BATCH);
    if (bulk) {
      query = query
        .eq("hub_catalog_opt_in", true)
        .eq("hub_commercial_approved", true)
        .in("hub_sync_status", ["PENDING", "FAILED"]);
    } else {
      query = query.in("id", requestedIds);
    }
    if (
      !auth.context.isService && auth.context.profile?.role !== "SUPER_ADMIN"
    ) {
      query = query.eq("tenant_id", auth.context.profile?.tenant_id);
    }

    const { data, error: materialsError } = await query;
    if (materialsError) throw materialsError;
    const materials: PublicationCandidate[] = [];
    for (const row of data || []) {
      const material = parsePublicationCandidate(row);
      if (!material) throw new Error("MATERIAL_RECORD_INVALID");
      materials.push(material);
    }
    if (!bulk && materials.length === 0) {
      return json(404, {
        error: "MATERIAL_NOT_FOUND",
        code: "MATERIAL_NOT_FOUND",
      });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const material of materials) {
      if (
        !auth.context.isService && auth.context.profile?.role !== "SUPER_ADMIN"
      ) {
        const sameTenant =
          auth.context.profile?.tenant_id === material.tenant_id;
        if (!sameTenant) {
          results.push({
            materialId: material.id,
            ok: false,
            code: "MATERIAL_ACCESS_DENIED",
          });
          continue;
        }
      }

      const eligibilityError = publicationEligibilityError(material);
      if (eligibilityError) {
        results.push({
          materialId: material.id,
          ok: false,
          code: eligibilityError,
        });
        continue;
      }

      try {
        const fullSourcePath = material.storage_object_path!;
        const previewSourcePath = material.hub_preview_source_path!;
        const { data: sourcesValid, error: sourceValidationError } = await auth
          .context.admin
          .rpc("hub_validate_material_publication_sources", {
            p_material_id: material.id,
            p_full_source_path: fullSourcePath,
            p_preview_source_path: previewSourcePath,
          });
        if (sourceValidationError) {
          throw new Error("PUBLICATION_SOURCE_VALIDATION_FAILED");
        }
        if (sourcesValid !== true) {
          throw new Error("PUBLICATION_SOURCE_PROVENANCE_INVALID");
        }

        const { data: claimed, error: claimError } = await auth.context.admin
          .from("pedagogical_materials")
          .update({
            hub_sync_status: "SYNCING",
            hub_sync_error: null,
          })
          .eq("id", material.id)
          .eq("hub_catalog_opt_in", true)
          .eq("hub_commercial_approved", true)
          .eq("storage_object_path", fullSourcePath)
          .eq("hub_preview_source_path", previewSourcePath)
          .in("hub_sync_status", ["PENDING", "FAILED"])
          .select("id")
          .maybeSingle();
        if (claimError) throw claimError;
        if (!claimed) throw new Error("PUBLICATION_AUTHORIZATION_CHANGED");

        const fullObjectPath = await copyPrivateObject(
          supabaseUrl,
          serviceRoleKey,
          fullSourcePath,
          `pedagogical/${material.id}/full`,
        );
        const previewObjectPath = await copyPrivateObject(
          supabaseUrl,
          serviceRoleKey,
          previewSourcePath,
          `pedagogical/${material.id}/preview`,
        );

        const { data: finalized, error: updateError } = await auth.context.admin
          .from("pedagogical_materials")
          .update({
            hub_object_path: fullObjectPath,
            hub_preview_object_path: previewObjectPath,
            hub_sync_status: "SYNCED",
            hub_sync_error: null,
            hub_synced_at: new Date().toISOString(),
          })
          .eq("id", material.id)
          .eq("hub_catalog_opt_in", true)
          .eq("hub_commercial_approved", true)
          .eq("storage_object_path", fullSourcePath)
          .eq("hub_preview_source_path", previewSourcePath)
          .select("id")
          .maybeSingle();
        if (updateError) throw updateError;
        if (!finalized) throw new Error("PUBLICATION_AUTHORIZATION_CHANGED");
        results.push({
          materialId: material.id,
          ok: true,
          fullObjectPath,
          previewObjectPath,
        });
      } catch (error) {
        const code = error instanceof Error
          ? error.message.slice(0, 120)
          : "MATERIAL_SYNC_FAILED";
        await auth.context.admin.from("pedagogical_materials").update({
          hub_sync_status: "FAILED",
          hub_sync_error: code,
          hub_synced_at: null,
        })
          .eq("id", material.id)
          .eq("hub_catalog_opt_in", true)
          .eq("hub_commercial_approved", true);
        results.push({ materialId: material.id, ok: false, code });
      }
    }

    const synced = results.filter((result) => result.ok === true).length;
    return json(200, {
      ok: results.length > 0 && synced === results.length,
      processed: results.length,
      synced,
      failed: results.length - synced,
      results,
    });
  } catch (error) {
    console.error("Hub material synchronization failed", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    return json(500, {
      error: "MATERIAL_SYNC_FAILED",
      code: "MATERIAL_SYNC_FAILED",
    });
  }
});
