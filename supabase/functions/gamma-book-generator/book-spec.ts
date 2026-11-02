export const BOOK_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type BookLevel = typeof BOOK_LEVELS[number];
export type BookAudience = "kids" | "teens" | "adults";
export type BookLanguage = "bilingual" | "english";

export interface SchoolBookSpec {
  title: string;
  level: BookLevel;
  niche: string;
  audience: BookAudience;
  language: BookLanguage;
  pageCount: number;
  objective: string;
  topics: string[];
}

export type BookSpecParse =
  | { ok: true; spec: SchoolBookSpec }
  | { ok: false; code: string };

type JsonObject = Record<string, unknown>;

const DEFAULT_TOPICS: Record<BookLevel, string[]> = {
  A1: [
    "Introductions",
    "Daily routines",
    "Family and friends",
    "Food and drinks",
    "Around town",
    "Free time",
    "Shopping",
    "Travel basics",
    "Plans",
  ],
  A2: [
    "Life experiences",
    "Work and study",
    "Travel stories",
    "Health and habits",
    "Technology",
    "Food and culture",
    "City life",
    "Relationships",
    "Future plans",
  ],
  B1: [
    "Identity and life stories",
    "Work and collaboration",
    "Travel and problem-solving",
    "Technology in daily life",
    "Health and well-being",
    "Culture and media",
    "Sustainability",
    "Relationships and communication",
    "Goals and decisions",
  ],
  B2: [
    "Professional communication",
    "Innovation",
    "Global challenges",
    "Media literacy",
    "Leadership",
    "Culture and identity",
    "Science and ethics",
    "Negotiation",
    "Future scenarios",
  ],
  C1: [
    "Strategic communication",
    "Social change",
    "Complex decision-making",
    "Research and evidence",
    "Leadership and influence",
    "Culture and discourse",
    "Ethics",
    "Innovation",
    "Global perspectives",
  ],
  C2: [
    "Nuance and rhetoric",
    "Intercultural discourse",
    "Critical analysis",
    "Persuasion",
    "Humor and implication",
    "Professional mastery",
    "Literary language",
    "Public debate",
    "Synthesis and reflection",
  ],
};

const LEVEL_GRAMMAR: Record<BookLevel, string> = {
  A1:
    "verb to be, present simple, articles, plurals, there is/are, can, basic prepositions and WH questions",
  A2:
    "past simple, present continuous, going to/will, comparatives, countable and uncountable nouns, should and have to",
  B1:
    "present perfect versus past simple, first conditional, modals of deduction, used to, relative clauses, basic passive voice, common phrasal verbs, too/enough and future arrangements",
  B2:
    "second and third conditionals, reported speech, passive voice, defining and non-defining clauses, wish/if only, past modals and gerund versus infinitive",
  C1:
    "mixed conditionals, inversion, cleft sentences, hedging, discourse markers, register, collocations and nominalisation",
  C2:
    "idiomatic precision, discourse grammar, emphasis, ellipsis, substitution, modality nuance and stylistic control",
};

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

const clean = (value: unknown, max: number): string => {
  if (typeof value !== "string") return "";
  return collapse(value.replace(/[<>{}]/g, " ")).slice(0, max);
};

const readTopics = (value: unknown): string[] => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[\n,;]+/)
    : [];
  const unique = new Set<string>();
  for (const item of raw) {
    const topic = clean(item, 120);
    if (topic.length >= 3) unique.add(topic);
    if (unique.size === 20) break;
  }
  return [...unique];
};

export function parseSchoolBookSpec(body: JsonObject): BookSpecParse {
  const title = clean(body.title, 160);
  if (title.length < 3) return { ok: false, code: "BOOK_TITLE_REQUIRED" };

  const level = typeof body.level === "string"
    ? body.level.trim().toUpperCase()
    : "";
  if (!(BOOK_LEVELS as readonly string[]).includes(level)) {
    return { ok: false, code: "INVALID_BOOK_LEVEL" };
  }

  const audience = typeof body.audience === "string"
    ? body.audience.trim().toLowerCase()
    : "adults";
  if (!["kids", "teens", "adults"].includes(audience)) {
    return { ok: false, code: "INVALID_BOOK_AUDIENCE" };
  }

  const language = typeof body.language === "string"
    ? body.language.trim().toLowerCase()
    : "bilingual";
  if (!["bilingual", "english"].includes(language)) {
    return { ok: false, code: "INVALID_BOOK_LANGUAGE" };
  }

  const pageCount = Number(body.pageCount ?? body.page_count ?? 60);
  if (!Number.isInteger(pageCount) || pageCount < 12 || pageCount > 60) {
    return { ok: false, code: "INVALID_BOOK_PAGE_COUNT" };
  }

  const objective = clean(body.objective, 1200);
  if (objective.length < 3) {
    return { ok: false, code: "BOOK_OBJECTIVE_REQUIRED" };
  }

  const niche = clean(body.niche, 80).toUpperCase() || "GENERAL";
  if (!/^[A-Z0-9_-]{2,80}$/.test(niche)) {
    return { ok: false, code: "INVALID_BOOK_NICHE" };
  }

  return {
    ok: true,
    spec: {
      title,
      level: level as BookLevel,
      niche,
      audience: audience as BookAudience,
      language: language as BookLanguage,
      pageCount,
      objective,
      topics: readTopics(body.topics),
    },
  };
}

