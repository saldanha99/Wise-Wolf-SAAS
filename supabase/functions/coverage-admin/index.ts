/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeRequest,
  methodNotAllowed,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import { loadTenantCentralWhatsAppInstance } from "../_shared/tenant-communication.ts";

// ============================================================================
// coverage-admin — Substituição temporária de aula (Fase 2).
//   createAbsence  : registra ausência do professor e lista as aulas afetadas
//   requestCoverage: cria coberturas (handshake via WhatsApp) ou força executor
//   listCoverages  : coberturas de uma ausência, sem expor o token de aceite
// O cover_teacher_id (executor) é quem recebe; o titular fica intacto.
// ============================================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") ||
  "https://api.2b.app.br").replace(/\/+$/, "");
const EVOLUTION_TOKENS = Array.from(
  new Set(
    [(Deno.env.get("EVOLUTION_API_KEY") || "").trim()].filter(Boolean),
  ),
);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")?.trim() ?? "";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ABSENCE_DAYS = 31;
const MAX_AFFECTED_CLASSES = 200;
const MAX_COVERAGE_ITEMS = 50;
const MAX_LIST_COVERAGES = 200;
const MAX_REASON_LENGTH = 500;
const CONFLICT_WINDOW_MINUTES = 30;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const ACTIVE_APPOINTMENT_STATUSES = new Set(["scheduled", "confirmed"]);
const COVERAGE_SAFE_FIELDS = [
  "id",
  "original_teacher_id",
  "cover_teacher_id",
  "student_id",
  "booking_id",
  "absence_id",
  "tenant_id",
  "class_date",
  "class_time",
  "status",
  "notes",
  "confirmed_at",
  "dispatched_at",
  "invite_expires_at",
].join(",");

const WEEKDAY_BY_NAME: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

type AdminClient = RequestAuthContext["admin"];
type JsonObject = Record<string, unknown>;

interface CoverageItemInput {
  bookingId: string;
  studentId: string;
  classDate: string;
  classTime: string;
  coverTeacherId: string;
}

interface ValidatedCoverageItem extends CoverageItemInput {
  studentName: string;
  coverName: string;
  coverPhone: string | null;
}

interface MemberProfile {
  id: string;
  full_name: string | null;
  phone: string | null;
  attendance_phone: string | null;
  lifecycle_status: string | null;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function dbFailure(context: string, error: { code?: string } | null): never {
  console.error(`coverage-admin ${context} failed`, {
    code: error?.code ?? "UNKNOWN",
  });
  throw new ApiError(503, "servico temporariamente indisponivel");
}

async function readJsonObject(req: Request): Promise<JsonObject> {
  const declaredLength = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload muito grande");
  }

  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, "json invalido");

  const decoder = new TextDecoder();
  let raw = "";
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(413, "payload muito grande");
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "json invalido");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new ApiError(400, "json invalido");
  }
  return parsed as JsonObject;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCoveragePhone(value: unknown): string | null {
  let digits = stringField(value).replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return /^[1-9]\d{11,14}$/.test(digits) ? digits : null;
}

function requireUuid(value: unknown, field: string): string {
  const normalized = stringField(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw new ApiError(400, `${field} invalido`);
  }
  return normalized;
}

function parseDateKey(value: unknown): Date | null {
  const normalized = stringField(value);
  if (!DATE_PATTERN.test(normalized)) return null;
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) return null;
  return parsed;
}

function dateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().slice(0, 10);
  return parseDateKey(candidate) ? candidate : null;
}

function lessonDateKey(value: unknown): string | null {
  const iso = dateKey(value);
  if (iso) return iso;
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const candidate = `${match[3]}-${match[2]}-${match[1]}`;
  return parseDateKey(candidate) ? candidate : null;
}

function formatDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${
    String(date.getUTCMonth() + 1).padStart(2, "0")
  }-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function normalizeTime(value: unknown): string | null {
  const match = stringField(value).match(TIME_PATTERN);
  return match ? `${match[1]}:${match[2]}` : null;
}

function timeMinutes(value: unknown): number | null {
  const normalized = normalizeTime(value);
  if (!normalized) return null;
  const [hour, minute] = normalized.split(":").map(Number);
  return hour * 60 + minute;
}

function weekdayIndex(value: unknown): number | null {
  if (
    typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= 6
  ) return value;
  const normalized = stringField(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/-?feira/g, "")
    .trim();
  return Object.prototype.hasOwnProperty.call(WEEKDAY_BY_NAME, normalized)
    ? WEEKDAY_BY_NAME[normalized]
    : null;
}

function isActiveLifecycle(value: unknown): boolean {
  return stringField(value).toLowerCase() === "active";
}

function isScheduledBooking(value: unknown): boolean {
  return stringField(value).toUpperCase() === "SCHEDULED";
}

