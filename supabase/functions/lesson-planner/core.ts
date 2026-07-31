import {
  PLANNER_TASK_MODES,
  type PlannerTaskMode,
} from "./wise-wolf-training-engine.ts";

export interface PlannerExample {
  english: string;
  portuguese: string;
}

export interface PlannerSection {
  title: string;
  minutes: number;
  teacher_guidance: string;
  student_task: string;
  examples: PlannerExample[];
}

export interface PlannerMaterial {
  title: string;
  usage: string;
}

export interface RetrievedSource {
  source_id: string;
  document_id: string;
  title: string;
  score: number | null;
  attributes: Record<string, string | number | boolean>;
}

export interface RetrievedKnowledgeChunk {
  chunk_id: string;
  document_id: string;
  title: string;
  content: string;
  similarity: number | null;
  chunk_index: number;
  metadata: Record<string, string | number | boolean>;
}

export interface StudentMemoryUpdate {
  lesson_objective: string;
  content_practiced: string[];
  new_vocabulary: string[];
  recurring_errors: string[];
  corrections_mastered: string[];
  strengths_observed: string[];
  homework_assigned: string;
  recommended_next_step: string;
  confidence_level: "LOW" | "MEDIUM" | "HIGH";
  notes_to_verify: string[];
}

export interface PlannerResult {
  task_mode: PlannerTaskMode;
  title: string;
  objective: string;
  level: string;
  duration_minutes: number;
  bilingual: boolean;
  overview: string;
  sections: PlannerSection[];
  vocabulary: Array<{
    item: string;
    meaning_pt: string;
    example_en: string;
    use_question_en: string;
  }>;
  teacher_questions: Array<{
    question_en: string;
    model_answer_en: string;
    translation_pt: string;
  }>;
  expected_corrections: Array<{
    focus: string;
    produced_or_likely_error: string;
    minimal_correction: string;
    natural_version: string;
    advanced_version: string;
    explanation_pt: string;
    micropractice: string[];
  }>;
  homework: string;
  materials: PlannerMaterial[];
  assessment_criteria: Array<{
    criterion: string;
    what_to_observe: string;
    rating_guide: string;
  }>;
  strengths: string[];
  priorities: string[];
  next_steps: string[];
  student_memory_update: StudentMemoryUpdate;
  ai_memory_reflection: string;
  warnings: string[];
}

export type PlannerRequest =
  | {
    action: "generate";
    studentId: string;
    teacherRequest: string;
    taskMode: PlannerTaskMode;
    bilingual: boolean;
    durationMinutes: number;
  }
  | {
    action: "save";
    runId: string;
  };

type JsonRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const boundedText = (
  value: unknown,
  maxLength: number,
  fallback = "",
): string => {
  if (typeof value !== "string") return fallback;
  const normalized = value.split("\u0000").join("").trim();
  return normalized.slice(0, maxLength);
};

export const boundedStringArray = (
  value: unknown,
  maxItems = 20,
  maxItemLength = 300,
): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => boundedText(item, maxItemLength))
    .filter(Boolean)
    .slice(0, maxItems);
};

const HIGH_ACCURACY_TASK_MODES: readonly PlannerTaskMode[] = [
  "student_feedback",
  "oral_test",
  "presentation_coaching",
  "progress_report",
];

const NON_OBSERVATIONAL_TASK_MODES: readonly PlannerTaskMode[] = [
  "lesson_plan",
  "homework",
  "class_script",
  "vocabulary",
  "material_generation",
];

export interface PlannerModelProfile {
  supportsReasoning: boolean;
  temperature: number | null;
  timeoutMs: number;
}

export function plannerLevelRequiresHighAccuracy(level: unknown): boolean {
  return /(?:^|[^A-Z0-9])(?:B2|C1|C2)(?:$|[^A-Z0-9])/i.test(
    boundedText(level, 120),
  );
}

export function selectPlannerModel(
  taskMode: PlannerTaskMode,
  economyModel: string,
  highAccuracyModel: string,
  studentLevel?: unknown,
): string {
  return HIGH_ACCURACY_TASK_MODES.includes(taskMode) ||
      plannerLevelRequiresHighAccuracy(studentLevel)
    ? highAccuracyModel
    : economyModel;
}

