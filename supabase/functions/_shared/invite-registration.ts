/// <reference lib="deno.ns" />

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { legalSignatureLocation } from "./tenant-legal-assets.ts";

export type InviteKind = "TEACHER_INVITE" | "VENDOR_INVITE";

export interface ClaimedInvite {
  offerId: string;
  claimToken: string;
  kind: InviteKind;
  tenantId: string;
  data: Record<string, unknown>;
}

export class InviteRegistrationError extends Error {
  constructor(
    readonly code:
      | "INVALID_INVITE"
      | "INVITE_UNAVAILABLE"
      | "INVITE_FINALIZE_FAILED",
  ) {
    super(code);
    this.name = "InviteRegistrationError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasContractSchoolInfo(value: unknown, tenantId: string): boolean {
  if (!isRecord(value)) return false;
  const required = [
    "legalName",
    "cnpj",
    "address",
    "email",
    "phone",
    "city",
    "state",
    "legalRepresentativeName",
    "legalRepresentativeSignaturePath",
  ];
  if (
    required.some((key) =>
      typeof value[key] !== "string" || !String(value[key]).trim()
    )
  ) return false;
  return Boolean(
    legalSignatureLocation(value.legalRepresentativeSignaturePath, tenantId),
  );
}

export function isServerInviteId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value.trim());
}

export function validateClaimedInvite(
  value: unknown,
  expectedKind: InviteKind,
): Record<string, unknown> {
  if (
    !isRecord(value) || value.kind !== expectedKind ||
    typeof value.tenantId !== "string" || !value.tenantId.trim() ||
    typeof value._offerId !== "string" || !isServerInviteId(value._offerId)
  ) {
    throw new InviteRegistrationError("INVALID_INVITE");
  }
  if (
    expectedKind === "TEACHER_INVITE" &&
    (
      typeof value.hourlyRate !== "number" ||
      !Number.isFinite(value.hourlyRate) ||
      value.hourlyRate <= 0 || value.hourlyRate > 10_000 ||
      typeof value.subject !== "string" || !value.subject.trim() ||
      !hasContractSchoolInfo(value.schoolInfo, value.tenantId)
    )
  ) {
    throw new InviteRegistrationError("INVALID_INVITE");
  }
  if (
    expectedKind === "VENDOR_INVITE" &&
    (
      typeof value.commissionRate !== "number" ||
      !Number.isSafeInteger(value.commissionRate) ||
      value.commissionRate <= 0 ||
      value.commissionRate > 10_000_000
    )
  ) {
    throw new InviteRegistrationError("INVALID_INVITE");
  }
  return value;
}

export async function claimInvite(
  admin: SupabaseClient,
  rawOfferId: unknown,
  kind: InviteKind,
): Promise<ClaimedInvite> {
  if (!isServerInviteId(rawOfferId)) {
    throw new InviteRegistrationError("INVALID_INVITE");
  }
  const offerId = rawOfferId.trim();
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc("claim_invite_offer_server", {
    p_offer_id: offerId,
    p_kind: kind,
    p_claim_token: claimToken,
  });
  if (error) throw new InviteRegistrationError("INVITE_UNAVAILABLE");
  const validated = validateClaimedInvite(data, kind);
  return {
    offerId,
    claimToken,
    kind,
    tenantId: String(validated.tenantId),
    data: validated,
  };
}

export async function releaseInviteClaim(
  admin: SupabaseClient,
  invite: ClaimedInvite | null,
): Promise<void> {
  if (!invite) return;
  await admin.rpc("release_invite_offer_claim_server", {
    p_offer_id: invite.offerId,
    p_kind: invite.kind,
    p_claim_token: invite.claimToken,
  });
}

export async function finalizeInvite(
  admin: SupabaseClient,
  invite: ClaimedInvite,
  userId: string,
): Promise<void> {
  const { data, error } = await admin.rpc("finalize_invite_offer_server", {
    p_offer_id: invite.offerId,
    p_kind: invite.kind,
    p_claim_token: invite.claimToken,
    p_user_id: userId,
  });
  if (error || data !== true) {
    throw new InviteRegistrationError("INVITE_FINALIZE_FAILED");
  }
}