function bookingOccursAt(
  booking: JsonObject,
  classDate: string,
  classTime: string,
  exactTime = true,
): boolean {
  if (!isScheduledBooking(booking.status)) return false;
  const bookingTime = timeMinutes(booking.time_slot);
  const requestedTime = timeMinutes(classTime);
  if (bookingTime === null || requestedTime === null) return false;
  if (
    exactTime
      ? bookingTime !== requestedTime
      : Math.abs(bookingTime - requestedTime) >= CONFLICT_WINDOW_MINUTES
  ) return false;

  const fixedDate = dateKey(booking.date);
  if (booking.date !== null && booking.date !== undefined) {
    return fixedDate === classDate;
  }

  const requestedDate = parseDateKey(classDate);
  if (
    !requestedDate ||
    weekdayIndex(booking.day_of_week) !== requestedDate.getUTCDay()
  ) return false;
  const startsOn = dateKey(booking.start_date);
  return !startsOn || startsOn <= classDate;
}

function availabilityCovers(
  availability: JsonObject,
  classDate: string,
  classTime: string,
): boolean {
  const date = parseDateKey(classDate);
  const requested = timeMinutes(classTime);
  const start = timeMinutes(availability.start_time);
  const end = timeMinutes(availability.end_time);
  if (
    !date || requested === null || start === null ||
    weekdayIndex(availability.day_of_week) !== date.getUTCDay()
  ) return false;
  return end === null
    ? start === requested
    : start <= requested && requested < end;
}

function sameTimeWindow(left: unknown, right: unknown): boolean {
  const a = timeMinutes(left);
  const b = timeMinutes(right);
  return a !== null && b !== null &&
    Math.abs(a - b) < CONFLICT_WINDOW_MINUTES;
}

function brStartMillis(classDate: string, classTime: string): number {
  return new Date(`${classDate}T${classTime}:00-03:00`).getTime();
}

function coverageInviteExpired(
  coverage: JsonObject,
  now = Date.now(),
): boolean {
  if (stringField(coverage.status).toLowerCase() !== "pending") return false;
  const explicitExpiry = Date.parse(stringField(coverage.invite_expires_at));
  if (Number.isFinite(explicitExpiry)) return explicitExpiry <= now;
  const classDate = dateKey(coverage.class_date);
  const classTime = normalizeTime(coverage.class_time);
  return Boolean(
    classDate && classTime && brStartMillis(classDate, classTime) <= now,
  );
}

function coverageBlocksSlot(coverage: JsonObject, now = Date.now()): boolean {
  const status = stringField(coverage.status).toLowerCase();
  return status === "confirmed" ||
    (status === "pending" && !coverageInviteExpired(coverage, now));
}

async function resolveAuthorizedTenant(
  context: RequestAuthContext,
): Promise<string> {
  const role = context.profile?.role ?? "";
  if (!context.userId || !context.profile) {
    throw new ApiError(403, "forbidden");
  }

  let tenantId = context.profile.tenant_id?.trim() ?? "";
  if (role === "SUPER_ADMIN") {
    const { data: selected, error: selectedError } = await context.admin
      .from("tenant_user_contexts")
      .select("tenant_id")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (selectedError) dbFailure("tenant context lookup", selectedError);
    tenantId = stringField(selected?.tenant_id);
    if (!tenantId) throw new ApiError(403, "tenant ativo obrigatorio");
  }

  if (!tenantId) throw new ApiError(403, "tenant ativo obrigatorio");
  const membershipQuery = context.admin.from("tenant_memberships")
    .select("tenant_id,role")
    .eq("user_id", context.userId)
    .eq("tenant_id", tenantId)
    .eq("status", "ACTIVE");
  const { data: membership, error: membershipError } = role === "SUPER_ADMIN"
    ? await membershipQuery.maybeSingle()
    : await membershipQuery.eq("role", role).maybeSingle();
  if (membershipError) {
    dbFailure("caller membership lookup", membershipError);
  }
  if (!membership) {
    throw new ApiError(403, "membership ativa obrigatoria");
  }

  const { data: tenant, error: tenantError } = await context.admin
    .from("tenants")
    .select("id,saas_status")
    .eq("id", tenantId)
    .maybeSingle();
  if (tenantError) dbFailure("tenant lookup", tenantError);
  const tenantStatus = stringField(tenant?.saas_status).toLowerCase();
  if (
    !tenant ||
    !["active", "trial", "trialing"].includes(tenantStatus)
  ) throw new ApiError(403, "tenant inativo");
  return tenantId;
}