export function plannerModelProfile(
  model: string,
  isQualityRetry = false,
): PlannerModelProfile {
  const normalized = boundedText(model, 200).toLowerCase();
  const isGpt4oMini = normalized === "openai/gpt-4o-mini" ||
    normalized.startsWith("openai/gpt-4o-mini-");
  const isGpt5Mini = normalized === "openai/gpt-5-mini" ||
    normalized.startsWith("openai/gpt-5-mini-");
  return {
    supportsReasoning: isGpt5Mini,
    temperature: isGpt4oMini ? 0.2 : null,
    timeoutMs: isGpt4oMini || isGpt5Mini || isQualityRetry ? 25_000 : 50_000,
  };
}

export function redactDirectIdentifiers(value: string): string {
  return value
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[EMAIL_REMOVIDO]",
    )
    .replace(
      /\b(?:CPF[\s:#-]*)?\d{3}[.\s-]?\d{3}[.\s-]?\d{3}[-.\s]?\d{2}\b/gi,
      "[CPF_REMOVIDO]",
    )
    .replace(
      /\b(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/g,
      "[TELEFONE_REMOVIDO]",
    )
    .replace(
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g,
      "[CHAVE_REMOVIDA]",
    )
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi,
      "Bearer [TOKEN_REMOVIDO]",
    );
}

export const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);

const normalizedTaskMode = (value: unknown): PlannerTaskMode => {
  if (value === undefined || value === null || value === "") {
    return "lesson_plan";
  }
  if (
    typeof value === "string" &&
    PLANNER_TASK_MODES.includes(value as PlannerTaskMode)
  ) {
    return value as PlannerTaskMode;
  }
  throw new Error("invalid_task_mode");
};

export function parsePlannerRequest(value: unknown): PlannerRequest {
  if (!isRecord(value)) throw new Error("invalid_request");
  if (
    value.action !== undefined &&
    value.action !== "generate" &&
    value.action !== "save"
  ) {
    throw new Error("invalid_action");
  }
  const action = value.action === "save" ? "save" : "generate";

  if (action === "save") {
    const runId = boundedText(value.run_id ?? value.runId, 64);
    if (!isUuid(runId)) throw new Error("invalid_run_id");
    return { action, runId };
  }

  const studentId = boundedText(value.student_id ?? value.studentId, 64);
  if (!isUuid(studentId)) throw new Error("invalid_student_id");
  const requestedDuration = typeof value.duration_minutes === "number"
    ? value.duration_minutes
    : typeof value.durationMinutes === "number"
    ? value.durationMinutes
    : 30;
  const finiteDuration = Number.isFinite(requestedDuration)
    ? requestedDuration
    : 30;
  const durationMinutes = Math.min(
    120,
    Math.max(10, Math.round(finiteDuration)),
  );
  const teacherRequest = redactDirectIdentifiers(
    boundedText(
      value.teacher_request ?? value.custom_prompt ?? value.teacherRequest,
      2_500,
    ),
  );

  return {
    action,
    studentId,
    teacherRequest,
    taskMode: normalizedTaskMode(value.task_mode ?? value.taskMode),
    bilingual: value.bilingual !== false,
    durationMinutes,
  };
}

export const normalizeTitle = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\.[a-z0-9]{2,6}$/i, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase("pt-BR");

export function filterRecommendedMaterials(
  materials: PlannerMaterial[],
  allowedTitles: string[],
): PlannerMaterial[] {
  const allowed = new Map<string, string | null>();
  for (const title of allowedTitles) {
    const safeTitle = boundedText(title, 300);
    const key = normalizeTitle(safeTitle);
    if (!key) continue;
    const existing = allowed.get(key);
    if (existing === undefined) {
      allowed.set(key, safeTitle);
    } else if (existing !== safeTitle) {
      // Two distinct files that normalize to the same title are ambiguous.
      allowed.set(key, null);
    }
  }

  const seen = new Set<string>();
  return materials.flatMap((material) => {
    const requestedKey = normalizeTitle(boundedText(material?.title, 300));
    const exactTitle = allowed.get(requestedKey);
    if (!exactTitle || seen.has(requestedKey)) return [];
    seen.add(requestedKey);
    return [{
      title: exactTitle,
      usage: boundedText(material?.usage, 800),
    }];
  });
}

