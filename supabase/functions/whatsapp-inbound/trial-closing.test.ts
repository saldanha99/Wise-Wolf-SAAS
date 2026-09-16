/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CatalogPrice,
  parseEnrollmentDuration,
  parseEnrollmentSlots,
  parseTrialDenial,
  parseTrialOutcomeReply,
  priceTableText,
  studentNeedMessage,
  studentOfferMessage,
  studentPlanQuestion,
  studentSlotsUnavailableMessage,
  teacherFeedbackAsk,
  teacherOutcomeQuestion,
} from "./trial-closing.ts";

const PRICES: CatalogPrice[] = [
  { frequency: 2, duration: 1, value: 220 },
  { frequency: 2, duration: 6, value: 198 },
  { frequency: 2, duration: 12, value: 169 },
  { frequency: 3, duration: 1, value: 290 },
  { frequency: 3, duration: 12, value: 229 },
];

Deno.test("lê a resposta completa da professora", () => {
  const reply = parseTrialOutcomeReply("SIM A2 4 2x");
  assertEquals(reply.outcome, "DONE");
  assertEquals(reply.level, "A2");
  assertEquals(reply.interest, 4);
  assertEquals(reply.plan, "2x_semana");
});

Deno.test("a frequência não vira nota de interesse", () => {
  const reply = parseTrialOutcomeReply("sim, 3x por semana, nível B1");
  assertEquals(reply.plan, "3x_semana");
  assertEquals(reply.level, "B1");
  assertEquals(reply.interest, null);
});

Deno.test("falta é falta, mesmo escrita de várias formas", () => {
  for (
    const text of [
      "faltou",
      "Não veio",
      "o aluno não apareceu",
      "não aconteceu",
      "não",
    ]
  ) {
    assertEquals(parseTrialOutcomeReply(text).outcome, "NO_SHOW", text);
  }
});

Deno.test("comentário sem 'sim' não inventa resultado — quem decide é o banco", () => {
  const reply = parseTrialOutcomeReply("A2 4 2x");
  assertEquals(reply.outcome, null);
  assertEquals(reply.level, "A2");
  assertEquals(reply.interest, 4);
  assertEquals(reply.plan, "2x_semana");
});

Deno.test("texto que não fala da aula não é resposta", () => {
  const reply = parseTrialOutcomeReply("bom dia, tudo bem?");
  assertEquals(reply.outcome, null);
  assertEquals(reply.level, null);
  assertEquals(reply.interest, null);
  assertEquals(reply.plan, null);
});

Deno.test("4x ou mais é intensivo", () => {
  assertEquals(parseTrialOutcomeReply("sim b2 5 4x").plan, "intensivo");
  assertEquals(
    parseTrialOutcomeReply("sim, intensivo, a1, 5").plan,
    "intensivo",
  );
});

Deno.test("o horário da aula não vira interesse", () => {
  const reply = parseTrialOutcomeReply("sim, foi às 19:30, nivel a1");
  assertEquals(reply.outcome, "DONE");
  assertEquals(reply.level, "A1");
  assertEquals(reply.interest, null);
});

Deno.test("lê o plano que o aluno escolheu", () => {
  assertEquals(parseEnrollmentDuration("quero 12 meses"), 12);
  assertEquals(parseEnrollmentDuration("prefiro o anual"), 12);
  assertEquals(parseEnrollmentDuration("6 meses"), 6);
  assertEquals(parseEnrollmentDuration("mensal mesmo"), 1);
  assertEquals(parseEnrollmentDuration("não sei ainda"), null);
});

Deno.test("lê dias e horários do aluno", () => {
  const slots = parseEnrollmentSlots("segunda e quarta às 19h");
  assertEquals(slots, [
    { day: "Segunda", time: "19:00" },
    { day: "Quarta", time: "19:00" },
  ]);
});

