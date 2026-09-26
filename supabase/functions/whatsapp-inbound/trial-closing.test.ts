/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adjacentFourDayAlternative,
  asksToReadContract,
  type CatalogPrice,
  classifyTeacherSlotsReply,
  contractReadingAnswer,
  mergeTeacherCounterproposal,
  parseCounterproposalDecision,
  parseEnrollmentDueDay,
  parseEnrollmentDuration,
  parseEnrollmentSlots,
  parseEnrollmentSlotsFromMessages,
  parseEnrollmentStartDate,
  parseTeacherOptionChoice,
  parseTrialDenial,
  parseTrialOutcomeReply,
  priceTableText,
  studentCounterproposalBlocks,
  studentNeedMessage,
  studentOfferMessage,
  studentPlanQuestion,
  studentSlotsUnavailableMessage,
  studentTwoOptionsBlocks,
  teacherAlternativeQuestion,
  teacherFeedbackAsk,
  teacherOutcomeQuestion,
  teacherRecurringSlotsQuestion,
  trialClosingMayResumeAfterHandoff,
} from "./trial-closing.ts";

Deno.test("contrato pode ser lido antes da assinatura", () => {
  assert(asksToReadContract("Gostaria de ler o contrato, é possível?"));
  assert(contractReadingAnswer().includes("antes de assinar"));
});

Deno.test("contraproposta da professora não confirma horários diferentes", () => {
  const requested = parseEnrollmentSlots("Segunda 15h, Quarta 16h, Quinta 16h");
  assertEquals(
    classifyTeacherSlotsReply(
      "Sim! Se puder ser segunda, quarta-feira e sexta às 16:00 consigo sim.",
      requested,
    ),
    "counterproposal",
  );
  assertEquals(classifyTeacherSlotsReply("Sim sim", requested), "confirmed");
  assertEquals(classifyTeacherSlotsReply("Não consigo", requested), "declined");
});

Deno.test("aluno aceita ou recusa contraproposta apenas com resposta inequívoca", () => {
  assertEquals(parseCounterproposalDecision("Sim!"), true);
  assertEquals(parseCounterproposalDecision("Pode ser"), true);
  assertEquals(parseCounterproposalDecision("Não serve"), false);
  assertEquals(
    parseCounterproposalDecision("Sim, mas queria terça às 17h"),
    null,
  );
});

Deno.test("contraproposta sai em blocos, explica a restrição e não promete reserva", () => {
  const blocks = studentCounterproposalBlocks({
    leadName: "Caio Sintetico",
    teacherName: "Carla Sintetica",
    requested: [
      { day: "Segunda", time: "15:00" },
      { day: "Terça", time: "16:00" },
      { day: "Quarta", time: "16:00" },
      { day: "Quinta", time: "16:00" },
    ],
    proposed: [
      { day: "Segunda", time: "16:00" },
      { day: "Terça", time: "16:00" },
      { day: "Quarta", time: "16:00" },
      { day: "Quinta", time: "16:00" },
    ],
    hourBRT: 10,
  });
  assertEquals(blocks.length, 4);
  assertEquals(blocks[0], "Bom dia, Caio!");
  assertEquals(blocks[1], "Tudo bem?");
  assert(blocks[2].includes("não consegue segunda às 15:00"));
  assert(blocks[3].includes("Esses horários funcionam para você?"));
  assert(!blocks.join(" ").includes("reservad"));
});

Deno.test("junta horários enviados pelo aluno em várias mensagens sem assumir grade parcial", () => {
  const first = parseEnrollmentSlotsFromMessages([
    "Seg 15h, demais as 16h",
    "4x",
  ], 4);
  assertEquals(first.complete, []);
  assertEquals(first.partial, [{ day: "Segunda", time: "15:00" }]);
  const complete = parseEnrollmentSlotsFromMessages([
    "Seg 15h, demais as 16h",
    "4x",
    "Ter, Qua e Qui",
    "As 16h",
  ], 4);
  assertEquals(complete.complete, [
    { day: "Segunda", time: "15:00" },
    { day: "Terça", time: "16:00" },
    { day: "Quarta", time: "16:00" },
    { day: "Quinta", time: "16:00" },
  ]);
});