async function loadActiveMembers(
  admin: AdminClient,
  tenantId: string,
  userIds: string[],
  expectedRole: "TEACHER" | "STUDENT",
): Promise<Map<string, MemberProfile>> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return new Map();

  const [membershipsResponse, profilesResponse] = await Promise.all([
    admin.from("tenant_memberships")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("status", "ACTIVE")
      .eq("role", expectedRole)
      .in("user_id", ids),
    admin.from("profiles")
      .select("id,full_name,phone,attendance_phone,lifecycle_status")
      .in("id", ids),
  ]);
  if (membershipsResponse.error) {
    dbFailure("target membership lookup", membershipsResponse.error);
  }
  if (profilesResponse.error) {
    dbFailure("target profile lookup", profilesResponse.error);
  }

  const activeMemberIds = new Set(
    (membershipsResponse.data || []).map((row: JsonObject) =>
      String(row.user_id)
    ),
  );
  const profiles = new Map<string, MemberProfile>();
  for (const row of profilesResponse.data || []) {
    const profile = row as MemberProfile;
    if (
      activeMemberIds.has(profile.id) &&
      isActiveLifecycle(profile.lifecycle_status)
    ) profiles.set(profile.id, profile);
  }
  return profiles;
}

async function requireAbsence(
  admin: AdminClient,
  tenantId: string,
  absenceId: string,
): Promise<JsonObject> {
  const { data, error } = await admin.from("teacher_absences")
    .select("id,teacher_id,tenant_id,starts_at,ends_at,reason,status")
    .eq("id", absenceId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error) dbFailure("absence lookup", error);
  if (!data) throw new ApiError(404, "absence invalida");
  return data as JsonObject;
}

async function createAbsence(
  admin: AdminClient,
  caller: RequestAuthContext,
  tenantId: string,
  body: JsonObject,
): Promise<Response> {
  const teacherId = requireUuid(body.teacherId, "teacherId");
  const startsAt = stringField(body.startsAt);
  const endsAt = stringField(body.endsAt);
  const start = parseDateKey(startsAt);
  const end = parseDateKey(endsAt);
  if (!start || !end || end < start) {
    throw new ApiError(400, "periodo invalido");
  }
  const intervalDays = Math.floor(
    (end.getTime() - start.getTime()) / 86_400_000,
  ) + 1;
  if (intervalDays > MAX_ABSENCE_DAYS) {
    throw new ApiError(
      422,
      `periodo maximo de ${MAX_ABSENCE_DAYS} dias`,
    );
  }
  const reason = body.reason === null || body.reason === undefined
    ? ""
    : stringField(body.reason);
  if (reason.length > MAX_REASON_LENGTH) {
    throw new ApiError(
      422,
      `motivo deve ter ate ${MAX_REASON_LENGTH} caracteres`,
    );
  }

  const teachers = await loadActiveMembers(
    admin,
    tenantId,
    [teacherId],
    "TEACHER",
  );
  if (!teachers.has(teacherId)) {
    throw new ApiError(404, "professor ausente invalido");
  }

  const { data: bookings, error: bookingsError } = await admin.from("bookings")
    .select(
      "id,tenant_id,teacher_id,student_id,day_of_week,time_slot,date,start_date,status",
    )
    .eq("tenant_id", tenantId)
    .eq("teacher_id", teacherId)
    .in("status", ["SCHEDULED", "scheduled"])
    .not("student_id", "is", null);
  if (bookingsError) {
    dbFailure("affected bookings lookup", bookingsError);
  }

  const studentIds = [
    ...new Set(
      (bookings || []).map((booking: JsonObject) =>
        String(booking.student_id || "")
      ).filter(Boolean),
    ),
  ];
  const students = await loadActiveMembers(
    admin,
    tenantId,
    studentIds,
    "STUDENT",
  );
  const classes: JsonObject[] = [];

  for (const rawBooking of bookings || []) {
    const booking = rawBooking as JsonObject;
    const studentId = String(booking.student_id || "");
    const student = students.get(studentId);
    if (!student) {
      throw new ApiError(
        409,
        "booking possui aluno fora do tenant ou inativo",
      );
    }
    const classTime = normalizeTime(booking.time_slot);
    if (!classTime) {
      throw new ApiError(409, "booking possui horario invalido");
    }

    const fixedDate = dateKey(booking.date);
    const candidateDates = fixedDate ? [fixedDate] : Array.from(
      { length: intervalDays },
      (_, index) => formatDateKey(addUtcDays(start, index)),
    );
    for (const classDate of candidateDates) {
      if (classDate < startsAt || classDate > endsAt) continue;
      if (!bookingOccursAt(booking, classDate, classTime)) continue;
      classes.push({
        bookingId: String(booking.id),
        studentId,
        studentName: student.full_name || "Aluno",
        classDate,
        classTime,
        dow: parseDateKey(classDate)!.getUTCDay(),
      });
      if (classes.length > MAX_AFFECTED_CLASSES) {
        throw new ApiError(
          422,
          `periodo gera mais de ${MAX_AFFECTED_CLASSES} aulas; reduza o intervalo`,
        );
      }
    }
  }
  classes.sort((a, b) =>
    `${a.classDate}${a.classTime}`.localeCompare(
      `${b.classDate}${b.classTime}`,
    )
  );

  const { data: absence, error: absenceError } = await admin.from(
    "teacher_absences",
  )
    .insert({
      teacher_id: teacherId,
      tenant_id: tenantId,
      starts_at: startsAt,
      ends_at: endsAt,
      reason: reason || null,
      status: "active",
    })
    .select("id,teacher_id,tenant_id,starts_at,ends_at,reason,status")
    .single();
  if (absenceError) dbFailure("absence insert", absenceError);

  const audit = await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    user_id: caller.userId,
    user_role: caller.profile?.role,
    action: "coverage_absence_create",
    resource_type: "absence",
    resource_id: absence.id,
    new_values: {
      teacher_id: teacherId,
      starts_at: startsAt,
      ends_at: endsAt,
      affected_classes: classes.length,
    },
  });
  if (audit.error) {
    console.error("coverage-admin absence audit failed", {
      code: audit.error.code,
    });
  }
  return json({ ok: true, absence, classes });
}

