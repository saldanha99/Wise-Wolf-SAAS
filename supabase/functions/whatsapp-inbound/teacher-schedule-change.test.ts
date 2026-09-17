/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  annotateConflicts,
  parseTeacherScheduleChange,
  proposeChanges,
  scheduleChangeAppliedMessage,
  scheduleChangeConfirmationMessage,
} from "./teacher-schedule-change.ts";

Deno.test("lê o pedido do Mateus: dois alunos, dois horários novos, sem dia", () => {
  const entries = parseTeacherScheduleChange(
    "O aluno Felipe trocou pra 14:30 e a Isabella para as 14",
  );
  assertEquals(entries, [
    {
      name: "felipe",
      newTime: "14:30",
      newDay: null,
      oldTime: null,
      oldDay: null,
    },
    {
      name: "isabella",
      newTime: "14:00",
      newDay: null,
      oldTime: null,
      oldDay: null,
    },
  ]);
});

Deno.test("origem e destino explícitos, com dia da semana", () => {
  const entries = parseTeacherScheduleChange(
    "A Ana Clara de segunda 14:00 passa para quarta às 15h30",
  );
  assertEquals(entries, [
    {
      name: "ana clara",
      newTime: "15:30",
      newDay: "Quarta",
      oldTime: "14:00",
      oldDay: "Segunda",
    },
  ]);
  assertEquals(
    parseTeacherScheduleChange("João mudou das 19h para as 20h")?.[0],
    {
      name: "joao",
      newTime: "20:00",
      newDay: null,
      oldTime: "19:00",
      oldDay: null,
    },
  );
});

Deno.test("mensagens que não são troca de horário não viram proposta", () => {
  assertEquals(parseTeacherScheduleChange("Bom dia! Tudo bem?"), null);
  assertEquals(
    parseTeacherScheduleChange("Não vou conseguir dar aula hoje"),
    null,
  );
  assertEquals(
    parseTeacherScheduleChange(
      "Só o João e Gabriel que tiveram coisas no trabalho",
    ),
    null,
  );
  assertEquals(parseTeacherScheduleChange("Ele faltou 3 dias"), null);
});

const felipe = {
  student_id: "s1",
  student_name: "Felipe de Souza Ramos",
  slots: [
    { booking_id: "b1", day: "Quarta", time: "14:00" },
    { booking_id: "b2", day: "Quinta", time: "14:00" },
    { booking_id: "b3", day: "Sexta", time: "14:00" },
  ],
};
const isabella = {
  student_id: "s2",
  student_name: "Isabella Navarro Araújo de Barros",
  slots: [
    { booking_id: "c1", day: "Segunda", time: "14:00" },
    { booking_id: "c2", day: "Terça", time: "14:00" },
    { booking_id: "c3", day: "Quinta", time: "20:30" },
  ],
};

Deno.test("sem dia: muda todas as aulas que ainda não estão no horário; as que já estão são ditas", () => {
  const entries = parseTeacherScheduleChange(
    "O aluno Felipe trocou pra 14:30 e a Isabella para as 14",
  )!;
  const f = proposeChanges(entries[0], felipe);
  assertEquals(f.changes.map((c) => `${c.day} ${c.old_time}→${c.new_time}`), [
    "Quarta 14:00→14:30",
    "Quinta 14:00→14:30",
    "Sexta 14:00→14:30",
  ]);
  const i = proposeChanges(entries[1], isabella);
  assertEquals(i.changes.map((c) => `${c.day} ${c.old_time}→${c.new_time}`), [
    "Quinta 20:30→14:00",
  ]);
  assertEquals(i.already.map((s) => s.day), ["Segunda", "Terça"]);
  const msg = scheduleChangeConfirmationMessage({
    students: [f, i],
    unknownNames: ["fulano"],
    ambiguous: [],
    effectiveFrom: "2026-09-18",
  });
  assert(
    msg.includes(
      "*Felipe de Souza Ramos*\n• Quarta 14:00 → 14:30\n• Quinta 14:00 → 14:30\n• Sexta 14:00 → 14:30",
    ),
    msg,
  );
  assert(msg.includes("• Quinta 20:30 → 14:00"), msg);
  assert(msg.includes("(Segunda 14:00, Terça 14:00 já estão assim)"), msg);
  assert(msg.includes("Não achei *fulano*"), msg);
  assert(msg.includes("Vale a partir de 18/09"), msg);
  assert(msg.includes("Confirma? Responda *sim* ou *não*."), msg);
});

