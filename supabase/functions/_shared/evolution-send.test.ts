/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  precisaResolverJid,
  resolveJid,
  resolveWhatsAppDestination,
  sendWhatsText,
  sendWhatsTextDetailed,
  sendWhatsTextToResolvedDestinationDetailed,
} from "./evolution-send.ts";

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
    chamadas.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(handler(String(url), init || {}));
  }) as typeof fetch;
  return fn(chamadas).finally(() => {
    globalThis.fetch = original;
  });
}

type ChamadaFetch = {
  url: string;
  body: any;
  apikey: string | null;
  redirect: RequestRedirect | undefined;
};

/**
 * Simula o comportamento automático de redirects do fetch para 307/308, que
 * preservam POST, headers e corpo. Com `redirect: "error"`, a resposta 30x
 * vira erro e o segundo request nunca acontece.
 */
function comRedirectPreservandoPostFalso(
  status: 307 | 308,
  fn: (chamadas: ChamadaFetch[]) => Promise<void>,
) {
  const original = globalThis.fetch;
  const captura = "https://destino-nao-confiavel.test/captura";
  const chamadas: ChamadaFetch[] = [];

  globalThis.fetch = (async (url: any, init: RequestInit = {}) => {
    const alvo = String(url);
    const headers = new Headers(init.headers);
    chamadas.push({
      url: alvo,
      body: init.body ? JSON.parse(String(init.body)) : null,
      apikey: headers.get("apikey"),
      redirect: init.redirect,
    });

    if (alvo === captura) {
      return ok({ key: { id: "capturado" } });
    }

    const resposta = new Response(null, {
      status,
      headers: { location: captura },
    });
    if (init.redirect === "error") {
      throw new TypeError("redirect bloqueado");
    }

    return await globalThis.fetch(captura, init);
  }) as typeof fetch;

  return fn(chamadas).finally(() => {
    globalThis.fetch = original;
  });
}

const ok = (corpo: unknown) =>
  new Response(JSON.stringify(corpo), { status: 200 });

Deno.test("grupo e JID pronto não gastam consulta de número", () => {
  assertEquals(precisaResolverJid("120363403699904869@g.us"), false);
  assertEquals(precisaResolverJid("5511999999999@s.whatsapp.net"), false);
  assertEquals(precisaResolverJid(""), false);
  assertEquals(precisaResolverJid("5511999999999"), true);
});

Deno.test("REGRESSÃO: número sem o 9º dígito é enviado ao JID real", async () => {
  await comFetchFalso(
    (url) =>
      url.includes("whatsappNumbers")
        ? ok([{ exists: true, jid: "5533999975104@s.whatsapp.net" }])
        : ok({ key: { id: "x" } }),
    async (chamadas) => {
      const enviado = await sendWhatsText({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "553399975104",
        text: "oi",
      });
      assertEquals(enviado, true);
      assertEquals(chamadas.length, 2);
      assertEquals(chamadas[1].body.number, "5533999975104");
    },
  );
});

Deno.test("resolve destino antes do fence com um único lookup", async () => {
  await comFetchFalso(
    (url) => {
      assertEquals(url.includes("whatsappNumbers"), true);
      return ok([{ exists: true, jid: "5533999975104@s.whatsapp.net" }]);
    },
    async (chamadas) => {
      const destination = await resolveWhatsAppDestination({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "553399975104",
      });

      assertEquals(destination, "5533999975104");
      assertEquals(chamadas.length, 1);
      assertEquals(chamadas[0].url.includes("whatsappNumbers"), true);
    },
  );
});

Deno.test(
  "envio a destino resolvido faz só um sendText e preserva timeout",
  async () => {
    const timeoutOriginal = Object.getOwnPropertyDescriptor(
      AbortSignal,
      "timeout",
    );
    const timeouts: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (milliseconds: number) => {
        timeouts.push(milliseconds);
        return new AbortController().signal;
      },
    });

    try {
      await comFetchFalso(
        (url, init) => {
          assertEquals(url.includes("/message/sendText/"), true);
          assertEquals(url.includes("whatsappNumbers"), false);
          assertEquals(init.method, "POST");
          assertEquals(init.redirect, "error");
          assertEquals(init.signal instanceof AbortSignal, true);
          return ok({ key: { id: "resolved-message" } });
        },
        async (chamadas) => {
          const result = await sendWhatsTextToResolvedDestinationDetailed({
            base: BASE,
            keys: KEYS,
            instance: "i",
            to: "5533999975104",
            text: "oi",
          });

          assertEquals(result, {
            outcome: "accepted",
            messageId: "resolved-message",
            httpStatus: 200,
          });
          assertEquals(chamadas.length, 1);
          assertEquals(chamadas[0].url.includes("/message/sendText/"), true);
          assertEquals(
            chamadas.some((chamada) => chamada.url.includes("whatsappNumbers")),
            false,
          );
          assertEquals(chamadas[0].body.number, "5533999975104");
          assertEquals(timeouts, [15000]);
        },
      );
    } finally {
      if (timeoutOriginal) {
        Object.defineProperty(AbortSignal, "timeout", timeoutOriginal);
      }
    }
  },
);

Deno.test("quando o número não existe no WhatsApp, envia para o original", async () => {
  await comFetchFalso(
    (url) => url.includes("whatsappNumbers") ? ok([{ exists: false }]) : ok({}),
    async (chamadas) => {
      await sendWhatsText({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "5511999999999",
        text: "oi",
      });
      assertEquals(chamadas[1].body.number, "5511999999999");
    },
  );
});

