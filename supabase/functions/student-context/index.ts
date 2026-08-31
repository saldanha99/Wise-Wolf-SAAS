/// <reference lib="deno.ns" />

import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  type BillingStatus,
  type OpenStudentPaymentRow,
  resolveDisplayedStreak,
  resolveStudentAccess,
  resolveStudentBilling,
  type StudentAccess,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const profileColumns = [
  "id",
  "full_name",
  "role",
  "tenant_id",
  "meeting_link",
  "module",
  "current_book_part",
  "evaluation_unlocked",
  "documentation_status",
  "rejection_reason",
  "onboarded",
  "class_frequency",
  "xp",
  "level",
  "streak_count",
  "last_streak_date",
  "last_activity",
  "wolfie_settings",
  "english_for",
  "preferred_topics",
  "short_term_goal",
  "is_test_account",
].join(",");

interface StudentProfile {
  id: string;
  full_name: string | null;
  role: string | null;
  tenant_id: string | null;
  meeting_link: string | null;
  module: string | null;
  current_book_part: string | null;
  evaluation_unlocked: boolean | null;
  documentation_status: string | null;
  rejection_reason: string | null;
  onboarded: boolean | null;
  class_frequency: string | null;
  xp: number | null;
  level: number | null;
  streak_count: number | null;
  last_streak_date: string | null;
  last_activity: string | null;
  monthly_fee: number | null;
  due_day: number | null;
  status_financial: string | null;
  paid_through: string | null;
  prepaid_months: number | null;
  wolfie_settings: Record<string, unknown> | null;
  english_for: string | null;
  preferred_topics: string[] | null;
  short_term_goal: string | null;
  is_test_account: boolean | null;
}

type PublicStudentProfile = Omit<StudentProfile, "is_test_account">;

interface AuthorizedStudentFinancialProfile {
  monthly_fee: number | null;
  due_day: number | null;
  status_financial: string | null;
  paid_through: string | null;
  prepaid_months: number | null;
}

interface BookingRow {
  id: string;
  tenant_id: string;
  teacher_id: string | null;
  student_id: string;
  day_of_week: string | null;
  time_slot: string | null;
  start_date: string | null;
  status: string | null;
}

interface NextClass extends BookingRow {
  start_time: string;
}

interface StudentContextResponse {
  profile: PublicStudentProfile | Record<string, never>;
  gamification: {
    xp: number;
    level: number;
    streak: number;
    nextLevelProgress: number;
  };
  billing: {
    status: BillingStatus;
    oldestDue: string | null;
  };
  access: StudentAccess | { status: "UNAVAILABLE"; enrollmentState: null };
  nextClass: NextClass | null;
  _error?: string;
}

const unavailableResponse = (
  message: string,
): StudentContextResponse => ({
  profile: {},
  gamification: { xp: 0, level: 1, streak: 0, nextLevelProgress: 0 },
  // Fail closed: the application must not grant access based on an unchecked bill.
  billing: { status: "SUSPENDED", oldestDue: null },
  access: { status: "UNAVAILABLE", enrollmentState: null },
  nextClass: null,
  _error: message,
});

