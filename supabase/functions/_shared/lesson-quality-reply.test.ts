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

Deno.test("número solto após auditoria pede contexto sem gravar presença nem cair no care", async () => {
  const filters: Record<string, unknown> = {};
  const query: any = {
    select: () => query,
    eq: (key: string, value: unknown) => {
      filters[key] = value;
      return query;
    },
    neq: (key: string, value: unknown) => {
      filters[`not_${key}`] = value;
      return query;
    },
    gte: (key: string, value: unknown) => {
      filters[key] = value;
      return query;
    },
    gt: (key: string, value: unknown) => {
      filters[key] = value;
      return query;
    },
    then: (resolve: (value: unknown) => void) =>
      resolve({
        data: [{ id: "audit", canonical_confirmation_id: "audit" }],
        error: null,
      }),
  };
  const result = await routeLessonQualityReply({
    from: (table: string) => {
      assertEquals(table, "attendance_confirmations");
      return query;
    },
    rpc: () => {
      throw new Error("não pode gravar retorno por palpite");
    },
  }, {
    tenantId: "school",
    instance: " Central ",
    phone: "5511000000000",
    messageId: "in-1",
    text: "1",
    quotedId: null,
  });
  assertEquals(result, { handled: true, needs_context: true });
  assertEquals(filters.tenant_id, "school");
  assertEquals(filters.provider_instance_name, "central");
  assertEquals(filters.quality_recipient_phone, "5511000000000");
  assertEquals(filters.delivery_status, "SENT");
  assertEquals(filters.not_status, "CANCELLED");
});

Deno.test("número sem auditoria recente pode continuar para outro menu; falha de leitura não", async () => {
  const input = {
    tenantId: "s",
    instance: "i",
    phone: "5511000000000",
    messageId: "m",
    text: "2",
    quotedId: null,
  };
  function client(result: unknown) {
    const query: any = {
      select: () => query,
      eq: () => query,
      neq: () => query,
      gte: () => query,
      gt: () => Promise.resolve(result),
    };
    return { from: () => query };
  }
  assertEquals(
    await routeLessonQualityReply(client({ data: [], error: null }), input),
    { handled: false },
  );
  assertEquals(
    await routeLessonQualityReply(
      client({
        data: [{ id: "copy", canonical_confirmation_id: "original" }],
        error: null,
      }),
      input,
    ),
    { handled: false },
  );
  await assertRejects(
    () => routeLessonQualityReply(client({ error: {} }), input),
    Error,
    "lesson_quality_context_failed",
  );
});