Deno.test("resolução indisponível NÃO cancela o envio", async () => {
  await comFetchFalso(
    (url) =>
      url.includes("whatsappNumbers")
        ? new Response("erro", { status: 500 })
        : ok({}),
    async (chamadas) => {
      const enviado = await sendWhatsText({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "5511999999999",
        text: "oi",
      });
      assertEquals(enviado, true);
      assertEquals(chamadas[1].body.number, "5511999999999");
    },
  );
});

Deno.test("mensagem de grupo vai direto, sem consulta", async () => {
  await comFetchFalso(
    () => ok({}),
    async (chamadas) => {
      await sendWhatsText({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "120363403699904869@g.us",
        text: "oi",
      });
      assertEquals(chamadas.length, 1);
      assertEquals(chamadas[0].url.includes("sendText"), true);
    },
  );
});

Deno.test("chave inválida (401) tenta a próxima chave", async () => {
  let n = 0;
  await comFetchFalso(
    (url) => {
      if (url.includes("whatsappNumbers")) {
        return new Response("", { status: 401 });
      }
      n++;
      return n === 1 ? new Response("", { status: 401 }) : ok({});
    },
    async () => {
      const enviado = await sendWhatsText({
        base: BASE,
        keys: ["ruim", "boa"],
        instance: "i",
        to: "5511999999999",
        text: "oi",
      });
      assertEquals(enviado, true);
    },
  );
});

Deno.test("Evolution recusando a mensagem devolve false, sem lançar", async () => {
  await comFetchFalso(
    (url) =>
      url.includes("whatsappNumbers")
        ? ok([{ exists: false }])
        : new Response("bad", { status: 400 }),
    async () => {
      assertEquals(
        await sendWhatsText({
          base: BASE,
          keys: KEYS,
          instance: "i",
          to: "5511999999999",
          text: "oi",
        }),
        false,
      );
    },
  );
});

Deno.test("Evolution detalhada captura o message id aceito", async () => {
  await comFetchFalso(
    (url) =>
      url.includes("whatsappNumbers")
        ? ok([{ exists: false }])
        : ok({ key: { id: "message-123" } }),
    async (chamadas) => {
      const result = await sendWhatsTextDetailed({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "5511999999999",
        text: "oi",
      });
      assertEquals(result.outcome, "accepted");
      assertEquals(result.messageId, "message-123");
      assertEquals(chamadas.length, 2);
    },
  );
});

Deno.test("Evolution separa rejeição conhecida de resultado ambíguo", async () => {
  await comFetchFalso(
    (url) =>
      url.includes("whatsappNumbers")
        ? ok([{ exists: false }])
        : new Response("bad", { status: 400 }),
    async () => {
      const result = await sendWhatsTextDetailed({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "5511999999999",
        text: "oi",
      });
      assertEquals(result.outcome, "rejected");
      assertEquals(result.httpStatus, 400);
    },
  );

  await comFetchFalso(
    (url) =>
      url.includes("whatsappNumbers")
        ? ok([{ exists: false }])
        : new Response("unavailable", { status: 503 }),
    async () => {
      const result = await sendWhatsTextDetailed({
        base: BASE,
        keys: KEYS,
        instance: "i",
        to: "5511999999999",
        text: "oi",
      });
      assertEquals(result.outcome, "ambiguous");
      assertEquals(result.httpStatus, 503);
    },
  );
});

Deno.test("resolveJid devolve null para grupo, sem chamar a API", async () => {
  await comFetchFalso(
    () => ok([]),
    async (chamadas) => {
      assertEquals(
        await resolveJid(BASE, KEYS, "i", "120363403699904869@g.us"),
        null,
      );
      assertEquals(chamadas.length, 0);
    },
  );
});

Deno.test("307 na resolução não encaminha apikey nem corpo", async () => {
  await comRedirectPreservandoPostFalso(307, async (chamadas) => {
    const resolved = await resolveJid(
      BASE,
      ["chave-secreta"],
      "i",
      "5511999999999",
    );

    assertEquals(resolved, null);
    assertEquals(chamadas.length, 1);
    assertEquals(chamadas[0].redirect, "error");
    assertEquals(chamadas[0].apikey, "chave-secreta");
    assertEquals(chamadas[0].body, { numbers: ["5511999999999"] });
    assertEquals(
      chamadas.some((chamada) =>
        chamada.url === "https://destino-nao-confiavel.test/captura"
      ),
      false,
    );
  });
});

Deno.test("308 no envio resolvido não encaminha apikey nem corpo", async () => {
  await comRedirectPreservandoPostFalso(308, async (chamadas) => {
    const result = await sendWhatsTextToResolvedDestinationDetailed({
      base: BASE,
      keys: ["chave-secreta"],
      instance: "i",
      to: "120363403699904869@g.us",
      text: "conteúdo confidencial",
    });

    assertEquals(result.outcome, "ambiguous");
    assertEquals(result.messageId, null);
    assertEquals(result.httpStatus, null);
    assertEquals(chamadas.length, 1);
    assertEquals(chamadas[0].redirect, "error");
    assertEquals(chamadas[0].apikey, "chave-secreta");
    assertEquals(chamadas[0].body, {
      number: "120363403699904869@g.us",
      text: "conteúdo confidencial",
      delay: 1200,
      linkPreview: false,
    });
    assertEquals(
      chamadas.some((chamada) =>
        chamada.url === "https://destino-nao-confiavel.test/captura"
      ),
      false,
    );
  });
});
