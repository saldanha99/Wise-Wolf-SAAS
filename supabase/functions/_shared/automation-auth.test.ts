/// <reference lib="deno.ns" />

import {
  resolveManualAutomationScope,
  scopeAutomationRows,
} from "./automation-auth.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("school admin requires an explicit context and ACTIVE admin membership", () => {
  assertEquals(
    resolveManualAutomationScope({
      activeRole: "SCHOOL_ADMIN",
      selectedTenantId: null,
      membershipTenantId: "school-a",
      membershipRole: "SCHOOL_ADMIN",
    }),
    { ok: false, error: "tenant_context_required" },
    "implicit profile tenant must never authorize a manual automation",
  );
  assertEquals(
    resolveManualAutomationScope({
      activeRole: "SCHOOL_ADMIN",
      selectedTenantId: "school-a",
      membershipTenantId: null,
      membershipRole: null,
    }),
    { ok: false, error: "active_tenant_membership_required" },
    "suspended or missing memberships must fail closed",
  );
  assertEquals(
    resolveManualAutomationScope({
      activeRole: "SCHOOL_ADMIN",
      selectedTenantId: "school-a",
      membershipTenantId: "school-a",
      membershipRole: "COORDINATOR",
    }),
    { ok: false, error: "school_admin_membership_required" },
    "a role from another active membership must not inherit admin authority",
  );
});

Deno.test("super admin manual execution is never implicitly global", () => {
  assertEquals(
    resolveManualAutomationScope({
      activeRole: "SUPER_ADMIN",
      selectedTenantId: null,
      membershipTenantId: null,
      membershipRole: null,
    }),
    { ok: false, error: "tenant_context_required" },
    "super admin must select a tenant before a manual run",
  );
  assertEquals(
    resolveManualAutomationScope({
      activeRole: "SUPER_ADMIN",
      selectedTenantId: "school-a",
      membershipTenantId: "school-a",
      membershipRole: "SCHOOL_ADMIN",
    }),
    { ok: true, tenantId: "school-a" },
    "an explicit ACTIVE context authorizes exactly one tenant",
  );
});

Deno.test("manual row scoping ignores any tenant claimed by the request body", () => {
  const body = { tenantId: "school-b" };
  const authorizedTenantId = "school-a";
  const rows = [
    { tenant_id: "school-a", id: "a-1" },
    { tenant_id: "school-b", id: "b-1" },
    { id: "tenantless" },
  ];

  assertEquals(
    body.tenantId,
    "school-b",
    "the hostile claim should be present",
  );
  assertEquals(
    scopeAutomationRows(rows, authorizedTenantId),
    [{ tenant_id: "school-a", id: "a-1" }],
    "only the server-authorized tenant may reach a manual loop",
  );
  assertEquals(
    scopeAutomationRows(rows, null),
    rows,
    "service-role cron keeps the intentional global scope",
  );
});
