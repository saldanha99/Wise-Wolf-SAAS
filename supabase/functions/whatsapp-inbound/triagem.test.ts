import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ETAPAS,
  etapasRespondidas,
  mergeRespostas,
  promptTriagem,
  proximaEtapa,
  triagemCompleta,
} from "./triagem.ts";
import {
  applyCommercialReplyPolicy,
  CLASS_DURATION_MINUTES,
  MINIMUM_PLAN_PRICE_BRL,
  resolveAtendenteTraining,
  resolveCommercialPolicy,
} from "./commercial-response-policy.ts";

const HOJE = "2026-08-09";
const base = { nomeCandidato: "Ana", primeiraInteracao: false, coletando: true, hoje: HOJE };
const commercialPolicy = {
  classDurationMinutes: CLASS_DURATION_MINUTES,
  minimumPlanPriceBrl: MINIMUM_PLAN_PRICE_BRL,
  strategy: "trial_first_then_minimum_on_insistence" as const,
};

const todasRespondidas = () =>
  Object.fromEntries(ETAPAS.map((e) => [e.key, "resposta"]));

Deno.test("a primeira etapa é nacionalidade", () => {
  assertEquals(proximaEtapa({})?.key, "nacionalidade");
});

Deno.test("avança para a etapa seguinte quando a anterior tem resposta", () => {
  assertEquals(proximaEtapa({ nacionalidade: "brasileira" })?.key, "idade");
});

Deno.test("resposta em branco NÃO conta como respondida", () => {
  // O modelo devolve "" quando não conseguiu extrair. Tratar isso como resposta
  // pularia a etapa em silêncio — foi o que fez a triagem morrer no meio.
  assertEquals(proximaEtapa({ nacionalidade: "   " })?.key, "nacionalidade");
  assertEquals(proximaEtapa({ nacionalidade: null })?.key, "nacionalidade");
});

Deno.test("triagem só termina com as 10 etapas preenchidas", () => {
  assertEquals(triagemCompleta({}), false);
  assertEquals(triagemCompleta({ nacionalidade: "sim" }), false);
  assertEquals(triagemCompleta(todasRespondidas()), true);
  assertEquals(etapasRespondidas(todasRespondidas()), ETAPAS.length);
});

Deno.test("nota_ingles não é etapa — não segura o encerramento", () => {
  assertEquals(triagemCompleta({ ...todasRespondidas(), nota_ingles: undefined }), true);
});

Deno.test("mergeRespostas ignora chave que o modelo inventou", () => {
  const out = mergeRespostas({}, { nacionalidade: "brasileira", salario_pretendido: "5000" });
  assertEquals(out.nacionalidade, "brasileira");
  assertEquals(out.salario_pretendido, undefined);
});

Deno.test("mergeRespostas aceita nota_ingles", () => {
  assertEquals(mergeRespostas({}, { nota_ingles: 8 }).nota_ingles, 8);
});

Deno.test("mergeRespostas não sobrescreve resposta já dada", () => {
  const out = mergeRespostas({ idade: "30" }, { idade: "31" });
  assertEquals(out.idade, "30");
});

Deno.test("mergeRespostas descarta vazio vindo do modelo", () => {
  const out = mergeRespostas({ idade: "30" }, { nacionalidade: "", formacao: null });
  assertEquals(out.nacionalidade, undefined);
  assertEquals(out.formacao, undefined);
  assertEquals(out.idade, "30");
});

Deno.test("o prompt carrega UMA pergunta, não as dez", () => {
  const p = promptTriagem({ ...base, answers: {} });
  assertStringIncludes(p, "Você tem nacionalidade brasileira?");
  // A pergunta da etapa 2 não pode aparecer, senão o modelo emenda as duas.
  assertEquals(p.includes("Qual a sua idade?"), false);
});

Deno.test("o bloco comercial acompanha a etapa que depende dele", () => {
  const answers = { nacionalidade: "sim", idade: "30" };
  const p = promptTriagem({ ...base, answers });
  assertStringIncludes(p, "aulas particulares 1:1");
  assertStringIncludes(p, "Esse formato faz sentido pra você?");
});

Deno.test("os números da remuneração não são reescritos", () => {
  const answers = {
    nacionalidade: "sim", idade: "30", modelo_ok: "sim",
    formacao: "Letras", computador_internet: "sim",
  };
  const p = promptTriagem({ ...base, answers });
  assertStringIncludes(p, "R$8,00 por aula");
  assertStringIncludes(p, "5x = R$160");
});

Deno.test("etapa 0 não faz pergunta da triagem", () => {
  const p = promptTriagem({ ...base, primeiraInteracao: true, answers: {} });
  assertStringIncludes(p, "ETAPA 0");
  assertEquals(p.includes("Você tem nacionalidade brasileira?"), false);
});

Deno.test("com tudo respondido o prompt vira encerramento", () => {
  const p = promptTriagem({ ...base, answers: todasRespondidas() });
  assertStringIncludes(p, "ENCERRAMENTO");
});

