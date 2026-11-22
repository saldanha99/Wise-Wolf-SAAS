/// <reference lib="deno.ns" />
/**
 * wolfie-lesson-track — a trilha da aula do Wolfie (22/11/2026).
 *
 * Ações (sempre do próprio aluno, papel STUDENT):
 *   home            → cartão "Sua aula de {dia}" + revisões vencidas
 *   prepare         → gera a trilha da última aula aprovada (1 vez por aula)
 *   get             → a trilha sem gabarito + o progresso
 *   answer          → corrige um item (sem IA quando dá; IA só no que é livre)
 *   complete        → fecha a sessão, dá a nota e agenda D+1/3/7/14/30
 *   roleplay_feedback → cartões de erro do roleplay de voz (1 vez por trilha)
 *   review_get / review_answer / review_complete → revisões espaçadas
 *
 * Fonte: class_logs aprovados pelo professor + memória VERIFIED do resumo.
 * IA: ponte já existente (_shared/ai-gateway.ts, Haiku), custo em
 * ai_usage_events. Nada de reposição, cobrança ou dado de outro aluno.
 */
import { aiFetch as fetch } from "../_shared/ai-gateway.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  OPEN_STUDENT_PAYMENT_STATUSES,
  requireWolfieProductAccess,
  studentBillingDateInSaoPaulo,
  studentPaymentIsBeyondTolerance,
} from "../_shared/wolfie-product-access.ts";
import { parseAiUsage, recordAiUsage } from "../_shared/ai-usage.ts";
import {
  addDays,
  answeredCount,
  type ApprovedMemory,
  buildLessonInput,
  buildReviewItems,
  checkDeterministic,
  checkReviewItem,
  type ClassLogSource,
  ContentError,
  evaluationPrompt,
  itemOrder,
  type JsonObject,
  type LearnerContext,
  type LearnerFact,
  type LessonInput,
  lessonInputIsUsable,
  normalizeTrackContent,
  parseEvaluation,
  parseRoleplayFeedback,
  type Progress,
  PROMPT_VERSION,
  publicReviewItems,
  publicTrack,
  readProgress,
  REVIEW_OFFSETS,
  REVIEW_STEPS,
  type ReviewItem,
  type ReviewStep,
  reviewUnlocked,
  roleplayBrief,
  roleplayFeedbackPrompt,
  sha256Hex,
  TRACK_SYSTEM_PROMPT,
  type TrackContent,
  trackScore,
  trackTaskPrompt,
} from "./core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";
// A ponte troca pelo Haiku 5.5 da Anthropic; o OpenRouter fica de reserva.
const TEXT_MODEL = "anthropic/claude-haiku-4.5";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOKBACK_DAYS = 14;
const GENERATION_LEASE_MS = 120_000;
const MAX_GENERATION_ATTEMPTS = 3;
const MAX_AI_CHECKS_PER_TRACK = 24;

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

// deno-lint-ignore no-explicit-any
type Db = any;

interface Student {
  id: string;
  tenantId: string;
  isTestAccount: boolean;
  learner: LearnerContext;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function str(value: unknown, max = 300): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new HttpError(400, code);
  }
  return value;
}

function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// ── Aluno, cobrança e contexto ──────────────────────────────────────────────

async function assertBillingAccess(
  admin: Db,
  studentId: string,
  tenantId: string,
) {
  let today: string;
  try {
    today = studentBillingDateInSaoPaulo();
  } catch {
    throw new HttpError(503, "BILLING_CHECK_UNAVAILABLE");
  }
  const { data, error } = await admin
    .from("student_payments")
    .select("due_date")
    .eq("student_id", studentId)
    .eq("tenant_id", tenantId)
    .in("status", OPEN_STUDENT_PAYMENT_STATUSES)
    .lt("due_date", today);
  if (error) throw new HttpError(503, "BILLING_CHECK_UNAVAILABLE");
  for (const payment of data ?? []) {
    if (studentPaymentIsBeyondTolerance(payment.due_date, today)) {
      throw new HttpError(402, "PAYMENT_REQUIRED");
    }
  }
}

function listOf(value: unknown, max = 6): string[] {
  return Array.isArray(value)
    ? value.map((item) => str(item, 80)).filter(Boolean).slice(0, max)
    : [];
}