const audienceLabel = (audience: BookAudience): string =>
  ({
    kids: "children; playful, safe, short and highly scaffolded tasks",
    teens:
      "teenagers; contemporary school, friendship, media and exchange contexts",
    adults: "adults; practical personal and professional situations",
  })[audience];

const page = (number: number, title: string, brief: string) =>
  `# Page ${number} — ${title}\n${brief}`;

export function buildSchoolBookInput(spec: SchoolBookSpec): string {
  const topics = spec.topics.length ? spec.topics : DEFAULT_TOPICS[spec.level];
  const pages: string[] = [
    page(
      1,
      spec.title,
      `Design a polished cover. Include “CEFR ${spec.level}”, the audience, and a short promise connected to this objective: ${spec.objective}. Do not add exercises on the cover.`,
    ),
    page(
      2,
      "Welcome and how to use this book",
      "Explain the learning routine, symbols, self-study flow and how speaking, vocabulary, grammar, reading, listening and writing work together.",
    ),
    page(
      3,
      `${spec.level} learning map`,
      `Show practical can-do outcomes, the progression across the book and the core grammar range: ${
        LEVEL_GRAMMAR[spec.level]
      }.`,
    ),
  ];

  const reviewPageCount = spec.pageCount >= 36 ? 2 : 1;
  const projectPageCount = spec.pageCount >= 48 ? 2 : 1;
  const answerPageCount = spec.pageCount >= 48
    ? 5
    : spec.pageCount >= 30
    ? 3
    : spec.pageCount >= 18
    ? 2
    : 1;
  const contentPageCount = spec.pageCount - 3 - reviewPageCount -
    projectPageCount - answerPageCount;
  const unitPageTypes = [
    [
      "Unit opener",
      "Introduce the real-life situation, clear can-do goals, a visual warm-up and three activating questions.",
    ],
    [
      "Vocabulary in context",
      "Teach 10–14 useful words or chunks with meaning from context, pronunciation support, examples and a short retrieval activity.",
    ],
    [
      "Grammar for communication",
      `Teach one useful ${spec.level} grammar point from this range: ${
        LEVEL_GRAMMAR[spec.level]
      }. Include a discovery example, concise explanation, form, meaning, use, common errors and controlled practice.`,
    ],
    [
      "Reading and listening",
      "Create an original level-appropriate reading plus a clearly labelled listening script. Include gist, detail and inference tasks. Never claim an audio file or QR code exists.",
    ],
    [
      "Practice lab",
      "Mix controlled and guided practice with 8–12 answerable items. Include at least one personalization step and keep every instruction unambiguous.",
    ],
    [
      "Speak and write",
      "End the unit with a realistic speaking task, a short writing task, useful language, success criteria and a self-check.",
    ],
  ] as const;

  const completeUnitCount = Math.max(1, Math.floor(contentPageCount / 6));
  const completeUnitPages = completeUnitCount * 6;
  for (let index = 0; index < completeUnitPages; index += 1) {
    const pageNumber = pages.length + 1;
    const unitIndex = Math.floor(index / unitPageTypes.length);
    const pageType = unitPageTypes[index % unitPageTypes.length];
    const baseTopic = topics[unitIndex % topics.length];
    const cycle = Math.floor(unitIndex / topics.length) + 1;
    const topic = cycle > 1 ? `${baseTopic} — extension ${cycle}` : baseTopic;
    pages.push(page(
      pageNumber,
      `Unit ${unitIndex + 1}: ${topic} — ${pageType[0]}`,
      `${
        pageType[1]
      } Keep the context aligned with the book objective: ${spec.objective}.`,
    ));
  }

  const supplementalPages = [
    [
      "Pronunciation clinic",
      "Recycle the most useful language from prior units through stress, rhythm, connected speech and a short speak-record-improve routine.",
    ],
    [
      "Vocabulary recycling lab",
      "Create retrieval, categorisation and collocation tasks that deliberately connect vocabulary from several units.",
    ],
    [
      "Culture and communication strategy",
      "Use an original intercultural scenario to practise politeness, clarification, turn-taking and repair strategies without stereotypes.",
    ],
    [
      "Progress checkpoint",
      "Create a compact can-do checkpoint with balanced vocabulary, grammar, reading, listening-script and speaking evidence.",
    ],
    [
      "Fluency lab",
      "Create timed, repeated speaking tasks with useful language, increasing challenge and a practical self-assessment scale.",
    ],
  ] as const;
  for (let index = completeUnitPages; index < contentPageCount; index += 1) {
    const supplemental =
      supplementalPages[(index - completeUnitPages) % supplementalPages.length];
    pages.push(page(
      pages.length + 1,
      supplemental[0],
      `${
        supplemental[1]
      } Keep the work at CEFR ${spec.level} and aligned with this objective: ${spec.objective}.`,
    ));
  }

  for (let index = 0; index < reviewPageCount; index += 1) {
    pages.push(page(
      pages.length + 1,
      reviewPageCount === 1
        ? "Cumulative review"
        : `Cumulative review — part ${index + 1}`,
      index === 0
        ? "Create a balanced review of vocabulary, grammar, reading and functional language from every unit. Use varied task types and provide enough context for one unequivocal answer."
        : "Continue the cumulative review with integrated listening-script, mediation, speaking and short writing tasks. Do not repeat items from the prior review page.",
    ));
  }
  const answerableEndPage = pages.length;

  for (let index = 0; index < projectPageCount; index += 1) {
    pages.push(page(
      pages.length + 1,
      projectPageCount === 1
        ? "Final real-world project"
        : index === 0
        ? "Final real-world project — brief and planning"
        : "Final real-world project — production and assessment",
      index === 0
        ? `Create a meaningful project that proves the learner can achieve this objective: ${spec.objective}. Include the scenario, stages, deliverables, collaboration options and planning support.`
        : "Provide production support, useful language, a clear analytic rubric, peer-feedback protocol and individual reflection prompts for the final project.",
    ));
  }

  const answerablePageCount = Math.max(1, answerableEndPage - 3);
  for (let index = 0; index < answerPageCount; index += 1) {
    const rangeStart = 4 +
      Math.floor(index * answerablePageCount / answerPageCount);
    const rangeEnd = 3 +
      Math.floor((index + 1) * answerablePageCount / answerPageCount);
    pages.push(page(
      pages.length + 1,
      answerPageCount === 1
        ? "Answer key and model answers"
        : `Answer key — pages ${rangeStart}–${rangeEnd}`,
      `Provide an accurate, compact answer key for every closed exercise on pages ${rangeStart}–${rangeEnd}. Add short model answers or criteria where needed. Verify every answer against its exact question and do not key pages outside this range.`,
    ));
  }

  return pages.join("\n---\n");
}

