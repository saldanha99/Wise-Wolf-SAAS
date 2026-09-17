import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyCommercialReplyPolicy } from "./commercial-response-policy.ts";
import { wiseWolfLeadTraining } from "./wise-wolf-lead-training.ts";

const base = {
  history: [],
  currentMessage: "Quanto custa?",
  modelReply: "Temos planos de R$ 999. Vamos agendar sua experimental?",
  trialRequested: false,
  commercialPolicy: {
    strategy: "trial_first_then_minimum_on_insistence" as const,
    classDurationMinutes: 30,
    minimumPlanPriceBrl: 169,
  },
  consultativeLead: {},
};

// Regra trocada pela direção em 16/09/2026. Antes, a primeira pergunta de preço
// virava descoberta ("qual é seu objetivo?") e o lead ficava sem valor nenhum —
// aconteceu com um lead real, que perguntou o custo e ouviu "os valores variam".
// Agora preço perguntado é preço respondido, a partir do mínimo, junto com o
// porquê do método. A descoberta continua, mas depois da resposta.
// O modelo do `base` inventa R$ 999: desde 17/09/2026 a política registra que
// barrou um valor de fora do catálogo (`blocked_foreign_price`) em vez do nome
// genérico — a resposta ao lead é a mesma.
Deno.test("primeira pergunta de preço já recebe o valor mínimo", () => {
  const result = applyCommercialReplyPolicy(base);
  assertEquals(result.policy, "blocked_foreign_price");
  assertStringIncludes(result.reply, "R$ 169 por mês");
  // O valor inventado pelo modelo (R$ 999) nunca passa.
  assertEquals(result.reply.includes("999"), false);
});

Deno.test("o preço vem acompanhado do porquê do método", () => {
  const result = applyCommercialReplyPolicy({
    ...base,
    consultativeLead: { goal: "Reuniões globais" },
  });
  assertStringIncludes(result.reply, "30 minutos, e isso é proposital");
  assertStringIncludes(result.reply, "100% conversação");
});

Deno.test("insistência, pedido só de preço, qualificação e pós-aula recebem valor", () => {
  for (
    const options of [
      { history: [{ role: "user", content: "Quanto custa?" }] },
      { currentMessage: "Quero somente o preço" },
      { consultativeLead: { goal: "Viagem", level: "Iniciante" } },
      { consultativeLead: { afterTrial: true } },
    ]
  ) {
    const result = applyCommercialReplyPolicy({ ...base, ...options });
    assertEquals(result.policy, "blocked_foreign_price");
    assertStringIncludes(result.reply, "R$ 169 por mês");
    assertEquals(result.reply.includes("999"), false);
  }
});

Deno.test("sem valor configurado encaminha sem inventar", () => {
  const result = applyCommercialReplyPolicy({
    ...base,
    commercialPolicy: null,
    currentMessage: "Só o preço",
  });
  assertEquals(result.policy, "price_unavailable");
  assertEquals(result.reply.includes("R$"), false);
  assertStringIncludes(result.reply, "coordenação");
});

Deno.test("preserva explicação personalizada, avaliação periódica e convite solicitado", () => {
  for (
    const modelReply of [
      "Em reuniões, praticamos como pedir esclarecimentos e responder perguntas inesperadas. Você já participa delas hoje?",
      "A cada 40 a 45 dias, incentivamos uma interação com outro teacher para desenvolver sua autonomia.",
      "A plataforma e a IA complementam o acompanhamento do professor. Você já consegue conversar em inglês?",
      "A experimental é gratuita e tem 30 minutos. Qual destes horários fica melhor para você?",
    ]
  ) {
    const result = applyCommercialReplyPolicy({
      ...base,
      currentMessage: "Quero saber mais",
      modelReply,
    });
    assertEquals(result, { reply: modelReply, policy: null });
  }
});

Deno.test("corrige duração sem impor agendamento", () => {
  const result = applyCommercialReplyPolicy({
    ...base,
    currentMessage: "Como é a aula?",
    modelReply: "A aula experimental dura 50 minutos.",
  });
  assertEquals(result.policy, "corrected_duration");
  assertStringIncludes(result.reply, "30 minutos");
  assertEquals(result.reply.includes("?"), false);
});

Deno.test("preço não solicitado é removido", () => {
  const result = applyCommercialReplyPolicy({
    ...base,
    currentMessage: "Quero inglês para viagem",
  });
  assertEquals(result.policy, "blocked_unsolicited_price");
  assertEquals(result.reply.includes("999"), false);
});

Deno.test("base exclusiva Wise Wolf inclui diferenciais e limite de consulta dos exames", () => {
  assertEquals(wiseWolfLeadTraining("outra-escola"), "");
  const training = wiseWolfLeadTraining("school-wise-wolf");
  for (
    const term of [
      "40 a 45 dias",
      "IELTS",
      "TOEFL",
      "TOEIC",
      "CAMBRIDGE",
      "não substitui o professor",
      "não tem ferramenta de consulta à web",
      "handoff=true",
    ]
  ) {
    assertStringIncludes(training, term);
  }
});

Deno.test("prazo para aprender não é confundido com duração de aula", () => {
  const modelReply =
    "O prazo depende do seu nível e da sua meta. Você já tem uma viagem programada?";
  assertEquals(
    applyCommercialReplyPolicy({
      ...base,
      currentMessage: "Quanto tempo leva para conseguir conversar?",
      modelReply,
    }),
    { reply: modelReply, policy: null },
  );
});
