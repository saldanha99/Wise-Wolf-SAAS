import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleGoogleMeet } from "./index.ts";
const teacher = "10000000-0000-4000-8000-000000000001";
const tenant = "meet-fixture-school";
Deno.test("service key cannot act as a teacher or initiate OAuth", async () => {
  const originalUrl = Deno.env.get("SUPABASE_URL"),
    originalKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  try {
    Deno.env.set("SUPABASE_URL", "http://localhost:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fixture-service");
    const result = await handleGoogleMeet(
      new Request("https://fixture.test/google-meet", {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture-service",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "connect" }),
      }),
    );
    assertEquals(result.status, 403);
    assertEquals((await result.json()).error, "service_action_forbidden");
  } finally {
    originalUrl === undefined
      ? Deno.env.delete("SUPABASE_URL")
      : Deno.env.set("SUPABASE_URL", originalUrl);
    originalKey === undefined
      ? Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY")
      : Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", originalKey);
  }
});
Deno.test("student cannot fetch transcripts or initiate teacher actions even with a valid session", async () => {
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const previous = names.map((n) => Deno.env.get(n));
  const originalFetch = globalThis.fetch;
  let privateReads = 0;
  try {
    Deno.env.set(names[0], "http://localhost:54321");
    Deno.env.set(names[1], "fixture-service");
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      let data: unknown;
      if (url.includes("/auth/v1/user")) {
        data = { id: teacher, email: "fixture@example.test" };
      } else if (url.includes("/profiles")) {
        data = {
          id: teacher,
          role: "STUDENT",
          tenant_id: tenant,
          lifecycle_status: "active",
        };
      } else if (url.includes("/tenant_user_contexts")) {
        data = { tenant_id: tenant };
      } else if (url.includes("/tenant_memberships")) {
        data = { tenant_id: tenant, role: "STUDENT" };
      } else if (url.includes("/tenants")) {
        data = { saas_status: "active", current_period_end: null };
      } else if (url.includes("/saas_checkout_intents")) data = [];
      else {
        privateReads++;
        data = [];
      }
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    };
    const result = await handleGoogleMeet(
      new Request("https://fixture.test/google-meet", {
        method: "POST",
        headers: {
          Authorization: "Bearer fixture-user",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "transcripts",
          roomId: "30000000-0000-4000-8000-000000000001",
        }),
      }),
    );
    assertEquals(result.status, 403);
    assertEquals((await result.json()).error, "teacher_required");
    assertEquals(privateReads, 0);
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, i) =>
      previous[i] === undefined
        ? Deno.env.delete(name)
        : Deno.env.set(name, previous[i]!)
    );
  }
});