Deno.test("correção de um dia pela professora conserva os outros sem confirmar a escolha antiga", () => {
  const requested = parseEnrollmentSlots(
    "Segunda 15h, Terça 16h, Quarta 16h, Quinta 16h",
  );
  assertEquals(
    mergeTeacherCounterproposal(
      requested,
      "Na segunda eu consigo às 16:00 somente",
    ),
    [
      { day: "Segunda", time: "16:00" },
      { day: "Terça", time: "16:00" },
      { day: "Quarta", time: "16:00" },
      { day: "Quinta", time: "16:00" },
    ],
  );
  assertEquals(
    mergeTeacherCounterproposal(
      requested,
      "Na sexta eu consigo às 16:00 somente",
    ),
    [],
  );
});

Deno.test("reconhece início e vencimento compartilhados na fala do Caio", () => {
  const message =
    "Dia 05/10/26 para começar e vencimento, porém antes vou avaliar o contrato";
  assertEquals(parseEnrollmentStartDate(message), "2026-10-05");
  assertEquals(parseEnrollmentDueDay(message), 5);
  assertEquals(asksToReadContract(message), false);
  assertEquals(
    parseEnrollmentDueDay("Começo dia 05/10, vencimento a definir"),
    null,
  );
  assertEquals(
    parseEnrollmentDueDay("Dia 05/10 para começar, vencimento depois"),
    null,
  );
  assertEquals(
    parseEnrollmentDueDay("Começar dia 05/10 e vencimento dia 15"),
    15,
  );
});

Deno.test("explora terça a sexta somente após contraproposta exata da professora", () => {
  const original = parseEnrollmentSlots(
    "Segunda 15h, Terça 16h, Quarta 16h, Quinta 16h",
  );
  const primary = mergeTeacherCounterproposal(
    original,
    "Na segunda só consigo às 16h",
  );
  const alternative = adjacentFourDayAlternative(primary);
  assertEquals(alternative, [
    { day: "Terça", time: "16:00" },
    { day: "Quarta", time: "16:00" },
    { day: "Quinta", time: "16:00" },
    { day: "Sexta", time: "16:00" },
  ]);
  assert(
    teacherAlternativeQuestion({
      teacherName: "Carla Sintetica",
      leadName: "Caio Sintetico",
      slots: alternative,
    }).includes("Se a segunda não funcionar para Caio"),
  );
  assertEquals(classifyTeacherSlotsReply("Consigo!", alternative), "confirmed");
  const blocks = studentTwoOptionsBlocks({
    leadName: "Caio Sintetico",
    teacherName: "Carla Sintetica",
    requested: original,
    primary,
    alternative,
    hourBRT: 10,
  });
  assertEquals(blocks.length, 4);
  assert(blocks[3].includes("duas opções"));
  assertEquals(
    parseTeacherOptionChoice("Prefiro de segunda a quinta às 16h"),
    "primary",
  );
  assertEquals(
    parseTeacherOptionChoice("Pode ser de terça a sexta"),
    "alternative",
  );
  assertEquals(
    parseTeacherOptionChoice("Prefiro terça a sexta, não segunda a quinta"),
    null,
  );
  assertEquals(parseTeacherOptionChoice("Sim"), null);
  assertEquals(adjacentFourDayAlternative(original), []);
});

const PRICES: CatalogPrice[] = [
  { frequency: 2, duration: 1, value: 220 },
  { frequency: 2, duration: 6, value: 198 },
  { frequency: 2, duration: 12, value: 169 },
  { frequency: 3, duration: 1, value: 290 },
  { frequency: 3, duration: 12, value: 229 },
];

