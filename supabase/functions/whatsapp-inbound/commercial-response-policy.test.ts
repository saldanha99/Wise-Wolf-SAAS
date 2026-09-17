/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  applyCommercialReplyPolicy,
  type CommercialPolicy,
} from "./commercial-response-policy.ts";
import { formatPriceList } from "./lead-pricing.ts";

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

// ── Com o catálogo da escola (regressão da Diná, 17/09/2026) ──────────────────
import { CATALOGO } from "./lead-pricing.test.ts";

const dina = {
  ...base,
  catalog: CATALOGO,
  consultativeLead: { goal: "inglês para trabalho", level: "B1" },
};

Deno.test("Diná 07:12 — 'estimativa de valores' recebe a tabela inteira", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    currentMessage: "Vc pode me passar estimativa de valores ?",
    modelReply: "Os planos começam em R$ 169 por mês.",
    trialRequested: true,
  });
  assertEquals(policy, "price_list");
  assert(reply.includes("🔹 Planos de 6 meses"), reply);
  assert(reply.includes("✅ 4x por semana – R$355/mês"), reply);
  assert(reply.includes("✅ 2x por semana – R$169/mês"), reply);
  // O pedido de experimental veio junto: a promessa de verificar não some.
  assert(reply.includes("vou verificar o professor"), reply);
});

Deno.test("Diná 07:15 — '4 vezes na semana qual valor?' responde 4x e manda a tabela", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    history: [
      { role: "user", content: "Vc pode me passar estimativa de valores ?" },
      {
        role: "assistant",
        content:
          "As aulas são de 30 minutos, e isso é proposital: … Os planos começam em R$ 169 por mês.",
      },
    ],
    currentMessage: "4 vezes na semana qual valor ?",
    modelReply: "Vou verificar com a coordenação e te retorno.",
  });
  assertEquals(policy, "frequency_price_answer");
  assert(
    reply.startsWith(
      "4x por semana fica R$355/mês no plano de 6 meses ou R$299/mês no de 12 meses.",
    ),
    reply,
  );
  assert(reply.includes("🔹 Planos de 12 meses (com desconto)"), reply);
  assert(!reply.includes("aguardando o aceite"), reply);
});

Deno.test("frequência dita e modelo respondeu com o número certo: a frase dele fica", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    currentMessage: "e 3x por semana?",
    modelReply:
      "3x por semana fica R$261/mês no plano de 6 meses ou R$229/mês no de 12 😊 Quer que eu já veja o horário?",
  });
  assertEquals(policy, "frequency_price_answer_model");
  assert(reply.startsWith("3x por semana fica R$261/mês"), reply);
  assert(
    reply.includes("🔹 Planos de 6 meses"),
    "a tabela vai junto na primeira vez",
  );
});

Deno.test("modelo inventou valor: barrado, entra a resposta com o catálogo", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    currentMessage: "quanto fica 4x por semana?",
    modelReply: "4x por semana fica R$ 350 por mês.",
  });
  assertEquals(policy, "frequency_price_answer");
  assert(!reply.includes("350"), reply);
  assert(reply.includes("R$355/mês"), reply);
});

Deno.test("Diná 07:17 — '??' depois de preço sem resposta é cobrança: a tabela sai", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    history: [
      { role: "user", content: "4 vezes na semana qual valor ?" },
      {
        role: "assistant",
        content:
          "Esse horário já está aguardando o aceite de um professor. O prazo de 60 minutos continua contando.",
      },
    ],
    currentMessage: "??",
    modelReply: "Desculpe, pode repetir?",
  });
  assertEquals(policy, "price_list");
  assert(reply.includes("Desculpa a demora com o valor"), reply);
  assert(reply.includes("✅ 4x por semana – R$355/mês"), reply);
});

Deno.test("tabela já enviada: não repete; aponta para cima e pergunta a frequência", () => {
  const lista = formatPriceList(CATALOGO);
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    history: [
      { role: "user", content: "me passa os valores" },
      { role: "assistant", content: lista },
    ],
    currentMessage: "e os valores?",
    modelReply: "Os valores variam conforme a frequência.",
  });
  assertEquals(policy, "price_list_repeat");
  assert(!reply.includes("🔹"), reply);
  assert(reply.includes("tabela que te mandei acima"), reply);
});

Deno.test("preço perguntado e modelo respondeu com valor do catálogo: passa como está", () => {
  const original =
    "Eu te passo sim 😊 Os planos começam em R$169/mês e mudam conforme a quantidade de aulas por semana. Quantas vezes por semana você pensa em fazer?";
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    currentMessage: "quanto custa?",
    modelReply: original,
  });
  assertEquals(policy, "price_answer_model");
  assertEquals(reply, original);
});

Deno.test("o 'isso é proposital' não é repetido na segunda explicação", () => {
  const { reply } = applyCommercialReplyPolicy({
    ...dina,
    history: [
      { role: "user", content: "quanto custa?" },
      {
        role: "assistant",
        content: "As aulas são de 30 minutos, e isso é proposital: …",
      },
    ],
    currentMessage: "mas qual o preço?",
    modelReply: "Os valores variam.",
  });
  assert(!reply.includes("proposital"), reply);
  assert(reply.includes("R$ 169"), reply);
});

Deno.test("modelo escreveu a tabela inteira com números certos: não anexa outra", () => {
  const { reply, policy } = applyCommercialReplyPolicy({
    ...dina,
    currentMessage: "4x por semana quanto fica?",
    modelReply:
      "4x fica R$355/mês em 6 meses ou R$299/mês em 12. Para comparar: 2x R$198/R$169, 3x R$261/R$229 😊",
  });
  assertEquals(policy, "frequency_price_answer_model");
  assert(!reply.includes("🔹"), reply);
});
