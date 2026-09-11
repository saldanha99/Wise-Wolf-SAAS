import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  followupStage,
  stageFollowupMessage,
  teacherReminderDue,
} from "./sdr-lifecycle.ts";
import { deliverTeacherReminder } from "./sdr-teacher-reminders.ts";
const now = Date.parse("2026-09-08T18:00:00Z");
Deno.test("reminders run only from 30 minutes until strictly before 60 minutes", () => {
  const ago = (n: number) => new Date(now - n * 60000).toISOString();
  assertEquals(teacherReminderDue(ago(29), ago(-31), "PENDING", now), false);
  assertEquals(teacherReminderDue(ago(30), ago(-30), "PENDING", now), true);
  assertEquals(teacherReminderDue(ago(60), ago(-1), "PENDING", now), false);
  assertEquals(teacherReminderDue(ago(40), ago(-20), "ACCEPTED", now), false);
  assertEquals(teacherReminderDue(ago(40), ago(1), "PENDING", now), false);
});
Deno.test("follow-ups honor enrollment and confirmed or completed trial states", () => {
  assertEquals(followupStage("CONTACTED", null, false), "qualification");
  assertEquals(followupStage("SCHEDULED", "SCHEDULED", false), null);
  assertEquals(followupStage("TRIAL_DONE", "SCHEDULED", false), null);
  assertEquals(followupStage("TRIAL_DONE", "DONE", false), "after_trial");
  assertEquals(followupStage("TRIAL_DONE", "DONE", true), "enrollment_pending");
  assertEquals(followupStage("WON", "DONE", true), null);
  assertEquals(followupStage("LOST", null, false), null);
});
Deno.test("post-class and enrollment messages do not sell another experimental", () => {
  assertEquals(
    stageFollowupMessage("after_trial", "Ana", "Escola", 0).includes(
      "Como foi",
    ),
    true,
  );
  assertEquals(
    stageFollowupMessage("enrollment_pending", "Ana", "Escola", 0).includes(
      "está em andamento",
    ),
    true,
  );
  assertEquals(
    stageFollowupMessage("qualification", "Ana", "Escola", 0, "viagem")
      .includes("Qual é seu objetivo"),
    false,
  );
});
function fakeDb() {
  const marks = new Set<string>();
  return {
    marks,
    from(table: string) {
      return {
        insert: (row: any) => {
          if (table !== "automation_sent") {
            return Promise.resolve({
              error: null,
            });
          }
          const duplicate = marks.has(row.subject_id);
          marks.add(row.subject_id);
          return Promise.resolve({
            error: duplicate ? { code: "23505" } : null,
          });
        },
        delete: () => ({
          match: (row: any) => {
            marks.delete(row.subject_id);
            return Promise.resolve({ error: null });
          },
        }),
      };
    },
  };
}
Deno.test("repeated worker runs send exactly one reminder per teacher", async () => {
  const sb = fakeDb();
  let sends = 0;
  const input = {
    tenantId: "test",
    subject: "request1",
    phone: "5511999999999",
    message: "test_fixture",
    stillPending: async () => true,
    send: async () => {
      sends++;
      return { outcome: "accepted" as const, messageId: "id", httpStatus: 200 };
    },
  };
  await Promise.all([
    deliverTeacherReminder(sb, input),
    deliverTeacherReminder(sb, input),
  ]);
  assertEquals(sends, 1);
});
Deno.test("acceptance during claim prevents a stale reminder", async () => {
  const sb = fakeDb();
  let checks = 0;
  let sends = 0;
  await deliverTeacherReminder(sb, {
    tenantId: "test",
    subject: "request1",
    phone: "5511999999999",
    message: "test_fixture",
    stillPending: async () => ++checks === 1,
    send: async () => {
      sends++;
      return { outcome: "accepted", messageId: null, httpStatus: 200 };
    },
  });
  assertEquals(sends, 0);
});
Deno.test("ambiguous delivery keeps its claim; a known rejection can retry", async () => {
  for (const outcome of ["ambiguous", "rejected"] as const) {
    const sb = fakeDb();
    let sends = 0;
    const input = {
      tenantId: "test",
      subject: "request1",
      phone: "5511999999999",
      message: "test_fixture",
      stillPending: async () => true,
      send: async () => {
        sends++;
        return { outcome, messageId: null, httpStatus: null };
      },
    };
    await deliverTeacherReminder(sb, input);
    await deliverTeacherReminder(sb, input);
    assertEquals(sends, outcome === "ambiguous" ? 1 : 2);
  }
});