function parseCoverageItems(value: unknown): CoverageItemInput[] {
  if (!Array.isArray(value) || !value.length) {
    throw new ApiError(400, "items invalidos");
  }
  if (value.length > MAX_COVERAGE_ITEMS) {
    throw new ApiError(
      422,
      `maximo de ${MAX_COVERAGE_ITEMS} coberturas por pedido`,
    );
  }

  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || Array.isArray(raw) || typeof raw !== "object") {
      throw new ApiError(400, "item invalido");
    }
    const item = raw as JsonObject;
    const bookingId = requireUuid(item.bookingId, "bookingId");
    const studentId = requireUuid(item.studentId, "studentId");
    const coverTeacherId = requireUuid(
      item.coverTeacherId,
      "coverTeacherId",
    );
    const classDate = stringField(item.classDate);
    const classTime = normalizeTime(item.classTime);
    if (!parseDateKey(classDate) || !classTime) {
      throw new ApiError(400, "data ou horario da cobertura invalido");
    }
    const occurrenceKey = `${bookingId}|${classDate}`;
    if (seen.has(occurrenceKey)) {
      throw new ApiError(409, "aula duplicada no pedido");
    }
    seen.add(occurrenceKey);
    return {
      bookingId,
      studentId,
      coverTeacherId,
      classDate,
      classTime,
    };
  });
}

