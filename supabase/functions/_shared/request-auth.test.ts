/// <reference lib="deno.ns" />

import {
  isActiveLifecycleProfile,
  isAuthorizedTenantlessProfile,
  isAuthorizedTenantMembership,
} from "./request-auth.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("tenant membership never grants global or unknown authority", () => {
  for (const role of ["SUPER_ADMIN", "OWNER", "super_admin", ""]) {
    assertEquals(
      isAuthorizedTenantMembership({ tenant_id: "school-a", role }),
      false,
      `${role || "empty role"} must be rejected`,
    );
  }
});

Deno.test("only active-query tenant-scoped roles authorize a tenant profile", () => {
  assertEquals(
    isAuthorizedTenantMembership(null),
    false,
    "missing ACTIVE membership cannot authorize a tenant-scoped profile",
  );
  for (
    const role of [
      "STUDENT",
      "TEACHER",
      "SCHOOL_ADMIN",
      "COORDINATOR",
      "COMMERCIAL",
      "SALESPERSON",
      "NON_STUDENT",
    ]
  ) {
    assertEquals(
      isAuthorizedTenantMembership({ tenant_id: "school-a", role }),
      true,
      `${role} should remain tenant-scoped`,
    );
  }
});

Deno.test("only the intentional tenantless Hub learner bypasses membership lookup", () => {
  assertEquals(
    isAuthorizedTenantlessProfile({
      id: "hub-user",
      role: "NON_STUDENT",
      tenant_id: null,
      lifecycle_status: "active",
    }),
    true,
    "tenantless Hub learners must keep access to Hub functions",
  );
  for (
    const profile of [
      {
        id: "student",
        role: "STUDENT",
        tenant_id: null,
        lifecycle_status: "active",
      },
      {
        id: "revoked",
        role: "NON_STUDENT",
        tenant_id: "school-a",
        lifecycle_status: "active",
      },
      {
        id: "admin",
        role: "SCHOOL_ADMIN",
        tenant_id: null,
        lifecycle_status: "active",
      },
    ]
  ) {
    assertEquals(
      isAuthorizedTenantlessProfile(profile),
      false,
      `${profile.id} must require an ACTIVE membership`,
    );
  }
});

Deno.test("suspended and offboarded profiles fail closed", () => {
  for (const lifecycle_status of [null, "", "suspended", "offboarded"]) {
    assertEquals(
      isActiveLifecycleProfile({
        id: "user-a",
        role: "TEACHER",
        tenant_id: "school-a",
        lifecycle_status,
      }),
      false,
      `${lifecycle_status || "missing lifecycle"} must be rejected`,
    );
  }
  assertEquals(
    isActiveLifecycleProfile({
      id: "user-a",
      role: "TEACHER",
      tenant_id: "school-a",
      lifecycle_status: " ACTIVE ",
    }),
    true,
    "active lifecycle should be accepted case-insensitively",
  );
});
