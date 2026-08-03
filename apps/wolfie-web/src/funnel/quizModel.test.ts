import { describe, expect, it } from "vitest";
import { getExperienceById } from "../../../../src/components/wolfie/experienceCatalog";
import {
  PUBLIC_QUIZ_STEPS,
  PUBLIC_QUIZ_VERSION,
  answerQuizStep,
  createQuizSnapshot,
  isQuizComplete,
  isQuizGoal,
  parseQuizSnapshot,
  recommendQuizExperience,
  resolveQuizStart,
  sanitizeQuizAnswers,
  serializeQuizSnapshot,
  type CompleteQuizAnswers,
} from "./quizModel";

const baseAnswers: CompleteQuizAnswers = {
  goal: "conversation",
  context: "general",
  participation: "respond",
  declaredAbility: "routine_conversations",
  obstacle: "thinking_time",
  modality: "mixed",
  urgency: "next_30_days",
  practiceMinutes: "10",
};

describe("modelo do quiz público do Wolfie", () => {
  it("aceita somente objetivos enumerados para pré-preencher o diagnóstico", () => {
    expect(isQuizGoal("global_meeting")).toBe(true);
    expect(isQuizGoal("conversation")).toBe(true);
    expect(isQuizGoal("qualquer_coisa")).toBe(false);
    expect(isQuizGoal(null)).toBe(false);
  });

  it("resolve URL, snapshot e etapa inicial sem executar efeitos colaterais", () => {
    const existing = serializeQuizSnapshot(createQuizSnapshot({ goal: "travel" }));
    const prefilled = resolveQuizStart(
      "?novo=1&objetivo=interview&utm_source=cenario",
      existing,
    );

    expect(prefilled.shouldStartNew).toBe(true);
    expect(prefilled.cleanSearch).toBe("utm_source=cenario");
    expect(prefilled.snapshot.answers).toEqual({ goal: "interview" });
    expect(prefilled.snapshot.currentStep).toBe("context");

    const invalid = resolveQuizStart("?novo=1&objetivo=inventado", existing);
    expect(invalid.snapshot.answers).toEqual({});
    expect(invalid.snapshot.currentStep).toBe("goal");
    expect(invalid.cleanSearch).toBe("");
  });

  it("preserva snapshot válido e sinaliza somente storage inválido para limpeza", () => {
    const existing = serializeQuizSnapshot(createQuizSnapshot({ goal: "travel" }));
    const resumed = resolveQuizStart("", existing);
    const malformed = resolveQuizStart("", "conteúdo inválido");

    expect(resumed.snapshot.answers).toEqual({ goal: "travel" });
    expect(resumed.shouldRemoveStoredSnapshot).toBe(false);
    expect(malformed.snapshot.answers).toEqual({});
    expect(malformed.shouldRemoveStoredSnapshot).toBe(true);
  });

  it("mantém um fluxo curto de oito etapas, com respostas fechadas e texto pt-BR", () => {
    expect(PUBLIC_QUIZ_STEPS).toHaveLength(8);
    expect(PUBLIC_QUIZ_STEPS.map((step) => step.id)).toEqual([
      "goal",
      "context",
      "participation",
      "declaredAbility",
      "obstacle",
      "modality",
      "urgency",
      "practiceMinutes",
    ]);
    expect(PUBLIC_QUIZ_STEPS.every((step) => step.options.length >= 3)).toBe(
      true,
    );
    expect(PUBLIC_QUIZ_STEPS[3].supportingText).toContain(
      "não um teste de nível",
    );
    expect(JSON.stringify(PUBLIC_QUIZ_STEPS).toLowerCase()).not.toContain(
      "sexo",
    );
  });

  it("atualiza respostas de forma imutável e só considera completas as oito etapas", () => {
    const initial = { goal: "travel" as const };
    const next = answerQuizStep(initial, "context", "tourism");

    expect(initial).toEqual({ goal: "travel" });
    expect(next).toEqual({ goal: "travel", context: "tourism" });
    expect(isQuizComplete(next)).toBe(false);
    expect(isQuizComplete(baseAnswers)).toBe(true);
    expect(() =>
      answerQuizStep(baseAnswers, "urgency", "amanhã" as never),
    ).toThrow(/Resposta inválida/);
  });

  it.each([
    {
      name: "reunião global de tecnologia",
      answers: {
        ...baseAnswers,
        goal: "global_meeting" as const,
        context: "technology" as const,
        participation: "lead" as const,
      },
      expectedId: "meetings-technology",
    },
    {
      name: "entrevista",
      answers: { ...baseAnswers, goal: "interview" as const },
      expectedId: "job-interviews",
    },
    {
      name: "apresentação",
      answers: {
        ...baseAnswers,
        goal: "presentation" as const,
        participation: "present" as const,
      },
      expectedId: "presentation-lab",
    },
    {
      name: "viagem",
      answers: { ...baseAnswers, goal: "travel" as const },
      expectedId: "services",
    },
    {
      name: "conversação",
      answers: { ...baseAnswers, goal: "conversation" as const },
      expectedId: "give-your-opinion",
    },
  ])("recomenda de forma determinística para $name", ({ answers, expectedId }) => {
    const first = recommendQuizExperience(answers);
    const second = recommendQuizExperience({ ...answers });

    expect(first).toEqual(second);
    expect(first.primary.experienceId).toBe(expectedId);
    expect(first.primary.matchScore).toBeGreaterThanOrEqual(0);
    expect(first.primary.matchScore).toBeLessThanOrEqual(100);
    expect(first.alternatives).toHaveLength(2);
    expect([first.primary, ...first.alternatives].map((item) => item.matchScore))
      .toEqual(
        [first.primary, ...first.alternatives]
          .map((item) => item.matchScore)
          .sort((left, right) => right - left),
      );
    expect(
      [first.primary, ...first.alternatives].every((item) =>
        Boolean(getExperienceById(item.experienceId)),
      ),
    ).toBe(true);
    expect(first.disclaimer).toContain("não é teste de proficiência");
  });

  it("usa o contexto para escolher o cenário canônico da reunião global", () => {
    const contexts = {
      business: "meetings-business",
      technology: "meetings-technology",
      health: "meetings-medicine",
      laboratory: "meetings-laboratories",
      beauty: "meetings-beauty",
      retail: "meetings-retail",
      logistics: "meetings-logistics",
      tourism: "meetings-tourism",
      aviation: "meetings-aviation",
      general: "meetings-business",
    } as const;

    for (const [context, expectedId] of Object.entries(contexts)) {
      const recommendation = recommendQuizExperience({
        ...baseAnswers,
        goal: "global_meeting",
        context: context as keyof typeof contexts,
      });
      expect(recommendation.primary.experienceId).toBe(expectedId);
    }
  });

  it("mapeia somente o nível autodeclarado e a rotina escolhida", () => {
    const recommendation = recommendQuizExperience({
      ...baseAnswers,
      declaredAbility: "short_exchanges",
      urgency: "next_7_days",
      practiceMinutes: "5",
      obstacle: "listening",
    });

    expect(recommendation.startingLevel).toBe("A2");
    expect(recommendation.practicePlan).toEqual({
      minutesPerSession: 5,
      sessionsPerWeek: 5,
      focus: "identificar a mensagem principal e confirmar entendimento",
    });
  });

  it("persiste apenas a versão, etapa e respostas enumeradas, descartando PII e campos desconhecidos", () => {
    const raw = JSON.stringify({
      version: PUBLIC_QUIZ_VERSION,
      currentStep: "obstacle",
      expiresAt: Date.now() + 60_000,
      answers: {
        goal: "interview",
        context: "business",
        email: "pessoa@exemplo.com",
        name: "Pessoa de Teste",
        phone: "+55 11 99999-9999",
        urgency: "um dia inventado",
      },
      utm_email: "pessoa@exemplo.com",
    });

    expect(parseQuizSnapshot(raw)).toMatchObject({
      version: PUBLIC_QUIZ_VERSION,
      currentStep: "obstacle",
      answers: { goal: "interview", context: "business" },
    });
    expect(sanitizeQuizAnswers({ email: "pessoa@exemplo.com" })).toEqual({});
  });

  it("faz round-trip do snapshot e rejeita conteúdo malformado ou de outra versão", () => {
    const snapshot = createQuizSnapshot(baseAnswers, "practiceMinutes");
    expect(parseQuizSnapshot(serializeQuizSnapshot(snapshot))).toEqual(snapshot);
    expect(parseQuizSnapshot("não é json")).toBeNull();
    expect(
      parseQuizSnapshot(JSON.stringify({ version: 999, answers: baseAnswers })),
    ).toBeNull();
    expect(parseQuizSnapshot(JSON.stringify({
      ...snapshot,
      expiresAt: Date.now() - 1,
    }))).toBeNull();
  });

  it("não gera resultado com respostas incompletas", () => {
    expect(() => recommendQuizExperience({ goal: "travel" })).toThrow(
      /Complete as oito etapas/,
    );
  });
});