Deno.test("pós-experimental só retoma com autorização explícita após a última fala humana", () => {
  assertEquals(
    trialClosingMayResumeAfterHandoff(
      "2026-09-23T19:04:13Z",
      null,
    ),
    false,
  );
  assertEquals(
    trialClosingMayResumeAfterHandoff(
      "2026-09-23T19:50:00Z",
      "2026-09-23T19:40:15Z",
    ),
    false,
  );
  assertEquals(
    trialClosingMayResumeAfterHandoff(
      null,
      "2026-09-23T19:40:15Z",
    ),
    false,
  );
  assertEquals(
    trialClosingMayResumeAfterHandoff(
      "2026-09-23T21:42:13Z",
      "2026-09-23T22:45:00Z",
    ),
    true,
  );
  assertEquals(
    trialClosingMayResumeAfterHandoff(
      "2026-09-23T23:00:00Z",
      "2026-09-23T22:45:00Z",
    ),
    false,
  );
});

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

Deno.test("início e vencimento exigem escolhas explícitas e válidas", () => {
  assertEquals(
    parseEnrollmentStartDate("Quero começar em 28/09/2026"),
    "2026-09-28",
  );
  assertEquals(parseEnrollmentStartDate("início 31/02/2026"), null);
  assertEquals(parseEnrollmentStartDate("talvez semana que vem"), null);
  assertEquals(parseEnrollmentDueDay("vencimento dia 15"), 15);
  assertEquals(parseEnrollmentDueDay("vencimento 32"), null);
  assertEquals(parseEnrollmentDueDay("3 aulas por semana"), null);
});

Deno.test("pedido à professora inclui apenas os horários escolhidos", () => {
  const msg = teacherRecurringSlotsQuestion({
    teacherName: "Carla Sintetica",
    leadName: "Caio Sintetico",
    slots: [
      { day: "Segunda", time: "15:00" },
      { day: "Quarta", time: "16:00" },
      { day: "Quinta", time: "16:00" },
    ],
  });
  assert(msg.includes("Caio"));
  assert(msg.includes("Segunda às 15:00"));
  assert(msg.includes("Quinta às 16:00"));
  assert(msg.includes("Responda SIM ou NÃO"));
});

Deno.test("fechamento pergunta plano, início e vencimento sem repetir horários", () => {
  const msg = studentNeedMessage({
    need: ["plano", "inicio", "vencimento", "professora"],
    frequency: 3,
    prices: PRICES,
  });
  assert(msg.includes("qual plano prefere"));
  assert(msg.includes("DD/MM/AAAA"));
  assert(msg.includes("vencimento da mensalidade"));
  assert(!msg.includes("quais dias e horários"));
});

Deno.test("link reflete vencimento escolhido e taxa condicional", () => {
  const base = {
    leadName: "Caio Sintetico",
    teacherName: "Carla Sintetica",
    url: "https://system.wisewolflanguage.com.br/matricula?offer=test",
    value: 229,
    frequency: 3,
    duration: 12,
    slots: [
      { day: "Segunda", time: "15:00" },
      { day: "Quarta", time: "16:00" },
      { day: "Quinta", time: "16:00" },
    ],
    startDate: "05/10",
    dueDay: 20,
  };
  const charged = studentOfferMessage({ ...base, enrollmentFee: 49.9 });
  assert(charged.includes("todo dia 20"));
  assert(charged.includes("R$ 49,90"));
  const waived = studentOfferMessage({ ...base, enrollmentFee: 0 });
  assert(waived.includes("Sem taxa de matrícula"));
});

Deno.test("lê dias e horários do aluno", () => {
  const slots = parseEnrollmentSlots("segunda e quarta às 19h");
  assertEquals(slots, [
    { day: "Segunda", time: "19:00" },
    { day: "Quarta", time: "19:00" },
  ]);
});

