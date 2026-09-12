import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyLessonQualityReply,
  quotedLessonMessageId,
  routeLessonQualityReply,
} from "./lesson-quality-reply.ts";
Deno.test("numeric replies require quote; recruiting and generic replies are ignored", () => {
  assertEquals(classifyLessonQualityReply("1", false), null);
  assertEquals(classifyLessonQualityReply("1", true), "OK");
  assertEquals(classifyLessonQualityReply("2", true), "OTHER");
  assertEquals(classifyLessonQualityReply("3", true), "UNKNOWN");
  assertEquals(
    classifyLessonQualityReply("quero remarcar entrevista", false),
    null,
  );
  assertEquals(classifyLessonQualityReply("sim", true), null);
  assertEquals(
    classifyLessonQualityReply("a aula atrasou", false),
    "LATE_START",
  );
  assertEquals(
    classifyLessonQualityReply("não acompanhei a aula", false),
    "UNKNOWN",
  );
  assertEquals(
    classifyLessonQualityReply("a aula terminou mais cedo", false),
    "EARLY_END",
  );
});
Deno.test("quoted id is evidence context, not a guessed lesson identifier", async () => {
  assertEquals(
    quotedLessonMessageId({
      extendedTextMessage: { contextInfo: { stanzaId: "out-1" } },
    }),
    "out-1",
  );
  let args: any;
  const client = {
    rpc: (_name: string, value: unknown) => {
      args = value;
      return Promise.resolve({
        data: { handled: true, needs_context: true },
        error: null,
      });
    },
  };
  const result = await routeLessonQualityReply(client, {
    tenantId: "school",
    instance: "central",
    phone: "5511000000000",
    messageId: "in-1",
    text: "a aula atrasou",
    quotedId: null,
  });
  assertEquals(result.needs_context, true);
  assertEquals(args.p_tenant, "school");
  assertEquals(args.p_quoted_id, null);
});
Deno.test("failed persistence is not acknowledged as saved", async () => {
  await assertRejects(
    () =>
      routeLessonQualityReply({ rpc: () => Promise.resolve({ error: {} }) }, {
        tenantId: "s",
        instance: "i",
        phone: "1",
        messageId: "m",
        text: "2",
        quotedId: "q",
      }),
    Error,
    "lesson_quality_reply_failed",
  );
});
