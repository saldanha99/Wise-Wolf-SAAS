/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

export const TENANT_LEGAL_ASSETS_BUCKET = "tenant-legal-assets";
export const LEGAL_SIGNATURE_TTL_SECONDS = 15 * 60;

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export interface LegalSignatureLocation {
  bucket: typeof TENANT_LEGAL_ASSETS_BUCKET;
  path: string;
}

function publicSignedAssetUrl(
  signedUrl: string,
  configuredPublicBaseUrl?: string,
): string {
  const publicBaseUrl = configuredPublicBaseUrl?.trim() || "";
  if (!publicBaseUrl) return signedUrl;

  const signed = new URL(signedUrl);
  const publicBase = new URL(publicBaseUrl);
  const publicIsSafe = publicBase.protocol === "https:" ||
    (publicBase.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(publicBase.hostname));
  if (
    !publicIsSafe || publicBase.username || publicBase.password ||
    publicBase.hash
  ) {
    throw new Error("tenant_legal_public_url_invalid");
  }

  return new URL(`${signed.pathname}${signed.search}`, publicBase.origin)
    .toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function legalSignatureLocation(
  value: unknown,
  tenantId: string,
): LegalSignatureLocation | null {
  if (typeof value !== "string" || !tenantId) return null;
  const path = value.trim();
  const tenant = escapedPattern(tenantId);
  const privatePattern = new RegExp(
    `^${tenant}/legal-representative-signature/${UUID_PATTERN}\\.(?:png|jpe?g|webp)$`,
    "i",
  );
  if (privatePattern.test(path)) {
    return { bucket: TENANT_LEGAL_ASSETS_BUCKET, path };
  }
  return null;
}

export function storedLegalSignatureLocation(
  schoolInfo: unknown,
  tenantId: string,
): LegalSignatureLocation | null {
  if (!isRecord(schoolInfo)) return null;
  const direct = legalSignatureLocation(
    schoolInfo.legalRepresentativeSignaturePath,
    tenantId,
  );
  return direct || null;
}

export async function materializeLegalSchoolInfo(
  admin: SupabaseClient,
  tenantId: string,
  schoolInfo: unknown,
  options: {
    includePath?: boolean;
    expiresIn?: number;
    publicBaseUrl?: string;
  } = {},
): Promise<Record<string, unknown> | null> {
  if (!isRecord(schoolInfo)) return null;
  const safeInfo = { ...schoolInfo };
  delete safeInfo.legalRepresentativeSignatureUrl;
  delete safeInfo.directorSignatureUrl;
  delete safeInfo.signatureUrl;
  delete safeInfo.legalRepresentativeSignaturePath;

  const location = storedLegalSignatureLocation(schoolInfo, tenantId);
  if (!location) return safeInfo;

  const { data, error } = await admin.storage
    .from(location.bucket)
    .createSignedUrl(
      location.path,
      options.expiresIn || LEGAL_SIGNATURE_TTL_SECONDS,
    );
  if (error || !data?.signedUrl) {
    throw new Error("tenant_legal_signature_unavailable");
  }

  if (options.includePath) {
    safeInfo.legalRepresentativeSignaturePath = location.path;
  }
  safeInfo.legalRepresentativeSignatureUrl = publicSignedAssetUrl(
    data.signedUrl,
    options.publicBaseUrl,
  );
  return safeInfo;
}
