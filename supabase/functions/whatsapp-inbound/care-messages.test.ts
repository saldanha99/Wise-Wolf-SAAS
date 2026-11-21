/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  absenceFollowupMessage,
  isMakeupOrSlotMessage,
  makeupWithTeacherReply,
  monthlyCheckinMessage,
  quotaSentence,
  replyOffersSlot,
  teacherAbsenceNudgeMessage,
  teacherReschedulePolicyMessage,
  weeklyCheckinMessage,
} from "./care-messages.ts";

const slots = [
  { date: "2026-09-18", day: "Sexta", time: "09:00", label: "18/09 às 09:00" },
  { date: "2026-09-18", day: "Sexta", time: "10:30", label: "18/09 às 10:30" },
];

// Qualquer dia/horário de reposição num texto para o aluno reprova (direção, 21/11/2026).
const SEM_HORARIO = /\b([01]?\d|2[0-3])\s?(h|:[0-5]\d)\b|•|hor[aá]rio livre|tem livre|dispon[ií]vel|https?:\/\//i;

Deno.test("falta: só o lembrete de combinar com o professor antes do fim do mês (direção, 21/11/2026)", () => {
  for (const used of [1, 5]) {
    const msg = absenceFollowupMessage({
      studentName: "Mariana Pastro Morais",
      teacherName: "Lais Sampaio Conde",
      classDate: "2026-09-16",
      quota: { limit: 4, used },
      freeSlots: slots,
    });
    assertEquals(
      msg,
      "Oi, Mariana! Sentimos sua falta na aula de 16/09. Lembre de combinar a reposição dessa aula diretamente com a teacher Lais antes do fim do mês 😉",
    );
    assert(!SEM_HORARIO.test(msg), msg);
    assert(!/reposições por|usou as/.test(msg), msg);
  }
  const semProfessor = absenceFollowupMessage({ studentName: "Ana", teacherName: null, classDate: "", freeSlots: slots });
  assertEquals(semProfessor, "Oi, Ana! Sentimos sua falta na sua aula. Lembre de combinar a reposição dessa aula diretamente com seu professor antes do fim do mês 😉");
});

Deno.test("aluno fala de reposição ou propõe horário: resposta fixa, sem horário", () => {
  const pedidos = [
    "quero repor a aula",
    "posso remarcar?",
    "dá pra reagendar pra quinta 15h?",
    "pode ser segunda às 14:00",
    "consigo amanhã 18h",
    "tem vaga dia 23/11?",
    "Faltei, como faço a reposição?",
    // Resposta automática real de 21/11 que virou oferta de horário em produção:
    "Agradeço seu contato, informo que nosso horário de atendimento é de: *Segunda a Quinta de 08:00hs às 18:00hs e Sexta de 08:00hs às 17:00hs*.",
  ];
  for (const pedido of pedidos) assert(isMakeupOrSlotMessage(pedido), pedido);
  for (const outro of ["a semana foi ótima, obrigada!", "gostei muito da teacher", "ok 😊"]) {
    assert(!isMakeupOrSlotMessage(outro), outro);
  }
  const reply = makeupWithTeacherReply("Mariana Pastro", "Lais Sampaio");
  assertEquals(reply, "Mariana, a reposição é combinada diretamente com a teacher Lais, antes do fim do mês 😉 É só falar com ela(e) e escolher juntos o melhor horário.");
  assert(!SEM_HORARIO.test(reply), reply);
  assert(makeupWithTeacherReply(null, null).startsWith("A reposição é combinada diretamente com seu professor"));
});

Deno.test("trava final: texto da IA com horário de reposição não sai para o aluno", () => {
  const ofertas = [
    "Nesse horário a teacher já tem aula. Ela tem livre:\n• Segunda 23/11 às 14:00\n• Segunda 23/11 às 15:30\n\nAlgum desses serve?",
    "A teacher Debora tem horário livre em: • Segunda 16/11 às 17:00 • Quinta 19/11 às 08:30. Quer um desses?",
    "Fechado: Sexta 13/11 às 09:30 com a Teacher Mateus — ela já ficou sabendo 😊",
    "Que tal quinta às 10h? A teacher tem disponibilidade.",
    "Posso marcar sua reposição para amanhã 18h?",
  ];
  for (const oferta of ofertas) assert(replyOffersSlot(oferta), oferta);
  for (const ok of [
    "Que bom saber! A reposição é combinada direto com a teacher Lais, antes do fim do mês 😉",
    "Entendi, vou passar para a coordenação.",
    "Fico feliz que a semana foi boa! O que você mais gostou?",
  ]) assert(!replyOffersSlot(ok), ok);
});

Deno.test("semanal e mensal: uma pergunta, sem questionário e sem nota", () => {
  const weekly = weeklyCheckinMessage({
    studentName: "Diná Santos",
    teacherName: "Bruna",
    classesThisWeek: 3,
  });
  assertEquals(
    weekly,
    "Oi, Diná! Como foi a semana de aulas com a teacher Bruna? Me conta o que você achou 😊",
  );
  const monthly = monthlyCheckinMessage({
    studentName: "Diná",
    teacherName: "Bruna",
    monthsEnrolled: 4,
  });
  assert(monthly.includes("faz 4 meses"), monthly);
  assert(monthly.includes("está te atendendo"), monthly);
  assert(!/\b[1-5]\b.*nota|nota de/i.test(monthly));
});

Deno.test("professor: cobrança de comparecimento vem com o texto pronto", () => {
  const msg = teacherAbsenceNudgeMessage({
    teacherName: "Lais Sampaio Conde",
    studentName: "Anderson Fernandes",
    classDate: "2026-09-16",
    quota: { limit: 4, used: 1 },
    freeSlots: slots,
  });
  assert(
    msg.startsWith("Teacher Lais, Anderson faltou em 16/09 e não respondeu"),
    msg,
  );
  assert(msg.includes("ainda tem 3 de 4 reposições"), msg);
  assert(
    msg.includes(
      'Sugestão: "Oi, Anderson! Senti sua falta em 16/09. Quer marcar a reposição? Tenho 18/09 às 09:00 ou 18/09 às 10:30."',
    ),
    msg,
  );
});

Deno.test("professor: política de remarcação — cobertura primeiro, aviso cedo, sem sermão", () => {
  const msg = teacherReschedulePolicyMessage({
    teacherName: "Flávio",
    reschedules30d: 2,
  });
  assert(msg.includes("2 remarcações"), msg);
  assert(msg.includes("*cobertura*"), msg);
  assert(msg.includes("Não vou conseguir dar aula dia X"), msg);
  assert(msg.includes("só se ele topar"), msg);
  assertEquals(quotaSentence(null), "");
});
