/// <reference lib="deno.ns" />

import type { RequestAuthContext } from "./request-auth.ts";

const DIRECT_TENANT_ID = "wolfie-direct";
const CALENDAR_DAY_MS = 86_400_000;

export const OPEN_STUDENT_PAYMENT_STATUSES = [
  "PENDING",
  "OVERDUE",
] as const;

const calendarDayUtc = (value: unknown): number => {
  if (typeof value !== "string") {
    throw new RangeError("invalid_calendar_date");
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new RangeError("invalid_calendar_date");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new RangeError("invalid_calendar_date");
  }
  return timestamp;
};

/** Returns the calendar date used by every student billing access gate. */
export function studentBillingDateInSaoPaulo(now = new Date()): string {
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("invalid_billing_instant");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const businessDate = `${part("year")}-${part("month")}-${part("day")}`;
  calendarDayUtc(businessDate);
  return businessDate;
}

/**
 * Counts Monday-Friday dates in (dueDate, asOfDate]. This deliberately mirrors
 * the contractual seven-business-day rule shown in the student portal.
 */
export function studentPaymentBusinessDaysLate(
  dueDate: unknown,
  asOfDate: unknown,
): number {
  const dueTimestamp = calendarDayUtc(dueDate);
  const asOfTimestamp = calendarDayUtc(asOfDate);
  if (asOfTimestamp <= dueTimestamp) return 0;

  let businessDays = 0;
  for (
    let cursor = dueTimestamp + CALENDAR_DAY_MS;
    cursor <= asOfTimestamp;
    cursor += CALENDAR_DAY_MS
  ) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) businessDays += 1;
  }
  return businessDays;
}

export function studentPaymentIsBeyondTolerance(
  dueDate: unknown,
  asOfDate: unknown,
  toleranceBusinessDays = 7,
): boolean {
  if (
    !Number.isInteger(toleranceBusinessDays) ||
    toleranceBusinessDays < 0
  ) {
    throw new RangeError("invalid_business_day_tolerance");
  }
  return studentPaymentBusinessDaysLate(dueDate, asOfDate) >
    toleranceBusinessDays;
}

type WolfieAccess = {
  allowed?: boolean;
  code?: string;
  accessKind?: "SCHOOL" | "STANDALONE";
  planCode?: string | null;
  planName?: string | null;
};

const jsonError = (
  corsHeaders: Record<string, string>,
  status: number,
  code: string,
) =>
  new Response(
    JSON.stringify({
      error: code,
      code,
      upgradeUrl: "https://wolfie.wisewolflanguage.com.br/planos",
    }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    },
  );

/**
 * School memberships keep their established billing path. The isolated
 * direct tenant, however, fails closed unless Postgres confirms a live paid
 * Wolfie subscription for the authenticated user.
 */
export async function requireWolfieProductAccess(
  context: RequestAuthContext,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (context.profile?.tenant_id !== DIRECT_TENANT_ID) return null;
  if (!context.userId) {
    return jsonError(corsHeaders, 401, "AUTHENTICATION_REQUIRED");
  }

  const { data, error } = await context.admin.rpc("wolfie_access_for_user", {
    p_user_id: context.userId,
  });
  if (error) {
    console.error("Wolfie product access lookup failed", { code: error.code });
    return jsonError(corsHeaders, 503, "WOLFIE_ACCESS_UNAVAILABLE");
  }

  const access = data && typeof data === "object" && !Array.isArray(data)
    ? data as WolfieAccess
    : null;
  if (access?.allowed === true && access.accessKind === "STANDALONE") {
    return null;
  }
  return jsonError(
    corsHeaders,
    402,
    access?.code || "WOLFIE_SUBSCRIPTION_REQUIRED",
  );
}
