/// <reference lib="deno.ns" />

import {
  agreementViolations,
  auditQuestionKey,
  explanationContradiction,
  fillBlanks,
} from "./answer-key-audit.ts";
import {
  type ActivityLevel,
  type ActivitySubject,
  buildContextualFallback,
} from "./personalization.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ??
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────
// Caso reportado em produção (print da aluna)
// ─────────────────────────────────────────────────────────────

const REPORTED_PROMPT =
  'Complete the dialogue between two students: Ana: "Hi! My name _____ Ana. ' +
  'I _____ sports." João: "Nice to meet you! I _____ from Curitiba."';

const REPORTED_OPTIONS = [
  "is / like / am",
  "am / am / like",
  "is / am / like",
  "am / like / am",
];

const REPORTED_EXPLANATION =
  "'My name is' usa 'is', mas 'I like' e 'I am' usam 'am'. " +
  "Cuidado: 'My name' é singular, mas o pronome 'I' sempre usa 'am'.";

Deno.test("rejeita o gabarito que produz 'My name am Ana'", () => {
  const verdict = auditQuestionKey({
    prompt: REPORTED_PROMPT,
    options: REPORTED_OPTIONS,
    correctIndex: 3, // "am / like / am" — o que a plataforma marcou como certo
    explanationPt: REPORTED_EXPLANATION,
  });
  assertEquals(verdict.status, "rejected");
  assertEquals(verdict.code, "KEY_FAILS_AGREEMENT");
});

Deno.test("aceita o gabarito gramaticalmente correto do mesmo enunciado", () => {
  const verdict = auditQuestionKey({
    prompt: REPORTED_PROMPT,
    options: REPORTED_OPTIONS,
    correctIndex: 0, // "is / like / am"
    explanationPt: REPORTED_EXPLANATION,
  });
  assertEquals(verdict.status, "ok");
});

Deno.test("a explicação sozinha já denuncia o gabarito incoerente", () => {
  const contradiction = explanationContradiction(
    "Hi! My name am Ana. I like sports.",
    REPORTED_EXPLANATION,
  );
  assert(contradiction, "esperava contradição entre explicação e gabarito");
  assert(
    contradiction.includes("name is"),
    `detalhe inesperado: ${contradiction}`,
  );
});

// ─────────────────────────────────────────────────────────────
// Concordância de classe fechada
// ─────────────────────────────────────────────────────────────

Deno.test("flagra 'am' sem o pronome I e concordância pronominal quebrada", () => {
  assertEquals(agreementViolations("My name am Ana.").length, 1);
  assertEquals(agreementViolations("I is from Curitiba.").length, 1);
  assertEquals(agreementViolations("He are ready.").length, 1);
  assertEquals(agreementViolations("They is late.").length, 1);
  assertEquals(agreementViolations("She have two meetings.").length, 1);
  assertEquals(agreementViolations("I does not agree.").length, 1);
  assertEquals(agreementViolations("You was there.").length, 1);
});

Deno.test("não acusa construções corretas nem ambíguas", () => {
  const clean = [
    "My name is Ana.",
    "I am from Curitiba.",
    "I like sports.",
    "We are having a client call right now.",
    "There are two open tasks on the list.",
    "Could you help me with this file, please?",
    "Are you from Brazil?",
    "Why am I here?",
    "Does he have a minute?",
    "Did they have lunch already?",
    "She should have called the client.",
    "If I were you, I would call now.",
    "Ana and I are colleagues.",
    "The meeting starts at 9 am sharp.",
    "The analyst who presented the forecast will join us later.",
    "She checks the daily report every morning.",
    "I really am interested in this role.",
    "He doesn't have the file yet.",
  ];
  for (const sentence of clean) {
    assertEquals(
      agreementViolations(sentence),
      [],
      `falso positivo em: ${sentence}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────
// Montagem das lacunas
// ─────────────────────────────────────────────────────────────

Deno.test("preenche lacuna única e sequência com o mesmo número de lacunas", () => {
  assertEquals(
    fillBlanks("She ___ the daily report every morning.", "checks"),
    "She checks the daily report every morning.",
  );
  assertEquals(
    fillBlanks("My name ___ Ana. I ___ sports.", "is / like"),
    "My name is Ana. I like sports.",
  );
});

Deno.test("não arrisca mapeamento quando a sequência não bate", () => {
  assertEquals(fillBlanks("My name ___ Ana. I ___ sports.", "is"), null);
  assertEquals(fillBlanks("Sem lacuna aqui.", "is"), null);
});

// ─────────────────────────────────────────────────────────────
// Fronteiras do veto: só rejeita com prova
// ─────────────────────────────────────────────────────────────

Deno.test("mantém questões cuja correção não é decidível sem modelo", () => {
  const verdict = auditQuestionKey({
    prompt: "They ___ the proposal yesterday.",
    options: ["approved", "approve", "are approving", "approves"],
    correctIndex: 0,
    explanationPt: "Yesterday pede passado simples: approved.",
  });
  assertEquals(verdict.status, "ok");
});

Deno.test("rejeita quando nenhuma alternativa fecha a concordância", () => {
  const verdict = auditQuestionKey({
    prompt: "My name ___ Ana.",
    options: ["am", "are am", "am am"],
    correctIndex: 0,
  });
  assertEquals(verdict.status, "rejected");
  assertEquals(verdict.code, "NO_VALID_OPTION");
});

Deno.test("não confunde contraexemplo citado na explicação com gabarito", () => {
  const verdict = auditQuestionKey({
    prompt: "He ___ two meetings today.",
    options: ["has", "have", "having", "is have"],
    correctIndex: 0,
    explanationPt: "Com he usamos 'has'; nunca diga 'he have'.",
  });
  assertEquals(verdict.status, "ok");
});

// ─────────────────────────────────────────────────────────────
// O banco curado é a rede de segurança: se a auditoria reprovar ele,
// `normalizeGeneratedActivity` cai de novo no fallback e recursiona.
// ─────────────────────────────────────────────────────────────

Deno.test("nenhuma questão do banco curado é reprovada pela auditoria", () => {
  const subjects: ActivitySubject[] = [
    "vocabulary",
    "grammar",
    "listening",
    "reading",
  ];
  const levels: ActivityLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
  let audited = 0;

  for (const subject of subjects) {
    for (const level of levels) {
      const fallback = buildContextualFallback(subject, level, null);
      const questions = Array.isArray(fallback.questions)
        ? fallback.questions
        : [];
      assert(
        questions.length >= 6,
        `${subject}/${level}: banco curado com menos de 6 questões`,
      );
      for (const raw of questions) {
        const question = raw as Record<string, unknown>;
        const verdict = auditQuestionKey({
          prompt: String(question.prompt ?? ""),
          options: (question.options as string[]) ?? [],
          correctIndex: Number(question.correctIndex),
          explanationPt: String(question.explanationPt ?? ""),
        });
        assertEquals(
          verdict.status === "rejected",
          false,
          `${subject}/${level} — "${question.prompt}" reprovada: ${verdict.detail}`,
        );
        audited += 1;
      }
    }
  }
  assert(audited >= 24, `esperava auditar o banco inteiro, auditei ${audited}`);
});

Deno.test("índice fora de faixa vira unknown, não rejeição", () => {
  assertEquals(
    auditQuestionKey({
      prompt: "My name ___ Ana.",
      options: ["is", "am"],
      correctIndex: 7,
    }).status,
    "unknown",
  );
});