async function validateCoverageItems(
  admin: AdminClient,
  tenantId: string,
  absence: JsonObject,
  items: CoverageItemInput[],
): Promise<ValidatedCoverageItem[]> {
  if (stringField(absence.status).toLowerCase() !== "active") {
    throw new ApiError(409, "absence inativa");
  }
  const absenceStart = dateKey(absence.starts_at);
  const absenceEnd = dateKey(absence.ends_at);
  const originalTeacherId = String(absence.teacher_id || "");
  if (
    !absenceStart || !absenceEnd ||
    !UUID_PATTERN.test(originalTeacherId)
  ) throw new ApiError(409, "absence inconsistente");

  const bookingIds = [...new Set(items.map((item) => item.bookingId))];
  const coverTeacherIds = [
    ...new Set(items.map((item) => item.coverTeacherId)),
  ];
  const requestedStudentIds = [
    ...new Set(items.map((item) => item.studentId)),
  ];

  const [originalTeachers, coverTeachers, students, bookingsResponse] =
    await Promise.all([
      loadActiveMembers(admin, tenantId, [originalTeacherId], "TEACHER"),
      loadActiveMembers(admin, tenantId, coverTeacherIds, "TEACHER"),
      loadActiveMembers(admin, tenantId, requestedStudentIds, "STUDENT"),
      admin.from("bookings")
        .select(
          "id,tenant_id,teacher_id,student_id,day_of_week,time_slot,date,start_date,status",
        )
        .eq("tenant_id", tenantId)
        .in("id", bookingIds),
    ]);
  if (bookingsResponse.error) {
    dbFailure("coverage booking lookup", bookingsResponse.error);
  }
  if (!originalTeachers.has(originalTeacherId)) {
    throw new ApiError(
      409,
      "professor ausente fora do tenant ou inativo",
    );
  }

  const bookingsById = new Map<string, JsonObject>();
  for (const booking of bookingsResponse.data || []) {
    bookingsById.set(String(booking.id), booking as JsonObject);
  }

  const validated: ValidatedCoverageItem[] = [];
  for (const item of items) {
    const booking = bookingsById.get(item.bookingId);
    if (!booking) throw new ApiError(404, "booking invalido");
    if (String(booking.teacher_id || "") !== originalTeacherId) {
      throw new ApiError(
        409,
        "booking nao pertence ao professor ausente",
      );
    }
    if (String(booking.student_id || "") !== item.studentId) {
      throw new ApiError(
        409,
        "booking nao pertence ao aluno informado",
      );
    }
    if (
      item.classDate < absenceStart ||
      item.classDate > absenceEnd
    ) throw new ApiError(409, "aula fora do periodo da ausencia");
    if (!bookingOccursAt(booking, item.classDate, item.classTime)) {
      throw new ApiError(
        409,
        "data ou horario nao corresponde ao booking",
      );
    }
    if (item.coverTeacherId === originalTeacherId) {
      throw new ApiError(409, "substituto deve ser outro professor");
    }
    const student = students.get(item.studentId);
    if (!student) {
      throw new ApiError(409, "aluno fora do tenant ou inativo");
    }
    const cover = coverTeachers.get(item.coverTeacherId);
    if (!cover) {
      throw new ApiError(409, "substituto fora do tenant ou inativo");
    }
    validated.push({
      ...item,
      studentName: student.full_name || "Aluno",
      coverName: cover.full_name || "Professor",
      coverPhone: normalizeCoveragePhone(cover.attendance_phone) ??
        normalizeCoveragePhone(cover.phone),
    });
  }

  for (let left = 0; left < validated.length; left += 1) {
    for (let right = left + 1; right < validated.length; right += 1) {
      const first = validated[left];
      const second = validated[right];
      if (
        first.coverTeacherId === second.coverTeacherId &&
        first.classDate === second.classDate &&
        sameTimeWindow(first.classTime, second.classTime)
      ) {
        throw new ApiError(
          409,
          "substituto possui conflito dentro do proprio pedido",
        );
      }
    }
  }

  const minDate = validated.reduce(
    (minimum, item) => item.classDate < minimum ? item.classDate : minimum,
    validated[0].classDate,
  );
  const maxDate = validated.reduce(
    (maximum, item) => item.classDate > maximum ? item.classDate : maximum,
    validated[0].classDate,
  );
  const afterMax = formatDateKey(
    addUtcDays(parseDateKey(maxDate)!, 1),
  );
  const teacherFilter = coverTeacherIds.join(",");

  const [
    availabilityResponse,
    busyBookingsResponse,
    reschedulesResponse,
    appointmentsResponse,
    substituteAbsencesResponse,
    occurrenceCoveragesResponse,
    teacherCoveragesResponse,
  ] = await Promise.all([
    admin.from("teacher_availability")
      .select("teacher_id,day_of_week,start_time,end_time")
      .eq("tenant_id", tenantId)
      .in("teacher_id", coverTeacherIds),
    admin.from("bookings")
      .select(
        "id,teacher_id,day_of_week,time_slot,date,start_date,status",
      )
      .eq("tenant_id", tenantId)
      .in("teacher_id", coverTeacherIds)
      .neq("status", "CANCELLED"),
    admin.from("reschedules")
      .select("teacher_id,date,time,used_at")
      .eq("tenant_id", tenantId)
      .in("teacher_id", coverTeacherIds)
      .is("used_at", null),
    admin.from("appointments")
      .select("teacher_id,professor_id,start_time,status")
      .eq("tenant_id", tenantId)
      .or(
        `teacher_id.in.(${teacherFilter}),professor_id.in.(${teacherFilter})`,
      )
      .gte(
        "start_time",
        new Date(`${minDate}T00:00:00-03:00`).toISOString(),
      )
      .lt(
        "start_time",
        new Date(`${afterMax}T00:00:00-03:00`).toISOString(),
      ),
    admin.from("teacher_absences")
      .select("teacher_id,starts_at,ends_at,status")
      .eq("tenant_id", tenantId)
      .in("teacher_id", coverTeacherIds),
    admin.from("class_coverages")
      .select(
        "id,booking_id,class_date,class_time,status,invite_expires_at",
      )
      .eq("tenant_id", tenantId)
      .in("booking_id", bookingIds)
      .gte("class_date", minDate)
      .lte("class_date", maxDate),
    admin.from("class_coverages")
      .select(
        "id,cover_teacher_id,class_date,class_time,status,invite_expires_at",
      )
      .eq("tenant_id", tenantId)
      .in("cover_teacher_id", coverTeacherIds)
      .gte("class_date", minDate)
      .lte("class_date", maxDate),
  ]);
  const responses = [
    ["availability lookup", availabilityResponse],
    ["booking conflict lookup", busyBookingsResponse],
    ["reschedule conflict lookup", reschedulesResponse],
    ["appointment conflict lookup", appointmentsResponse],
    ["substitute absence lookup", substituteAbsencesResponse],
    ["occurrence coverage lookup", occurrenceCoveragesResponse],
    ["teacher coverage lookup", teacherCoveragesResponse],
  ] as const;
  for (const [label, response] of responses) {
    if (response.error) dbFailure(label, response.error);
  }

  let occurrenceCoverageRows =
    (occurrenceCoveragesResponse.data || []) as JsonObject[];
  let teacherCoverageRows =
    (teacherCoveragesResponse.data || []) as JsonObject[];
  const expiredCoverageIds = new Set<string>();
  for (
    const row of [
      ...occurrenceCoverageRows,
      ...teacherCoverageRows,
    ]
  ) {
    if (coverageInviteExpired(row)) {
      const id = String(row.id || "");
      if (UUID_PATTERN.test(id)) expiredCoverageIds.add(id);
    }
  }
  if (expiredCoverageIds.size) {
    const { error: expiryError } = await admin.from("class_coverages")
      .update({ status: "cancelled" })
      .eq("tenant_id", tenantId)
      .eq("status", "pending")
      .in("id", [...expiredCoverageIds]);
    if (expiryError) dbFailure("expired coverage cleanup", expiryError);

    const [occurrenceRefresh, teacherRefresh] = await Promise.all([
      admin.from("class_coverages")
        .select(
          "id,booking_id,class_date,class_time,status,invite_expires_at",
        )
        .eq("tenant_id", tenantId)
        .in("booking_id", bookingIds)
        .gte("class_date", minDate)
        .lte("class_date", maxDate),
      admin.from("class_coverages")
        .select(
          "id,cover_teacher_id,class_date,class_time,status,invite_expires_at",
        )
        .eq("tenant_id", tenantId)
        .in("cover_teacher_id", coverTeacherIds)
        .gte("class_date", minDate)
        .lte("class_date", maxDate),
    ]);
    if (occurrenceRefresh.error) {
      dbFailure("occurrence coverage refresh", occurrenceRefresh.error);
    }
    if (teacherRefresh.error) {
      dbFailure("teacher coverage refresh", teacherRefresh.error);
    }
    occurrenceCoverageRows = (occurrenceRefresh.data || []) as JsonObject[];
    teacherCoverageRows = (teacherRefresh.data || []) as JsonObject[];
  }

  for (const item of validated) {
    const hasAvailability = (availabilityResponse.data || []).some(
      (row: JsonObject) =>
        String(row.teacher_id) === item.coverTeacherId &&
        availabilityCovers(row, item.classDate, item.classTime),
    );
    if (!hasAvailability) {
      throw new ApiError(
        409,
        "substituto sem disponibilidade para a aula",
      );
    }

    const hasBookingConflict = (busyBookingsResponse.data || []).some(
      (row: JsonObject) =>
        String(row.teacher_id) === item.coverTeacherId &&
        bookingOccursAt(row, item.classDate, item.classTime, false),
    );
    const hasRescheduleConflict = (reschedulesResponse.data || [])
      .some((row: JsonObject) =>
        String(row.teacher_id) === item.coverTeacherId &&
        lessonDateKey(row.date) === item.classDate &&
        sameTimeWindow(row.time, item.classTime)
      );
    const targetStart = brStartMillis(item.classDate, item.classTime);
    const hasAppointmentConflict = (appointmentsResponse.data || [])
      .some((row: JsonObject) => {
        if (
          !ACTIVE_APPOINTMENT_STATUSES.has(
            stringField(row.status).toLowerCase(),
          )
        ) return false;
        if (
          String(row.teacher_id || "") !== item.coverTeacherId &&
          String(row.professor_id || "") !== item.coverTeacherId
        ) return false;
        const appointmentStart = new Date(
          String(row.start_time || ""),
        ).getTime();
        return Number.isFinite(appointmentStart) &&
          Math.abs(appointmentStart - targetStart) <
            CONFLICT_WINDOW_MINUTES * 60_000;
      });
    const substituteIsAbsent = (substituteAbsencesResponse.data || [])
      .some((row: JsonObject) =>
        String(row.teacher_id || "") === item.coverTeacherId &&
        stringField(row.status).toLowerCase() === "active" &&
        Boolean(
          dateKey(row.starts_at) && dateKey(row.ends_at) &&
            dateKey(row.starts_at)! <= item.classDate &&
            dateKey(row.ends_at)! >= item.classDate,
        )
      );
    const occurrenceAlreadyCovered = occurrenceCoverageRows
      .some((row: JsonObject) =>
        String(row.booking_id) === item.bookingId &&
        dateKey(row.class_date) === item.classDate &&
        coverageBlocksSlot(row)
      );
    const coverTeacherConflict = teacherCoverageRows
      .some((row: JsonObject) =>
        String(row.cover_teacher_id) === item.coverTeacherId &&
        dateKey(row.class_date) === item.classDate &&
        coverageBlocksSlot(row) &&
        sameTimeWindow(row.class_time, item.classTime)
      );
    if (occurrenceAlreadyCovered) {
      throw new ApiError(409, "cobertura ja existente para a aula");
    }
    if (
      hasBookingConflict || hasRescheduleConflict ||
      hasAppointmentConflict || substituteIsAbsent || coverTeacherConflict
    ) throw new ApiError(409, "substituto possui conflito de agenda");
  }
  return validated;
}