const jsonResponse = (
  body: StudentContextResponse,
  status = 200,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const singleRelation = <T>(value: T | T[] | null): T | null =>
  Array.isArray(value) ? value[0] ?? null : value;

const normaliseDay = (value: string): number => {
  const day = value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .split("-")[0]
    .trim();

  const dayIndexes: Record<string, number> = {
    domingo: 0,
    sunday: 0,
    segunda: 1,
    monday: 1,
    terca: 2,
    tuesday: 2,
    quarta: 3,
    wednesday: 3,
    quinta: 4,
    thursday: 4,
    sexta: 5,
    friday: 5,
    sabado: 6,
    saturday: 6,
  };

  return dayIndexes[day] ?? -1;
};

const dateInSaoPaulo = (date: Date): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const findNextClass = (
  bookings: BookingRow[],
  now: Date,
): NextClass | null => {
  const today = dateInSaoPaulo(now);
  const todayAtNoonUtc = new Date(`${today}T12:00:00.000Z`);
  const candidates: NextClass[] = [];

  for (const booking of bookings) {
    if (
      !booking.day_of_week ||
      !booking.time_slot ||
      !/^\d{2}:\d{2}$/.test(booking.time_slot) ||
      ["CANCELLED", "CANCELED", "INACTIVE"].includes(
        (booking.status ?? "").toUpperCase(),
      )
    ) {
      continue;
    }

    const bookingDay = normaliseDay(booking.day_of_week);
    if (bookingDay < 0) continue;

    for (let daysAhead = 0; daysAhead <= 7; daysAhead += 1) {
      const candidateDay = new Date(
        todayAtNoonUtc.getTime() + daysAhead * 86_400_000,
      );
      if (candidateDay.getUTCDay() !== bookingDay) continue;

      const candidateDate = candidateDay.toISOString().slice(0, 10);
      if (booking.start_date && candidateDate < booking.start_date) continue;

      const startTime = `${candidateDate}T${booking.time_slot}:00-03:00`;
      if (new Date(startTime).getTime() < now.getTime()) continue;

      candidates.push({ ...booking, start_time: startTime });
      break;
    }
  }

  return candidates.sort(
    (first, second) =>
      new Date(first.start_time).getTime() -
      new Date(second.start_time).getTime(),
  )[0] ?? null;
};

const fetchNextClass = async (
  supabase: SupabaseClient,
  studentId: string,
  tenantId: string,
  now: Date,
): Promise<NextClass | null> => {
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, tenant_id, teacher_id, student_id, day_of_week, time_slot, start_date, status",
    )
    .eq("student_id", studentId)
    .eq("tenant_id", tenantId);

  if (error) return null;
  return findNextClass((data ?? []) as BookingRow[], now);
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(unavailableResponse("METHOD_NOT_ALLOWED"), 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return jsonResponse(unavailableResponse("SERVICE_UNAVAILABLE"), 503);
    }

    const authorization = req.headers.get("Authorization") ?? "";
    const bearerMatch = authorization.match(/^Bearer\s+(\S+)$/i);
    if (!bearerMatch) {
      return jsonResponse(unavailableResponse("UNAUTHORIZED"), 401);
    }

    const jwt = bearerMatch[1];
    const supabase = createClient(supabaseUrl, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    // The enrollment offer is an operational record and may not be visible
    // through end-user RLS. This server-side client is used only after JWT,
    // role and tenant validation, with exact user/tenant predicates below.
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser(jwt);
    if (userError || !user) {
      return jsonResponse(unavailableResponse("UNAUTHORIZED"), 401);
    }

    const { data: rawProfile, error: profileError } = await supabase
      .from("profiles")
      .select(profileColumns)
      .eq("id", user.id)
      .maybeSingle();
    const directoryProfile = singleRelation(
      rawProfile as unknown as StudentProfile | StudentProfile[] | null,
    );

    if (profileError) {
      return jsonResponse(unavailableResponse("PROFILE_UNAVAILABLE"), 503);
    }
    if (!directoryProfile) {
      return jsonResponse(unavailableResponse("PROFILE_NOT_FOUND"), 404);
    }
    if (directoryProfile.role !== "STUDENT") {
      return jsonResponse(unavailableResponse("FORBIDDEN"), 403);
    }
    if (!directoryProfile.tenant_id) {
      return jsonResponse(unavailableResponse("TENANT_REQUIRED"), 403);
    }
    const tenantId = directoryProfile.tenant_id;

    const { data: privateProfileData, error: privateProfileError } =
      await supabase.rpc("get_authorized_profile_private", {
        p_profile_id: user.id,
      });
    if (privateProfileError || !privateProfileData) {
      return jsonResponse(unavailableResponse("PROFILE_UNAVAILABLE"), 503);
    }

    const privateProfile = privateProfileData as Record<string, unknown>;
    const financialProfile: AuthorizedStudentFinancialProfile = {
      monthly_fee: typeof privateProfile.monthly_fee === "number"
        ? privateProfile.monthly_fee
        : null,
      due_day: typeof privateProfile.due_day === "number"
        ? privateProfile.due_day
        : null,
      status_financial: typeof privateProfile.status_financial === "string"
        ? privateProfile.status_financial
        : null,
      paid_through: typeof privateProfile.paid_through === "string"
        ? privateProfile.paid_through
        : null,
      prepaid_months: typeof privateProfile.prepaid_months === "number"
        ? privateProfile.prepaid_months
        : null,
    };
    const profile: StudentProfile = {
      ...directoryProfile,
      ...financialProfile,
    };

    const { data: enrollmentOffers, error: enrollmentOffersError } = await admin
      .from("offers")
      .select(
        "processing_state, processing_by, consumed_by, consumed_at, processing_updated_at",
      )
      .eq("tenant_id", tenantId)
      .eq("kind", "ENROLLMENT")
      .or(`processing_by.eq.${user.id},consumed_by.eq.${user.id}`)
      .order("processing_updated_at", { ascending: false });
    if (enrollmentOffersError) {
      return jsonResponse(
        unavailableResponse("ENROLLMENT_STATE_UNAVAILABLE"),
        503,
      );
    }
    const access = resolveStudentAccess(enrollmentOffers ?? [], user.id);

    const now = new Date();
    const businessDate = dateInSaoPaulo(now);
    const streak = resolveDisplayedStreak(
      profile.streak_count ?? 0,
      profile.last_streak_date,
      businessDate,
    );
    const { data: paymentData, error: paymentError } = await supabase
      .from("student_payments")
      .select("due_date, status")
      .eq("student_id", user.id)
      .eq("tenant_id", tenantId)
      .in("status", ["PENDING", "OVERDUE"])
      .lt("due_date", businessDate)
      .order("due_date", { ascending: true });

    if (paymentError) {
      return jsonResponse(unavailableResponse("BILLING_UNAVAILABLE"), 503);
    }

    const billingDecision = resolveStudentBilling(
      (paymentData ?? []) as OpenStudentPaymentRow[],
      businessDate,
    );
    const billingStatus: BillingStatus = billingDecision.status;
    const oldestDue = billingDecision.oldestDue
      ? `${billingDecision.oldestDue}T00:00:00.000Z`
      : null;

    const nextClass = access.status === "ACTIVE"
      ? await fetchNextClass(
        supabase,
        user.id,
        tenantId,
        now,
      )
      : null;
    const { is_test_account: _isTestAccount, ...publicProfile } = profile;
    void _isTestAccount;

    return jsonResponse({
      profile: {
        ...publicProfile,
        streak_count: streak,
        last_activity: profile.last_activity,
      },
      gamification: {
        xp: profile.xp ?? 0,
        level: profile.level ?? 1,
        streak,
        nextLevelProgress: ((profile.xp ?? 0) % 1000) / 10,
      },
      billing: { status: billingStatus, oldestDue },
      access,
      nextClass,
    });
  } catch {
    return jsonResponse(unavailableResponse("INTERNAL_ERROR"), 500);
  }
});