Deno.test("a pergunta à professora diz o que fazer e o que acontece depois", () => {
  const msg = teacherOutcomeQuestion({
    teacherName: "Professora Sintetica",
    leadName: "Aluno Sintetico",
    whenText: "15/09 às 19:30",
  });
  assert(msg.includes("Aluno (15/09 às 19:30) aconteceu?"));
  assert(msg.includes("*SIM A2 4 2x*"));
  assert(msg.includes("FALTOU"));
  assert(msg.includes("entra no seu pagamento"));
});

Deno.test("falta de comentário pede só o que falta", () => {
  assert(teacherFeedbackAsk(["interesse"]).includes("interesse do aluno"));
  const dois = teacherFeedbackAsk(["nivel", "frequencia"]);
  assert(dois.includes("nível") && dois.includes("aulas por semana"));
});

Deno.test("a pergunta ao aluno mostra a tabela de preços", () => {
  const msg = studentPlanQuestion({
    leadName: "Aluna Sintetica",
    teacherName: "Professora Sintetica",
    prices: PRICES,
  });
  assert(msg.startsWith("Oi, Aluna!"));
  assert(msg.includes("teacher Professora"));
  assert(msg.includes("• 2x por semana: R$ 220,00 no mensal"));
  assert(msg.includes("R$ 169,00 em 12 meses"));
});

Deno.test("quando falta só o plano, mostra os preços daquela frequência", () => {
  const msg = studentNeedMessage({
    need: ["plano"],
    frequency: 3,
    prices: PRICES,
  });
  assert(msg.includes("3x por semana"));
  assert(!msg.includes("2x por semana"));
  assertEquals(priceTableText(PRICES, 3).split("\n").length, 1);
});

Deno.test("quando falta o horário, pergunta pelo número de aulas escolhido", () => {
  const msg = studentNeedMessage({
    need: ["horarios"],
    frequency: 2,
    prices: PRICES,
  });
  assert(msg.includes("2 aulas por semana"));
});

Deno.test("a mensagem do link traz preço, horário e vencimento", () => {
  const msg = studentOfferMessage({
    leadName: "Aluna Sintetica",
    teacherName: "Professora Sintetica",
    url: "https://exemplo.invalid/matricula?offer=abc",
    value: 229,
    frequency: 3,
    duration: 12,
    slots: [
      { day: "Segunda", time: "19:00" },
      { day: "Quarta", time: "19:00" },
      { day: "Sexta", time: "19:00" },
    ],
    startDate: "22/09",
  });
  assert(msg.includes("3x por semana · plano de 12 meses"));
  assert(msg.includes("R$ 229,00 por mês, vencimento todo dia 10"));
  assert(msg.includes("Segunda às 19:00 · Quarta às 19:00 · Sexta às 19:00"));
  assert(msg.includes("https://exemplo.invalid/matricula?offer=abc"));
  assert(msg.includes("Primeira aula em 22/09"));
});

Deno.test("horário ocupado oferece os livres, e sem livres pede outros", () => {
  const comLivres = studentSlotsUnavailableMessage([
    { day: "Terça", time: "18:00" },
  ]);
  assert(comLivres.includes("• Terça às 18:00"));
  assert(studentSlotsUnavailableMessage([]).includes("Me manda outras opções"));
});

Deno.test("aluno desmentindo a aula é lido como contestação", () => {
  for (
    const texto of [
      "a aula não aconteceu",
      "não tive aula hoje",
      "a teacher não apareceu",
      "não consegui entrar na aula",
      "não fiz a aula experimental",
      "faltei, perdi a aula",
    ]
  ) {
    assertEquals(parseTrialDenial(texto), true, texto);
  }
});

Deno.test("resposta normal sobre plano não trava pagamento de ninguém", () => {
  for (
    const texto of [
      "não quero 12 meses",
      "não sei ainda",
      "não tive tempo de responder antes",
      "quero 2x por semana",
      "não pode ser terça, só quinta",
      "segunda e quarta às 19h",
    ]
  ) {
    assertEquals(parseTrialDenial(texto), false, texto);
  }
});