export function extractChatCompletionText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return "";
  const choice = payload.choices.find(isRecord);
  if (!choice || !isRecord(choice.message)) return "";
  const content = choice.message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!isRecord(part)) return [];
    if (typeof part.text === "string") return [part.text];
    return [];
  }).join("\n").trim();
}

export function chatCompletionFailure(
  payload: unknown,
): "incomplete" | "refusal" | "provider_error" | null {
  if (!isRecord(payload)) return "incomplete";
  const errorIsRefusal = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    const metadata = isRecord(value.metadata) ? value.metadata : {};
    const errorType = boundedText(
      metadata.error_type ?? metadata.type ?? value.type,
      80,
    ).toLowerCase();
    return [
      "refusal",
      "content_policy_violation",
      "moderation",
      "moderation_error",
    ].includes(errorType);
  };
  if (isRecord(payload.error)) {
    return errorIsRefusal(payload.error) ? "refusal" : "provider_error";
  }
  if (!Array.isArray(payload.choices) || payload.choices.length === 0) {
    return "incomplete";
  }

  const choice = payload.choices.find(isRecord);
  if (!choice || !isRecord(choice.message)) return "incomplete";
  if (isRecord(choice.error) || isRecord(choice.message.error)) {
    const error = isRecord(choice.error) ? choice.error : choice.message.error;
    return errorIsRefusal(error) ? "refusal" : "provider_error";
  }
  if (
    typeof choice.message.refusal === "string" &&
    choice.message.refusal.trim()
  ) {
    return "refusal";
  }
  const finishReason = boundedText(choice.finish_reason, 60).toLowerCase();
  if (["length", "content_filter", "error"].includes(finishReason)) {
    return finishReason === "content_filter" ? "refusal" : "incomplete";
  }
  return null;
}

export function extractEmbeddingVector(
  payload: unknown,
  expectedDimensions: number,
): number[] | null {
  if (
    !Number.isInteger(expectedDimensions) ||
    expectedDimensions <= 0 ||
    !isRecord(payload) ||
    isRecord(payload.error) ||
    !Array.isArray(payload.data)
  ) {
    return null;
  }
  const first = payload.data.find(isRecord);
  if (!first || !Array.isArray(first.embedding)) return null;
  if (first.embedding.length !== expectedDimensions) return null;
  const vector = first.embedding.filter((item): item is number =>
    typeof item === "number" && Number.isFinite(item)
  );
  return vector.length === expectedDimensions ? vector : null;
}

const primitiveMetadata = (
  value: unknown,
): Record<string, string | number | boolean> => {
  if (!isRecord(value)) return {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    const safeKey = boundedText(key, 80);
    if (!safeKey) continue;
    if (typeof item === "string") {
      result[safeKey] = boundedText(item, 300);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      result[safeKey] = item;
    } else if (typeof item === "boolean") {
      result[safeKey] = item;
    }
  }
  return result;
};