Deno.test("lê os três horários escolhidos por Caio no pós-experimental", () => {
  assertEquals(
    parseEnrollmentSlots("Segunda - 15h - Quarta 16h - Quinta 16h"),
    [
      { day: "Segunda", time: "15:00" },
      { day: "Quarta", time: "16:00" },
      { day: "Quinta", time: "16:00" },
    ],
  );
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
  assert(
    studentSlotsUnavailableMessage([]).includes("confirmação direta"),
  );
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

// ── Pós-experimental como conversa + briefing do professor (17/09/2026) ──────
import {
  cleanLeadNotes,
  formatPhoneBr,
  studentPostTrialOpener,
  teacherTrialBriefing,
} from "./trial-closing.ts";

Deno.test("a abertura do pós-aula pergunta como foi, sem tabela nem formulário", () => {
  const msg = studentPostTrialOpener({
    leadName: "Janaina Dias",
    teacherName: "Carla Sintetica",
    classLogged: true,
  });
  assertEquals(
    msg,
    "Oi, Janaina! Como foi a aula experimental com a teacher Carla? 😊\n\nMe conta o que você achou — da aula e da professora.",
  );
  assert(!msg.includes("R$"));
});

Deno.test("sem aula lançada, a abertura confirma se aconteceu antes de vender", () => {
  const msg = studentPostTrialOpener({
    leadName: "Cleice Brito",
    teacherName: "Lais Sampaio Conde",
    classLogged: false,
  });
  assert(msg.includes("Vocês conseguiram fazer a aula?"));
  assert(msg.includes("ajudo a reagendar"));
  assert(!msg.includes("Como foi a aula experimental"));
});

Deno.test("briefing do professor traz aluno, telefone, horário, objetivo e o que fazer antes", () => {
  const msg = teacherTrialBriefing({
    teacherName: "Carla Sintetica",
    whenText: "18/09 às 10:00",
    leadName: "Janaina",
    leadPhone: "5511900000123",
    goal: "Inglês para trabalho",
    level: "intermediário (B1)",
    notes:
      '[IA 2026-09-16] voltou de intercâmbio na Irlanda; quer falar em reuniões\nUTMs: {"utm_source":"google"}',
    weeklyAvailability: "sábado de manhã",
    interests: null,
    meetingLink: null,
  });
  assert(msg.startsWith("🎯 *Experimental 18/09 às 10:00* — Janaina"), msg);
  assert(msg.includes("(11) 90000-0123"), msg);
  assert(
    msg.includes("Objetivo: Inglês para trabalho · Nível: intermediário (B1)"),
    msg,
  );
  assert(
    msg.includes(
      "Contexto: voltou de intercâmbio na Irlanda; quer falar em reuniões",
    ),
    msg,
  );
  assert(!msg.includes("UTMs"), "UTM não é assunto do professor");
  assert(!msg.includes("[IA"), "carimbo da IA não vai para o professor");
  assert(msg.includes("Aulas de Hoje"), "sem link fixo, aponta a plataforma");
  assert(msg.includes("Trial Class"), msg);
});

Deno.test("briefing usa o link fixo do professor quando existe; telefone estranho sai como veio", () => {
  const msg = teacherTrialBriefing({
    teacherName: null,
    whenText: "17/09 às 18:30",
    leadName: null,
    leadPhone: "12345",
    meetingLink: "https://meet.google.com/abc-defg-hij",
  });
  assert(
    msg.includes("Link da aula: https://meet.google.com/abc-defg-hij"),
    msg,
  );
  assert(msg.includes("aluno sem nome no cadastro"), msg);
  assert(msg.includes("WhatsApp do aluno: 12345"), msg);
  assertEquals(formatPhoneBr("557187168313"), "(71) 8716-8313");
  assertEquals(
    cleanLeadNotes(
      "[IA 2026-09-14] aguardando aceite de professor p/ experimental 2026-09-16 10:00",
    ),
    "",
  );
});
