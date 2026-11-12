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

Deno.test("falta: mensagem curta, sem cota, sem horários (direção, 12/11/2026)", () => {
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
      "Oi, Mariana! Não conseguiu comparecer? Combine sua reposição diretamente com seu professor.",
    );
    assert(!/reposições por|usou as|• Sexta|horário livre/.test(msg), msg);
  }
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
