export interface InsightCaller {
  id: string;
  role: string;
  tenant_id: string | null;
}

export interface InsightStudent {
  id: string;
}

export interface ActiveStudentMembership {
  tenant_id: string;
  role: "STUDENT";
}

export type InsightTenantDecision =
  | { ok: true; tenantId: string }
  | {
    ok: false;
    error:
      | "forbidden"
      | "tenant_context_required"
      | "target_membership_inactive";
    status: 403;
  };

const TENANT_ADMIN_ROLES = new Set(["COORDINATOR", "SCHOOL_ADMIN"]);

export function resolveInsightTenantScope(input: {
  caller: InsightCaller;
  student: InsightStudent;
  authorizedTenantId: string | null;
  activeStudentMemberships: ActiveStudentMembership[];
  teacherHasTenantAssignment: boolean;
}): InsightTenantDecision {
  const tenantId = input.authorizedTenantId?.trim() || "";
  if (!tenantId) {
    return {
      ok: false,
      error: input.caller.role === "SUPER_ADMIN"
        ? "tenant_context_required"
        : "forbidden",
      status: 403,
    };
  }
  if (
    input.caller.role !== "SUPER_ADMIN" &&
    input.caller.tenant_id !== tenantId
  ) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  const targetMembership = input.activeStudentMemberships.find(
    (membership) =>
      membership.role === "STUDENT" && membership.tenant_id === tenantId,
  );
  if (!targetMembership) {
    return {
      ok: false,
      error: "target_membership_inactive",
      status: 403,
    };
  }

  const isOwnInsight = input.caller.role === "STUDENT" &&
    input.caller.id === input.student.id;
  const isAssignedTeacher = input.caller.role === "TEACHER" &&
    input.teacherHasTenantAssignment;
  const isTenantAdmin = TENANT_ADMIN_ROLES.has(input.caller.role);
  if (
    input.caller.role !== "SUPER_ADMIN" && !isOwnInsight &&
    !isAssignedTeacher && !isTenantAdmin
  ) {
    return { ok: false, error: "forbidden", status: 403 };
  }

  return { ok: true, tenantId: targetMembership.tenant_id };
}

export function insightTenantMatch(
  tenantId: string,
  studentId: string,
): { tenant_id: string; student_id: string } {
  return { tenant_id: tenantId, student_id: studentId };
}

export function isOperationalSaasStatus(status: unknown): boolean {
  return typeof status === "string" &&
    ["active", "trial", "trialing"].includes(status.trim().toLowerCase());
}
