/// <reference lib="deno.ns" />
import {
  combineAttendanceReports,
  findHeader,
  looksLikeAttendanceReport,
  meetingCodeFromUri,
  mergeAttendanceRows,
  namesOtherMeeting,
  parseAttendanceReport,
  parseCsv,
  parseDuration,
  parseTimeOnDate,
  pickAttendanceReport,
  pickAttendanceReports,
  summarizeAttendance,
} from "./attendance.ts";

function assertEquals(actual: unknown, expected: unknown, message = "") {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message}\n  esperado: ${e}\n  recebido: ${a}`);
  }
}

// Aula das 10:00 (BRT) = 13:00Z.
const START = "2026-09-26T13:00:00.000Z";

Deno.test("CSV com aspas, vírgula e quebra de linha dentro do campo", () => {
  assertEquals(
    parseCsv('﻿Nome,"Sobre, nome"\r\n"Ana ""A""",Silva\n'),
    [["Nome", "Sobre, nome"], ['Ana "A"', "Silva"]],
  );
});

Deno.test("acha o cabeçalho em português ou inglês, mesmo depois de linhas de título", () => {
  const pt = findHeader([
    ["Relatório de participação"],
    ["Código da reunião: abc-defg-hij"],
    [
      "Nome",
      "Sobrenome",
      "E-mail",
      "Duração",
      "Horário de entrada",
      "Horário de saída",
    ],
  ]);
  assertEquals(pt?.index, 2);
  assertEquals(pt?.columns.email, 2);
  assertEquals(pt?.columns.joined, 4);
  const en = findHeader([[
    "First name",
    "Last name",
    "Email",
    "Duration",
    "Time joined",
    "Time exited",
  ]]);
  assertEquals(en?.columns.exited, 5);
  assertEquals(findHeader([["Qualquer", "Coisa"]]), null);
});

Deno.test("duração em formatos do Google e ambígua vira nula", () => {
  assertEquals(parseDuration("35 min"), 2100);
  assertEquals(parseDuration("1 hr 5 min"), 3900);
  assertEquals(parseDuration("1 hora 2 minutos"), 3720);
  assertEquals(parseDuration("35 min 12 s"), 2112);
  assertEquals(parseDuration("00:35:12"), 2112);
  assertEquals(parseDuration("0:35"), null);
  assertEquals(parseDuration(""), null);
});

Deno.test("horário vira UTC no fuso da escola", () => {
  assertEquals(parseTimeOnDate("10:02", START), "2026-09-26T13:02:00.000Z");
  assertEquals(
    parseTimeOnDate("10:02:30 AM", START),
    "2026-09-26T13:02:30.000Z",
  );
  assertEquals(parseTimeOnDate("1:15 PM", START), "2026-09-26T16:15:00.000Z");
  assertEquals(
    parseTimeOnDate("26/09/2026 10:05", START),
    "2026-09-26T13:05:00.000Z",
  );
  assertEquals(
    parseTimeOnDate("Sep 26, 2026, 10:07:00 AM", START),
    "2026-09-26T13:07:00.000Z",
  );
  assertEquals(
    parseTimeOnDate("26 de set. de 2026 10:08", START),
    "2026-09-26T13:08:00.000Z",
  );
  assertEquals(
    parseTimeOnDate("2026-09-26T13:09:00Z", START),
    "2026-09-26T13:09:00.000Z",
  );
  assertEquals(parseTimeOnDate("", START), null);
  assertEquals(parseTimeOnDate("sem hora", START), null);
});

const REPORT = [
  "Relatório de participação",
  "Nome,Sobrenome,E-mail,Duração,Horário de entrada,Horário de saída",
  "Professora,Fixture,prof.fixture@example.com,28 min,10:04,10:32",
  "Aluno,Fixture,,25 min,10:06,10:31",
  "Wise,Wolf,escola@example.com,2 min,09:58,10:00",
].join("\n");

Deno.test("lê a planilha e separa professor, aluno e organizador", () => {
  const parsed = parseAttendanceReport(REPORT, START);
  if ("error" in parsed) throw new Error(parsed.error);
  assertEquals(parsed.rows.length, 3);
  assertEquals(parsed.rows[1].email, null);
  const summary = summarizeAttendance(parsed.rows, {
    teacherEmail: "Prof.Fixture@example.com",
    teacherName: "Professora Fixture",
    organizerEmail: "escola@example.com",
  });
  assertEquals(summary.participants.map((p) => p.role), [
    "TEACHER",
    "STUDENT",
    "ORGANIZER",
  ]);
  assertEquals(summary.teacherFirstJoinAt, "2026-09-26T13:04:00.000Z");
  assertEquals(summary.teacherSeconds, 1680);
  assertEquals(summary.studentFirstJoinAt, "2026-09-26T13:06:00.000Z");
  assertEquals(summary.studentSeconds, 1500);
});

Deno.test("professor sem e-mail no relatório é reconhecido pelo nome", () => {
  const summary = summarizeAttendance(
    [{
      name: "Professora Maria Fixture",
      email: null,
      joinedAt: START,
      leftAt: null,
      durationSeconds: 1800,
    }],
    {
      teacherEmail: "outra@example.com",
      teacherName: "Professora Fixture",
      organizerEmail: null,
    },
  );
  assertEquals(summary.participants[0].role, "TEACHER");
});

Deno.test("duração ausente sai de entrada × saída; planilha sem cabeçalho é erro", () => {
  const parsed = parseAttendanceReport(
    "First name,Last name,Email,Time joined,Time exited\nAna,Fixture,,10:00,10:30",
    START,
  );
  if ("error" in parsed) throw new Error(parsed.error);
  assertEquals(parsed.rows[0].durationSeconds, 1800);
  assertEquals(parseAttendanceReport("a,b\n1,2", START), {
    error: "attendance_header_not_found",
  });
});

Deno.test("escolhe a planilha da sala certa entre aulas simultâneas", () => {
  const candidates = [
    {
      id: "1",
      name: "abc-defg-hij - Relatório de participação",
      csv: "prof.a@example.com",
    },
    {
      id: "2",
      name: "xyz-wxyz-klm - Relatório de participação",
      csv: "prof.b@example.com",
    },
  ];
  assertEquals(pickAttendanceReport(candidates, "xyz-wxyz-klm", null)?.id, "2");
  const noCode = [
    { id: "1", name: "Relatório", csv: "prof.a@example.com" },
    { id: "2", name: "Relatório", csv: "prof.b@example.com" },
  ];
  assertEquals(
    pickAttendanceReport(noCode, "abc-defg-hij", "PROF.B@example.com")?.id,
    "2",
  );
  assertEquals(pickAttendanceReport(noCode, null, null), null);
  assertEquals(
    meetingCodeFromUri("https://meet.google.com/abc-defg-hij"),
    "abc-defg-hij",
  );
  assertEquals(meetingCodeFromUri(null), null);
});

Deno.test("plano B só abre planilha com nome de relatório de presença", () => {
  // Nome real medido em 26/09/2026 na conta central.
  assertEquals(
    looksLikeAttendanceReport(
      "Relatório de participação em fxj-hykv-jev (2026-09-26 14:41)",
    ),
    true,
  );
  assertEquals(looksLikeAttendanceReport("Attendance report - abc"), true);
  assertEquals(looksLikeAttendanceReport("Lista de presença"), true);
  assertEquals(
    looksLikeAttendanceReport("Controle financeiro setembro"),
    false,
  );
  assertEquals(looksLikeAttendanceReport("Folha dos professores"), false);
});

Deno.test("aulas seguidas do mesmo professor: plano B não pega o relatório da aula anterior", () => {
  // 14:00 na sala abc-defg-hij, 14:30 na fxj-hykv-jev; o relatório das 14:30
  // ainda não saiu e o das 14:00 cita o mesmo professor.
  const anterior = {
    id: "anterior",
    name: "Relatório de participação em abc-defg-hij (2026-09-26 14:00)",
    csv: "Nome,E-mail\nProf,prof@example.com\nAluno A,aluno.a@example.com",
  };
  assertEquals(
    pickAttendanceReport([anterior], "fxj-hykv-jev", "prof@example.com"),
    null,
  );
  // Quando o relatório certo chega, é ele.
  const certo = {
    id: "certo",
    name: "Relatório de participação em fxj-hykv-jev (2026-09-26 14:30)",
    csv: "Nome,E-mail\nProf,prof@example.com",
  };
  assertEquals(
    pickAttendanceReport([anterior, certo], "fxj-hykv-jev", "prof@example.com")
      ?.id,
    "certo",
  );
  assertEquals(namesOtherMeeting(anterior.name, "fxj-hykv-jev"), true);
  assertEquals(namesOtherMeeting(certo.name, "fxj-hykv-jev"), false);
  assertEquals(namesOtherMeeting("Relatório", "fxj-hykv-jev"), false);
});

// ---- Queda e reentrada: mais de um relatório da MESMA sala (20260926170000) ----
const HEADER =
  "Nome,Sobrenome,E-mail,Duração,Horário de entrada,Horário de saída";
const PRIMEIRA = [
  HEADER,
  "Professora,Fixture,prof.fixture@example.com,12 min,10:03,10:15",
  "Aluno,Fixture,,11 min,10:04,10:15",
].join("\n");
// Caiu às 10:15, todos saíram; voltaram às 10:17 (nova conferência, nova planilha).
const SEGUNDA = [
  HEADER,
  "Professora,Fixture,prof.fixture@example.com,15 min,10:17,10:32",
  "Aluno,Fixture,,14 min,10:18,10:32",
].join("\n");

Deno.test("junta as linhas da mesma pessoa: primeira entrada, última saída e soma do tempo", () => {
  const a = parseAttendanceReport(PRIMEIRA, START);
  const b = parseAttendanceReport(SEGUNDA, START);
  if ("error" in a || "error" in b) {
    throw new Error("planilha de teste inválida");
  }
  const merged = mergeAttendanceRows([...a.rows, ...b.rows]);
  assertEquals(merged.length, 2);
  assertEquals(merged[0].email, "prof.fixture@example.com");
  assertEquals(merged[0].joinedAt, "2026-09-26T13:03:00.000Z");
  assertEquals(merged[0].leftAt, "2026-09-26T13:32:00.000Z");
  assertEquals(merged[0].durationSeconds, 27 * 60);
  // Sem e-mail, o aluno é juntado pelo nome.
  assertEquals(merged[1].durationSeconds, 25 * 60);
  assertEquals(merged[1].joinedAt, "2026-09-26T13:04:00.000Z");
  const summary = summarizeAttendance(merged, {
    teacherEmail: "prof.fixture@example.com",
    teacherName: null,
    organizerEmail: null,
  });
  assertEquals(summary.teacherSeconds, 27 * 60);
  assertEquals(summary.studentSeconds, 25 * 60);
});

Deno.test("duração ausente dos dois lados continua ausente", () => {
  const merged = mergeAttendanceRows([
    {
      name: "Ana",
      email: null,
      joinedAt: null,
      leftAt: null,
      durationSeconds: null,
    },
    {
      name: "ana ",
      email: null,
      joinedAt: START,
      leftAt: null,
      durationSeconds: null,
    },
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].durationSeconds, null);
  assertEquals(merged[0].joinedAt, START);
});

Deno.test("todas as planilhas com o código da sala entram; sem código, o plano B pega uma só", () => {
  const code = "fxj-hykv-jev";
  const candidates = [
    {
      id: "a",
      name: `Relatório de participação em ${code} (2026-09-26 10:15)`,
    },
    {
      id: "b",
      name: `Relatório de participação em ${code} (2026-09-26 10:32)`,
    },
    {
      id: "c",
      name: "Relatório de participação em abc-defg-hij (2026-09-26 10:30)",
    },
  ];
  assertEquals(pickAttendanceReports(candidates, code, null).map((c) => c.id), [
    "a",
    "b",
  ]);
  // Antes, duas com o mesmo código faziam o plano B desistir e a presença sumia.
  assertEquals(pickAttendanceReport(candidates, code, null), null);
  const semCodigo = [
    { id: "x", name: "Relatório", csv: "prof@example.com" },
    { id: "y", name: "Relatório", csv: "outra@example.com" },
  ];
  assertEquals(
    pickAttendanceReports(semCodigo, code, "prof@example.com").map((c) => c.id),
    ["x"],
  );
  assertEquals(pickAttendanceReports(semCodigo, code, null), []);
});

Deno.test("relatórios combinados: ordem de criação, ids guardados e planilha ilegível não derruba as outras", () => {
  const combined = combineAttendanceReports([
    {
      id: "b",
      name: "segunda",
      csv: SEGUNDA,
      createdTime: "2026-09-26T13:32:02Z",
    },
    {
      id: "ruim",
      name: "ruim",
      csv: "a,b\n1,2",
      createdTime: "2026-09-26T13:40:00Z",
    },
    {
      id: "a",
      name: "primeira",
      csv: PRIMEIRA,
      createdTime: "2026-09-26T13:15:02Z",
    },
  ], START);
  assertEquals(combined.documentIds, ["a", "b", "ruim"]);
  assertEquals(combined.documentId, "a");
  assertEquals(combined.documentName, "primeira + segunda + ruim");
  assertEquals(combined.parseError, null);
  assertEquals(combined.rows.length, 2);
  assertEquals(combined.sourceCsv.startsWith(PRIMEIRA), true);
  const nenhuma = combineAttendanceReports(
    [{ id: "ruim", name: "ruim", csv: "a,b\n1,2" }],
    START,
  );
  assertEquals(nenhuma.parseError, "attendance_header_not_found");
  assertEquals(nenhuma.rows, []);
});