Deno.test("com dia de origem, só aquela aula muda; troca de dia vai junto", () => {
  const entry = parseTeacherScheduleChange(
    "Ana Clara de segunda 14:00 passa para quarta às 15h30",
  )![0];
  const ana = {
    student_id: "s3",
    student_name: "Ana Clara Matedi",
    slots: [
      { booking_id: "d1", day: "Segunda", time: "14:00" },
      { booking_id: "d2", day: "Sexta", time: "14:00" },
    ],
  };
  const p = proposeChanges(entry, ana);
  assertEquals(p.changes, [{
    booking_id: "d1",
    day: "Segunda",
    old_time: "14:00",
    new_day: "Quarta",
    new_time: "15:30",
  }]);
});

Deno.test("resultado aula a aula: o que mudou, o que chocou (e com quem)", () => {
  const msg = scheduleChangeAppliedMessage({
    applied: [
      {
        student_name: "Felipe de Souza Ramos",
        day: "Quinta",
        old_time: "14:00",
        new_day: "Quinta",
        new_time: "14:30",
      },
      {
        student_name: "Felipe de Souza Ramos",
        day: "Sexta",
        old_time: "14:00",
        new_day: "Sexta",
        new_time: "14:30",
      },
    ],
    errors: [
      {
        student_name: "Felipe de Souza Ramos",
        day: "Quarta",
        old_time: "14:00",
        new_day: "Quarta",
        new_time: "14:30",
        occupant: "Ana Clara Sant’Ana",
        error: "Choque de agenda: Quarta às 14:30 já está ocupado.",
      },
    ],
    effectiveFrom: "2026-09-18",
  });
  assert(
    msg.startsWith(
      "✅ Atualizado a partir de 18/09:\n*Felipe de Souza Ramos*: Quinta 14:00 → 14:30, Sexta 14:00 → 14:30",
    ),
    msg,
  );
  assert(
    msg.includes(
      "⚠️ *Felipe* Quarta 14:00: Quarta 14:30 ocupado — Ana Clara Sant’Ana já está nesse horário. Ficou como estava.",
    ),
    msg,
  );
  assert(msg.includes("Gestão foi avisada"), msg);
});

Deno.test("choque é dito antes do confirma; slot que a própria proposta libera não é choque", () => {
  const felipe = {
    student_id: "f",
    student_name: "Felipe de Souza Ramos",
    already: [],
    changes: [
      {
        booking_id: "f-qua",
        day: "Quarta",
        old_time: "14:00",
        new_day: "Quarta",
        new_time: "14:30",
      },
      {
        booking_id: "f-qui",
        day: "Quinta",
        old_time: "14:00",
        new_day: "Quinta",
        new_time: "14:30",
      },
    ],
  };
  const isabella = {
    student_id: "i",
    student_name: "Isabella Navarro",
    already: [],
    changes: [
      {
        booking_id: "i-qui",
        day: "Quinta",
        old_time: "20:30",
        new_day: "Quinta",
        new_time: "14:00",
      },
    ],
  };
  const busy = [
    {
      booking_id: "a-qua",
      day: "Quarta",
      time: "14:30",
      student_name: "Ana Clara Sant’Ana",
    },
    {
      booking_id: "f-qua",
      day: "Quarta",
      time: "14:00",
      student_name: "Felipe de Souza Ramos",
    },
    {
      booking_id: "f-qui",
      day: "Quinta",
      time: "14:00",
      student_name: "Felipe de Souza Ramos",
    },
    {
      booking_id: "i-qui",
      day: "Quinta",
      time: "20:30",
      student_name: "Isabella Navarro",
    },
  ];
  const out = annotateConflicts([felipe, isabella], busy);
  assertEquals(out[0].changes.map((c) => c.day), ["Quinta"]);
  assertEquals(out[0].conflicts?.map((c) => c.occupant), [
    "Ana Clara Sant’Ana",
  ]);
  assertEquals(out[1].changes.length, 1); // quinta 14:00 vaga porque o Felipe sai de lá
  assertEquals(out[1].conflicts, []);
  const msg = scheduleChangeConfirmationMessage({
    students: out,
    unknownNames: [],
    ambiguous: [],
    effectiveFrom: "2026-09-18",
  });
  assert(
    msg.includes(
      "⚠️ Quarta 14:00 → 14:30: Quarta 14:30 já é de Ana — essa fica como está.",
    ),
    msg,
  );
  assert(msg.includes("• Quinta 14:00 → 14:30"), msg);
  assert(msg.includes("• Quinta 20:30 → 14:00"), msg);
  assert(msg.includes("Confirma?"), msg);
});