export function normalizeKnowledgeMatches(
  value: unknown,
  maxItems = 8,
  maxTotalChars = 24_000,
): RetrievedKnowledgeChunk[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const matches: RetrievedKnowledgeChunk[] = [];
  const itemLimit = Number.isInteger(maxItems)
    ? Math.min(20, Math.max(1, maxItems))
    : 8;
  let remainingChars = Number.isFinite(maxTotalChars)
    ? Math.min(60_000, Math.max(1, Math.round(maxTotalChars)))
    : 24_000;

  for (const item of value) {
    if (
      !isRecord(item) ||
      matches.length >= itemLimit ||
      remainingChars <= 0
    ) {
      continue;
    }
    const chunkId = boundedText(item.chunk_id, 64);
    const documentId = boundedText(item.document_id, 64);
    const title = boundedText(item.title, 300);
    const content = boundedText(item.content, Math.min(4_000, remainingChars));
    if (!chunkId || !documentId || !title || !content || seen.has(chunkId)) {
      continue;
    }
    seen.add(chunkId);
    remainingChars -= content.length;
    const rawSimilarity = typeof item.similarity === "number" &&
        Number.isFinite(item.similarity)
      ? item.similarity
      : null;
    matches.push({
      chunk_id: chunkId,
      document_id: documentId,
      title,
      content,
      similarity: rawSimilarity === null
        ? null
        : Math.max(-1, Math.min(1, rawSimilarity)),
      chunk_index: typeof item.chunk_index === "number" &&
          Number.isInteger(item.chunk_index) && item.chunk_index >= 0
        ? item.chunk_index
        : 0,
      metadata: primitiveMetadata(item.metadata),
    });
  }
  return matches;
}

export function knowledgeMatchesToSources(
  matches: RetrievedKnowledgeChunk[],
): RetrievedSource[] {
  return matches.map((match) => ({
    source_id: match.chunk_id,
    document_id: match.document_id,
    title: match.title,
    score: match.similarity,
    attributes: {
      ...match.metadata,
      chunk_index: match.chunk_index,
    },
  }));
}

const stringField = (
  record: JsonRecord,
  key: string,
  maxLength = 5_000,
): string => boundedText(record[key], maxLength);

const stringArrayField = (
  record: JsonRecord,
  key: string,
  maxItems = 30,
): string[] => boundedStringArray(record[key], maxItems, 600);

export function plannerResultQualityGaps(
  value: unknown,
  request: Extract<PlannerRequest, { action: "generate" }>,
): string[] {
  if (!isRecord(value)) return ["invalid_result"];

  const gaps: string[] = [];
  if (!boundedText(value.title, 300)) gaps.push("missing_title");
  if (!boundedText(value.objective, 2_000)) gaps.push("missing_objective");

  const sections = (Array.isArray(value.sections) ? value.sections : [])
    .filter(isRecord);
  if (!sections.length) {
    gaps.push("missing_sections");
    return gaps;
  }

  if (request.taskMode !== "lesson_plan") return gaps;

  const minimumSections = request.durationMinutes >= 45
    ? 6
    : request.durationMinutes >= 30
    ? 5
    : request.durationMinutes >= 20
    ? 4
    : 3;
  const maximumSections = request.durationMinutes <= 30 ? 8 : 12;
  if (
    sections.length < minimumSections ||
    sections.length > maximumSections
  ) {
    gaps.push("lesson_section_count");
  }

  const totalMinutes = sections.reduce(
    (sum, section) =>
      sum +
      (typeof section.minutes === "number" &&
          Number.isFinite(section.minutes)
        ? Math.max(0, Math.round(section.minutes))
        : 0),
    0,
  );
  const toleratedMinuteDrift = Math.max(
    1,
    Math.floor(request.durationMinutes * 0.1),
  );
  if (
    Math.abs(totalMinutes - request.durationMinutes) > toleratedMinuteDrift
  ) {
    gaps.push("lesson_minutes_total");
  }

  if (
    sections.some((section) =>
      !boundedText(section.teacher_guidance, 3_000) ||
      !boundedText(section.student_task, 3_000)
    )
  ) {
    gaps.push("lesson_instructions");
  }

  const exampleSections = sections.filter((section) => {
    const examples = (Array.isArray(section.examples) ? section.examples : [])
      .filter(isRecord);
    return examples.some((example) =>
      boundedText(example.english, 800) &&
      (!request.bilingual || boundedText(example.portuguese, 800))
    );
  }).length;
  const minimumExampleSections = request.bilingual
    ? Math.min(4, minimumSections)
    : Math.min(3, minimumSections);
  if (exampleSections < minimumExampleSections) {
    gaps.push("lesson_examples");
  }

  const vocabularyCount =
    (Array.isArray(value.vocabulary) ? value.vocabulary : []).filter(isRecord)
      .filter((item) =>
        boundedText(item.item, 200) &&
        boundedText(item.meaning_pt, 600) &&
        boundedText(item.example_en, 800) &&
        boundedText(item.use_question_en, 800)
      ).length;
  if (vocabularyCount < (request.durationMinutes >= 20 ? 4 : 2)) {
    gaps.push("lesson_vocabulary");
  }

  const questionCount =
    (Array.isArray(value.teacher_questions) ? value.teacher_questions : [])
      .filter(isRecord)
      .filter((item) =>
        boundedText(item.question_en, 800) &&
        boundedText(item.model_answer_en, 1_200) &&
        (!request.bilingual || boundedText(item.translation_pt, 1_200))
      ).length;
  if (questionCount < (request.durationMinutes >= 20 ? 4 : 2)) {
    gaps.push("lesson_teacher_questions");
  }

  return gaps;
}

