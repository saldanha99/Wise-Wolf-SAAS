/// <reference lib="deno.ns" />
// Trilha da aula: regras puras, sem banco e sem IA.
import {
  addDays,
  buildLessonInput,
  buildReviewItems,
  checkDeterministic,
  checkReviewItem,
  ContentError,
  itemOrder,
  normalizeAnswer,
  normalizeTrackContent,
  publicTrack,
  reviewUnlocked,
  roleplayBrief,
  trackScore,
} from "./core.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function assertEquals(actual: unknown, expected: unknown, message = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message} expected ${e}, got ${a}`);
}

const learner = {
  firstName: "Ana",
  level: "A2",
  goal: "reuniões em inglês no trabalho",
  occupation: "analista de TI",
  routine: ["daily às 9h"],
  interests: ["academia"],
  isKids: false,
};

const log = {
  id: "11111111-1111-4111-8111-111111111111",
  class_date: "2026-11-20",
  content: null,
  content_covered: "Simple Past verbs (drank, saw, went)\nTravel vocabulary",
  lesson_objective: "Relatar uma viagem no passado simples",
  student_difficulties:
    "Disse 'Yesterday I go to the beach'; Possível uso de ago (a confirmar)",
  recommended_next_step: "Perguntas no passado",
  homework_assigned: null,
  lesson_session_id: null,
};

function sampleRaw() {
  return {
    topic: "Passado simples",
    topic_en: "Past simple",
    grammar: {
      explanation_pt: "Usamos o passado simples para ações terminadas.",
      pattern: "Subject + verb-ed / irregular",
      examples: [{ en: "I went to the daily.", pt: "Eu fui à daily." }],
    },
    warmup: [1, 2, 3, 4, 5, 6].map((n) => ({
      id: `w${n}`,
      pt: `palavra ${n}`,
      en: `word ${n}`,
      accepted: [`word ${n}`],
    })),
    mistakes: [{
      id: "m1",
      said: "Yesterday I go to the beach",
      from_class: true,
      hint_pt: "Pense no tempo verbal de 'yesterday'.",
      accepted: ["yesterday i went to the beach"],
      rule_pt: "Yesterday pede passado.",
      native: "I went to the beach yesterday.",
    }],
    practice: [
      {
        kind: "recognize",
        topic: "current",
        prompt: "Yesterday I ___ coffee.",
        options: ["drink", "drank", "drunk"],
        answer_index: 1,
        why_pt: "passado",
      },
      {
        kind: "recognize",
        topic: "previous",
        prompt: "She ___ here now.",
        options: ["is", "was"],
        answer_index: 0,
        why_pt: "agora",
      },
      {
        kind: "complete",
        topic: "current",
        prompt: "I ___ (see) Mark.",
        accepted: ["saw"],
        model_answer: "saw",
        why_pt: "see → saw",
      },
      {
        kind: "complete",
        topic: "current",
        prompt: "We ___ (go) home.",
        accepted: ["went"],
        model_answer: "went",
        why_pt: "go → went",
      },
      {
        kind: "transform",
        topic: "current",
        prompt: "I go to work. (yesterday)",
        accepted: ["i went to work yesterday", "yesterday i went to work"],
        model_answer: "I went to work yesterday",
        why_pt: "passado",
      },
      {
        kind: "transform",
        topic: "previous",
        prompt: "He works. (negative)",
        accepted: ["he doesn't work"],
        model_answer: "He doesn't work",
        why_pt: "negativa",
      },
      {
        kind: "produce",
        topic: "current",
        prompt: "Write about your weekend.",
        model_answer: "I visited my parents.",
        why_pt: "passado",
      },
      {
        kind: "produce",
        topic: "current",
        prompt: "What did you do at the daily?",
        model_answer: "I talked about the deadline.",
        why_pt: "passado",
      },
    ],
    vocabulary: [{
      term: "deadline",
      meaning_pt: "prazo",
      sentence: "The deadline was yesterday.",
    }],
    speaking: {
      question: "Tell me 3 things you did yesterday.",
      target_pt: "passado simples",
    },
    roleplay: {
      title_pt: "Daily das 9h",
      scenario: "Your tech lead asks what you did yesterday.",
      character: "your tech lead Mark",
      opening_line: "Morning! What did you do yesterday?",
      objectives: [
        "Conte 2 coisas no passado",
        "Use deadline",
        "Proponha nova data",
      ],
      closing: "Mark thanks you and ends the call.",
    },
    review_bank: [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      kind: n % 2 ? "recognize" : "complete",
      prompt: `review ${n}`,
      options: ["a", "b"],
      answer_index: 0,
      accepted: ["went"],
      why_pt: "porque",
    })),
  };
}

