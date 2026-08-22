/// <reference lib="deno.ns" />

import {
  insightTenantMatch,
  isOperationalSaasStatus,
  resolveInsightTenantScope,
} from "./tenant-scope.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const student = {
  id: "student-shared",
};
const memberships = [
  { tenant_id: "school-a", role: "STUDENT" as const },
  { tenant_id: "school-b", role: "STUDENT" as const },
];

Deno.test("multi-tenant student insight follows the caller active context", () => {
  for (const tenantId of ["school-a", "school-b"]) {
    assertEquals(
      resolveInsightTenantScope({
        caller: {
          id: `admin-${tenantId}`,
          role: "SCHOOL_ADMIN",
          tenant_id: tenantId,
        },
        student,
        authorizedTenantId: tenantId,
        activeStudentMemberships: memberships,
        teacherHasTenantAssignment: false,
      }),
      { ok: true, tenantId },
      `the ${tenantId} context must select only its student membership`,
    );
  }
});

Deno.test("legacy profile tenant cannot revive an inactive target membership", () => {
  assertEquals(
    resolveInsightTenantScope({
      caller: {
        id: "admin-a",
        role: "SCHOOL_ADMIN",
        tenant_id: "school-a",
      },
      student,
      authorizedTenantId: "school-a",
      activeStudentMemberships: [memberships[1]],
      teacherHasTenantAssignment: false,
    }),
    { ok: false, error: "target_membership_inactive", status: 403 },
    "the target must have an ACTIVE STUDENT membership in the caller tenant",
  );
});

Deno.test("non-super callers cannot override their authenticated tenant", () => {
  assertEquals(
    resolveInsightTenantScope({
      caller: {
        id: "admin-a",
        role: "SCHOOL_ADMIN",
        tenant_id: "school-a",
      },
      student,
      authorizedTenantId: "school-b",
      activeStudentMemberships: memberships,
      teacherHasTenantAssignment: false,
    }),
    { ok: false, error: "forbidden", status: 403 },
    "a server-derived caller context must not be replaceable",
  );
});

Deno.test("student self access and teacher assignment remain tenant scoped", () => {
  assertEquals(
    resolveInsightTenantScope({
      caller: {
        id: student.id,
        role: "STUDENT",
        tenant_id: "school-b",
      },
      student,
      authorizedTenantId: "school-b",
      activeStudentMemberships: memberships,
      teacherHasTenantAssignment: false,
    }),
    { ok: true, tenantId: "school-b" },
    "the student must use the selected active membership",
  );
  for (const [tenantId, teacherHasTenantAssignment] of [
    ["school-a", false],
    ["school-b", true],
  ] as const) {
    assertEquals(
      resolveInsightTenantScope({
        caller: {
          id: "teacher-b",
          role: "TEACHER",
          tenant_id: tenantId,
        },
        student,
        authorizedTenantId: tenantId,
        activeStudentMemberships: memberships,
        teacherHasTenantAssignment,
      }),
      teacherHasTenantAssignment
        ? { ok: true, tenantId: "school-b" }
        : { ok: false, error: "forbidden", status: 403 },
      `the tenant-scoped booking must control teacher access in ${tenantId}`,
    );
  }
});

Deno.test("super admin requires an explicit active tenant context", () => {
  const caller = {
    id: "super-admin",
    role: "SUPER_ADMIN",
    tenant_id: "legacy-school",
  };
  assertEquals(
    resolveInsightTenantScope({
      caller,
      student,
      authorizedTenantId: null,
      activeStudentMemberships: memberships,
      teacherHasTenantAssignment: false,
    }),
    { ok: false, error: "tenant_context_required", status: 403 },
    "the legacy profile tenant must never scope a super admin request",
  );
  assertEquals(
    resolveInsightTenantScope({
      caller,
      student,
      authorizedTenantId: "school-b",
      activeStudentMemberships: memberships,
      teacherHasTenantAssignment: false,
    }),
    { ok: true, tenantId: "school-b" },
    "an explicit context must select exactly one tenant",
  );
});

Deno.test("cache filters and writes share the same tenant key", () => {
  assertEquals(
    insightTenantMatch("school-a", student.id),
    { tenant_id: "school-a", student_id: student.id },
    "reads and writes must share the canonical tenant/student match",
  );
});

Deno.test("only operational SaaS states may consume insight resources", () => {
  for (const status of ["active", "ACTIVE", "trial", " trialing "]) {
    assertEquals(
      isOperationalSaasStatus(status),
      true,
      `${status} must remain operational`,
    );
  }
  for (const status of ["blocked", "suspended", "cancelled", null, ""]) {
    assertEquals(
      isOperationalSaasStatus(status),
      false,
      `${String(status)} must fail closed`,
    );
  }
});
