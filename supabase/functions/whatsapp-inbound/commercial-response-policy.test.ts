/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCommercialReplyPolicy,
  type CommercialPolicy,
} from "./commercial-response-policy.ts";

const politica: CommercialPolicy = {
  classDurationMinutes: 30,
  minimumPlanPriceBrl: 169,
  strategy: "trial_first_then_minimum_on_insistence",
};

const base = {
  history: [] as { role: string; content: string }[],
  trialRequested: false,
  commercialPolicy: politica,
};

Deno.test("preço perguntado uma vez já é respondido, com o mínimo e o método", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...base,
    currentMessage: "Gostaria de saber qual seria o custo.",
    modelReply: "Os valores variam conforme a quantidade de aulas por semana.",
    consultativeLead: { goal: null, level: null },
  });
  assert(reply.includes("começam em R$ 169 por mês"), reply);
  assert(reply.includes("30 minutos, e isso é proposital"), reply);
  assert(reply.includes("100% conversação"), reply);
  assertEquals(policy, "consultative_price_answer");
});

Deno.test("o porquê dos 30 minutos entra uma vez só", () => {
  const { reply } = applyCommercialReplyPolicy({
    ...base,
    currentMessage: "Quanto custa e quanto tempo dura a aula?",
    modelReply: "Nossas aulas duram 50 minutos.",
    consultativeLead: { goal: "trabalho", level: "B1" },
  });
  assertEquals(reply.split("proposital").length - 1, 1, reply);
  assert(reply.includes("R$ 169"), reply);
});

Deno.test("sem pergunta de preço, a resposta do modelo passa intacta", () => {
  const original = "Que bom, Ana! Qual dia da semana fica melhor para você?";
  const { reply, policy } = applyCommercialReplyPolicy({
    ...base,
    currentMessage: "Quero aula para o meu filho de 9 anos.",
    modelReply: original,
    consultativeLead: { goal: null, level: null },
  });
  assertEquals(reply, original);
  assertEquals(policy, null);
});

Deno.test("sem política configurada, não inventa valor", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...base,
    commercialPolicy: null,
    currentMessage: "Quanto custa?",
    modelReply: "São R$ 100 por mês.",
    consultativeLead: { goal: "viagem", level: "A2" },
  });
  assert(!reply.includes("R$ 100"), reply);
  assert(reply.includes("coordenação"), reply);
  assertEquals(policy, "price_unavailable");
});
