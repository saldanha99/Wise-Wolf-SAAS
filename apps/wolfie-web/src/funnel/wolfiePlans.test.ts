import { describe, expect, it } from "vitest";
import {
  recommendQuizExperience,
  type CompleteQuizAnswers,
} from "./quizModel";
import {
  DEFAULT_WOLFIE_PLAN_CODE,
  WOLFIE_STANDALONE_PLANS,
  recommendWolfiePlanCode,
  resolveWolfiePlan,
  toWolfieCheckoutPlanCode,
  wolfieSubscribeHref,
} from "./wolfiePlans";

const answers: CompleteQuizAnswers = {
  goal: "global_meeting",
  context: "technology",
  participation: "lead",
  declaredAbility: "routine_conversations",
  obstacle: "thinking_time",
  modality: "voice",
  urgency: "ongoing",
  practiceMinutes: "10",
};

describe("catálogo de assinaturas independentes do Wolfie", () => {
  it("mantém os três planos mensais e seus valores comerciais", () => {
    expect(WOLFIE_STANDALONE_PLANS.map((plan) => ({
      code: plan.code,
      price: plan.monthlyPrice,
      minutes: plan.liveMinutes,
    }))).toEqual([
      { code: "FOCO", price: 49.9, minutes: 45 },
      { code: "RITMO", price: 99.9, minutes: 120 },
      { code: "PERFORMANCE", price: 179.9, minutes: 240 },
    ]);
  });

  it("normaliza código vindo da URL e usa Ritmo como fallback seguro", () => {
    expect(resolveWolfiePlan(" performance ").code).toBe("PERFORMANCE");
    expect(resolveWolfiePlan("plano-inexistente").code).toBe(
      DEFAULT_WOLFIE_PLAN_CODE,
    );
    expect(wolfieSubscribeHref("FOCO", "quiz_result")).toBe(
      "/assinar?planCode=FOCO&source=quiz_result",
    );
  });

  it("mapeia o código amigável para o código canônico do checkout", () => {
    expect(WOLFIE_STANDALONE_PLANS.map((plan) =>
      toWolfieCheckoutPlanCode(plan.code),
    )).toEqual([
      "WOLFIE_FOCO",
      "WOLFIE_RITMO",
      "WOLFIE_PERFORMANCE",
    ]);
  });

  it.each([
    {
      expected: "FOCO",
      input: {
        ...answers,
        modality: "text" as const,
        urgency: "ongoing" as const,
        practiceMinutes: "5" as const,
      },
    },
    {
      expected: "RITMO",
      input: answers,
    },
    {
      expected: "PERFORMANCE",
      input: {
        ...answers,
        modality: "voice" as const,
        urgency: "next_7_days" as const,
        practiceMinutes: "15" as const,
      },
    },
  ])("recomenda $expected pelo volume mensal estimado", ({ input, expected }) => {
    expect(recommendWolfiePlanCode(input, recommendQuizExperience(input)))
      .toBe(expected);
  });
});
