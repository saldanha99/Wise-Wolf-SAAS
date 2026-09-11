import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  alternativeQuestion,
  availableMenu,
  type AvailableTrialSlot,
  rankTrialAlternatives,
} from "./sdr-scheduling.ts";
const slot = (
  date: string,
  time: string,
  teacher = "teacher-a",
): AvailableTrialSlot => ({
  date,
  time,
  teacher_id: teacher,
  teacher_name: "Professor Teste",
  phone: "5511999999999",
});
const now = Date.parse("2026-09-05T15:00:00-03:00");
Deno.test("alternatives omit past dates, holidays, Sundays and failed exact slot", () => {
  const rows = [
    slot("2026-09-04", "18:00"),
    slot("2026-09-07", "18:00"),
    slot("2026-09-06", "18:00"),
    slot("2026-09-08", "18:00"),
    slot("2026-09-09", "18:00"),
  ];
  assertEquals(
    rankTrialAlternatives(rows, { date: "2026-09-08", time: "18:00" }, "", now)
      .map((s) => s.date),
    ["2026-09-09"],
  );
});
Deno.test("preference ranks the student's evening before earlier morning openings", () => {
  const rows = [
    slot("2026-09-08", "08:00"),
    slot("2026-09-08", "19:00"),
    slot("2026-09-09", "18:00"),
  ];
  assertEquals(
    rankTrialAlternatives(rows, null, "à noite", now).map((s) => s.time),
    ["19:00", "18:00"],
  );
});
Deno.test("explicit exclusions are respected and duplicate teacher slots collapse", () => {
  const rows = [
    slot("2026-09-08", "08:00"),
    slot("2026-09-08", "08:00", "teacher-b"),
    slot("2026-09-08", "19:00"),
  ];
  assertEquals(
    rankTrialAlternatives(rows, null, "não posso à noite", now).map((s) =>
      s.time
    ),
    ["08:00"],
  );
});
Deno.test("same requested hour wins among equally compatible future alternatives", () => {
  const rows = [
    slot("2026-09-08", "16:30"),
    slot("2026-09-09", "18:00"),
    slot("2026-09-10", "19:00"),
  ];
  assertEquals(
    rankTrialAlternatives(
      rows,
      { date: "2026-09-08", time: "18:00" },
      "",
      now,
    )[0].time,
    "18:00",
  );
});
Deno.test("menu uses exact dates, avoids duplicate teachers and never confirms the agenda", () => {
  assertEquals(
    availableMenu([
      slot("2026-09-08", "19:00"),
      slot("2026-09-08", "19:00", "b"),
    ]),
    "2026-09-08: 19:00",
  );
  assertEquals(
    alternativeQuestion([slot("2026-09-08", "19:00")]).includes(
      "sujeito ao aceite",
    ),
    true,
  );
  assertEquals(alternativeQuestion([]).includes("Qual outro dia"), true);
});

Deno.test("only evenings never offers mornings when no preferred slot remains", () => {
  assertEquals(
    rankTrialAlternatives(
      [slot("2026-09-08", "08:00")],
      null,
      "somente à noite",
      now,
    ),
    [],
  );
});
