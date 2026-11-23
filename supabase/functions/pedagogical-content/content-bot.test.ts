import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";

import {
  contentBotMaterialBody,
  contentBotTokenFrom,
  resolveContentBotIdentity,
} from "./content-bot.ts";

const identity = {
  hubUserId: "8e541217-9b3f-49c0-a3e0-b70fe9aed643",
  hubAccountId: "0720e03f-a669-4a4d-8c99-90fed0057393",
};
const token = "a".repeat(48);
const fakeHash = (value: string) => Promise.resolve(`h:${value.length}`);

Deno.test("só geração de material passa, com a conta do acervo por cima", () => {
  const body = contentBotMaterialBody({
    hubMode: true,
    action: "material",
    accountId: "11111111-1111-4111-8111-111111111111",
    account_id: "22222222-2222-4222-8222-222222222222",
    kind: "quiz",
  }, identity);
  assertEquals(body, {
    hubMode: true,
    action: "material",
    accountId: identity.hubAccountId,
    kind: "quiz",
  });
  assertEquals(
    contentBotMaterialBody({ hubMode: true, action: "generate" }, identity),
    null,
  );
  assertEquals(
    contentBotMaterialBody({ hubMode: true, action: "cefr_check" }, identity),
    null,
  );
  assertEquals(contentBotMaterialBody({ action: "material" }, identity), null);
  assertEquals(
    contentBotMaterialBody({ hubMode: "true", action: "material" }, identity),
    null,
  );
});

Deno.test("header vazio não ativa o caminho do agente", () => {
  const req = (value?: string) =>
    new Request("http://x", {
      method: "POST",
      headers: value === undefined ? {} : { "x-content-bot-token": value },
    });
  assertEquals(contentBotTokenFrom(req()), null);
  assertEquals(contentBotTokenFrom(req("   ")), null);
  assertEquals(contentBotTokenFrom(req(` ${token} `)), token);
});

Deno.test("token malformado não chega ao banco; resposta estranha nega", async () => {
  let calls = 0;
  const admin = (data: unknown, error: { code?: string } | null = null) => ({
    rpc: (_fn: string, _args: Record<string, unknown>) => {
      calls += 1;
      return Promise.resolve({ data, error });
    },
  });
  assertEquals(
    await resolveContentBotIdentity(admin([]), "curto", fakeHash),
    null,
  );
  assertEquals(calls, 0);
  assertEquals(
    await resolveContentBotIdentity(admin([]), token, fakeHash),
    null,
  );
  assertEquals(
    await resolveContentBotIdentity(
      admin(null, { code: "42501" }),
      token,
      fakeHash,
    ),
    null,
  );
  assertEquals(
    await resolveContentBotIdentity(
      admin([{ hub_user_id: "x", hub_account_id: "y" }]),
      token,
      fakeHash,
    ),
    null,
  );
  assertEquals(
    await resolveContentBotIdentity(
      admin([{
        hub_user_id: identity.hubUserId,
        hub_account_id: identity.hubAccountId,
      }]),
      token,
      fakeHash,
    ),
    identity,
  );
});