export function normalizePlannerResult(
  value: unknown,
  request: Extract<PlannerRequest, { action: "generate" }>,
): PlannerResult {
  if (!isRecord(value)) throw new Error("invalid_model_output");
  const rawSections = Array.isArray(value.sections) ? value.sections : [];
  const sections: PlannerSection[] = rawSections
    .filter(isRecord)
    .slice(0, 12)
    .map((section) => ({
      title: stringField(section, "title", 200),
      minutes: Math.min(
        120,
        Math.max(
          0,
          Math.round(
            typeof section.minutes === "number" ? section.minutes : 0,
          ),
        ),
      ),
      teacher_guidance: stringField(section, "teacher_guidance", 3_000),
      student_task: stringField(section, "student_task", 3_000),
      examples: (Array.isArray(section.examples) ? section.examples : [])
        .filter(isRecord)
        .slice(0, 12)
        .map((example) => ({
          english: stringField(example, "english", 800),
          portuguese: request.bilingual
            ? stringField(example, "portuguese", 800)
            : "",
        })),
    }))
    .filter((section) => section.title);

  if (!sections.length) throw new Error("invalid_model_output");

  if (request.taskMode === "lesson_plan") {
    const total = sections.reduce((sum, section) => sum + section.minutes, 0);
    if (total < request.durationMinutes) {
      const lastSection = sections[sections.length - 1];
      lastSection.minutes += request.durationMinutes - total;
    } else if (total > request.durationMinutes) {
      let minutesToRemove = total - request.durationMinutes;
      for (let index = sections.length - 1; index >= 0; index -= 1) {
        const removable = Math.min(
          sections[index].minutes,
          minutesToRemove,
        );
        sections[index].minutes -= removable;
        minutesToRemove -= removable;
        if (minutesToRemove === 0) break;
      }
    }
  }

  const rawMemory = isRecord(value.student_memory_update)
    ? value.student_memory_update
    : {};
  const confidence = rawMemory.confidence_level;

  const result: PlannerResult = {
    task_mode: request.taskMode,
    title: stringField(value, "title", 300),
    objective: stringField(value, "objective", 2_000),
    level: stringField(value, "level", 50),
    duration_minutes: request.durationMinutes,
    bilingual: request.bilingual,
    overview: stringField(value, "overview", 3_000),
    sections,
    vocabulary: (Array.isArray(value.vocabulary) ? value.vocabulary : [])
      .filter(isRecord)
      .slice(0, 20)
      .map((item) => ({
        item: stringField(item, "item", 200),
        meaning_pt: stringField(item, "meaning_pt", 600),
        example_en: stringField(item, "example_en", 800),
        use_question_en: stringField(item, "use_question_en", 800),
      })),
    teacher_questions:
      (Array.isArray(value.teacher_questions) ? value.teacher_questions : [])
        .filter(isRecord)
        .slice(0, 20)
        .map((item) => ({
          question_en: stringField(item, "question_en", 800),
          model_answer_en: stringField(item, "model_answer_en", 1_200),
          translation_pt: request.bilingual
            ? stringField(item, "translation_pt", 1_200)
            : "",
        })),
    expected_corrections:
      (Array.isArray(value.expected_corrections)
        ? value.expected_corrections
        : [])
        .filter(isRecord)
        .slice(0, 3)
        .map((item) => ({
          focus: stringField(item, "focus", 300),
          produced_or_likely_error: stringField(
            item,
            "produced_or_likely_error",
            800,
          ),
          minimal_correction: stringField(item, "minimal_correction", 800),
          natural_version: stringField(item, "natural_version", 800),
          advanced_version: stringField(item, "advanced_version", 800),
          explanation_pt: stringField(item, "explanation_pt", 1_200),
          micropractice: stringArrayField(item, "micropractice", 4),
        })),
    homework: stringField(value, "homework", 2_000),
    materials: (Array.isArray(value.materials) ? value.materials : [])
      .filter(isRecord)
      .slice(0, 12)
      .map((item) => ({
        title: stringField(item, "title", 300),
        usage: stringField(item, "usage", 800),
      })),
    assessment_criteria:
      (Array.isArray(value.assessment_criteria)
        ? value.assessment_criteria
        : [])
        .filter(isRecord)
        .slice(0, 12)
        .map((item) => ({
          criterion: stringField(item, "criterion", 300),
          what_to_observe: stringField(item, "what_to_observe", 1_000),
          rating_guide: stringField(item, "rating_guide", 1_000),
        })),
    strengths: stringArrayField(value, "strengths", 12),
    priorities: stringArrayField(value, "priorities", 12),
    next_steps: stringArrayField(value, "next_steps", 12),
    student_memory_update: {
      lesson_objective: stringField(rawMemory, "lesson_objective", 1_500),
      content_practiced: stringArrayField(rawMemory, "content_practiced"),
      new_vocabulary: stringArrayField(rawMemory, "new_vocabulary"),
      recurring_errors: stringArrayField(rawMemory, "recurring_errors"),
      corrections_mastered: stringArrayField(rawMemory, "corrections_mastered"),
      strengths_observed: stringArrayField(rawMemory, "strengths_observed"),
      homework_assigned: stringField(rawMemory, "homework_assigned", 1_500),
      recommended_next_step: stringField(
        rawMemory,
        "recommended_next_step",
        1_500,
      ),
      confidence_level: confidence === "HIGH" || confidence === "MEDIUM"
        ? confidence
        : "LOW",
      notes_to_verify: stringArrayField(rawMemory, "notes_to_verify"),
    },
    ai_memory_reflection: stringField(
      value,
      "ai_memory_reflection",
      1_500,
    ),
    warnings: stringArrayField(value, "warnings", 10),
  };

  if (!result.title || !result.objective) {
    throw new Error("invalid_model_output");
  }
  if (NON_OBSERVATIONAL_TASK_MODES.includes(request.taskMode)) {
    result.student_memory_update = {
      lesson_objective: "",
      content_practiced: [],
      new_vocabulary: [],
      recurring_errors: [],
      corrections_mastered: [],
      strengths_observed: [],
      homework_assigned: "",
      recommended_next_step: "",
      confidence_level: "LOW",
      notes_to_verify: result.student_memory_update.notes_to_verify,
    };
  }
  return result;
}

export function renderLegacyContent(result: PlannerResult): string {
  return result.sections.map((section) => {
    const examples = section.examples
      .map((example) =>
        example.portuguese
          ? `• ${example.english}\n  ${example.portuguese}`
          : `• ${example.english}`
      )
      .join("\n");
    return [
      `${section.title} (${section.minutes} min)`,
      `Professor: ${section.teacher_guidance}`,
      `Aluno: ${section.student_task}`,
      examples,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

export function memoryHasContent(memory: StudentMemoryUpdate): boolean {
  return Boolean(
    memory.lesson_objective ||
      memory.content_practiced.length ||
      memory.new_vocabulary.length ||
      memory.recurring_errors.length ||
      memory.corrections_mastered.length ||
      memory.strengths_observed.length ||
      memory.homework_assigned ||
      memory.recommended_next_step ||
      memory.notes_to_verify.length,
  );
}

export async function safetyIdentifier(
  tenantId: string,
  userId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${tenantId}:${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `wwp_${hex.slice(0, 32)}`;
}
