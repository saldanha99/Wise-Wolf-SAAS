/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  absenceFollowupMessage,
  monthlyCheckinMessage,
  quotaSentence,
  teacherAbsenceNudgeMessage,
  teacherReschedulePolicyMessage,
  weeklyCheckinMessage,
} from "./care-messages.ts";

const slots = [
  { date: "2026-09-18", day: "Sexta", time: "09:00", label: "18/09 às 09:00" },
  { date: "2026-09-18", day: "Sexta", time: "10:30", label: "18/09 às 10:30" },
];

Deno.test("falta de ontem: acolhe, diz o direito (4 por mês) e oferece horário", () => {
  const msg = absenceFollowupMessage({
    studentName: "Mariana Pastro Morais",
    teacherName: "Lais Sampaio Conde",
    classDate: "2026-09-16",
    quota: { limit: 4, used: 1 },
    freeSlots: slots,
  });
  assert(
    msg.startsWith(
      "Oi, Mariana! Sentimos sua falta na aula de 16/09 com a teacher Lais",
    ),
    msg,
  );
  assert(
    msg.includes("direito a 4 reposições por mês — este mês ainda sobram 3"),
    msg,
  );
  assert(msg.includes("• Sexta 18/09 às 09:00"), msg);
  assert(msg.includes("Quer um desses, ou prefere outro dia?"), msg);
});

Deno.test("acima das 4 por direito: reposição vira combinação com a teacher, sem obrigação", () => {
  const msg = absenceFollowupMessage({
    studentName: "Anderson",
    teacherName: "Lais",
    classDate: "2026-09-16",
    quota: { limit: 4, used: 5 },
    freeSlots: slots,
  });
  assert(msg.includes("já usou as 4 reposições por direito"), msg);
  assert(msg.includes("sem obrigação"), msg);
  assert(
    !msg.includes("• Sexta"),
    "acima do direito não lista horário como se fosse garantido",
  );
});

Deno.test("sem horário livre: pergunta em vez de listar", () => {
  const msg = absenceFollowupMessage({
    studentName: "Ana",
    teacherName: null,
    classDate: "2026-09-16",
    quota: { limit: 4, used: 0 },
    freeSlots: [],
  });
  assert(
    msg.includes(
      "Quer que eu veja um horário para repor, com a teacher ou com outro professor?",
    ),
    msg,
  );
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
