/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import {
  handleRenewalManagementCommand,
  handleRenewalStudentMessage,
  handleRenewalTeacherReply,
  type RenewalBotDeps,
  type RpcResult,
} from "./renewal-bot.ts";

type Sent = { to: string; text: string };

function fakeDeps(responses: Record<string, unknown>, aiAnswer: unknown = null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const sent: Sent[] = [];
  const deps: RenewalBotDeps = {
    tenantId: "tenant-qa",
    schoolName: "Escola QA",
    portalUrl: "https://portal.example.invalid/",
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult> {
      calls.push({ fn, args });
      return Promise.resolve({ data: responses[fn] ?? null, error: null });
    },
    send(to: string, text: string) {
      sent.push({ to, text });
      return Promise.resolve(true);
    },
    log() {
      return Promise.resolve();
    },
    ai() {
      return Promise.resolve(aiAnswer);
    },
    managementGroup() {
      return Promise.resolve("120363400000000099@g.us");
    },
  };
  return { deps, calls, sent };
}

const student = { id: "student-1", name: "Aluna Sintética" };
const activeContext = {
  active: true,
  offer: { token: "a".repeat(64), monthly_fee_cents: 37700, classes_per_week: 5 },
  negotiation: null,
  teacher: { id: "teacher-1", name: "Teacher Sintética" },
};

Deno.test("aluno pede horários: abre negociação e pergunta ao professor atual", async () => {
  const { deps, calls, sent } = fakeDeps({
    renewal_negotiation_context: activeContext,
    open_renewal_negotiation: {
      ok: true, action: "ask_teacher", teacher_name: "Teacher Sintética", teacher_phone: "5511900000001",
      reply_code: "A1B2C3D4", slots: [{ day: "Segunda", time: "14:00" }, { day: "Terça", time: "14:30" }, { day: "Sexta", time: "14:30" }],
      busy_slots: [],
    },
  });
  const handled = await handleRenewalStudentMessage(deps, student, "5511900000009",
    "quero 3x: segunda as 14h e terça e sexta as 14:30", "msg-1");
  assertEquals(handled, true);
  const open = calls.find((call) => call.fn === "open_renewal_negotiation");
  assertEquals(open?.args.p_classes_per_week, 3);
  assertEquals(sent[0].to, "5511900000001");
  assertEquals(sent[0].text.includes("SIM #A1B2C3D4"), true);
  assertEquals(sent[1].to, "5511900000009");
});

Deno.test("aluno sem renovação aberta não é capturado", async () => {
  const { deps } = fakeDeps({ renewal_negotiation_context: { active: false } });
  assertEquals(await handleRenewalStudentMessage(deps, student, "55119", "oi", "msg-2"), false);
});

Deno.test("frequência sem dias pede os dias antes de abrir negociação", async () => {
  const { deps, calls, sent } = fakeDeps({ renewal_negotiation_context: activeContext });
  await handleRenewalStudentMessage(deps, student, "5511900000009", "quero 3 vezes por semana", "msg-3");
  assertEquals(calls.some((call) => call.fn === "open_renewal_negotiation"), false);
  assertEquals(sent[0].text.includes("Quais dias"), true);
});

Deno.test("dúvida vai para a IA com o link real e escala quando pedido", async () => {
  const { deps, sent } = fakeDeps({ renewal_negotiation_context: activeContext },
    { reply: "Aqui está o link.", handoff: true });
  await handleRenewalStudentMessage(deps, student, "5511900000009", "me manda o link de novo?", "msg-4");
  assertEquals(sent[0].text, "Aqui está o link.");
  assertEquals(sent[1].to, "120363400000000099@g.us");
});

Deno.test("professor aceita: Gestão recebe o pedido de aprovação com código", async () => {
  const { deps, sent } = fakeDeps({
    renewal_teacher_has_pending: true,
    respond_renewal_teacher_request: {
      ok: true, action: "await_management", approval_code: "C0FFEE11", student_name: "Aluna Sintética",
      student_phone: "5511900000009", teacher_name: "Teacher Sintética", classes_per_week: 3,
      slots: [{ day: "Segunda", time: "14:00" }], suggested_fee_cents: 26100,
    },
  });
  const handled = await handleRenewalTeacherReply(deps, { id: "teacher-1", name: "Teacher Sintética" },
    "5511900000001", "sim #A1B2C3D4", "msg-5");
  assertEquals(handled, true);
  const group = sent.find((message) => message.to === "120363400000000099@g.us");
  assertEquals(group?.text.includes("aprovar #C0FFEE11"), true);
  assertEquals(sent.some((message) => message.to === "5511900000009"), true);
});

Deno.test("professor sem pedido aberto não é capturado", async () => {
  const { deps } = fakeDeps({ renewal_teacher_has_pending: false });
  assertEquals(await handleRenewalTeacherReply(deps, { id: "t", name: "T" }, "55", "sim", "msg-6"), false);
});

Deno.test("Gestão aprova com valor e o grupo recebe a confirmação", async () => {
  const { deps, calls, sent } = fakeDeps({
    approve_renewal_negotiation: {
      ok: true, fee_cents: 26100, classes_per_week: 3, teacher_name: "Teacher Sintética",
      slots: [{ day: "Segunda", time: "14:00" }, { day: "Terça", time: "14:30" }, { day: "Sexta", time: "14:30" }],
    },
  });
  const handled = await handleRenewalManagementCommand(deps, "admin-1", "120363400000000099@g.us", "aprovar #C0FFEE11 261");
  assertEquals(handled, true);
  assertEquals(calls[0].args.p_fee_cents, 26100);
  assertEquals(sent[0].text.includes("R$ 261,00"), true);
});

Deno.test("aprovação sem gestor identificado é recusada sem chamar o banco", async () => {
  const { deps, calls, sent } = fakeDeps({});
  await handleRenewalManagementCommand(deps, null, "120363400000000099@g.us", "aprovar #C0FFEE11");
  assertEquals(calls.length, 0);
  assertEquals(sent[0].text.includes("Só diretor ou coordenação"), true);
});