async function sendCoverageInvite(
  instance: string,
  token: string,
  item: ValidatedCoverageItem,
): Promise<"accepted" | "rejected" | "ambiguous"> {
  if (brStartMillis(item.classDate, item.classTime) <= Date.now()) {
    return "rejected";
  }
  const phone = item.coverPhone;
  if (!phone || !SUPABASE_URL || !EVOLUTION_TOKENS.length) return "rejected";

  const link = `${SUPABASE_URL}/functions/v1/accept-coverage?token=${token}`;
  const firstName = item.coverName.split(" ")[0] || "Professor";
  const date = parseDateKey(item.classDate)!;
  const dataFmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
  }).format(date);
  const text =
    `Olá ${firstName}! 🐺\n\nA coordenação precisa de uma *cobertura de aula*:\n\n` +
    `📅 ${dataFmt} às *${item.classTime}*\n👤 Aluno: ${item.studentName}\n\n` +
    `Consegue cobrir? Confirme aqui:\n${link}`;

  const result = await sendWhatsTextDetailed({
    base: EVOLUTION_API_URL,
    keys: EVOLUTION_TOKENS,
    instance,
    to: phone,
    text,
    delayMs: 600,
  });
  return result.outcome;
}

async function cancelUndispatchedCoverage(
  admin: AdminClient,
  tenantId: string,
  coverageId: string,
): Promise<boolean> {
  const { data, error } = await admin.from("class_coverages")
    .update({ status: "cancelled" })
    .eq("id", coverageId)
    .eq("tenant_id", tenantId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error || !data) {
    console.error("coverage-admin undispatched cancellation failed", {
      code: error?.code ?? "ROW_NOT_UPDATED",
    });
    return false;
  }
  return true;
}