export function buildSchoolBookInstructions(spec: SchoolBookSpec): string {
  const languageRule = spec.language === "bilingual"
    ? "Write learning texts, examples and target language in natural English. Write explanations and task instructions in Brazilian Portuguese when that improves clarity. Never translate away the English practice."
    : "Write the complete book in natural English, including explanations and task instructions.";
  return [
    `Create exactly ${spec.pageCount} A4 cards, one card for each numbered section in inputText.`,
    "Never merge, remove, add or reorder cards. Keep each card printable with comfortable margins and no overflow.",
    `This is a rigorous CEFR ${spec.level} English coursebook for ${
      audienceLabel(spec.audience)
    }.`,
    languageRule,
    "Use original content only. Do not reproduce copyrighted textbook passages, logos or proprietary characters.",
    "Prefer communicative, realistic tasks over generic filler. Build progression and recycle prior vocabulary across units.",
    "All multiple-choice and gap-fill activities must have one defensible answer. The answer-key cards must match the exercises exactly and may never invent missing questions.",
    "Use tables, callouts and visual hierarchy where useful. Never invent external links, audio files, QR codes, citations or research claims.",
  ].join(" ");
}

export function schoolBookAudience(spec: SchoolBookSpec): string {
  return `${spec.level} English learners; ${audienceLabel(spec.audience)}`;
}
