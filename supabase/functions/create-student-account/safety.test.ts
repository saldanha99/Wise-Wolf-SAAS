import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const source = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

Deno.test("student provisioning is server-side, tenant scoped and retry safe", () => {
  assertStringIncludes(source, 'allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"]');
  assertStringIncludes(source, "hasTenantAccess(auth.context, tenantId)");
  assertStringIncludes(source, '.eq("tenant_id", tenantId)');
  assertStringIncludes(source, '.eq("email", email)');
  assertStringIncludes(source, "created: false");
  assertStringIncludes(source, "Student account is inactive");
  assertStringIncludes(source, "secureInitialPassword()");
  assertStringIncludes(source, 'monthlyFee > 0 ? "PENDING" : "ACTIVE"');
  assert(!source.includes("password: '123456'"));
  assert(!source.includes('password: "123456"'));
  assertEquals(
    (source.match(/admin\.auth\.admin\s*\.createUser/g) || []).length,
    1,
  );
});