async function requestCoverage(
  admin: AdminClient,
  caller: RequestAuthContext,
  tenantId: string,
  body: JsonObject,
): Promise<Response> {
  const absenceId = requireUuid(body.absenceId, "absenceId");
  const mode = stringField(body.mode);
  if (mode !== "request" && mode !== "force") {
    throw new ApiError(400, "mode invalido");
  }
  const items = parseCoverageItems(body.items);
  const absence = await requireAbsence(admin, tenantId, absenceId);
  const validated = await validateCoverageItems(
    admin,
    tenantId,
    absence,
    items,
  );
  const validationNow = Date.now();
  const alreadyStarted = validated.some((item) =>
    brStartMillis(item.classDate, item.classTime) <= validationNow
  );
  if (alreadyStarted) {
    throw new ApiError(
      409,
      mode === "force"
        ? "force indisponivel para aula que ja iniciou"
        : "convite indisponivel para aula que ja iniciou",
    );
  }

  const instance = mode === "request"
    ? await loadTenantCentralWhatsAppInstance(admin, tenantId)
    : null;
  const out: JsonObject[] = [];
  let successful = 0;

  for (const item of validated) {
    const isForce = mode === "force";
    const itemNow = Date.now();
    const classStart = brStartMillis(item.classDate, item.classTime);
    if (classStart <= itemNow) {
      out.push({
        item: { bookingId: item.bookingId, classDate: item.classDate },
        error: "a aula iniciou antes da cobertura ser criada",
      });
      continue;
    }
    const token = isForce ? null : crypto.randomUUID().replace(/-/g, "");
    const inviteExpiresAt = isForce ? null : new Date(
      Math.min(
        classStart,
        itemNow + 48 * 60 * 60 * 1000,
      ),
    ).toISOString();
    const { data: coverage, error: coverageError } = await admin.from(
      "class_coverages",
    )
      .insert({
        original_teacher_id: absence.teacher_id,
        cover_teacher_id: item.coverTeacherId,
        student_id: item.studentId,
        booking_id: item.bookingId,
        absence_id: absenceId,
        tenant_id: tenantId,
        class_date: item.classDate,
        class_time: item.classTime,
        status: isForce ? "confirmed" : "pending",
        token,
        notes: isForce ? "Forçado pela coordenação" : null,
        confirmed_at: isForce ? new Date().toISOString() : null,
        dispatched_at: null,
        invite_expires_at: inviteExpiresAt,
      })
      .select(COVERAGE_SAFE_FIELDS)
      .single();
    if (coverageError) {
      console.error("coverage-admin coverage insert failed", {
        code: coverageError.code,
      });
      out.push({
        item: {
          bookingId: item.bookingId,
          classDate: item.classDate,
        },
        error: "nao foi possivel criar a cobertura",
      });
      continue;
    }

    let safeCoverage = coverage as unknown as JsonObject;
    const coverageId = String(safeCoverage.id || "");
    if (!UUID_PATTERN.test(coverageId)) {
      throw new ApiError(503, "resposta invalida ao criar cobertura");
    }
    if (isForce) {
      successful += 1;
      out.push({ coverage: safeCoverage });
      continue;
    }

    let warning = "cobertura criada, mas o canal de WhatsApp esta indisponivel";
    const sendOutcome = instance && token
      ? await sendCoverageInvite(instance, token, item)
      : "rejected";
    if (sendOutcome === "accepted") {
      const dispatchedAt = new Date().toISOString();
      const { data: dispatchMarker, error: dispatchError } = await admin.from(
        "class_coverages",
      )
        .update({ dispatched_at: dispatchedAt })
        .eq("id", coverageId)
        .eq("tenant_id", tenantId)
        .select("id,dispatched_at")
        .maybeSingle();
      if (dispatchError || !dispatchMarker) {
        console.error("coverage-admin dispatch marker failed", {
          code: dispatchError?.code ?? "ROW_NOT_UPDATED",
        });
        warning = "convite enviado, mas o status de envio nao foi atualizado";
      } else {
        warning = "";
        safeCoverage = { ...safeCoverage, dispatched_at: dispatchedAt };
      }
      successful += 1;
      // COVERAGE_SAFE_FIELDS deliberadamente não contém `token`.
      out.push({ coverage: safeCoverage, ...(warning ? { warning } : {}) });
      continue;
    }

    if (sendOutcome === "ambiguous") {
      out.push({
        item: { bookingId: item.bookingId, classDate: item.classDate },
        error: "envio do convite ainda nao confirmado",
        warning:
          "o registro permanece pendente para preservar um link possivelmente entregue",
      });
      continue;
    }

    if (instance && token) {
      warning = "cobertura cancelada porque o WhatsApp nao confirmou o envio";
    }
    const cancelled = await cancelUndispatchedCoverage(
      admin,
      tenantId,
      coverageId,
    );
    out.push({
      item: { bookingId: item.bookingId, classDate: item.classDate },
      error: "convite de cobertura nao enviado",
      warning: cancelled
        ? warning
        : `${warning}; o registro pendente requer revisao`,
    });
  }

  const audit = await admin.from("audit_logs").insert({
    tenant_id: tenantId,
    user_id: caller.userId,
    user_role: caller.profile?.role,
    action: mode === "force" ? "coverage_force" : "coverage_request",
    resource_type: "absence",
    resource_id: absenceId,
    new_values: {
      requested: validated.length,
      successful,
    },
  });
  if (audit.error) {
    console.error("coverage-admin request audit failed", {
      code: audit.error.code,
    });
  }
  if (!successful) {
    return json({
      ok: false,
      error: "nenhuma cobertura foi criada com sucesso",
      results: out,
    }, 502);
  }
  return json({ ok: true, results: out });
}

