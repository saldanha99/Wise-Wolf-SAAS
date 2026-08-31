/// <reference lib="deno.ns" />

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function source(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

Deno.test({
  name: "student complementary generation is a dedicated server-owned action",
  permissions: { read: true },
  async fn() {
    const edge = await source("./index.ts");
    const handlerStart = edge.indexOf(
      "async function handleStudentComplementaryPack",
    );
    const serveStart = edge.indexOf("serve(async", handlerStart);
    assert(
      handlerStart >= 0 && serveStart > handlerStart,
      "handler is missing",
    );
    const handler = edge.slice(handlerStart, serveStart);

    assert(
      edge.includes(
        'const STUDENT_COMPLEMENTARY_ACTION = "student_complementary_pack"',
      ),
      "the dedicated action name changed or disappeared",
    );
    assert(
      handler.includes('"begin_student_complementary_generation"') &&
        handler.includes('"commit_student_complementary_generation"'),
      "generation is not protected by begin/commit reservation RPCs",
    );
    assert(
      handler.includes('"save_student_generated_activities"') &&
        handler.includes(
          "const { data: saved, error: saveError } = await admin.rpc",
        ) &&
        handler.includes("p_student_id: profile.id") &&
        handler.includes(
          "p_reservation_id: currentReservation.reservationId",
        ) &&
        handler.includes("p_lease_token: currentReservation.leaseToken"),
      "persistence is not bound to the student and active lease through service_role",
    );
    assert(
      handler.includes(
        "const { data: committed, error: commitError } = await admin.rpc",
      ) &&
        handler.includes('"commit_student_complementary_generation"'),
      "reservation commit is not service-role-only",
    );
    assert(
      handler.includes("buildStudentComplementaryPrompt(") &&
        handler.includes('.from("profiles")') &&
        handler.includes('.from("wolf_intelligence")'),
      "the prompt context is not assembled from server-owned data",
    );
  },
});

Deno.test({
  name: "student cannot submit a generic prompt or receive answer keys",
  permissions: { read: true },
  async fn() {
    const edge = await source("./index.ts");
    const serveStart = edge.indexOf("serve(async");
    const genericPrompt = edge.indexOf("const prompt =", serveStart);
    const studentDenied = edge.indexOf(
      'if (profile.role === "STUDENT")',
      serveStart,
    );
    assert(
      studentDenied > serveStart && studentDenied < genericPrompt,
      "a student can still reach the generic prompt branch",
    );
    assert(
      edge.includes('key !== "action" && key !== "requestKey"'),
      "the student action accepts browser-supplied context or prompt fields",
    );
    assert(
      edge.includes("containsStudentAnswerKey(item.content)") &&
        edge.includes("safeStudentActivitiesFromRpc(saved.activities)"),
      "the Edge response lacks a final answer-key leak guard",
    );
    assert(
      edge.includes("AI_DISABLED_FOR_TEST_FIXTURE") &&
        edge.includes("studentComplementaryMode"),
      "test fixtures can unexpectedly call the AI provider",
    );
  },
});

Deno.test({
  name: "unfinished reservations are released on every error path",
  permissions: { read: true },
  async fn() {
    const edge = await source("./index.ts");
    const finallyStart = edge.lastIndexOf("} finally {");
    const finallyBlock = edge.slice(finallyStart);
    assert(finallyStart >= 0, "request cleanup block is missing");
    assert(
      finallyBlock.includes('"release_student_complementary_generation"') &&
        finallyBlock.includes("p_reservation_id") &&
        finallyBlock.includes("p_lease_token") &&
        finallyBlock.includes("p_request_key"),
      "student generation lease is not released idempotently on failure",
    );
  },
});

Deno.test({
  name: "student generation follows the portal financial tolerance",
  permissions: { read: true },
  async fn() {
    const edge = await source("./index.ts");
    const billingStart = edge.indexOf(
      "async function enforceStudentBillingAccess",
    );
    const promptStart = edge.indexOf(
      "function buildStudentComplementaryPrompt",
      billingStart,
    );
    assert(
      billingStart >= 0 && promptStart > billingStart,
      "student billing gate is missing",
    );
    const billingGate = edge.slice(billingStart, promptStart);
    assert(
      billingGate.includes('.in("status", ["PENDING", "OVERDUE"])') &&
        billingGate.includes('timeZone: "America/Sao_Paulo"') &&
        billingGate.includes("businessDaysAfter(payment.due_date) > 7"),
      "generation billing diverges from the portal's seven-business-day open-payment rule",
    );
    assert(
      !billingGate.includes("SETTLED_PAYMENT_STATUSES") &&
        !billingGate.includes("7 * 86_400_000"),
      "generation still blocks on arbitrary non-settled statuses or calendar days",
    );
  },
});

Deno.test({
  name: "Edge arguments match the service-only persistence contract",
  permissions: { read: true },
  async fn() {
    const [edge, migration] = await Promise.all([
      source("./index.ts"),
      source(
        "../../migrations/20260831143000_student_learning_runtime_hardening.sql",
      ),
    ]);
    assert(
      migration.includes(
        "create or replace function public.save_student_generated_activities(\n  p_student_id uuid,",
      ) &&
        migration.includes(
          ") to service_role;\n\ncreate or replace function public.get_student_complementary_generation_status",
        ),
      "generated activity persistence is not service-role-only",
    );
    assert(
      migration.includes(
        "create or replace function public.commit_student_complementary_generation(\n  p_student_id uuid,",
      ) &&
        migration.includes(
          "grant execute on function public.commit_student_complementary_generation(",
        ),
      "generation commit does not use the explicit student service contract",
    );
    for (
      const argument of [
        "p_student_id: profile.id",
        "p_reservation_id: currentReservation.reservationId",
        "p_lease_token: currentReservation.leaseToken",
        "p_request_key: currentReservation.requestKey",
      ]
    ) {
      assert(edge.includes(argument), `Edge is missing ${argument}`);
    }
    assert(
      migration.includes(
        "Replaying a still-active key must never hand the lease token to a second",
      ) && migration.includes("limit 4"),
      "same-key concurrency or bounded pending replay protection is missing",
    );
  },
});
