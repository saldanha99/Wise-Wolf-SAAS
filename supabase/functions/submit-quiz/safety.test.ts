/// <reference lib="deno.ns" />

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function source(relativePath: string): Promise<string> {
  return await Deno.readTextFile(new URL(relativePath, import.meta.url));
}

Deno.test({
  name:
    "quiz load keeps the answer key server-side and checks the student's unlock",
  permissions: { read: true },
  async fn() {
    const edge = await source("./index.ts");
    const loadStart = edge.indexOf('if (action === "load")');
    const answerValidation = edge.indexOf(
      "if (!Array.isArray(body.answers)",
      loadStart,
    );
    assert(loadStart >= 0, "secure load action is missing");
    assert(
      answerValidation > loadStart,
      "load branch must finish before answer submission validation",
    );

    const loadBranch = edge.slice(loadStart, answerValidation);
    assert(
      loadBranch.includes('.select("current_book_part,evaluation_unlocked")'),
      "quiz load does not verify the student's authoritative progression",
    );
    assert(
      loadBranch.includes('.from("pedagogical_evaluation_catalog")') &&
        loadBranch.includes('.eq("active", true)'),
      "quiz load does not verify that the requested evaluation is published",
    );
    assert(
      loadBranch.includes("question: question.question") &&
        loadBranch.includes("options: question.options"),
      "quiz load does not expose the expected sanitized question contract",
    );
    assert(
      !loadBranch.includes("correct: question.correct") &&
        !loadBranch.includes("correctIndex"),
      "quiz load leaked the answer key to the browser",
    );
  },
});

Deno.test({
  name: "quiz submit records progression through the hardened v2 RPC",
  permissions: { read: true },
  async fn() {
    const [edge, migration] = await Promise.all([
      source("./index.ts"),
      source(
        "../../migrations/20260831150000_pedagogical_evaluation_catalog.sql",
      ),
    ]);

    assert(
      edge.includes('"record_verified_pedagogical_quiz_v2"'),
      "submit-quiz still calls the legacy progression RPC",
    );
    assert(
      edge.includes("p_request_key: requestKey"),
      "submit-quiz does not send an idempotency key",
    );
    assert(
      edge.includes('message.includes("pedagogical_quiz_already_completed")'),
      "a concurrent already-completed evaluation is not mapped to a stable conflict response",
    );
    assert(
      migration.includes(
        "create or replace function public.record_verified_pedagogical_quiz_v2(",
      ),
      "the hardened pedagogical progression RPC is missing",
    );
    assert(
      migration.includes(
        "create table if not exists public.pedagogical_evaluation_catalog",
      ),
      "published evaluation catalog is missing",
    );
    assert(
      migration.includes(
        "create table if not exists public.pedagogical_evaluation_submission_requests",
      ),
      "idempotent evaluation submission ledger is missing",
    );
  },
});
