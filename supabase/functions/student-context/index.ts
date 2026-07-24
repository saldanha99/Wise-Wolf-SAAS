import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.93.3";

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
  "last_activity",
  "monthly_fee",
  "due_day",
  "status_financial",
  "paid_through",
  "prepaid_months",
  "is_test_account",
].join(",");

type BillingStatus = "OK" | "OVERDUE" | "SUSPENDED";

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
  last_activity: string | null;
  monthly_fee: number | null;
  due_day: number | null;
  status_financial: string | null;
  paid_through: string | null;
  prepaid_months: number | null;
  is_test_account: boolean | null;
}

type PublicStudentProfile = Omit<StudentProfile, "is_test_account">;

interface PaymentRow {
  due_date: string;
  status: string;
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
    if (!supabaseUrl || !anonKey) {
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
    const profile = singleRelation(
      rawProfile as StudentProfile | StudentProfile[] | null,
    );

    if (profileError) {
      return jsonResponse(unavailableResponse("PROFILE_UNAVAILABLE"), 503);
    }
    if (!profile) {
      return jsonResponse(unavailableResponse("PROFILE_NOT_FOUND"), 404);
    }
    if (profile.role !== "STUDENT") {
      return jsonResponse(unavailableResponse("FORBIDDEN"), 403);
    }
    if (!profile.tenant_id) {
      return jsonResponse(unavailableResponse("TENANT_REQUIRED"), 403);
    }

    const now = new Date();
    let streak = profile.streak_count ?? 0;
    let lastActivity = profile.last_activity;

    // Test fixtures remain read-only so routine QA cannot create durable activity.
    if (!profile.is_test_account) {
      const persistedStreak = streak;
      const previousActivity = profile.last_activity
        ? new Date(profile.last_activity)
        : null;
      const today = dateInSaoPaulo(now);
      const previousDay = previousActivity
        ? dateInSaoPaulo(previousActivity)
        : null;

      if (previousDay !== today) {
        if (previousDay) {
          const todayUtc = new Date(`${today}T12:00:00.000Z`);
          const previousUtc = new Date(`${previousDay}T12:00:00.000Z`);
          const dayDifference = Math.round(
            (todayUtc.getTime() - previousUtc.getTime()) / 86_400_000,
          );
          streak = dayDifference === 1 ? streak + 1 : 1;
        } else {
          streak = 1;
        }
      }

      const activityTimestamp = now.toISOString();
      const { error: activityError } = await supabase
        .from("profiles")
        .update({
          streak_count: streak,
          last_activity: activityTimestamp,
        })
        .eq("id", user.id)
        .eq("tenant_id", profile.tenant_id)
        .eq("role", "STUDENT");

      if (activityError) {
        streak = persistedStreak;
      } else {
        lastActivity = activityTimestamp;
      }
    }

    const { data: paymentData, error: paymentError } = await supabase
      .from("student_payments")
      .select("due_date, status")
      .eq("student_id", user.id)
      .eq("tenant_id", profile.tenant_id)
      .in("status", ["PENDING", "OVERDUE"])
      .lt("due_date", dateInSaoPaulo(now))
      .order("due_date", { ascending: true });

    if (paymentError) {
      return jsonResponse(unavailableResponse("BILLING_UNAVAILABLE"), 503);
    }

    const overduePayments = (paymentData ?? []) as PaymentRow[];
    let billingStatus: BillingStatus = "OK";
    let oldestDue: string | null = null;
    if (overduePayments.length > 0) {
      oldestDue = new Date(overduePayments[0].due_date).toISOString();
      const todayAtNoonUtc = new Date(
        `${dateInSaoPaulo(now)}T12:00:00.000Z`,
      );
      const oldestDueAtNoonUtc = new Date(
        `${overduePayments[0].due_date.slice(0, 10)}T12:00:00.000Z`,
      );
      const daysLate = Math.round(
        (todayAtNoonUtc.getTime() - oldestDueAtNoonUtc.getTime()) / 86_400_000,
      );
      billingStatus = daysLate > 7 ? "SUSPENDED" : "OVERDUE";
    }

    const nextClass = await fetchNextClass(
      supabase,
      user.id,
      profile.tenant_id,
      now,
    );
    const { is_test_account: _isTestAccount, ...publicProfile } = profile;
    void _isTestAccount;

    return jsonResponse({
      profile: {
        ...publicProfile,
        streak_count: streak,
        last_activity: lastActivity,
      },
      gamification: {
        xp: profile.xp ?? 0,
        level: profile.level ?? 1,
        streak,
        nextLevelProgress: ((profile.xp ?? 0) % 1000) / 10,
      },
      billing: { status: billingStatus, oldestDue },
      nextClass,
    });
  } catch {
    return jsonResponse(unavailableResponse("INTERNAL_ERROR"), 500);
  }
});
