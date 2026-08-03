import type {
  CompleteQuizAnswers,
  QuizRecommendation,
} from "./quizModel";

export const WOLFIE_PLAN_CODES = [
  "FOCO",
  "RITMO",
  "PERFORMANCE",
] as const;

export type WolfiePlanCode = (typeof WOLFIE_PLAN_CODES)[number];
export type WolfieCheckoutPlanCode = `WOLFIE_${WolfiePlanCode}`;

export interface WolfieStandalonePlan {
  code: WolfiePlanCode;
  name: string;
  monthlyPrice: number;
  liveMinutes: number;
  practiceCount: number;
  tagline: string;
  description: string;
  cta: string;
  recommended: boolean;
  image: string;
  imageAlt: string;
  features: readonly string[];
}

/**
 * Catálogo comercial exibido no frontend. O preço cobrado continua vindo do
 * plano cadastrado no servidor; estes valores servem somente para apresentação.
 */
export const WOLFIE_STANDALONE_PLANS: readonly WolfieStandalonePlan[] = [
  {
    code: "FOCO",
    name: "Foco",
    monthlyPrice: 49.9,
    liveMinutes: 45,
    practiceCount: 3,
    tagline: "Comece sem transformar prática em mais uma obrigação.",
    description:
      "Para destravar a fala e manter o inglês em movimento com sessões objetivas.",
    cta: "Começar com Foco",
    recommended: false,
    image:
      "/assets/wolfie/scenes/speaking/give-your-opinion/desktop.66b5facc2154.webp",
    imageAlt: "Ambiente de conversação com o Wolfie",
    features: [
      "45 minutos de voz ao vivo por mês",
      "Texto ilimitado para continuar praticando",
      "Todos os cenários e feedback do Wolfie",
      "Histórico e contexto entre tentativas",
    ],
  },
  {
    code: "RITMO",
    name: "Ritmo",
    monthlyPrice: 99.9,
    liveMinutes: 120,
    practiceCount: 8,
    tagline: "Crie consistência e perceba evolução toda semana.",
    description:
      "O equilíbrio ideal entre prática por voz, texto e continuidade para uma rotina real.",
    cta: "Criar meu ritmo",
    recommended: true,
    image:
      "/assets/wolfie/scenes/global-meetings/meetings-technology/desktop.cc9f82869f7f.webp",
    imageAlt: "Sala de reunião global com o Wolfie",
    features: [
      "120 minutos de voz ao vivo por mês",
      "Texto ilimitado para continuar praticando",
      "Todos os cenários e feedback do Wolfie",
      "Histórico e contexto entre tentativas",
    ],
  },
  {
    code: "PERFORMANCE",
    name: "Performance",
    monthlyPrice: 179.9,
    liveMinutes: 240,
    practiceCount: 16,
    tagline: "Treine com intensidade para uma meta que já tem data.",
    description:
      "Para reuniões, entrevistas e apresentações que pedem mais ensaio e repetição.",
    cta: "Treinar em alta intensidade",
    recommended: false,
    image:
      "/assets/wolfie/scenes/skill-labs/presentation-lab/desktop.45863e9a8305.webp",
    imageAlt: "Ambiente de apresentação profissional com o Wolfie",
    features: [
      "240 minutos de voz ao vivo por mês",
      "Texto ilimitado para continuar praticando",
      "Todos os cenários e feedback do Wolfie",
      "Histórico e contexto entre tentativas",
    ],
  },
] as const;

export const DEFAULT_WOLFIE_PLAN_CODE: WolfiePlanCode = "RITMO";
export const WOLFIE_STANDALONE_TERMS_VERSION = "2026-08-03-v1" as const;

export const isWolfiePlanCode = (
  value: string | null | undefined,
): value is WolfiePlanCode =>
  typeof value === "string" &&
  WOLFIE_PLAN_CODES.some((code) => code === value);

export const resolveWolfiePlan = (
  value: string | null | undefined,
): WolfieStandalonePlan => {
  const normalized = value?.trim().toUpperCase();
  const code = isWolfiePlanCode(normalized)
    ? normalized
    : DEFAULT_WOLFIE_PLAN_CODE;
  return WOLFIE_STANDALONE_PLANS.find((plan) => plan.code === code) ??
    WOLFIE_STANDALONE_PLANS[1];
};

export const wolfieSubscribeHref = (
  planCode: WolfiePlanCode,
  source: "plans" | "quiz_result" = "plans",
) => `/assinar?planCode=${planCode}&source=${source}`;

export const toWolfieCheckoutPlanCode = (
  planCode: WolfiePlanCode,
): WolfieCheckoutPlanCode => `WOLFIE_${planCode}`;

export const formatWolfiePrice = (price: number) =>
  price.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

export const estimateMonthlyVoiceMinutes = (
  answers: CompleteQuizAnswers,
  recommendation: QuizRecommendation,
) => {
  const modalityWeight = answers.modality === "voice"
    ? 1
    : answers.modality === "mixed"
    ? 0.5
    : 0.25;
  return Math.ceil(
    recommendation.practicePlan.minutesPerSession *
      recommendation.practicePlan.sessionsPerWeek *
      4 *
      modalityWeight,
  );
};

export const recommendWolfiePlanCode = (
  answers: CompleteQuizAnswers,
  recommendation: QuizRecommendation,
): WolfiePlanCode => {
  const estimatedVoiceMinutes = estimateMonthlyVoiceMinutes(
    answers,
    recommendation,
  );
  if (estimatedVoiceMinutes <= 45) return "FOCO";
  if (estimatedVoiceMinutes <= 120) return "RITMO";
  return "PERFORMANCE";
};
