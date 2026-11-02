/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseConfirmationWithReason,
  parseTeacherRescheduleMessage,
  proposeRescheduleMove,
  rescheduleMoveAppliedMessage,
  rescheduleMoveConfirmationMessage,
  resolveDate,
} from "./teacher-reschedule-move.ts";

// Sexta 18/09/2026 10:00 (Brasília) — o dia do caso do Flávio.
const NOW = new Date(2026, 8, 18, 10, 0, 0);

Deno.test("remarca: 'a reposição do Theo passou para terça 15h'", () => {
  const e = parseTeacherRescheduleMessage(
    "A reposição do Theo passou para terça 15h",
    NOW,
  );
  assertEquals(e, {
    name: "theo",
    action: "remarcar",
    date: "2026-09-22",
    time: "15:00",
    fromTime: null,
    reason: null,
  });
});

Deno.test("remarca com origem e motivo: 'de hoje 20h passou para segunda 20h porque…'", () => {
  const e = parseTeacherRescheduleMessage(
    "A reposição da Milena de hoje 20h passou para segunda 20h porque ela pediu",
    NOW,
  );
  assert(e);
  assertEquals(e.action, "remarcar");
  assertEquals(e.name, "milena");
  assertEquals(e.date, "2026-09-21");
  assertEquals(e.time, "20:00");
  assertEquals(e.reason, "ela pediu");
});

Deno.test("marca: 'marca a reposição da Ana amanhã às 16:30'", () => {
  const e = parseTeacherRescheduleMessage(
    "Marca a reposição da Ana amanhã às 16:30",
    NOW,
  );
  assertEquals(e?.action, "marcar");
  assertEquals(e?.name, "ana");
  assertEquals(e?.date, "2026-09-19");
  assertEquals(e?.time, "16:30");
});

Deno.test("desmarca: 'desmarca a reposição do Vinícius, ele viajou'", () => {
  const e = parseTeacherRescheduleMessage(
    "Desmarca a reposição do Vinícius, ele viajou",
    NOW,
  );
  assertEquals(e?.action, "desmarcar");
  assertEquals(e?.name, "vinicius");
  assertEquals(e?.date, null);
});

Deno.test("sem a palavra reposição não é deste parser (troca de horário fixo tem o dela)", () => {
  assertEquals(
    parseTeacherRescheduleMessage("O Felipe trocou pra 14:30", NOW),
    null,
  );
  assertEquals(parseTeacherRescheduleMessage("bom dia!", NOW), null);
});

Deno.test("sem horário: entende a intenção e devolve o que falta", () => {
  const e = parseTeacherRescheduleMessage(
    "A reposição do Theo vai passar para terça",
    NOW,
  );
  assertEquals(e?.action, "remarcar");
  assertEquals(e?.time, null);
  assertEquals(e?.date, "2026-09-22");
});

Deno.test("resolveDate: dia da semana de hoje só é hoje se o horário ainda não passou; dd/mm; dia N", () => {
  assertEquals(resolveDate("sexta 15h", NOW, "15:00"), "2026-09-18");
  assertEquals(resolveDate("sexta 9h", NOW, "09:00"), "2026-09-25");
  assertEquals(resolveDate("22/09", NOW, null), "2026-09-22");
  assertEquals(resolveDate("dia 3", NOW, null), "2026-10-03");
  assertEquals(resolveDate("sábado", NOW, null), "2026-09-19");
});

const student = {
  student_id: "s1",
  student_name: "MILENA CARNEIRO",
  reschedules: [
    {
      id: "r-dated",
      date: "2026-09-18",
      time: "20:00",
      fault_type: "TEACHER",
      marcada: true,
    },
    {
      id: "r-open",
      date: "Pendente",
      time: "Pendente",
      fault_type: "STUDENT",
      marcada: false,
    },
  ],
};