async function listCoverages(
  admin: AdminClient,
  tenantId: string,
  body: JsonObject,
): Promise<Response> {
  const absenceId = requireUuid(body.absenceId, "absenceId");
  await requireAbsence(admin, tenantId, absenceId);
  const { data, error } = await admin.from("class_coverages")
    .select(COVERAGE_SAFE_FIELDS)
    .eq("tenant_id", tenantId)
    .eq("absence_id", absenceId)
    .order("class_date")
    .order("class_time")
    .limit(MAX_LIST_COVERAGES);
  if (error) dbFailure("coverage list", error);
  return json({ ok: true, coverages: data || [] });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: [
      "SCHOOL_ADMIN",
      "COORDINATOR",
      "SUPER_ADMIN",
    ],
  });
  if (auth.ok === false) return auth.response;

  try {
    const tenantId = await resolveAuthorizedTenant(auth.context);
    const body = await readJsonObject(req);
    const action = stringField(body.action);
    if (action === "createAbsence") {
      return await createAbsence(
        auth.context.admin,
        auth.context,
        tenantId,
        body,
      );
    }
    if (action === "requestCoverage") {
      return await requestCoverage(
        auth.context.admin,
        auth.context,
        tenantId,
        body,
      );
    }
    if (action === "listCoverages") {
      return await listCoverages(
        auth.context.admin,
        tenantId,
        body,
      );
    }
    throw new ApiError(400, "action invalida");
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message }, error.status);
    }
    console.error("coverage-admin unexpected failure", {
      message: error instanceof Error ? error.message : "unknown",
    });
    return json({ error: "erro interno" }, 500);
  }
});