async function loadStudent(
  admin: Db,
  userId: string,
  tenantId: string,
): Promise<Student> {
  const { data: profile, error } = await admin
    .from("profiles")
    .select(
      "id, full_name, module, occupation, english_for, short_term_goal, interests, preferred_topics, wolfie_settings, is_kids, is_test_account",
    )
    .eq("id", userId)
    .eq("role", "STUDENT")
    .maybeSingle();
  if (error) throw new HttpError(503, "PROFILE_UNAVAILABLE");
  if (!profile) throw new HttpError(403, "STUDENT_PROFILE_REQUIRED");
  const { data: intel } = await admin
    .from("wolf_intelligence")
    .select("primary_goal, profession, estimated_level")
    .eq("student_id", userId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const settings = asObject(profile.wolfie_settings);
  const goal = str(profile.english_for, 200) ||
    str(profile.short_term_goal, 200) ||
    str(settings.goal, 200) || str(intel?.primary_goal, 200);
  return {
    id: profile.id,
    tenantId,
    isTestAccount: profile.is_test_account === true,
    learner: {
      firstName: str(String(profile.full_name ?? "").split(" ")[0], 40),
      level: str(settings.level, 20) || str(intel?.estimated_level, 20) ||
        str(profile.module, 40) || "A2",
      goal,
      occupation: str(profile.occupation, 120) || str(intel?.profession, 120),
      // Rotina: não há coluna própria; usamos o que o aluno contou de si
      // (perfil + até 10 fatos da memória do Wolfie que ele mesmo informou).
      routine: [
        ...listOf(profile.preferred_topics),
        ...(await learnerMemoryFacts(admin, userId, tenantId)),
      ].slice(0, 10),
      interests: listOf(profile.interests),
      isKids: profile.is_kids === true,
    },
  };
}

const FACT_MEMORY_KINDS = ["goal", "professional_scenario", "preferred_topic"];
const MAX_ACTIVE_FACTS = 10;

async function learnerMemoryFacts(
  admin: Db,
  studentId: string,
  tenantId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("wolfie_memory_items")
    .select("content")
    .eq("student_id", studentId)
    .eq("tenant_id", tenantId)
    .eq("status", "active")
    .eq("sensitive", false)
    .in("kind", FACT_MEMORY_KINDS)
    .order("last_seen_at", { ascending: false })
    .limit(MAX_ACTIVE_FACTS);
  return (data ?? []).map((row: JsonObject) => str(row.content, 120)).filter(
    Boolean,
  );
}

/**
 * Memória de fatos (22/11/2026): o que o aluno disse de si no roleplay vai para
 * wolfie_memory_items (a mesma tabela que o realtime já lê). Fato repetido
 * soma ocorrência; acima de 10 ativos, os mais antigos saem (dismissed).
 */
async function saveLearnerFacts(
  admin: Db,
  student: Student,
  facts: LearnerFact[],
  conversationId: string,
): Promise<number> {
  let saved = 0;
  const now = new Date().toISOString();
  for (const fact of facts) {
    const memoryKey = `fact:${fact.key}`.slice(0, 160);
    const { data: existing } = await admin
      .from("wolfie_memory_items")
      .select("id, occurrence_count, evidence, status")
      .eq("tenant_id", student.tenantId)
      .eq("student_id", student.id)
      .eq("kind", fact.kind)
      .eq("memory_key", memoryKey)
      .maybeSingle();
    const evidence = {
      quote: fact.quote,
      source: "lesson_track_roleplay",
      at: now,
    };
    if (existing) {
      if (existing.status === "dismissed") continue;
      const previous = Array.isArray(existing.evidence)
        ? existing.evidence.slice(-19)
        : [];
      const { error } = await admin.from("wolfie_memory_items").update({
        content: fact.text,
        occurrence_count: Number(existing.occurrence_count || 1) + 1,
        evidence: [...previous, evidence],
        last_seen_at: now,
        source_conversation_session_id: conversationId,
        source_activity_session_id: null,
      }).eq("id", existing.id);
      if (!error) saved += 1;
      continue;
    }
    const { error } = await admin.from("wolfie_memory_items").insert({
      tenant_id: student.tenantId,
      student_id: student.id,
      kind: fact.kind,
      memory_key: memoryKey,
      content: fact.text,
      status: "active",
      confidence: 0.8,
      evidence: [evidence],
      sensitive: false,
      source_conversation_session_id: conversationId,
    });
    if (!error) saved += 1;
  }
  const { data: active } = await admin
    .from("wolfie_memory_items")
    .select("id")
    .eq("tenant_id", student.tenantId)
    .eq("student_id", student.id)
    .eq("status", "active")
    .in("kind", FACT_MEMORY_KINDS)
    .like("memory_key", "fact:%")
    .order("last_seen_at", { ascending: false });
  const overflow = (active ?? []).slice(MAX_ACTIVE_FACTS).map((
    row: JsonObject,
  ) => row.id);
  if (overflow.length) {
    await admin.from("wolfie_memory_items").update({ status: "dismissed" })
      .in("id", overflow);
  }
  return saved;
}

async function latestApprovedClass(
  admin: Db,
  student: Student,
): Promise<ClassLogSource | null> {
  const since = addDays(todayInSaoPaulo(), -LOOKBACK_DAYS);
  const { data, error } = await admin
    .from("class_logs")
    .select(
      "id, class_date, content, content_covered, lesson_objective, student_difficulties, recommended_next_step, homework_assigned, lesson_session_id",
    )
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .eq("presence", "COMPLETED")
    .eq("approval_status", "APPROVED")
    .gte("class_date", since)
    .order("class_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new HttpError(503, "CLASS_LOOKUP_FAILED");
  const row = data?.[0];
  if (!row) return null;
  const hasContent = str(row.content_covered) || str(row.lesson_objective) ||
    str(row.content);
  return hasContent
    ? { ...row, content_covered: row.content_covered || row.content }
    : null;
}

async function approvedMemory(
  admin: Db,
  student: Student,
  sessionId: string | null,
): Promise<ApprovedMemory | null> {
  if (!sessionId) return null;
  const { data } = await admin
    .from("student_learning_memories")
    .select(
      "lesson_objective, content_practiced, new_vocabulary, recurring_errors, strengths_observed",
    )
    .eq("tenant_id", student.tenantId)
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .eq("source_type", "MEET_SESSION")
    .eq("source_ref", sessionId)
    .eq("verification_status", "VERIFIED")
    .maybeSingle();
  return data ?? null;
}

// ── IA ──────────────────────────────────────────────────────────────────────

function providerText(payload: unknown): string {
  const choice = asObject(
    Array.isArray(asObject(payload).choices)
      ? (asObject(payload).choices as unknown[])[0]
      : null,
  );
  const content = asObject(choice.message).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => str(asObject(part).text, 100_000)).join("");
  }
  return "";
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callJson(
  admin: Db,
  student: Student,
  feature: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<{ value: unknown; usage: { input: number; output: number } }> {
  const apiKey = (Deno.env.get("OPENROUTER_API_KEY") ?? "").trim();
  const response = await fetch(OPENROUTER_CHAT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://system.wisewolflanguage.com.br",
      "X-Title": "Wise Wolf Lesson Track",
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      messages: [{ role: "system", content: system }, {
        role: "user",
        content: user,
      }],
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!response || !response.ok) {
    throw new HttpError(503, "AI_PROVIDER_UNAVAILABLE");
  }
  const payload: unknown = await response.json().catch(() => null);
  const usage = parseAiUsage(payload);
  await recordAiUsage(admin, {
    tenantId: student.tenantId,
    userId: student.id,
    feature,
    model: str(asObject(payload).model, 120) || TEXT_MODEL,
    usage,
  });
  return {
    value: extractJson(providerText(payload)),
    usage: { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 },
  };
}

// ── Trilha ──────────────────────────────────────────────────────────────────

interface TrackRow {
  id: string;
  tenant_id: string;
  student_id: string;
  class_log_id: string;
  class_date: string;
  topic: string;
  status: "GENERATING" | "READY" | "FAILED";
  content: unknown;
  lesson_input: unknown;
  generation_attempts: number;
  lease_expires_at: string | null;
  progress: unknown;
  score: number | null;
  started_at: string | null;
  completed_at: string | null;
  roleplay_feedback: unknown;
  error_code: string | null;
  updated_at: string;
}

async function loadTrack(
  admin: Db,
  student: Student,
  trackId: unknown,
): Promise<TrackRow> {
  const id = uuid(trackId, "INVALID_TRACK_ID");
  const { data, error } = await admin
    .from("wolfie_lesson_tracks")
    .select("*")
    .eq("id", id)
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .maybeSingle();
  if (error) throw new HttpError(503, "TRACK_LOOKUP_FAILED");
  if (!data) throw new HttpError(404, "TRACK_NOT_FOUND");
  return data as TrackRow;
}

function readyContent(track: TrackRow): TrackContent {
  if (track.status !== "READY" || !track.content) {
    throw new HttpError(409, "TRACK_NOT_READY");
  }
  return track.content as TrackContent;
}

function trackCard(track: TrackRow | null, log: ClassLogSource | null) {
  if (!track) {
    return log
      ? { id: null, classDate: log.class_date, status: "PENDING", topic: "" }
      : null;
  }
  let answered = 0;
  let total = 0;
  if (track.status === "READY" && track.content) {
    const content = track.content as TrackContent;
    total = itemOrder(content).length;
    answered = answeredCount(content, readProgress(track.progress));
  }
  return {
    id: track.id,
    classDate: track.class_date,
    status: track.status === "FAILED" &&
        track.generation_attempts < MAX_GENERATION_ATTEMPTS
      ? "PENDING"
      : track.status,
    topic: track.topic,
    answered,
    total,
    completed: !!track.completed_at,
    score: track.score,
    hasRoleplayFeedback: !!track.roleplay_feedback,
  };
}

async function handleHome(admin: Db, student: Student): Promise<Response> {
  const log = await latestApprovedClass(admin, student);
  let track: TrackRow | null = null;
  if (log) {
    const { data } = await admin
      .from("wolfie_lesson_tracks")
      .select("*")
      .eq("class_log_id", log.id)
      .eq("student_id", student.id)
      .eq("tenant_id", student.tenantId)
      .maybeSingle();
    track = data as TrackRow | null;
  } else if (student.isTestAccount) {
    // QA: conta de teste usa a trilha-fixture montada para ela (sem aula falsa).
    const { data } = await admin
      .from("wolfie_lesson_tracks")
      .select("*")
      .eq("student_id", student.id)
      .eq("tenant_id", student.tenantId)
      .eq("test_fixture", true)
      .order("class_date", { ascending: false })
      .limit(1);
    track = (data?.[0] as TrackRow | undefined) ?? null;
  }
  const today = todayInSaoPaulo();
  const { data: reviews } = await admin
    .from("wolfie_lesson_reviews")
    .select("id, step, due_on, track_id, wolfie_lesson_tracks(topic)")
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .eq("status", "PENDING")
    .lte("due_on", today)
    .order("due_on", { ascending: true })
    .limit(3);
  const unlocked: JsonObject[] = [];
  for (const review of reviews ?? []) {
    const scores = await reviewScores(
      admin,
      String(review.track_id),
      student.tenantId,
    );
    if (reviewUnlocked(review.step as ReviewStep, scores)) {
      unlocked.push(review);
    }
  }
  return json({
    track: trackCard(track, log),
    reviews: unlocked.map((r: JsonObject) => ({
      id: r.id,
      step: r.step,
      dueOn: r.due_on,
      topic: str(asObject(r.wolfie_lesson_tracks).topic, 80),
    })),
  });
}

async function previousTopics(
  admin: Db,
  student: Student,
  exceptLogId: string,
): Promise<string[]> {
  const { data } = await admin
    .from("wolfie_lesson_tracks")
    .select("topic, class_log_id")
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .eq("status", "READY")
    .order("class_date", { ascending: false })
    .limit(4);
  return (data ?? [])
    .filter((row: JsonObject) => row.class_log_id !== exceptLogId)
    .map((row: JsonObject) => str(row.topic, 80))
    .filter(Boolean)
    .slice(0, 2);
}

async function handlePrepare(admin: Db, student: Student): Promise<Response> {
  const log = await latestApprovedClass(admin, student);
  const now = new Date();
  let track: TrackRow;
  if (log) {
    // Reserva da geração: a linha única por aula impede gerar duas vezes.
    await admin.from("wolfie_lesson_tracks").upsert({
      tenant_id: student.tenantId,
      student_id: student.id,
      class_log_id: log.id,
      lesson_session_id: log.lesson_session_id,
      class_date: log.class_date,
    }, { onConflict: "class_log_id", ignoreDuplicates: true });

    const { data: existing, error } = await admin
      .from("wolfie_lesson_tracks")
      .select("*")
      .eq("class_log_id", log.id)
      .eq("student_id", student.id)
      .eq("tenant_id", student.tenantId)
      .maybeSingle();
    if (error || !existing) {
      throw new HttpError(503, "TRACK_RESERVATION_FAILED");
    }
    track = existing as TrackRow;
  } else if (student.isTestAccount) {
    // QA: a trilha-fixture da conta de teste traz a aula inventada em lesson_input.
    const { data } = await admin
      .from("wolfie_lesson_tracks")
      .select("*")
      .eq("student_id", student.id)
      .eq("tenant_id", student.tenantId)
      .eq("test_fixture", true)
      .order("class_date", { ascending: false })
      .limit(1);
    if (!data?.[0]) return json({ track: null });
    track = data[0] as TrackRow;
  } else {
    return json({ track: null });
  }
  if (track.status === "READY") return json({ track: trackCard(track, log) });
  if (
    track.generation_attempts >= MAX_GENERATION_ATTEMPTS &&
    track.status === "FAILED"
  ) {
    return json({ track: trackCard(track, log) });
  }
  if (track.lease_expires_at && new Date(track.lease_expires_at) > now) {
    return json({ track: { ...trackCard(track, log), status: "GENERATING" } });
  }

  const leaseUntil = new Date(now.getTime() + GENERATION_LEASE_MS)
    .toISOString();
  const { data: claimed } = await admin
    .from("wolfie_lesson_tracks")
    .update({
      status: "GENERATING",
      lease_expires_at: leaseUntil,
      generation_attempts: track.generation_attempts + 1,
      updated_at: now.toISOString(),
    })
    .eq("id", track.id)
    .eq("generation_attempts", track.generation_attempts)
    .select("id");
  if (!claimed?.length) {
    return json({ track: { ...trackCard(track, log), status: "GENERATING" } });
  }

  const input: LessonInput = log
    ? buildLessonInput(
      log,
      await approvedMemory(admin, student, log.lesson_session_id),
      student.learner,
      await previousTopics(admin, student, log.id),
    )
    : track.lesson_input as LessonInput;
  if (!input || !lessonInputIsUsable(input)) {
    await admin.from("wolfie_lesson_tracks").update({
      status: "FAILED",
      error_code: "LESSON_WITHOUT_CONTENT",
      generation_attempts: MAX_GENERATION_ATTEMPTS,
      lease_expires_at: null,
    }).eq("id", track.id);
    return json({ track: null });
  }

  try {
    const result = await callJson(
      admin,
      student,
      "wolfie_lesson_track_generate",
      TRACK_SYSTEM_PROMPT,
      trackTaskPrompt(input),
      6000,
      90_000,
    );
    const content = normalizeTrackContent(result.value);
    const { data: saved, error: saveError } = await admin
      .from("wolfie_lesson_tracks")
      .update({
        status: "READY",
        topic: content.topic,
        content,
        lesson_input: input,
        source_sha256: await sha256Hex(JSON.stringify(input)),
        model_id: `${TEXT_MODEL}|${PROMPT_VERSION}`,
        input_tokens: result.usage.input,
        output_tokens: result.usage.output,
        lease_expires_at: null,
        error_code: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", track.id)
      .select("*")
      .single();
    if (saveError) throw new HttpError(503, "TRACK_SAVE_FAILED");
    return json({ track: trackCard(saved as TrackRow, log) });
  } catch (error) {
    const code = error instanceof ContentError
      ? `CONTENT_${error.message}`
      : error instanceof HttpError
      ? error.code
      : "GENERATION_FAILED";
    await admin.from("wolfie_lesson_tracks").update({
      status: "FAILED",
      error_code: code.slice(0, 80),
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    }).eq("id", track.id);
    console.warn("[wolfie-lesson-track] generation failed", { code });
    return json({
      track: {
        ...trackCard({
          ...track,
          status: "FAILED",
          generation_attempts: track.generation_attempts + 1,
        }, log),
      },
    });
  }
}

async function handleGet(
  admin: Db,
  student: Student,
  body: JsonObject,
): Promise<Response> {
  const track = await loadTrack(admin, student, body.trackId);
  const content = readyContent(track);
  if (!track.started_at) {
    await admin.from("wolfie_lesson_tracks").update({
      started_at: new Date().toISOString(),
    }).eq("id", track.id);
  }
  const progress = readProgress(track.progress);
  // Devolve o que o aluno já respondeu, com o veredito — nunca o gabarito dos itens em aberto.
  const answered: Record<string, unknown> = {};
  for (const [id, item] of Object.entries(progress)) {
    const key = content.keys[id];
    answered[id] = {
      correct: item.correct,
      attempts: item.attempts,
      answer: item.answer,
      expected: item.correct || item.attempts >= 2
        ? key?.modelAnswer ?? ""
        : "",
      whyPt: item.correct || item.attempts >= 2
        ? key?.rulePt || key?.whyPt || ""
        : "",
      native: item.correct || item.attempts >= 2 ? key?.native ?? "" : "",
      hintPt: !item.correct && item.attempts === 1 && key?.kind !== "recognize"
        ? key?.hintPt || "Releia a regra e tente de novo."
        : "",
      canRetry: !item.correct && item.attempts === 1 &&
        key?.kind !== "recognize",
    };
  }
  return json({
    track: {
      id: track.id,
      classDate: track.class_date,
      topic: track.topic,
      completed: !!track.completed_at,
      score: track.score,
      content: publicTrack(content),
      answered,
      roleplay: roleplayBrief(content, student.learner.goal),
      roleplayFeedback: asObject(track.roleplay_feedback).status === "PENDING"
        ? null
        : track.roleplay_feedback ?? null,
    },
  });
}

async function handleAnswer(
  admin: Db,
  student: Student,
  body: JsonObject,
): Promise<Response> {
  const track = await loadTrack(admin, student, body.trackId);
  const content = readyContent(track);
  const itemId = str(body.itemId, 10);
  const key = content.keys[itemId];
  if (!key) throw new HttpError(400, "INVALID_ITEM");
  const answer = key.kind === "recognize"
    ? String(Number(body.answer))
    : str(body.answer, 600);
  if (!answer) throw new HttpError(400, "EMPTY_ANSWER");

  const rawProgress = asObject(track.progress);
  const progress: Progress = readProgress(rawProgress);
  const previous = progress[itemId];
  if (previous?.correct) {
    return json({
      correct: true,
      alreadyDone: true,
      expected: key.modelAnswer,
      whyPt: key.rulePt || key.whyPt,
      native: key.native,
    });
  }
  const attempts = (previous?.attempts ?? 0) + 1;

  let correct = false;
  let corrected = "";
  let whyPt = key.rulePt || key.whyPt;
  if (key.kind === "speaking") {
    // Fala guiada: o Wolfie comenta, mas não reprova quem respondeu.
    const evaluation = await evaluateWithAi(
      admin,
      student,
      track,
      content,
      key,
      answer,
      rawProgress,
    );
    correct = true;
    if (evaluation !== "CAPPED") {
      corrected = evaluation.corrected;
      whyPt = evaluation.whyPt || whyPt;
    }
  } else {
    const verdict = checkDeterministic(key, answer);
    if (verdict === "needs_ai") {
      const evaluation = await evaluateWithAi(
        admin,
        student,
        track,
        content,
        key,
        answer,
        rawProgress,
      );
      if (evaluation === "CAPPED") {
        // Teto de correções por IA da trilha: mostra a forma certa para o aluno conferir.
        correct = false;
      } else {
        correct = evaluation.correct;
        corrected = evaluation.corrected;
        if (evaluation.whyPt) whyPt = evaluation.whyPt;
      }
    } else {
      correct = verdict === "correct";
    }
  }

  progress[itemId] = {
    attempts,
    correct,
    answer: answer.slice(0, 400),
    firstTryCorrect: correct && attempts === 1,
  };
  // Trava otimista: duas respostas ao mesmo tempo não apagam uma à outra.
  const { data: savedProgress } = await admin
    .from("wolfie_lesson_tracks")
    .update({
      progress: {
        ...rawProgress,
        items: progress,
        ai_checks: rawProgress.ai_checks ?? 0,
      },
      updated_at: new Date().toISOString(),
    })
    .eq("id", track.id)
    .eq("updated_at", track.updated_at)
    .select("id");
  if (!savedProgress?.length) throw new HttpError(409, "TRACK_BUSY");

  // Mistake Repair: na 1ª falha só a dica; a forma certa vem na 2ª.
  const reveal = correct || attempts >= 2 || key.kind === "recognize";
  return json({
    correct,
    attempts,
    hintPt: !correct && !reveal
      ? key.hintPt || "Releia a regra e tente de novo."
      : "",
    expected: reveal ? key.modelAnswer : "",
    corrected: reveal ? corrected : "",
    whyPt: reveal ? whyPt : "",
    native: reveal ? key.native : "",
    canRetry: !correct && !reveal,
  });
}

async function evaluateWithAi(
  admin: Db,
  student: Student,
  track: TrackRow,
  content: TrackContent,
  key: TrackContent["keys"][string],
  answer: string,
  rawProgress: JsonObject,
) {
  const used = Number(rawProgress.ai_checks) || 0;
  if (used >= MAX_AI_CHECKS_PER_TRACK) return "CAPPED" as const;
  rawProgress.ai_checks = used + 1;
  try {
    const result = await callJson(
      admin,
      student,
      "wolfie_lesson_track_check",
      "You are a precise, encouraging English teacher for Brazilian learners. Return only JSON.",
      evaluationPrompt(key, answer, content.topicEn || content.topic),
      400,
      25_000,
    );
    const evaluation = parseEvaluation(result.value);
    if (!evaluation) throw new HttpError(503, "AI_PROVIDER_UNAVAILABLE");
    return evaluation;
  } catch {
    console.warn("[wolfie-lesson-track] check unavailable", {
      track: track.id,
    });
    // A tentativa do aluno não é gasta: nada é gravado e ele tenta de novo.
    throw new HttpError(503, "AI_PROVIDER_UNAVAILABLE");
  }
}

async function nextClassDate(
  admin: Db,
  student: Student,
  after: string,
): Promise<string | null> {
  const { data } = await admin
    .from("upcoming_classes")
    .select("class_date")
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .gt("class_date", after)
    .order("class_date", { ascending: true })
    .limit(1);
  return data?.[0]?.class_date ?? null;
}

async function olderReviewItems(
  admin: Db,
  student: Student,
  exceptTrackId: string,
): Promise<ReviewItem[]> {
  const { data } = await admin
    .from("wolfie_lesson_tracks")
    .select("id, content")
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .eq("status", "READY")
    .neq("id", exceptTrackId)
    .order("class_date", { ascending: false })
    .limit(3);
  const items: ReviewItem[] = [];
  for (const row of data ?? []) {
    const bank = asObject(row.content).reviewBank;
    if (Array.isArray(bank)) items.push(...(bank as ReviewItem[]).slice(0, 2));
  }
  return items;
}

async function handleComplete(
  admin: Db,
  student: Student,
  body: JsonObject,
): Promise<Response> {
  const track = await loadTrack(admin, student, body.trackId);
  const content = readyContent(track);
  const progress = readProgress(track.progress);
  const score = trackScore(content, progress);
  if (!track.completed_at) {
    await admin.from("wolfie_lesson_tracks").update({
      completed_at: new Date().toISOString(),
      score,
      updated_at: new Date().toISOString(),
    }).eq("id", track.id);

    const today = todayInSaoPaulo();
    const older = await olderReviewItems(admin, student, track.id);
    const rows: JsonObject[] = REVIEW_STEPS.map((step) => ({
      tenant_id: student.tenantId,
      student_id: student.id,
      track_id: track.id,
      step,
      due_on: addDays(today, REVIEW_OFFSETS[step]),
      items: buildReviewItems(step, content, progress, older),
    }));
    const nextClass = await nextClassDate(admin, student, today);
    if (nextClass) {
      const eve = addDays(nextClass, -1);
      rows.push({
        tenant_id: student.tenantId,
        student_id: student.id,
        track_id: track.id,
        step: "CHECKIN",
        due_on: eve < today ? today : eve,
        items: buildReviewItems("CHECKIN", content, progress, older),
      });
    }
    await admin.from("wolfie_lesson_reviews").upsert(rows, {
      onConflict: "track_id,step",
      ignoreDuplicates: true,
    });
  }
  return json({ score: track.score ?? score, completed: true });
}

async function handleRoleplayFeedback(
  admin: Db,
  student: Student,
  body: JsonObject,
): Promise<Response> {
  const track = await loadTrack(admin, student, body.trackId);
  const content = readyContent(track);
  const existing = asObject(track.roleplay_feedback);
  if (track.roleplay_feedback && existing.status !== "PENDING") {
    return json({ feedback: track.roleplay_feedback });
  }
  if (existing.status === "PENDING") {
    throw new HttpError(409, "FEEDBACK_IN_PROGRESS");
  }
  const conversationId = uuid(body.conversationId, "INVALID_CONVERSATION_ID");
  const { data: session } = await admin
    .from("wolfie_sessions")
    .select("id, student_id, created_at")
    .eq("id", conversationId)
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .maybeSingle();
  if (!session) throw new HttpError(404, "CONVERSATION_NOT_FOUND");
  const { data: turns } = await admin
    .from("wolfie_turns")
    .select("speaker, content, turn_index")
    .eq("session_id", conversationId)
    .order("turn_index", { ascending: true })
    .limit(80);
  const transcript = (turns ?? [])
    .map((turn: JsonObject) => ({
      speaker: /student|user/i.test(String(turn.speaker))
        ? "student"
        : "wolfie",
      text: str(turn.content, 500),
    }))
    .filter((turn: { text: string }) => turn.text);
  if (
    !transcript.some((turn: { speaker: string }) => turn.speaker === "student")
  ) {
    return json({ feedback: null, reason: "NO_LEARNER_TURNS" });
  }
  const { data: corrections } = await admin
    .from("wolfie_corrections")
    .select("wrong_sentence, correct_sentence, explanation_pt, status")
    .eq("session_id", conversationId)
    .limit(20);
  // Reserva: dois cliques não chamam a IA duas vezes.
  const { data: claimed } = await admin
    .from("wolfie_lesson_tracks")
    .update({ roleplay_feedback: { status: "PENDING" } })
    .eq("id", track.id)
    .is("roleplay_feedback", null)
    .select("id");
  if (!claimed?.length) throw new HttpError(409, "FEEDBACK_IN_PROGRESS");
  const release = () =>
    admin.from("wolfie_lesson_tracks").update({ roleplay_feedback: null })
      .eq("id", track.id);
  let result: Awaited<ReturnType<typeof callJson>>;
  try {
    result = await callJson(
      admin,
      student,
      "wolfie_lesson_track_roleplay_feedback",
      "You are an honest, encouraging English coach for Brazilian adults. Return only JSON.",
      roleplayFeedbackPrompt(
        content,
        transcript,
        (corrections ?? [])
          .filter((c: JsonObject) =>
            !/INVALID|DISPUT|SUPERSED/i.test(String(c.status ?? ""))
          )
          .map((c: JsonObject) => ({
            wrong: str(c.wrong_sentence, 300),
            correct: str(c.correct_sentence, 300),
            explanation: str(c.explanation_pt, 300),
          })),
      ),
      1500,
      40_000,
    );
  } catch (error) {
    await release();
    throw error;
  }
  const feedback = parseRoleplayFeedback(result.value);
  if (!feedback) {
    await release();
    throw new HttpError(503, "FEEDBACK_UNAVAILABLE");
  }
  const { facts, ...cards } = feedback;
  await admin.from("wolfie_lesson_tracks").update({
    roleplay_feedback: { ...cards, conversationId },
    updated_at: new Date().toISOString(),
  }).eq("id", track.id);
  const factsSaved = await saveLearnerFacts(
    admin,
    student,
    facts,
    conversationId,
  )
    .catch(() => 0);
  return json({ feedback: cards, factsSaved });
}

// ── Revisões ────────────────────────────────────────────────────────────────

async function loadReview(admin: Db, student: Student, reviewId: unknown) {
  const id = uuid(reviewId, "INVALID_REVIEW_ID");
  const { data, error } = await admin
    .from("wolfie_lesson_reviews")
    .select("*, wolfie_lesson_tracks(topic, class_date)")
    .eq("id", id)
    .eq("student_id", student.id)
    .eq("tenant_id", student.tenantId)
    .maybeSingle();
  if (error) throw new HttpError(503, "REVIEW_LOOKUP_FAILED");
  if (!data) throw new HttpError(404, "REVIEW_NOT_FOUND");
  return data as JsonObject;
}

/** D+14/D+30 trancadas não abrem, não recebem resposta e não fecham. */
async function loadUnlockedReview(
  admin: Db,
  student: Student,
  reviewId: unknown,
) {
  const review = await loadReview(admin, student, reviewId);
  const scores = await reviewScores(
    admin,
    String(review.track_id),
    student.tenantId,
  );
  if (!reviewUnlocked(review.step as ReviewStep, scores)) {
    throw new HttpError(409, "REVIEW_LOCKED");
  }
  return review;
}

async function reviewScores(
  admin: Db,
  trackId: string,
  tenantId: string,
): Promise<Partial<Record<ReviewStep, number | null>>> {
  const { data } = await admin
    .from("wolfie_lesson_reviews")
    .select("step, score")
    .eq("track_id", trackId)
    .eq("tenant_id", tenantId);
  const out: Partial<Record<ReviewStep, number | null>> = {};
  for (const row of data ?? []) out[row.step as ReviewStep] = row.score;
  return out;
}

async function handleReviewGet(
  admin: Db,
  student: Student,
  body: JsonObject,
): Promise<Response> {
  const review = await loadUnlockedReview(admin, student, body.reviewId);
  const step = review.step as ReviewStep;
  const track = asObject(review.wolfie_lesson_tracks);
  return json({
    review: {
      id: review.id,
      step,
      dueOn: review.due_on,
      topic: str(track.topic, 80),
      classDate: track.class_date,
      status: review.status,
      items: publicReviewItems((review.items as ReviewItem[]) ?? []),
      answers: review.answers ?? {},
    },
  });
}

async function handleReviewAnswer(
  admin: Db,
  student: Student,
  body: JsonObject,
): Promise<Response> {
  const review = await loadUnlockedReview(admin, student, body.reviewId);
  const items = (review.items as ReviewItem[]) ?? [];
  const item = items.find((candidate) => candidate.id === str(body.itemId, 40));
  if (!item) throw new HttpError(400, "INVALID_ITEM");
  const answers = asObject(review.answers);
  if (answers[item.id]) {
    const done = asObject(answers[item.id]);
    return json({
      correct: done.correct === true,
      expected: expectedOf(item),
      whyPt: item.whyPt,
    });
  }
  const correct = checkReviewItem(item, body.answer);
  answers[item.id] = { correct, answer: str(String(body.answer ?? ""), 300) };
  await admin.from("wolfie_lesson_reviews").update({ answers }).eq(
    "id",
    review.id,
  );
  return json({ correct, expected: expectedOf(item), whyPt: item.whyPt });
}

function expectedOf(item: ReviewItem): string {
  return item.kind === "recognize" && item.answerIndex !== null
    ? item.options[item.answerIndex] ?? ""
    : item.accepted[0] ?? "";
}

async function handleReviewComplete(
  admin: Db,
  student: Student,
  body: JsonObject,
): Promise<Response> {
  const review = await loadUnlockedReview(admin, student, body.reviewId);
  const items = (review.items as ReviewItem[]) ?? [];
  const answers = asObject(review.answers);
  const right =
    items.filter((item) => asObject(answers[item.id]).correct === true).length;
  const score = items.length ? Math.round((right / items.length) * 100) : 0;
  if (review.status !== "DONE") {
    await admin.from("wolfie_lesson_reviews").update({
      status: "DONE",
      score,
      completed_at: new Date().toISOString(),
    }).eq("id", review.id);
  }
  return json({ score: review.status === "DONE" ? review.score : score });
}

// ── Servidor ────────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);
  try {
    const auth = await authorizeRequest(req, {
      corsHeaders,
      allowedRoles: ["STUDENT"],
      allowWolfieDirect: true,
    });
    if (auth.ok === false) return auth.response;
    const accessError = await requireWolfieProductAccess(
      auth.context,
      corsHeaders,
    );
    if (accessError) return accessError;
    const userId = auth.context.userId!;
    const tenantId = auth.context.profile?.tenant_id;
    if (!tenantId) throw new HttpError(403, "STUDENT_PROFILE_REQUIRED");
    const admin = auth.context.admin;
    const student = await loadStudent(admin, userId, tenantId);
    await assertBillingAccess(admin, student.id, student.tenantId);

    const body = await req.json().catch(() => ({})) as JsonObject;
    const action = str(body.action, 40);
    switch (action) {
      case "home":
        return await handleHome(admin, student);
      case "prepare":
        return await handlePrepare(admin, student);
      case "get":
        return await handleGet(admin, student, body);
      case "answer":
        return await handleAnswer(admin, student, body);
      case "complete":
        return await handleComplete(admin, student, body);
      case "roleplay_feedback":
        return await handleRoleplayFeedback(admin, student, body);
      case "review_get":
        return await handleReviewGet(admin, student, body);
      case "review_answer":
        return await handleReviewAnswer(admin, student, body);
      case "review_complete":
        return await handleReviewComplete(admin, student, body);
      default:
        throw new HttpError(400, "UNKNOWN_ACTION");
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.code }, error.status);
    }
    console.error("[wolfie-lesson-track] unexpected", {
      name: (error as Error)?.name,
    });
    return json({ error: "INTERNAL_ERROR" }, 500);
  }
});
