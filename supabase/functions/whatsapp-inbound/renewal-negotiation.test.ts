/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import {
  classifyRenewalTeacherReply,
  classifyTeacherChoice,
  managementRenewalApprovalMessage,
  parseRenewalFrequency,
  parseRenewalManagementCommand,
  parseRenewalSlots,
  renewalReplyCode,
  renewalSlotsText,
  teacherChoiceQuestionMessage,
  teacherRenewalRequestMessage,
} from "./renewal-negotiation.ts";

Deno.test("escolha da professora: sim segue, outro troca, negação de troca segue", () => {
  const teacher = "Debora Sintética";
  assertEquals(classifyTeacherChoice("sim", teacher), "KEEP");
  assertEquals(
    classifyTeacherChoice("quero continuar com ela", teacher),
    "KEEP",
  );
  assertEquals(classifyTeacherChoice("Adoro a Débora!", teacher), "KEEP");
  assertEquals(classifyTeacherChoice("não quero trocar", teacher), "KEEP");
  assertEquals(classifyTeacherChoice("outro professor", teacher), "OTHER");
  assertEquals(
    classifyTeacherChoice("sim, mas prefiro outra", teacher),
    "OTHER",
  );
  assertEquals(classifyTeacherChoice("não", teacher), "OTHER");
  assertEquals(classifyTeacherChoice("não sei ainda", teacher), "UNKNOWN");
  assertEquals(classifyTeacherChoice("", teacher), "UNKNOWN");
});

Deno.test("a pergunta sobre a professora é positiva e oferece as duas saídas", () => {
  const message = teacherChoiceQuestionMessage({
    teacherName: "Debora Sintética",
    scheduleChange: false,
  });
  assertEquals(
    message.includes("feliz com as aulas com a teacher Debora"),
    true,
  );
  assertEquals(
    message.includes("*sim*") && message.includes("*outro professor*"),
    true,
  );
});

Deno.test("lê o pedido real: segunda 14h, terça e sexta 14:30", () => {
  assertEquals(
    parseRenewalSlots(
      "segunda as 14H e terça e sesta as 14:30".replace("sesta", "sexta"),
    ),
    [
      { day: "Segunda", time: "14:00" },
      { day: "Terça", time: "14:30" },
      { day: "Sexta", time: "14:30" },
    ],
  );
});

Deno.test("um horário vale para os dias citados antes dele", () => {
  assertEquals(parseRenewalSlots("seg, qua e sex às 9h30"), [
    { day: "Segunda", time: "09:30" },
    { day: "Quarta", time: "09:30" },
    { day: "Sexta", time: "09:30" },
  ]);
});

Deno.test("horário antes dos dias também vale", () => {
  assertEquals(parseRenewalSlots("14:30 na terça e na quinta"), [
    { day: "Terça", time: "14:30" },
    { day: "Quinta", time: "14:30" },
  ]);
});

Deno.test("palavras que começam como dia não viram dia", () => {
  assertEquals(parseRenewalSlots("quando der, qualquer hora terá aula"), []);
});

Deno.test("frequência em número ou por extenso", () => {
  assertEquals(parseRenewalFrequency("quero 3x por semana"), 3);
  assertEquals(parseRenewalFrequency("três vezes na semana"), 3);
  assertEquals(parseRenewalFrequency("sem frequência"), null);
});

Deno.test("resposta do professor: sim, não e contraproposta", () => {
  assertEquals(classifyRenewalTeacherReply("SIM #A1B2C3D4"), {
    decision: "ACCEPT",
  });
  assertEquals(classifyRenewalTeacherReply("não consigo #A1B2C3D4"), {
    decision: "DECLINE",
  });
  assertEquals(
    classifyRenewalTeacherReply("não dá, mas posso seg 15h, qua 15h e sex 15h"),
    {
      decision: "COUNTER",
      slots: [
        { day: "Segunda", time: "15:00" },
        { day: "Quarta", time: "15:00" },
        { day: "Sexta", time: "15:00" },
      ],
    },
  );
  assertEquals(classifyRenewalTeacherReply("vou ver e te falo"), {
    decision: "UNKNOWN",
  });
});

Deno.test("o código da mensagem não é lido como horário", () => {
  assertEquals(classifyRenewalTeacherReply("#1A2B3C4D sim"), {
    decision: "ACCEPT",
  });
  assertEquals(renewalReplyCode("sim #1a2b3c4d"), "1A2B3C4D");
});

Deno.test("comando da Gestão: aprovar com e sem valor, recusar", () => {
  assertEquals(parseRenewalManagementCommand("aprovar #A1B2C3D4"), {
    action: "approve",
    code: "A1B2C3D4",
    feeCents: null,
  });
  assertEquals(parseRenewalManagementCommand("Aprovar A1B2C3D4 R$ 261,00"), {
    action: "approve",
    code: "A1B2C3D4",
    feeCents: 26100,
  });
  assertEquals(parseRenewalManagementCommand("aprovar #a1b2c3d4 261"), {
    action: "approve",
    code: "A1B2C3D4",
    feeCents: 26100,
  });
  assertEquals(parseRenewalManagementCommand("recusar #A1B2C3D4"), {
    action: "decline",
    code: "A1B2C3D4",
  });
  assertEquals(
    parseRenewalManagementCommand("vamos aprovar isso depois"),
    null,
  );
});

Deno.test("mensagens carregam o código e os horários", () => {
  const slots = [{ day: "Segunda", time: "14:00" }, {
    day: "Terça",
    time: "14:30",
  }];
  assertEquals(renewalSlotsText(slots), "Segunda 14:00 e Terça 14:30");
  const teacher = teacherRenewalRequestMessage({
    teacherName: "Teacher Sintética",
    studentName: "Aluna Sintética",
    classesPerWeek: 2,
    slots,
    busySlots: [],
    code: "A1B2C3D4",
    currentTeacher: true,
  });
  assertEquals(
    teacher.includes("SIM #A1B2C3D4") &&
      teacher.includes("Segunda 14:00 e Terça 14:30"),
    true,
  );
  const management = managementRenewalApprovalMessage({
    studentName: "Aluna Sintética",
    teacherName: "Teacher Sintética",
    classesPerWeek: 2,
    slots,
    suggestedFeeCents: 26100,
    code: "A1B2C3D4",
  });
  assertEquals(
    management.includes("R$ 261,00") &&
      management.includes("aprovar #A1B2C3D4"),
    true,
  );
});
