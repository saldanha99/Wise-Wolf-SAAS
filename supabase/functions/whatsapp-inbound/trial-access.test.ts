import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  asksLessonAccess,
  loadTrialAccess,
  safeLessonAccessLink,
  schoolModalityFacts,
  trialAccessReply,
  vetoInventedPresential,
} from "./trial-access.ts";

const trial = {
  appointmentId: "appointment-1",
  opportunityId: "opportunity-1",
  teacherId: "teacher-1",
  teacherName: "Professora",
  teacherPhone: null,
  startIso: "2026-10-06T00:00:00Z",
};
const link = "https://meet.google.com/abc-defg-hij";
function fixture(overrides: Record<string, unknown> = {}, official = false) {
  const calls: string[] = [];
  const appointment = {
    id: trial.appointmentId,
    tenant_id: "school-wise-wolf",
    student_phone: "5511999999999",
    teacher_id: trial.teacherId,
    type: "experimental",
    start_time: trial.startIso,
    status: "scheduled",
    meeting_link: null,
    ...overrides,
  };
  const teacher = {
    id: trial.teacherId,
    tenant_id: "school-wise-wolf",
    role: "TEACHER",
    status: "Ativo",
    meeting_link: link,
  };
  const sb = {
    from(table: string) {
      calls.push(table);
      const data = table === "appointments"
        ? appointment
        : table === "profiles"
        ? teacher
        : official
        ? [{ id: "occurrence-1" }]
        : [];
      const query: any = {
        data,
        error: null,
        select: () => query,
        eq: () => query,
        neq: () => query,
        limit: () => Promise.resolve({ data, error: null }),
        maybeSingle: () => Promise.resolve({ data, error: null }),
      };
      return query;
    },
    rpc(name: string) {
      calls.push(name);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { sb, calls, teacher };
}
const now = Date.parse("2026-10-06T00:02:50Z");
const match = (a: string, b: string) => a === b;
const read = (sb: any) =>
  loadTrialAccess(sb, "school-wise-wolf", "5511999999999", trial, match, now);

Deno.test("pedido real e variantes são acesso; preço/matrícula/remarcação não são", () => {
  for (
    const text of [
      "Tem link da aula para acessar pelo met",
      "Olá tudo bem? Tem link da aula?",
      "Cadê o link?",
      "Não consigo entrar no Meet",
      "qual o link da experimental?",
    ]
  ) assert(asksLessonAccess(text), text);
  for (
    const text of [
      "quero link do contrato",
      "quanto custa",
      "preciso remarcar para amanhã",
      "qual o link de matrícula?",
    ]
  ) assertEquals(asksLessonAccess(text), false, text);
});
Deno.test("modalidade sem cidade nem presencial inventado; outras escolas não ganham regra Wise Wolf", () => {
  assert(schoolModalityFacts("school-wise-wolf").includes("são online"));
  assert(!schoolModalityFacts("outra-escola").includes("são online"));
  const fake =
    "A aula experimental é presencial aqui em Santa Isabel/SP. Qual dia para nos visitar?";
  assertEquals(
    vetoInventedPresential("school-wise-wolf", fake),
    "Nossas aulas, inclusive a experimental, são online. Não é necessário ir a uma unidade presencial.",
  );
  assertEquals(vetoInventedPresential("outra-escola", fake), fake);
});
Deno.test("link só vem de cadastro seguro, nunca de código inventado/modelo", () => {
  for (
    const value of [
      "javascript:alert(1)",
      "http://meet.google.com/abc-defg-hij",
      "https://meet.google.com.evil.org/abc-defg-hij",
      "https://user:pass@meet.google.com/abc-defg-hij",
      "https://meet.google.com/link-inventado",
      "https://example.com/aula",
      null,
    ]
  ) assertEquals(safeLessonAccessLink(value), null);
  assertEquals(safeLessonAccessLink(link), link);
});
Deno.test("experimental em andamento usa link cadastrado da professora e não escreve", async () => {
  const { sb, calls } = fixture();
  const access = await read(sb);
  assertEquals(access.link, link);
  assertEquals(calls, ["appointments", "lesson_occurrences", "profiles"]);
  assertEquals(
    trialAccessReply("school-wise-wolf", access),
    `O link cadastrado para sua aula experimental é: ${link}`,
  );
});
Deno.test("sem link confirmado encaminha sem convite/horário/room creation", async () => {
  const { sb, teacher } = fixture();
  teacher.meeting_link = "";
  const access = await read(sb);
  assertEquals(access.link, null);
  const reply = trialAccessReply("school-wise-wolf", access);
  assert(reply.includes("online"));
  assert(reply.includes("equipe"));
  assert(!/presencial|agendar|marcar|https:/.test(reply));
});
Deno.test("sala oficial não pronta/barrada nunca cai no link pessoal", async () => {
  const { sb, calls } = fixture({}, true);
  assertEquals((await read(sb)).link, null);
  assert(calls.includes("official_lesson_link"));
  assert(!calls.includes("profiles"));
});
Deno.test("professor, telefone, tenant, horário e status divergentes vetam o acesso", async () => {
  for (
    const override of [
      { teacher_id: "outro" },
      { student_phone: "5511888888888" },
      { tenant_id: "outra" },
      { start_time: "2026-10-07T00:00:00Z" },
      { status: "completed" },
      { status: "cancelled" },
    ]
  ) {
    const { sb, calls } = fixture(override);
    assertEquals((await read(sb)).link, null);
    assertEquals(calls, ["appointments"]);
  }
});
Deno.test("aula esquecida no scheduled não entrega sala antiga; falha do banco fecha o acesso", async () => {
  const { sb } = fixture();
  assertEquals(
    (await loadTrialAccess(
      sb,
      "school-wise-wolf",
      "5511999999999",
      trial,
      match,
      now + 86_400_000,
    )).reason,
    "trial_ended",
  );
  let failed = false;
  try {
    await read({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ maybeSingle: () => ({ data: null, error: {} }) }),
          }),
        }),
      }),
    });
  } catch {
    failed = true;
  }
  assert(failed);
});
