/// <reference lib="deno.ns" />

// deno-lint-ignore no-import-prefix
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// deno-lint-ignore no-import-prefix
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { parseAiUsage, recordAiUsage } from "../_shared/ai-usage.ts";
import {
  authorizeRequest,
  hasTenantAccess,
  methodNotAllowed,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import {
  boundedText,
  chatCompletionFailure,
  extractChatCompletionText,
  extractEmbeddingVector,
  filterRecommendedMaterials,
  isRecord,
  knowledgeMatchesToSources,
  memoryHasContent,
  normalizeKnowledgeMatches,
  normalizePlannerResult,
  parsePlannerRequest,
  PLANNER_TOTAL_BUDGET_MS,
  plannerModelProfile,
  type PlannerRequest,
  type PlannerResult,
  plannerResultQualityGaps,
  renderLegacyContent,
  type RetrievedKnowledgeChunk,
  safetyIdentifier,
  selectPlannerModel,
} from "./core.ts";
import {
  PLANNER_RESULT_JSON_SCHEMA,
  WISE_WOLF_TRAINING_ENGINE_PROMPT,
} from "./wise-wolf-training-engine.ts";
import {
  APPROVED_LESSON_COLUMNS,
  APPROVED_LESSONS_SYSTEM_PROMPT,
  approvedLessonBasis,
  approvedLessonsContext,
  latestGivenLessonDate,
  legacyContentWithBasis,
  LESSON_PLANNER_PROMPT_VERSION,
  MEET_APPROVED_LESSON_LIMIT,
  normalizeApprovedMeetLessons,
} from "./approved-lessons.ts";
import {
  PLANNER_ACCESS_DENIED_MESSAGE,
  teacherPlannerAccess,
} from "./access.ts";
import {
  buildPlannerModelInput,
  buildPlannerRetrievalQuery,
  PLANNER_CLASS_LOG_COLUMNS,
  PLANNER_GIVEN_LESSON_COLUMNS,
  PLANNER_INTELLIGENCE_COLUMNS,
  PLANNER_MEMORY_COLUMNS,
  PLANNER_STUDENT_COLUMNS,
  type PlannerStudentRow,
  safeArray,
} from "./planner-input.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonResponse = (
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });

