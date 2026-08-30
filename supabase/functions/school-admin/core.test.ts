/// <reference lib="deno.ns" />

import {
  hasExclusiveActiveTargetMembership,
  isEligibleForDunning,
  normalizeEnrollmentPlan,
  normalizeSchoolAdminAction,
} from "./core.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(callback: () => unknown, message: string): void {
  let rejected = false;
  try {
    callback();
  } catch {
    rejected = true;
  }
  assert(rejected, message);
}

Deno.test("school admin rejeita tenant e campos de autoridade do cliente", () => {
  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "setStudentLifecycle",
        studentId: "00000000-0000-4000-8000-000000000001",
        status: "suspended",
        tenantId: "tenant-b",
      }),
    "tenantId deveria ser rejeitado",
  );
  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "setStudentLifecycle",
        studentId: "00000000-0000-4000-8000-000000000001",
        status: "suspended",
        cancelBilling: false,
      }),
    "cancelamento financeiro nao pode ser desativado pelo cliente",
  );
  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "createEnrollmentOffer",
        leadId: "00000000-0000-4000-8000-000000000001",
        planId: "00000000-0000-4000-8000-000000000002",
        role: "SUPER_ADMIN",
      }),
    "role deveria ser rejeitada",
  );
  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "requestTrialReschedule",
        opportunityId: "00000000-0000-4000-8000-000000000001",
        requestedStartTime: "2027-08-21T15:00:00-03:00",
        teacherId: "00000000-0000-4000-8000-000000000002",
      }),
    "teacherId deve ser derivado no servidor",
  );
});

Deno.test("school admin aceita somente IDs e estados normalizados", () => {
  const action = normalizeSchoolAdminAction({
    action: "setTeacherLifecycle",
    teacherId: "00000000-0000-4000-8000-000000000001",
    status: "offboarded",
    reason: "  encerramento confirmado  ",
  });
  assert(action.action === "setTeacherLifecycle", "acao incorreta");
  assert(action.reason === "encerramento confirmado", "motivo nao normalizado");

  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "serasaNegativar",
        paymentId: "pay_123),tenant_id.neq.safe",
      }),
    "filtro injetavel deveria ser rejeitado",
  );
});

Deno.test("lifecycle exige um unico vinculo ativo e coerente do alvo", () => {
  const activeStudent = {
    tenant_id: "school-a",
    role: "STUDENT",
    status: "ACTIVE",
  };
  assert(
    hasExclusiveActiveTargetMembership(
      [activeStudent],
      "school-a",
      "STUDENT",
    ),
    "um unico vinculo ativo e coerente deveria ser aceito",
  );
  assert(
    !hasExclusiveActiveTargetMembership([], "school-a", "STUDENT"),
    "alvo sem membership deve falhar fechado",
  );
  assert(
    !hasExclusiveActiveTargetMembership(
      [{ ...activeStudent, status: "SUSPENDED" }],
      "school-a",
      "STUDENT",
    ),
    "membership inativa deve falhar fechado",
  );
  assert(
    !hasExclusiveActiveTargetMembership(
      [{ ...activeStudent, tenant_id: "school-b" }],
      "school-a",
      "STUDENT",
    ),
    "membership de outro tenant deve falhar fechado",
  );
  assert(
    !hasExclusiveActiveTargetMembership(
      [{ ...activeStudent, role: "TEACHER" }],
      "school-a",
      "STUDENT",
    ),
    "papel incoerente deve falhar fechado",
  );
  assert(
    !hasExclusiveActiveTargetMembership(
      [activeStudent, { ...activeStudent, tenant_id: "school-b" }],
      "school-a",
      "STUDENT",
    ),
    "perfil global multitenant nunca deve sofrer lifecycle por um tenant",
  );
});

Deno.test("negativacao exige cobranca marcada e realmente vencida", () => {
  assert(
    isEligibleForDunning("OVERDUE", "2026-08-20", "2026-08-21"),
    "cobranca vencida deveria ser elegivel",
  );
  assert(
    !isEligibleForDunning("PENDING", "2026-08-20", "2026-08-21"),
    "status pendente nao deveria negativar",
  );
  assert(
    !isEligibleForDunning("OVERDUE", "2026-08-21", "2026-08-21"),
    "vencimento de hoje nao deveria negativar",
  );
});

Deno.test("oferta usa somente plano comercial valido", () => {
  const plan = normalizeEnrollmentPlan({
    monthly_price: "229.00",
    fidelity_months: 12,
    classes_per_week: 3,
  });
  assert(plan.value === 229, "valor incorreto");
  assert(plan.planDuration === 12, "duracao incorreta");
  assert(plan.classesPerWeek === 3, "frequencia incorreta");

  rejects(
    () =>
      normalizeEnrollmentPlan({
        monthly_price: 1,
        fidelity_months: 24,
        classes_per_week: 3,
      }),
    "duracao nao suportada deveria ser rejeitada",
  );
});

Deno.test("oferta de matricula exige grade completa e termos de cobranca", () => {
  const action = normalizeSchoolAdminAction({
    action: "createEnrollmentOffer",
    leadId: "00000000-0000-4000-8000-000000000001",
    planId: "00000000-0000-4000-8000-000000000002",
    teacherId: "00000000-0000-4000-8000-000000000003",
    schedule: [
      { day: "Segunda-feira", time: "9:05" },
      { day: "Wednesday", time: "19:00" },
    ],
    startDate: "2099-01-05",
    billingStartMonth: "2099-02",
    dueDay: 10,
    enableProRata: true,
  });
  assert(action.action === "createEnrollmentOffer", "acao incorreta");
  assert(action.schedule[0].day === "Monday", "dia nao normalizado");
  assert(action.schedule[0].time === "09:05", "horario nao normalizado");
  const disabledProRataAction = normalizeSchoolAdminAction({
    ...action,
    enableProRata: false,
  });
  assert(
    disabledProRataAction.action === "createEnrollmentOffer" &&
      disabledProRataAction.enableProRata === false,
    "opt-out de pro-rata nao foi preservado",
  );

  rejects(
    () =>
      normalizeSchoolAdminAction({
        ...action,
        schedule: [
          { day: "Monday", time: "09:05" },
          { day: "Segunda", time: "09:05" },
        ],
      }),
    "grade duplicada deveria ser rejeitada",
  );
  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "createEnrollmentOffer",
        leadId: action.leadId,
        planId: action.planId,
      }),
    "oferta sem professor e grade deveria ser rejeitada",
  );
});

Deno.test("reagendamento aceita somente instante futuro com fuso explícito", () => {
  const requested = new Date(Date.now() + 60 * 60 * 1000);
  const action = normalizeSchoolAdminAction({
    action: "requestTrialReschedule",
    opportunityId: "00000000-0000-4000-8000-000000000001",
    requestedStartTime: requested.toISOString(),
  });
  assert(action.action === "requestTrialReschedule", "acao incorreta");
  assert(
    action.requestedStartTime === requested.toISOString(),
    "instante nao foi normalizado",
  );

  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "requestTrialReschedule",
        opportunityId: "00000000-0000-4000-8000-000000000001",
        requestedStartTime: "2099-01-01T12:00:00",
      }),
    "horario sem fuso deveria ser rejeitado",
  );
  rejects(
    () =>
      normalizeSchoolAdminAction({
        action: "requestTrialReschedule",
        opportunityId: "00000000-0000-4000-8000-000000000001",
        requestedStartTime: "2020-01-01T12:00:00-03:00",
      }),
    "horario passado deveria ser rejeitado",
  );
});