Deno.test("propor: remarcar pega a marcada; marcar pega a sem data mais antiga; desmarcar pega a marcada", () => {
  const rem = proposeRescheduleMove({
    name: "milena",
    action: "remarcar",
    date: "2026-09-21",
    time: "20:00",
    fromTime: null,
    reason: null,
  }, student);
  assertEquals(rem.item?.reschedule_id, "r-dated");
  assertEquals(rem.item?.from_time, "20:00");
  const mar = proposeRescheduleMove({
    name: "milena",
    action: "marcar",
    date: "2026-09-21",
    time: "20:00",
    fromTime: null,
    reason: null,
  }, student);
  assertEquals(mar.item?.reschedule_id, "r-open");
  const des = proposeRescheduleMove({
    name: "milena",
    action: "desmarcar",
    date: null,
    time: null,
    fromTime: null,
    reason: null,
  }, student);
  assertEquals(des.item?.action, "desmarcar");
  assertEquals(des.item?.reschedule_id, "r-dated");
});

Deno.test("propor: duas marcadas sem dizer qual → pergunta o horário; com 'das 16:00' escolhe", () => {
  const two = {
    student_id: "s2",
    student_name: "Ana Clara Matedi",
    reschedules: [
      {
        id: "a",
        date: "2026-09-17",
        time: "16:00",
        fault_type: "TEACHER",
        marcada: true,
      },
      {
        id: "b",
        date: "2026-09-17",
        time: "16:30",
        fault_type: "TEACHER",
        marcada: true,
      },
    ],
  };
  const ask = proposeRescheduleMove({
    name: "ana",
    action: "remarcar",
    date: "2026-09-22",
    time: "15:00",
    fromTime: null,
    reason: null,
  }, two);
  assertEquals(ask.item, null);
  assert(ask.ask?.includes("2 reposições marcadas"));
  const pick = proposeRescheduleMove({
    name: "ana",
    action: "remarcar",
    date: "2026-09-22",
    time: "15:00",
    fromTime: "16:00",
    reason: null,
  }, two);
  assertEquals(pick.item?.reschedule_id, "a");
});

Deno.test("mensagens: confirmação pede motivo quando não veio; aplicada avisa a coordenação", () => {
  const msg = rescheduleMoveConfirmationMessage({
    item: {
      action: "remarcar",
      reschedule_id: "r",
      student_name: "MILENA CARNEIRO",
      from_date: "2026-09-18",
      from_time: "20:00",
      date: "2026-09-21",
      time: "20:00",
    },
    ask: null,
    ambiguous: null,
    unknownName: null,
    reason: null,
  });
  assert(msg.includes("sex 18/09 20:00 → *seg 21/09 20:00*"));
  assert(msg.includes("sim, aluno pediu"));
  const done = rescheduleMoveAppliedMessage({
    applied: [{
      action: "remarcar",
      reschedule_id: "r",
      student_name: "MILENA CARNEIRO",
      from_date: "2026-09-18",
      from_time: "20:00",
      date: "2026-09-21",
      time: "20:00",
      result: { event: { em_cima_da_hora: true } },
    }],
    errors: [{
      action: "marcar",
      reschedule_id: "x",
      student_name: "Theo Levi",
      from_date: null,
      from_time: null,
      date: "2026-09-10",
      time: "10:00",
      error: "teacher_reschedule_slot_must_be_future",
    }],
  });
  assert(
    done.includes("✅ Reposição de MILENA: *seg 21/09 20:00*") &&
      done.includes("em cima da hora"),
  );
  assert(done.includes("⚠️ Reposição de Theo: esse horário já passou"));
});

Deno.test("confirmação: 'sim, aluna pediu' traz o motivo com acento; 'não' cancela; outra coisa não é resposta", () => {
  assertEquals(parseConfirmationWithReason("Sim, aluna pediu pra terça"), {
    yes: true,
    reason: "aluna pediu pra terça",
  });
  assertEquals(parseConfirmationWithReason("sim"), { yes: true, reason: null });
  assertEquals(parseConfirmationWithReason("Não"), {
    yes: false,
    reason: null,
  });
  assertEquals(parseConfirmationWithReason("e a Ana?"), null);
});