Deno.test("pós-triagem não volta a perguntar", () => {
  const p = promptTriagem({ ...base, coletando: false, answers: {} });
  assertStringIncludes(p, "PÓS-TRIAGEM");
  assertEquals(p.includes("Você tem nacionalidade brasileira?"), false);
});

Deno.test("a etapa de inglês pede a nota", () => {
  const answers = Object.fromEntries(
    ETAPAS.filter((e) => e.key !== "apresentacao_en").map((e) => [e.key, "ok"]),
  );
  const p = promptTriagem({ ...base, answers });
  assertStringIncludes(p, "nota_ingles");
  assertStringIncludes(p, "EM INGLÊS");
});

Deno.test("o prompt lista o que já foi respondido para não repetir", () => {
  const p = promptTriagem({ ...base, answers: { nacionalidade: "brasileira" } });
  assertStringIncludes(p, "NÃO pergunte de novo");
  assertStringIncludes(p, "brasileira");
});

Deno.test("atendente não informa preço na primeira pergunta e conduz para experimental", () => {
  const result = applyCommercialReplyPolicy({
    history: [],
    currentMessage: "Qual é o valor das aulas?",
    modelReply: "O plano custa R$ 296 por mês.",
    trialRequested: false,
    commercialPolicy,
  });
  assertEquals(result.policy, "trial_before_price");
  assertEquals(result.reply.includes("296"), false);
  assertEquals(result.reply.includes("experimental gratuita"), true);
  assertEquals(result.reply.includes(`R$ ${MINIMUM_PLAN_PRICE_BRL}`), false);
});

Deno.test("atendente informa somente o valor mínimo quando o lead insiste", () => {
  const result = applyCommercialReplyPolicy({
    history: [{ role: "user", content: "Quanto custa?" }],
    currentMessage: "Mas preciso saber o preço antes.",
    modelReply: "Temos R$ 198, R$ 261 e R$ 355.",
    trialRequested: false,
    commercialPolicy,
  });
  assertEquals(result.policy, "minimum_price_after_insistence");
  assertStringIncludes(result.reply, `a partir de R$ ${MINIMUM_PLAN_PRICE_BRL}/mês`);
  assertEquals(result.reply.includes("198"), false);
  assertEquals(result.reply.includes("261"), false);
  assertEquals(result.reply.includes("355"), false);
});

Deno.test("preço espontâneo do modelo é bloqueado mesmo sem pergunta do lead", () => {
  const result = applyCommercialReplyPolicy({
    history: [],
    currentMessage: "Quero aprender para viajar.",
    modelReply: "Legal! As aulas custam 296 reais por mês.",
    trialRequested: false,
    commercialPolicy,
  });
  assertEquals(result.policy, "blocked_unsolicited_price");
  assertEquals(result.reply.includes("296"), false);
  assertEquals(result.reply.includes("experimental gratuita"), true);
});

Deno.test("duração errada do modelo é substituída por 30 minutos", () => {
  const result = applyCommercialReplyPolicy({
    history: [],
    currentMessage: "Quanto tempo dura cada aula?",
    modelReply: "Cada aula dura 50 minutos.",
    trialRequested: false,
    commercialPolicy,
  });
  assertEquals(result.policy, "corrected_duration");
  assertStringIncludes(result.reply, `${CLASS_DURATION_MINUTES} minutos`);
  assertEquals(result.reply.includes("50 minutos"), false);

  const otherWrongDuration = applyCommercialReplyPolicy({
    history: [],
    currentMessage: "Quero conhecer a escola.",
    modelReply: "Nossas aulas têm 25 minutos.",
    trialRequested: false,
    commercialPolicy,
  });
  assertEquals(otherWrongDuration.policy, "corrected_duration");
  assertEquals(otherWrongDuration.reply.includes("25 minutos"), false);
});

Deno.test("resposta comercial segura do modelo passa sem alteração", () => {
  const modelReply = "Perfeito! Qual dia fica melhor para sua experimental?";
  const result = applyCommercialReplyPolicy({
    history: [],
    currentMessage: "Quero melhorar para o trabalho.",
    modelReply,
    trialRequested: false,
    commercialPolicy,
  });
  assertEquals(result, { reply: modelReply, policy: null });
});

Deno.test("treinamento atual da atendente prevalece sobre o campo legado", () => {
  assertEquals(resolveAtendenteTraining({
    agents: { atendente: { training: "Treinamento atual" } },
    sdr: { training: "Treinamento antigo" },
  }), "Treinamento atual");
  assertEquals(resolveAtendenteTraining({ sdr: { training: "Treinamento antigo" } }), "Treinamento antigo");
  assertEquals(resolveAtendenteTraining({
    agents: { atendente: { training: "" } },
    sdr: { training: "Treinamento antigo" },
  }), "");
});

Deno.test("política comercial é carregada somente quando configurada e válida", () => {
  assertEquals(resolveCommercialPolicy({ agents: { atendente: { commercialPolicy } } }), commercialPolicy);
  assertEquals(resolveCommercialPolicy({}), null);
  assertEquals(resolveCommercialPolicy({
    agents: { atendente: { commercialPolicy: { ...commercialPolicy, minimumPlanPriceBrl: -1 } } },
  }), null);
});