const errorResponse = (
  status: number,
  error: string,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response =>
  jsonResponse({ error, request_id: requestId }, status, extraHeaders);

type GenerateRequest = Extract<PlannerRequest, { action: "generate" }>;

interface KnowledgeBaseRow {
  id: string;
  embedding_model: string;
  embedding_dimensions: number;
  version: number;
}

interface OpenRouterChatPayload {
  id?: string;
  model?: string;
  choices?: unknown[];
  usage?: unknown;
  error?: unknown;
}

interface OpenRouterSuccess {
  ok: true;
  payload: OpenRouterChatPayload;
  requestedModel: string;
  model: string;
  ragUsed: boolean;
  latencyMs: number;
}

type OpenRouterCallResult =
  | OpenRouterSuccess
  | { ok: false; response: Response };

type DecodedPlannerPayload =
  | { ok: true; value: unknown }
  | {
    ok: false;
    reason: "refusal" | "provider_error" | "incomplete" | "invalid_json";
  };

async function requireStudentAccess(
  context: RequestAuthContext,
  studentId: string,
  requestId: string,
): Promise<
  | { ok: true; student: PlannerStudentRow; tenantId: string }
  | { ok: false; response: Response }
> {
  const { data, error } = await context.admin
    .from("profiles")
    // Só colunas que a montagem do prompt (planner-input.ts) usa — nada de
    // personality, occupation ou long_term_goal.
    .select(PLANNER_STUDENT_COLUMNS.join(","))
    .eq("id", studentId)
    .maybeSingle();

  if (error) {
    console.error("Planner student lookup failed", {
      requestId,
      code: error.code,
    });
    return {
      ok: false,
      response: errorResponse(
        503,
        "Não foi possível carregar o aluno.",
        requestId,
      ),
    };
  }

  const student = data as unknown as PlannerStudentRow | null;
  if (!student || student.role !== "STUDENT" || !student.tenant_id) {
    return {
      ok: false,
      response: errorResponse(404, "Aluno não encontrado.", requestId),
    };
  }

  if (!hasTenantAccess(context, student.tenant_id)) {
    return {
      ok: false,
      response: errorResponse(
        403,
        "Você não pode acessar este aluno.",
        requestId,
      ),
    };
  }

  if (context.profile?.role === "TEACHER") {
    // A regra mora no banco (planner_teacher_can_access_student): agenda viva,
    // segundo professor, titular sem agenda e — do dia anterior ao seguinte da
    // aula — cobertura confirmada e reposição com data.
    const access = await teacherPlannerAccess(
      (fn, args) => context.admin.rpc(fn, args),
      {
        teacherId: context.userId ?? "",
        studentId: student.id,
        tenantId: student.tenant_id,
      },
    );

    if (access.kind === "error") {
      console.error("Planner assignment lookup failed", {
        requestId,
        code: access.code,
      });
      return {
        ok: false,
        response: errorResponse(
          503,
          "Não foi possível validar o vínculo com o aluno.",
          requestId,
        ),
      };
    }
    if (access.kind === "denied") {
      return {
        ok: false,
        response: errorResponse(
          403,
          PLANNER_ACCESS_DENIED_MESSAGE,
          requestId,
        ),
      };
    }
  }

  return { ok: true, student, tenantId: student.tenant_id };
}

async function enforceGenerationLimit(
  db: SupabaseClient,
  teacherId: string,
  requestId: string,
): Promise<Response | null> {
  const { error: cleanupError } = await db
    .from("planner_ai_runs")
    .delete()
    .eq("status", "DRAFT")
    .lt("expires_at", new Date().toISOString());
  if (cleanupError) {
    console.error("Planner expired-draft cleanup failed", {
      requestId,
      code: cleanupError.code,
    });
  }

  const configuredLimit = Number.parseInt(
    Deno.env.get("OPENROUTER_PLANNER_HOURLY_LIMIT") ?? "40",
    10,
  );
  const hourlyLimit = Number.isFinite(configuredLimit)
    ? Math.min(200, Math.max(1, configuredLimit))
    : 40;
  const since = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
  const { count, error } = await db
    .from("planner_ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("teacher_id", teacherId)
    .gte("created_at", since);

  if (error) {
    console.error("Planner rate-limit lookup failed", {
      requestId,
      code: error.code,
    });
    return errorResponse(
      503,
      "Não foi possível verificar o limite de uso.",
      requestId,
    );
  }

  if ((count ?? 0) >= hourlyLimit) {
    return errorResponse(
      429,
      "Limite temporário de gerações atingido. Tente novamente mais tarde.",
      requestId,
    );
  }
  return null;
}

async function loadPlannerContext(
  db: SupabaseClient,
  tenantId: string,
  studentId: string,
  requestId: string,
) {
  const [
    intelligenceResult,
    memoryItemsResult,
    reportsResult,
    learningMemoriesResult,
    approvedLessonsResult,
    classLogsResult,
    latestGivenLessonResult,
    previousPlansResult,
    materialsResult,
    knowledgeBaseResult,
    teacherCardResult,
  ] = await Promise.all([
    db.from("wolf_intelligence").select(
      PLANNER_INTELLIGENCE_COLUMNS.join(","),
    ).eq("tenant_id", tenantId).eq("student_id", studentId).maybeSingle(),
    db.from("wolfie_memory_items").select(
      "kind,memory_key,content,status,confidence,occurrence_count,last_seen_at,next_review_at",
    ).eq("tenant_id", tenantId).eq("student_id", studentId)
      .eq("status", "active").eq("sensitive", false)
      .order("last_seen_at", { ascending: false }).limit(24),
    db.from("wolfie_session_reports").select(
      "topic,objective,difficulty,accomplishments,primary_corrections,new_vocabulary,recurring_error,best_phrase,review_point,next_step,practice_mission,rubric_scores,generated_at",
    ).eq("tenant_id", tenantId).eq("student_id", studentId)
      .order("generated_at", { ascending: false }).limit(3),
    // Memórias de outras origens (plano salvo, Wolfie, lançamento). As do Meet
    // entram só pela consulta de baixo, aprovadas pelo professor.
    db.from("student_learning_memories").select(
      PLANNER_MEMORY_COLUMNS.join(","),
    ).eq("tenant_id", tenantId).eq("student_id", studentId)
      .neq("source_type", "MEET_SESSION")
      .neq("verification_status", "REJECTED")
      .order("occurred_at", { ascending: false }).limit(12),
    // Aulas do Meet com resumo aprovado pelo professor, com a data da aula.
    db.from("student_learning_memories").select(
      APPROVED_LESSON_COLUMNS.join(","),
    ).eq("tenant_id", tenantId).eq("student_id", studentId)
      .eq("source_type", "MEET_SESSION")
      .eq("verification_status", "VERIFIED")
      .order("occurred_at", { ascending: false })
      .limit(MEET_APPROVED_LESSON_LIMIT),
    db.from("class_logs").select(
      PLANNER_CLASS_LOG_COLUMNS.join(","),
    ).eq("tenant_id", tenantId).eq("student_id", studentId)
      .order("created_at", { ascending: false }).limit(5),
    // A aula DADA mais recente, de qualquer professor: se ela é posterior à
    // última aula aprovada no Meet, a aprovada vira histórico.
    db.from("class_logs").select(
      PLANNER_GIVEN_LESSON_COLUMNS.join(","),
    ).eq("tenant_id", tenantId).eq("student_id", studentId)
      .eq("presence", "COMPLETED").not("class_date", "is", null)
      .order("class_date", { ascending: false, nullsFirst: false })
      .limit(1),
    db.from("lesson_plans").select(
      "task_mode,structured_plan,created_at",
    ).eq("tenant_id", tenantId).eq("student_id", studentId)
      .order("created_at", { ascending: false }).limit(3),
    db.from("pedagogical_materials").select(
      "title,type,level_tag,niche,category",
    ).eq("tenant_id", tenantId).eq("approval_status", "APPROVED")
      .order("created_at", { ascending: false }).limit(60),
    db.from("ai_knowledge_bases").select(
      "id,embedding_model,embedding_dimensions,version",
    ).eq("tenant_id", tenantId).eq("purpose", "WISE_WOLF_PLANNER")
      .eq("provider", "OPENROUTER").eq("status", "ACTIVE")
      .order("version", { ascending: false }).limit(1).maybeSingle(),
    // Cartão do aluno preenchido pelo professor (migration 20260926220000),
    // pela RPC que já aplica a regra de menor do banco.
    db.rpc("student_learning_card_for_planner", {
      p_tenant: tenantId,
      p_student: studentId,
    }),
  ]);

  const namedResults = [
    ["wolf_intelligence", intelligenceResult],
    ["wolfie_memory_items", memoryItemsResult],
    ["wolfie_session_reports", reportsResult],
    ["student_learning_memories", learningMemoriesResult],
    ["student_learning_memories:meet_verified", approvedLessonsResult],
    ["class_logs", classLogsResult],
    ["class_logs:latest_given", latestGivenLessonResult],
    ["lesson_plans", previousPlansResult],
    ["pedagogical_materials", materialsResult],
    ["ai_knowledge_bases", knowledgeBaseResult],
  ] as const;
  for (const [source, result] of namedResults) {
    if (result.error) {
      console.error("Planner context lookup failed", {
        requestId,
        source,
        code: result.error.code,
      });
      throw new Error("planner_context_unavailable");
    }
  }

  // O cartão melhora o plano, mas não pode derrubá-lo: o Planner já ficou
  // meses fora do ar. Sem o cartão, o plano sai com o que o Wolfie inferiu.
  if (teacherCardResult.error) {
    console.error("Planner teacher card lookup failed", {
      requestId,
      code: teacherCardResult.error.code,
    });
  }

  return {
    intelligence: intelligenceResult.data,
    teacherCard: teacherCardResult.error ? null : teacherCardResult.data,
    memoryItems: plannerRows(memoryItemsResult.data),
    reports: plannerRows(reportsResult.data),
    learningMemories: plannerRows(learningMemoriesResult.data),
    // A aula aprovada só é ponto de partida se nenhuma aula foi dada depois.
    approvedLessons: approvedLessonsContext(
      normalizeApprovedMeetLessons(approvedLessonsResult.data),
      latestGivenLessonDate(latestGivenLessonResult.data),
    ),
    classLogs: plannerRows(classLogsResult.data),
    previousPlans: plannerRows(previousPlansResult.data),
    materials: plannerRows(materialsResult.data),
    knowledgeBase: knowledgeBaseResult.data as KnowledgeBaseRow | null,
  };
}

/**
 * Linhas do PostgREST como registros soltos: quem lê campo a campo, com limite
 * de tamanho, é planner-input.ts.
 */
function plannerRows(data: unknown): Record<string, unknown>[] | null {
  return Array.isArray(data) ? data.filter(isRecord) : null;
}

const openRouterHeaders = (apiKey: string): Record<string, string> => ({
  "Authorization": `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "X-OpenRouter-Title": "Wise Wolf Planner AI",
});

const decodePlannerPayload = (
  payload: OpenRouterChatPayload,
): DecodedPlannerPayload => {
  const providerFailure = chatCompletionFailure(payload);
  const outputText = extractChatCompletionText(payload);
  if (providerFailure || !outputText) {
    return {
      ok: false,
      reason: providerFailure === "refusal"
        ? "refusal"
        : providerFailure === "provider_error"
        ? "provider_error"
        : "incomplete",
    };
  }
  try {
    return { ok: true, value: JSON.parse(outputText) };
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
};

const combinedOpenRouterUsage = (
  attempts: OpenRouterSuccess[],
): Record<string, unknown> => {
  const totals = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
  const observed = {
    input_tokens: false,
    output_tokens: false,
    total_tokens: false,
    cost_usd: false,
  };
  for (const attempt of attempts) {
    if (!isRecord(attempt.payload.usage)) continue;
    const metrics = [
      ["prompt_tokens", "input_tokens"],
      ["completion_tokens", "output_tokens"],
      ["total_tokens", "total_tokens"],
      ["cost", "cost_usd"],
    ] as const;
    for (const [sourceKey, targetKey] of metrics) {
      const value = attempt.payload.usage[sourceKey];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      totals[targetKey] += value;
      observed[targetKey] = true;
    }
  }
  return {
    input_tokens: observed.input_tokens ? totals.input_tokens : null,
    output_tokens: observed.output_tokens ? totals.output_tokens : null,
    total_tokens: observed.total_tokens ? totals.total_tokens : null,
    cost_usd: observed.cost_usd ? totals.cost_usd : null,
    attempt_count: attempts.length,
    quality_retry: attempts.length > 1,
    model_attempts: attempts.map((attempt) => attempt.model),
    requested_model_attempts: attempts.map((attempt) => attempt.requestedModel),
  };
};

const retryAfterHeader = (response: Response): Record<string, string> => {
  const value = response.headers.get("retry-after")?.trim() ?? "";
  if (!/^\d{1,3}$/.test(value)) return {};
  const seconds = Number.parseInt(value, 10);
  return seconds >= 1 && seconds <= 300 ? { "Retry-After": value } : {};
};

async function retrieveWiseWolfKnowledge(
  db: SupabaseClient,
  tenantId: string,
  knowledgeBase: KnowledgeBaseRow | null,
  query: string,
  requestId: string,
): Promise<RetrievedKnowledgeChunk[]> {
  if (
    !knowledgeBase ||
    knowledgeBase.embedding_dimensions !== 1536 ||
    !knowledgeBase.embedding_model ||
    !query
  ) {
    return [];
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY")?.trim() ?? "";
  if (!apiKey) return [];

  try {
    const embeddingResponse = await fetch(
      "https://openrouter.ai/api/v1/embeddings",
      {
        method: "POST",
        headers: openRouterHeaders(apiKey),
        body: JSON.stringify({
          model: knowledgeBase.embedding_model,
          input: query,
          dimensions: knowledgeBase.embedding_dimensions,
          encoding_format: "float",
          provider: {
            allow_fallbacks: true,
            data_collection: "deny",
            zdr: true,
          },
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!embeddingResponse.ok) {
      console.error("Planner OpenRouter embedding request failed", {
        requestId,
        status: embeddingResponse.status,
        providerRequestId: embeddingResponse.headers.get("x-request-id"),
      });
      return [];
    }

    const embeddingPayload: unknown = await embeddingResponse.json();
    const embedding = extractEmbeddingVector(
      embeddingPayload,
      knowledgeBase.embedding_dimensions,
    );
    if (!embedding) {
      console.error("Planner OpenRouter embedding response was invalid", {
        requestId,
      });
      return [];
    }

    const configuredMatchCount = Number.parseInt(
      Deno.env.get("OPENROUTER_RAG_MATCH_COUNT") ?? "8",
      10,
    );
    const matchCount = Number.isFinite(configuredMatchCount)
      ? Math.min(12, Math.max(1, configuredMatchCount))
      : 8;
    const configuredSimilarity = Number(
      Deno.env.get("OPENROUTER_RAG_MIN_SIMILARITY") ?? "0.50",
    );
    const minSimilarity = Number.isFinite(configuredSimilarity)
      ? Math.min(0.95, Math.max(0.20, configuredSimilarity))
      : 0.50;
    const { data, error } = await db.rpc("match_wise_wolf_knowledge", {
      p_tenant_id: tenantId,
      p_knowledge_base_id: knowledgeBase.id,
      p_query_embedding: embedding,
      p_match_count: matchCount,
      p_min_similarity: minSimilarity,
    });
    if (error) {
      console.error("Planner pgvector retrieval failed", {
        requestId,
        code: error.code,
      });
      return [];
    }
    return normalizeKnowledgeMatches(data, matchCount);
  } catch (error) {
    console.error("Planner RAG retrieval transport failed", {
      requestId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return [];
  }
}

async function callOpenRouter(
  tenantId: string,
  teacherId: string,
  input: string,
  ragUsed: boolean,
  requestId: string,
  modelOverride: string,
  qualityGaps: string[] = [],
  deadlineAt: number = performance.now() + PLANNER_TOTAL_BUDGET_MS,
): Promise<OpenRouterCallResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY")?.trim() ?? "";
  if (!apiKey) {
    return {
      ok: false,
      response: errorResponse(
        503,
        "A integração de IA do Planner ainda não foi configurada.",
        requestId,
      ),
    };
  }

  const model = boundedText(modelOverride, 200) || "openai/gpt-4o-mini";
  const modelProfile = plannerModelProfile(
    model,
    qualityGaps.length > 0,
    deadlineAt - performance.now(),
  );
  const requestedEffort =
    Deno.env.get("OPENROUTER_PLANNER_REASONING")?.trim().toLowerCase() || "low";
  const reasoningEffort = ["none", "minimal", "low", "medium", "high", "xhigh"]
      .includes(requestedEffort)
    ? requestedEffort
    : "low";

  const messages: Array<Record<string, string>> = [
    { role: "system", content: WISE_WOLF_TRAINING_ENGINE_PROMPT },
    { role: "system", content: APPROVED_LESSONS_SYSTEM_PROMPT },
  ];
  if (qualityGaps.length) {
    messages.push({
      role: "system",
      content: [
        "RETRY DE QUALIDADE OBRIGATÓRIO",
        "A tentativa anterior foi descartada pelos validadores internos.",
        `Corrija estes critérios: ${qualityGaps.join(", ")}.`,
        "Gere o artefato completo novamente, do zero.",
        "Em lesson_plan de 30 minutos, entregue 5 a 8 blocos cuja soma seja exatamente 30, orientação e tarefa em todos os blocos, ao menos 4 itens de vocabulário, 4 perguntas e exemplos em pelo menos 4 blocos.",
      ].join("\n"),
    });
  }
  messages.push({ role: "user", content: input });

  const body: Record<string, unknown> = {
    model,
    messages,
    user: await safetyIdentifier(tenantId, teacherId),
    max_completion_tokens: 7_000,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "wise_wolf_planner_result",
        strict: true,
        schema: PLANNER_RESULT_JSON_SCHEMA,
      },
    },
    provider: {
      require_parameters: true,
      allow_fallbacks: true,
      data_collection: "deny",
      zdr: true,
    },
  };
  if (modelProfile.supportsReasoning) {
    body.reasoning = { effort: reasoningEffort };
  }
  if (modelProfile.temperature !== null) {
    body.temperature = modelProfile.temperature;
  }

  try {
    const startedAt = performance.now();
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: openRouterHeaders(apiKey),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(modelProfile.timeoutMs),
      },
    );

    if (!response.ok) {
      console.error("Planner OpenRouter request failed", {
        requestId,
        status: response.status,
        providerRequestId: response.headers.get("x-request-id"),
      });
      const status = response.status === 429
        ? 429
        : response.status === 408 || response.status === 504
        ? 504
        : response.status >= 500
        ? 503
        : 502;
      return {
        ok: false,
        response: errorResponse(
          status,
          status === 429
            ? "A IA atingiu um limite temporário. Tente novamente em instantes."
            : status === 504
            ? "A geração demorou mais que o esperado. Tente novamente."
            : "A IA não conseguiu gerar o planejamento agora.",
          requestId,
          retryAfterHeader(response),
        ),
      };
    }

    let payload: OpenRouterChatPayload;
    try {
      payload = await response.json() as OpenRouterChatPayload;
    } catch {
      console.error("Planner OpenRouter response was not JSON", { requestId });
      return {
        ok: false,
        response: errorResponse(
          502,
          "A IA devolveu uma resposta inválida. Gere novamente.",
          requestId,
        ),
      };
    }
    return {
      ok: true,
      payload,
      requestedModel: model,
      model: boundedText(payload.model, 200) || model,
      ragUsed,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    console.error("Planner OpenRouter transport failed", {
      requestId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return {
      ok: false,
      response: errorResponse(
        504,
        "A geração demorou mais que o esperado. Tente novamente.",
        requestId,
      ),
    };
  }
}

async function generatePlan(
  context: RequestAuthContext,
  request: GenerateRequest,
  requestId: string,
): Promise<Response> {
  if (!context.userId) {
    return errorResponse(401, "Autenticação necessária.", requestId);
  }
  const access = await requireStudentAccess(
    context,
    request.studentId,
    requestId,
  );
  if (access.ok === false) return access.response;

  const limited = await enforceGenerationLimit(
    context.admin,
    context.userId,
    requestId,
  );
  if (limited) return limited;

  let plannerContext: Awaited<ReturnType<typeof loadPlannerContext>>;
  try {
    plannerContext = await loadPlannerContext(
      context.admin,
      access.tenantId,
      request.studentId,
      requestId,
    );
  } catch {
    return errorResponse(
      503,
      "Não foi possível montar o contexto pedagógico.",
      requestId,
    );
  }

  const retrievalQuery = buildPlannerRetrievalQuery(
    request,
    access.student,
    plannerContext,
  );
  const retrievedKnowledge = await retrieveWiseWolfKnowledge(
    context.admin,
    access.tenantId,
    plannerContext.knowledgeBase,
    retrievalQuery,
    requestId,
  );
  const input = buildPlannerModelInput(
    request,
    access.student,
    plannerContext,
    retrievedKnowledge,
  );
  const economyModel = Deno.env.get("OPENROUTER_PLANNER_MODEL")?.trim() ||
    "openai/gpt-4o-mini";
  const highAccuracyModel =
    Deno.env.get("OPENROUTER_PLANNER_FALLBACK_MODEL")?.trim() ||
    "openai/gpt-5-mini";
  const intelligence: Record<string, unknown> =
    isRecord(plannerContext.intelligence) ? plannerContext.intelligence : {};
  const studentSettings: Record<string, unknown> =
    isRecord(access.student.wolfie_settings)
      ? access.student.wolfie_settings
      : {};
  const studentLevel = intelligence.estimated_level ?? studentSettings.level ??
    access.student.module;
  const initialModel = selectPlannerModel(
    request.taskMode,
    economyModel,
    highAccuracyModel,
    studentLevel,
  );
  // Orçamento único para a geração inteira: o retry de qualidade só ganha o
  // que sobrar, para a resposta sair antes de o worker (150 s) morrer.
  const deadlineAt = performance.now() + PLANNER_TOTAL_BUDGET_MS;
  let openRouter = await callOpenRouter(
    access.tenantId,
    context.userId,
    input,
    retrievedKnowledge.length > 0,
    requestId,
    initialModel,
    [],
    deadlineAt,
  );
  if (openRouter.ok === false) return openRouter.response;

  const generationAttempts: OpenRouterSuccess[] = [openRouter];
  let decoded = decodePlannerPayload(openRouter.payload);
  if (decoded.ok === false && decoded.reason === "refusal") {
    console.error("Planner OpenRouter request was refused", { requestId });
    return errorResponse(
      502,
      "A IA não pôde atender a este pedido. Revise o objetivo da aula.",
      requestId,
    );
  }

  let qualityGaps: string[];
  if (decoded.ok === false) {
    qualityGaps = [decoded.reason];
  } else {
    qualityGaps = plannerResultQualityGaps(decoded.value, request);
  }
  if (qualityGaps.length) {
    console.warn("Planner quality retry requested", {
      requestId,
      qualityGaps,
    });
    const retry = await callOpenRouter(
      access.tenantId,
      context.userId,
      input,
      retrievedKnowledge.length > 0,
      requestId,
      highAccuracyModel,
      qualityGaps,
      deadlineAt,
    );
    if (retry.ok === false) return retry.response;
    generationAttempts.push(retry);
    openRouter = retry;
    decoded = decodePlannerPayload(retry.payload);
    if (decoded.ok === false) {
      qualityGaps = [decoded.reason];
    } else {
      qualityGaps = plannerResultQualityGaps(decoded.value, request);
    }
  }

  if (decoded.ok === false || qualityGaps.length) {
    console.error("Planner OpenRouter response failed quality validation", {
      requestId,
      reason: decoded.ok === false ? decoded.reason : "quality_gaps",
      qualityGaps,
    });
    return errorResponse(
      502,
      "A IA não devolveu um planejamento completo. Gere novamente.",
      requestId,
    );
  }

  let plan: PlannerResult;
  try {
    plan = normalizePlannerResult(decoded.value, request);
  } catch (error) {
    console.error("Planner OpenRouter structured output was invalid", {
      requestId,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return errorResponse(
      502,
      "A IA devolveu um formato incompleto. Gere novamente.",
      requestId,
    );
  }

  const retrievedSources = knowledgeMatchesToSources(retrievedKnowledge);
  const retrievedSourceTitles = retrievedSources
    .filter((source) =>
      source.attributes.recommendable === true ||
      source.attributes.student_facing === true
    )
    .map((source) => source.title);
  const approvedMaterialTitles = (plannerContext.materials ?? [])
    .map((material) => boundedText(material.title, 300))
    .filter(Boolean);
  plan.materials = filterRecommendedMaterials(
    plan.materials,
    [...approvedMaterialTitles, ...retrievedSourceTitles],
  );
  if (!openRouter.ragUsed) {
    plan.warnings = [
      ...plan.warnings,
      plannerContext.knowledgeBase
        ? "Nenhum trecho relevante da base RAG foi recuperado; o plano usou a memória estruturada e o catálogo aprovado."
        : "A base RAG da Wise Wolf ainda não está ativa para esta escola; o plano usou apenas memória estruturada e o catálogo aprovado.",
    ];
  }

  // A base do plano sai das aulas aprovadas, calculada pelo código — não é o
  // modelo quem diz em quais aulas o plano se baseou.
  const lessonBasis = approvedLessonBasis(
    plannerContext.approvedLessons,
    request.taskMode,
  );
  const legacyContent = legacyContentWithBasis(
    lessonBasis,
    renderLegacyContent(plan),
  );
  const planWithBasis = { ...plan, lesson_basis: lessonBasis };
  const persistedResult = {
    ...planWithBasis,
    legacy_content: legacyContent,
  };
  // Além do planner_ai_runs (que já registrava usage), alimenta o relatório
  // unificado de custo de IA para o Planner aparecer ao lado das demais.
  await recordAiUsage(context.admin, {
    tenantId: access.tenantId,
    userId: context.userId,
    feature: "lesson_planner",
    model: openRouter.model,
    usage: parseAiUsage(combinedOpenRouterUsage(generationAttempts)),
  });

  const { data: run, error: runError } = await context.admin
    .from("planner_ai_runs")
    .insert({
      tenant_id: access.tenantId,
      teacher_id: context.userId,
      student_id: request.studentId,
      task_mode: request.taskMode,
      duration_minutes: request.durationMinutes,
      bilingual: request.bilingual,
      teacher_request: request.teacherRequest,
      model_id: openRouter.model,
      prompt_version: LESSON_PLANNER_PROMPT_VERSION,
      response_id: boundedText(openRouter.payload.id, 200) || null,
      usage: combinedOpenRouterUsage(generationAttempts),
      latency_ms: generationAttempts.reduce(
        (total, attempt) => total + attempt.latencyMs,
        0,
      ),
      rag_used: openRouter.ragUsed,
      retrieved_sources: retrievedSources,
      result: persistedResult,
      status: "DRAFT",
    })
    .select("id")
    .single();

  if (runError || !run) {
    console.error("Planner run persistence failed", {
      requestId,
      code: runError?.code,
    });
    return errorResponse(
      503,
      "O plano foi gerado, mas não pôde ser preparado para salvamento.",
      requestId,
    );
  }

  return jsonResponse({
    run_id: run.id,
    student_id: request.studentId,
    plan: planWithBasis,
    lesson_basis: lessonBasis,
    knowledge: {
      mode: openRouter.ragUsed ? "RAG" : "STRUCTURED_MEMORY_ONLY",
      sources: retrievedSources,
      rag_used: openRouter.ragUsed,
      // Compatibility field for clients released before the pgvector rollout.
      vector_store_used: openRouter.ragUsed,
      knowledge_base_version: plannerContext.knowledgeBase?.version ?? null,
    },
    memory_status: memoryHasContent(plan.student_memory_update)
      ? "PROPOSED"
      : "EMPTY",
    // Compatibility fields for older clients during rollout.
    objectives: plan.objective,
    content: legacyContent,
    materials: plan.materials.map((material) => material.title).join(", "),
    ai_memory_reflection: plan.ai_memory_reflection,
    weak_points: safeArray(
      isRecord(plannerContext.intelligence)
        ? plannerContext.intelligence.weak_points
        : [],
      6,
    ),
    request_id: requestId,
  });
}

async function savePlan(
  context: RequestAuthContext,
  runId: string,
  requestId: string,
): Promise<Response> {
  if (!context.userId) {
    return errorResponse(401, "Autenticação necessária.", requestId);
  }

  const { data: run, error: runError } = await context.admin
    .from("planner_ai_runs")
    .select(
      "id,tenant_id,teacher_id,student_id,status,expires_at",
    )
    .eq("id", runId)
    .maybeSingle();

  if (runError) {
    console.error("Planner save lookup failed", {
      requestId,
      code: runError.code,
    });
    return errorResponse(
      503,
      "Não foi possível localizar o planejamento.",
      requestId,
    );
  }
  if (!run) {
    return errorResponse(404, "Planejamento não encontrado.", requestId);
  }
  if (
    run.teacher_id !== context.userId ||
    !hasTenantAccess(context, run.tenant_id)
  ) {
    return errorResponse(
      403,
      "Você não pode salvar este planejamento.",
      requestId,
    );
  }

  const access = await requireStudentAccess(
    context,
    run.student_id,
    requestId,
  );
  if (access.ok === false) return access.response;

  if (run.status === "SAVED") {
    const { data: existingPlan, error: existingPlanError } = await context.admin
      .from("lesson_plans")
      .select("id")
      .eq("planner_run_id", runId)
      .maybeSingle();
    if (existingPlanError || !existingPlan) {
      console.error("Planner saved run is missing its plan", {
        requestId,
        code: existingPlanError?.code,
      });
      return errorResponse(
        503,
        "O planejamento salvo está inconsistente.",
        requestId,
      );
    }
    return jsonResponse({
      saved: true,
      lesson_plan_id: existingPlan.id,
      run_id: runId,
      memory_status: "PROPOSED",
      request_id: requestId,
    });
  }
  if (
    run.status === "EXPIRED" ||
    Date.parse(run.expires_at) <= Date.now()
  ) {
    return errorResponse(
      409,
      "Este rascunho expirou. Gere um novo planejamento.",
      requestId,
    );
  }

  const { data: planId, error: saveError } = await context.admin.rpc(
    "save_planner_ai_run",
    {
      p_run_id: runId,
      p_actor_id: context.userId,
    },
  );
  if (saveError || typeof planId !== "string") {
    console.error("Planner transactional save failed", {
      requestId,
      code: saveError?.code,
    });
    return errorResponse(
      503,
      "Não foi possível salvar o planejamento.",
      requestId,
    );
  }

  return jsonResponse({
    saved: true,
    lesson_plan_id: planId,
    run_id: runId,
    memory_status: "PROPOSED",
    request_id: requestId,
  });
}

serve(async (req) => {
  const requestId = crypto.randomUUID();
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return methodNotAllowed(corsHeaders);
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 16_000) {
    return errorResponse(413, "Solicitação muito grande.", requestId);
  }

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["TEACHER", "COORDINATOR", "SCHOOL_ADMIN", "SUPER_ADMIN"],
    allowService: false,
  });
  if (auth.ok === false) return auth.response;

  let request: PlannerRequest;
  try {
    const rawBody = await req.text();
    if (rawBody.length > 16_000) {
      return errorResponse(413, "Solicitação muito grande.", requestId);
    }
    request = parsePlannerRequest(JSON.parse(rawBody));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid_request";
    const message = reason === "invalid_student_id"
      ? "Aluno inválido."
      : reason === "invalid_run_id"
      ? "Planejamento inválido."
      : "Solicitação inválida.";
    return errorResponse(400, message, requestId);
  }

  try {
    return request.action === "save"
      ? await savePlan(auth.context, request.runId, requestId)
      : await generatePlan(auth.context, request, requestId);
  } catch (error) {
    console.error("Planner request failed unexpectedly", {
      requestId,
      name: error instanceof Error ? error.name : "unknown",
    });
    return errorResponse(
      500,
      "Não foi possível concluir o planejamento.",
      requestId,
    );
  }
});
