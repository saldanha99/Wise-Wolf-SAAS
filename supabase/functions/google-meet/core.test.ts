import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertResource,
  normalizeProposal,
  seal,
  sha256,
  unseal,
  validMeetingUri,
} from "./core.ts";
const entries = [{
  name: "entry-1",
  participant: "student",
  text: "I work with logistics.",
  startTime: "2026-09-10T12:00:00Z",
}, {
  name: "entry-2",
  participant: "teacher",
  text: "I enjoy astronomy.",
  startTime: "2026-09-10T12:01:00Z",
}];
Deno.test("Google links and resource names reject external URLs and traversal", () => {
  assertEquals(validMeetingUri("https://meet.google.com/abc-defg-hij"), true);
  for (
    const value of [
      "https://meet.google.com.evil.test/abc-defg-hij",
      "javascript:alert(1)",
      "https://meet.google.com/abc-defg-hij?token=123",
    ]
  ) assertEquals(validMeetingUri(value), false);
  assertEquals(
    assertResource("conferenceRecords/a/transcripts/b", "transcripts"),
    "conferenceRecords/a/transcripts/b",
  );
  assertThrows(() =>
    assertResource("conferenceRecords/a/../../spaces/b", "transcripts")
  );
});
Deno.test("refresh token encryption is bound to its school and teacher", async () => {
  const key = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
  const encrypted = await seal(
    "fixture-not-a-real-token",
    key,
    "school-a:teacher-a",
  );
  assertEquals(encrypted.includes("fixture"), false);
  assertEquals(
    await unseal(encrypted, key, "school-a:teacher-a"),
    "fixture-not-a-real-token",
  );
  await assertRejects(() => unseal(encrypted, key, "school-b:teacher-a"));
  await assertRejects(() => unseal(encrypted, key, "school-a:teacher-b"));
});
Deno.test("OAuth state hash is deterministic without retaining the original state", async () => {
  const hashed = await sha256("fixture-state");
  assertEquals(hashed, await sha256("fixture-state"));
  assertEquals(hashed === "fixture-state", false);
});
Deno.test("analysis cannot use teacher speech as evidence for a student fact", () => {
  assertThrows(() =>
    normalizeProposal(
      { evidence: [{ entry: "entry-2", quote: "I enjoy astronomy." }] },
      entries,
      "student",
    )
  );
  assertThrows(() =>
    normalizeProposal(
      { evidence: [{ entry: "entry-1", quote: "I am a doctor." }] },
      entries,
      "student",
    )
  );
  assertThrows(() =>
    normalizeProposal({ summary: "No evidence" }, entries, "student")
  );
});
Deno.test("review proposal retains factual evidence and removes invented fields", () => {
  const result = normalizeProposal(
    {
      summary: "Practice",
      interests: ["logistics", 123],
      personality: "extrovert",
      evidence: [{ entry: "entry-1", quote: "I work with logistics." }],
    },
    entries,
    "student",
  );
  assertEquals(result.interests, ["logistics"]);
  assertEquals(Object.hasOwn(result, "personality"), false);
  assertEquals(result.evidence.length, 1);
});
