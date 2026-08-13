/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { precisaResolverJid, resolveJid, sendWhatsText } from "./evolution-send.ts";

const BASE = "https://evolution.test";
const KEYS = ["chave"];

/** Troca o fetch global por um dublê que grava as chamadas. */
function comFetchFalso(
  handler: (url: string, init: RequestInit) => Response,
  fn: (chamadas: Array<{ url: string; body: any }>) => Promise<void>,
) {
  const original = globalThis.fetch;
  const chamadas: Array<{ url: string; body: any }> = [];
  globalThis.fetch = ((url: any, init: any) => {
    chamadas.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Promise.resolve(handler(String(url), init || {}));
  }) as typeof fetch;
  return fn(chamadas).finally(() => { globalThis.fetch = original; });
}

const ok = (corpo: unknown) => new Response(JSON.stringify(corpo), { status: 200 });

Deno.test("grupo e JID pronto não gastam consulta de número", () => {
  assertEquals(precisaResolverJid("120363403699904869@g.us"), false);
  assertEquals(precisaResolverJid("5511999999999@s.whatsapp.net"), false);
  assertEquals(precisaResolverJid(""), false);
  assertEquals(precisaResolverJid("5511999999999"), true);
});

Deno.test("REGRESSÃO: número sem o 9º dígito é enviado ao JID real", async () => {
  await comFetchFalso(
    (url) => url.includes("whatsappNumbers")
      ? ok([{ exists: true, jid: "5533999975104@s.whatsapp.net" }])
      : ok({ key: { id: "x" } }),
    async (chamadas) => {
      const enviado = await sendWhatsText({ base: BASE, keys: KEYS, instance: "i", to: "553399975104", text: "oi" });
      assertEquals(enviado, true);
      assertEquals(chamadas.length, 2);
      assertEquals(chamadas[1].body.number, "5533999975104");
    },
  );
});

Deno.test("quando o número não existe no WhatsApp, envia para o original", async () => {
  await comFetchFalso(
    (url) => url.includes("whatsappNumbers") ? ok([{ exists: false }]) : ok({}),
    async (chamadas) => {
      await sendWhatsText({ base: BASE, keys: KEYS, instance: "i", to: "5511999999999", text: "oi" });
      assertEquals(chamadas[1].body.number, "5511999999999");
    },
  );
});

Deno.test("resolução indisponível NÃO cancela o envio", async () => {
  await comFetchFalso(
    (url) => url.includes("whatsappNumbers") ? new Response("erro", { status: 500 }) : ok({}),
    async (chamadas) => {
      const enviado = await sendWhatsText({ base: BASE, keys: KEYS, instance: "i", to: "5511999999999", text: "oi" });
      assertEquals(enviado, true);
      assertEquals(chamadas[1].body.number, "5511999999999");
    },
  );
});

Deno.test("mensagem de grupo vai direto, sem consulta", async () => {
  await comFetchFalso(
    () => ok({}),
    async (chamadas) => {
      await sendWhatsText({ base: BASE, keys: KEYS, instance: "i", to: "120363403699904869@g.us", text: "oi" });
      assertEquals(chamadas.length, 1);
      assertEquals(chamadas[0].url.includes("sendText"), true);
    },
  );
});

Deno.test("chave inválida (401) tenta a próxima chave", async () => {
  let n = 0;
  await comFetchFalso(
    (url) => {
      if (url.includes("whatsappNumbers")) return new Response("", { status: 401 });
      n++;
      return n === 1 ? new Response("", { status: 401 }) : ok({});
    },
    async () => {
      const enviado = await sendWhatsText({ base: BASE, keys: ["ruim", "boa"], instance: "i", to: "5511999999999", text: "oi" });
      assertEquals(enviado, true);
    },
  );
});

Deno.test("Evolution recusando a mensagem devolve false, sem lançar", async () => {
  await comFetchFalso(
    (url) => url.includes("whatsappNumbers") ? ok([{ exists: false }]) : new Response("bad", { status: 400 }),
    async () => {
      assertEquals(await sendWhatsText({ base: BASE, keys: KEYS, instance: "i", to: "5511999999999", text: "oi" }), false);
    },
  );
});

Deno.test("resolveJid devolve null para grupo, sem chamar a API", async () => {
  await comFetchFalso(
    () => ok([]),
    async (chamadas) => {
      assertEquals(await resolveJid(BASE, KEYS, "i", "120363403699904869@g.us"), null);
      assertEquals(chamadas.length, 0);
    },
  );
});
