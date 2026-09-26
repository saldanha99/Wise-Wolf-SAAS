/// <reference lib="deno.ns" />

import {
  PLANNER_ACCESS_DENIED_MESSAGE,
  PLANNER_ACCESS_REASONS,
  PLANNER_ACCESS_RPC,
  type PlannerAccessArgs,
  type PlannerAccessRpc,
  teacherPlannerAccess,
} from "./access.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message?: string) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(
    actualJson === expectedJson,
    message ?? `expected ${expectedJson}, received ${actualJson}`,
  );
}

const subject = {
  teacherId: "00000000-0000-4000-8000-00000000fa03",
  studentId: "00000000-0000-4000-8000-00000000fb02",
  tenantId: "school-wise-wolf",
};

/** Banco de mentira: grava a chamada e devolve a resposta combinada. */
function fakeRpc(response: { data: unknown; error: unknown }) {
  const calls: Array<{ fn: string; args: PlannerAccessArgs }> = [];
  const rpc: PlannerAccessRpc = (fn, args) => {
    calls.push({ fn, args });
    return Promise.resolve(response);
  };
  return { rpc, calls };
}

Deno.test("pergunta ao banco pelo professor, aluno e escola certos", async () => {
  const { rpc, calls } = fakeRpc({ data: "COVERAGE", error: null });
  const access = await teacherPlannerAccess(rpc, subject);
  assertEquals(access, { kind: "allowed", reason: "COVERAGE" });
  assertEquals(calls, [{
    fn: PLANNER_ACCESS_RPC,
    args: {
      p_teacher_id: subject.teacherId,
      p_student_id: subject.studentId,
      p_tenant_id: subject.tenantId,
    },
  }]);
  assertEquals(PLANNER_ACCESS_RPC, "planner_teacher_can_access_student");
});

Deno.test("todo motivo do banco abre: agenda, segundo professor, titular, cobertura, reposição", async () => {
  assertEquals([...PLANNER_ACCESS_REASONS], [
    "BOOKING",
    "SECOND_TEACHER",
    "PRIMARY_TEACHER",
    "COVERAGE",
    "RESCHEDULE",
  ]);
  for (const reason of PLANNER_ACCESS_REASONS) {
    const { rpc } = fakeRpc({ data: reason, error: null });
    assertEquals(await teacherPlannerAccess(rpc, subject), {
      kind: "allowed",
      reason,
    });
  }
});

Deno.test("nulo ou resposta estranha é recusa (fail-closed)", async () => {
  for (
    const data of [null, undefined, "", "booking", "ADMIN", true, 1, {
      access_reason: "BOOKING",
    }, ["BOOKING"]]
  ) {
    const { rpc } = fakeRpc({ data, error: null });
    assertEquals(
      await teacherPlannerAccess(rpc, subject),
      { kind: "denied" },
      `resposta ${JSON.stringify(data)} abriu o aluno`,
    );
  }
});

Deno.test("sem professor, aluno ou escola nem pergunta ao banco", async () => {
  for (
    const partial of [
      { ...subject, teacherId: "" },
      { ...subject, studentId: "" },
      { ...subject, tenantId: "" },
    ]
  ) {
    const { rpc, calls } = fakeRpc({ data: "BOOKING", error: null });
    assertEquals(await teacherPlannerAccess(rpc, partial), { kind: "denied" });
    assertEquals(calls.length, 0);
  }
});

Deno.test("erro do banco é erro (503), não recusa nem acesso", async () => {
  const { rpc } = fakeRpc({ data: "BOOKING", error: { code: "42883" } });
  assertEquals(await teacherPlannerAccess(rpc, subject), {
    kind: "error",
    code: "42883",
  });

  const { rpc: noCode } = fakeRpc({ data: null, error: { message: "x" } });
  assertEquals(await teacherPlannerAccess(noCode, subject), {
    kind: "error",
    code: null,
  });

  const throwing: PlannerAccessRpc = () => Promise.reject(new Error("rede"));
  assertEquals(await teacherPlannerAccess(throwing, subject), {
    kind: "error",
    code: null,
  });
});

Deno.test("a recusa explica o que abre o aluno", () => {
  for (
    const phrase of [
      "agenda",
      "segundo professor",
      "dia anterior ao seguinte",
      "cobertura",
      "reposição",
    ]
  ) {
    assert(
      PLANNER_ACCESS_DENIED_MESSAGE.includes(phrase),
      `a mensagem de recusa não fala de ${phrase}`,
    );
  }
});