Deno.test("entrada da aula descarta dúvida e mantém o que o professor confirmou", () => {
  const input = buildLessonInput(log, null, learner, ["Present perfect"]);
  assertEquals(input.difficulties, ["Disse 'Yesterday I go to the beach'"]);
  assert(input.content_practiced.includes("Travel vocabulary"));
  assertEquals(input.previous_topics, ["Present perfect"]);
});

Deno.test("conteúdo normalizado separa gabarito e parte pública", () => {
  const content = normalizeTrackContent(sampleRaw());
  const pub = JSON.stringify(publicTrack(content));
  assert(
    !pub.includes("answer_index") && !pub.includes("accepted") &&
      !pub.includes("keys"),
  );
  assert(!pub.includes("reviewBank"));
  assertEquals(itemOrder(content).length, 6 + 1 + 8 + 1);
});

Deno.test("conteúdo incompleto é recusado", () => {
  const raw = sampleRaw();
  raw.mistakes = [];
  let failed = false;
  try {
    normalizeTrackContent(raw);
  } catch (error) {
    failed = error instanceof ContentError;
  }
  assert(failed);
});

Deno.test("correção sem IA: contrações, pontuação e múltipla escolha", () => {
  const content = normalizeTrackContent(sampleRaw());
  assertEquals(checkDeterministic(content.keys.p1, 1), "correct");
  assertEquals(checkDeterministic(content.keys.p1, 0), "wrong");
  assertEquals(
    checkDeterministic(content.keys.m1, "Yesterday, I went to the beach!"),
    "correct",
  );
  assertEquals(
    checkDeterministic(content.keys.p6, "He does not work."),
    "correct",
  );
  assertEquals(
    checkDeterministic(content.keys.p7, "I visited my mom"),
    "needs_ai",
  );
  assertEquals(checkDeterministic(content.keys.w1, "wrong"), "wrong");
  assertEquals(normalizeAnswer("I’m  here."), "i am here");
});

Deno.test("nota e revisões: D1 traz o que falhou, D3 intercala tema antigo", () => {
  const content = normalizeTrackContent(sampleRaw());
  const progress = {
    w1: { attempts: 2, correct: true, answer: "x", firstTryCorrect: false },
    p1: { attempts: 1, correct: true, answer: "1", firstTryCorrect: true },
  };
  assert(trackScore(content, progress) > 0);
  const d1 = buildReviewItems("D1", content, progress, []);
  assertEquals(d1[0].source, "missed");
  const older = [{
    id: "r1",
    kind: "complete" as const,
    prompt: "old",
    options: [],
    answerIndex: null,
    accepted: ["x"],
    whyPt: "",
    source: "bank",
  }];
  const d3 = buildReviewItems("D3", content, progress, older);
  assert(d3.some((item) => item.source === "older"));
  assert(checkReviewItem(d1[0], "word 1"));
});

Deno.test("D+14 e D+30 só depois de ir bem", () => {
  assert(!reviewUnlocked("D14", { D7: 50 }));
  assert(reviewUnlocked("D14", { D7: 80 }));
  assert(!reviewUnlocked("D30", {}));
  assert(reviewUnlocked("D1", {}));
  assertEquals(addDays("2026-11-30", 1), "2026-12-01");
});

Deno.test("roleplay respeita o limite do realtime e a política de correção", () => {
  const content = normalizeTrackContent(sampleRaw());
  const brief = roleplayBrief(content, learner.goal);
  assert(brief.scenario.length <= 1200);
  assert(brief.scenario.includes("at most once every 3 turns"));
});
