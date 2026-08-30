/// <reference lib="deno.ns" />

import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const [source, migration] = await Promise.all([
  Deno.readTextFile(new URL("./index.ts", import.meta.url)),
  Deno.readTextFile(
    new URL(
      "../../migrations/20260825205000_fence_financial_report_notifications.sql",
      import.meta.url,
    ),
  ),
]);

Deno.test("monthly closing fences one tenant-routed provider POST", () => {
  const integration = source.indexOf("resolveEvolutionIntegration(");
  const claim = source.indexOf("claimFinancialReportMessage(", integration);
  const mark = source.indexOf(
    "markFinancialReportMessageSubmitting(",
    claim,
  );
  const send = source.indexOf("sendWhatsTextDetailed(", mark);
  const finish = source.indexOf("finishFinancialReportMessage(", send);
  assert(integration >= 0 && integration < claim);
  assert(claim < mark && mark < send && send < finish);
  assert(!source.includes("EVOLUTION_API_BASE"));
  assert(!source.includes("await fetch(`${EVOLUTION"));
});

Deno.test("monthly closing binds tenant, teacher, month and financial snapshot", () => {
  assert(source.includes('.from("teacher_closings")'));
  assert(source.includes('.eq("tenant_id", c.tenant_id)'));
  assert(source.includes('.eq("teacher_id", c.teacher_id)'));
  assert(source.includes('.eq("month_year", targetMonth)'));
  assert(source.includes('.eq("role", "TEACHER")'));
  assert(source.includes("monthlyTeacherClosingSubject({"));
  assert(source.includes('notificationKind: "MONTHLY_CLOSING"'));
  assert(source.includes("const refDate = `${targetMonth}-01`"));
});

Deno.test("monthly closing trusts legacy SENT only before a new durable claim", () => {
  const legacy = source.indexOf("const { data: dup,");
  const claim = source.indexOf("claimFinancialReportMessage(");
  assert(legacy >= 0 && legacy < claim);
  assert(source.includes("if (dupError)"));
  assert(!source.includes('.from("automation_sent").delete()'));
});

Deno.test("monthly closing SQL revalidates and locks the exact source snapshot", () => {
  assert(
    migration.includes("'DRE_REPORT', 'WEEKLY_DIGEST', 'MONTHLY_CLOSING'"),
  );
  assert(migration.includes("financial_report_message_exact_scope_active"));
  assert(migration.includes("closing.teacher_id::text || ':'"));
  assert(
    migration.includes(
      "attempt_row.ref_date::text = closing.month_year || '-01'",
    ),
  );
  assert(migration.includes("membership.status = 'ACTIVE'"));
  assert(migration.includes("setting.teacher_notifications_enabled is true"));
  assert(migration.includes("for update;"));
  assert(!/^\s*(begin|commit|rollback)\s*;/mi.test(migration));
});
