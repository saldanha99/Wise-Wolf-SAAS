/// <reference lib="deno.ns" />

import { resolvePaymentTargetScope } from "./payment-auth.ts";

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

const membership = (tenantId: string) => ({
  tenant_id: tenantId,
  role: "STUDENT" as const,
});

Deno.test("payment authorization uses the caller ACTIVE context instead of legacy tenant data", () => {
  const decision = resolvePaymentTargetScope({
    context: {
      isService: false,
      userId: "director-a",
      profile: {
        id: "director-a",
        role: "SCHOOL_ADMIN",
        tenant_id: "school-a",
        lifecycle_status: "active",
      },
    },
    targetUserId: "student",
    authorizedTenantId: "school-a",
    activeStudentMemberships: [membership("school-a"), membership("school-b")],
  });

  assertEquals(
    decision,
    { ok: true, tenantId: "school-a" },
    "the active director context must be authoritative",
  );
});

Deno.test("student self-service is restricted to the ACTIVE tenant context", () => {
  const decision = resolvePaymentTargetScope({
    context: {
      isService: false,
      userId: "student",
      profile: {
        id: "student",
        role: "STUDENT",
        tenant_id: "school-a",
        lifecycle_status: "active",
      },
    },
    targetUserId: "student",
    authorizedTenantId: "school-a",
    activeStudentMemberships: [membership("school-a"), membership("school-b")],
  });

  assertEquals(
    decision,
    { ok: true, tenantId: "school-a" },
    "the authenticated ACTIVE context must remain authoritative",
  );
});

Deno.test("suspended targets and cross-tenant staff access fail closed", () => {
  assertEquals(
    resolvePaymentTargetScope({
      context: {
        isService: false,
        userId: "director-a",
        profile: {
          id: "director-a",
          role: "SCHOOL_ADMIN",
          tenant_id: "school-a",
          lifecycle_status: "active",
        },
      },
      targetUserId: "student-b",
      authorizedTenantId: "school-a",
      activeStudentMemberships: [],
    }),
    { ok: false, error: "target_membership_inactive", status: 403 },
    "a legacy profile cannot revive a suspended membership",
  );

  assertEquals(
    resolvePaymentTargetScope({
      context: {
        isService: false,
        userId: "director-a",
        profile: {
          id: "director-a",
          role: "SCHOOL_ADMIN",
          tenant_id: "school-a",
          lifecycle_status: "active",
        },
      },
      targetUserId: "student-b",
      authorizedTenantId: "school-a",
      activeStudentMemberships: [membership("school-b")],
    }),
    { ok: false, error: "target_membership_inactive", status: 403 },
    "staff cannot cross the active tenant boundary",
  );
});

Deno.test("ordinary students cannot operate another student's billing", () => {
  assertEquals(
    resolvePaymentTargetScope({
      context: {
        isService: false,
        userId: "student-a",
        profile: {
          id: "student-a",
          role: "STUDENT",
          tenant_id: "school-a",
          lifecycle_status: "active",
        },
      },
      targetUserId: "student-b",
      authorizedTenantId: "school-a",
      activeStudentMemberships: [membership("school-a")],
    }),
    { ok: false, error: "forbidden", status: 403 },
    "same-tenant membership is not ownership",
  );
});

Deno.test("super admin requires an explicit tenant context and scopes the target", () => {
  assertEquals(
    resolvePaymentTargetScope({
      context: {
        isService: false,
        userId: "super-admin",
        profile: {
          id: "super-admin",
          role: "SUPER_ADMIN",
          tenant_id: "legacy-school",
          lifecycle_status: "active",
        },
      },
      targetUserId: "student",
      authorizedTenantId: null,
      activeStudentMemberships: [
        membership("school-a"),
        membership("school-b"),
      ],
    }),
    { ok: false, error: "tenant_context_required", status: 403 },
    "a legacy profile tenant must never authorize super admin payment access",
  );

  assertEquals(
    resolvePaymentTargetScope({
      context: {
        isService: false,
        userId: "super-admin",
        profile: {
          id: "super-admin",
          role: "SUPER_ADMIN",
          tenant_id: "legacy-school",
          lifecycle_status: "active",
        },
      },
      targetUserId: "student",
      authorizedTenantId: "school-a",
      activeStudentMemberships: [
        membership("school-a"),
        membership("school-b"),
      ],
    }),
    { ok: true, tenantId: "school-a" },
    "the explicit ACTIVE context must select exactly one target membership",
  );

  assertEquals(
    resolvePaymentTargetScope({
      context: {
        isService: false,
        userId: "super-admin",
        profile: {
          id: "super-admin",
          role: "SUPER_ADMIN",
          tenant_id: "legacy-school",
          lifecycle_status: "active",
        },
      },
      targetUserId: "student",
      authorizedTenantId: "school-a",
      activeStudentMemberships: [membership("school-b")],
    }),
    { ok: false, error: "target_membership_inactive", status: 403 },
    "super admin cannot cross from the selected tenant into another membership",
  );
});

Deno.test("trusted service access accepts only one unambiguous ACTIVE membership", () => {
  assertEquals(
    resolvePaymentTargetScope({
      context: { isService: true, userId: null, profile: null },
      targetUserId: "student",
      authorizedTenantId: null,
      activeStudentMemberships: [membership("school-a")],
    }),
    { ok: true, tenantId: "school-a" },
    "a unique active membership supplies the only safe service scope",
  );

  assertEquals(
    resolvePaymentTargetScope({
      context: { isService: true, userId: null, profile: null },
      targetUserId: "student",
      authorizedTenantId: null,
      activeStudentMemberships: [
        membership("school-a"),
        membership("school-b"),
      ],
    }),
    { ok: false, error: "target_tenant_ambiguous", status: 409 },
    "service calls must fail closed when user id alone is ambiguous",
  );
});
