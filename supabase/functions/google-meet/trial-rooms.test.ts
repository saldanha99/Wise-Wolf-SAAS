/// <reference lib="deno.ns" />
import {
  type TrialAttendanceInput,
  trialAttendanceOutcome,
  trialConferenceWindow,
} from "./trial-rooms.ts";

function assertEquals(actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
function assertThrows(fn: () => unknown) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error("esperava erro");
}

const base: TrialAttendanceInput = {
  conferenceCount: 1,
  conferenceOpen: false,
  reportFound: true,
  parseError: false,
  teacherSeconds: 1800,
  leadSeconds: 1700,
  minMinutes: 10,
  final: false,
};
const run = (patch: Partial<TrialAttendanceInput>) =>
  trialAttendanceOutcome({ ...base, ...patch });

Deno.test("professor e lead juntos na sala = aula dada", () => {
  assertEquals(run({}), "ATTENDED");
  assertEquals(run({ teacherSeconds: 600, leadSeconds: 600 }), "ATTENDED");
});

Deno.test("professor esperou e o lead não entrou = não veio", () => {
  assertEquals(run({ leadSeconds: 0 }), "NO_SHOW");
  assertEquals(run({ leadSeconds: 30 }), "NO_SHOW");
});

Deno.test("professor não entrou nunca vira não veio do lead", () => {
  assertEquals(run({ teacherSeconds: 0, leadSeconds: 1500 }), "TEACHER_ABSENT");
  assertEquals(run({ teacherSeconds: 0, leadSeconds: 0 }), "TEACHER_ABSENT");
});

Deno.test("presença curta dos dois não decide sozinha", () => {
  assertEquals(run({ leadSeconds: 240 }), "UNCERTAIN");
  assertEquals(run({ teacherSeconds: 300, leadSeconds: 0 }), "UNCERTAIN");
});

Deno.test("conferência aberta espera a próxima rodada", () => {
  assertEquals(run({ conferenceOpen: true, final: true }), null);
});

Deno.test("sem sala nem relatório só encerra na última rodada", () => {
  assertEquals(run({ conferenceCount: 0 }), null);
  assertEquals(run({ conferenceCount: 0, final: true }), "NO_CONFERENCE");
  assertEquals(run({ reportFound: false }), null);
  assertEquals(run({ reportFound: false, final: true }), "NO_REPORT");
});

Deno.test("planilha ilegível fica para a direção", () => {
  assertEquals(run({ parseError: true }), "UNCERTAIN");
});

Deno.test("mínimo nunca abaixo de 5 minutos", () => {
  assertEquals(
    run({ minMinutes: 1, teacherSeconds: 200, leadSeconds: 200 }),
    "UNCERTAIN",
  );
});

Deno.test("janela da conferência: 2 h antes até 4 h depois", () => {
  assertEquals(trialConferenceWindow("2026-11-03T22:00:00.000Z"), {
    start: "2026-11-03T20:00:00.000Z",
    end: "2026-11-04T02:00:00.000Z",
  });
  assertThrows(() => trialConferenceWindow("x"));
});
