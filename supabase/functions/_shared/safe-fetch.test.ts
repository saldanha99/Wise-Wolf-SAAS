/// <reference lib="deno.ns" />

import {
  extractReadableText,
  isPublicIp,
  SafeFetchError,
  safeFetchText,
  validatePublicUrl,
} from "./safe-fetch.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function rejects(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof SafeFetchError && error.code === code,
      `esperava ${code}, veio ${(error as Error).message}`,
    );
    return;
  }
  throw new Error(`esperava ${code}, passou`);
}

Deno.test("ip: privados, loopback, metadados e IPv6 locais são bloqueados", () => {
  for (
    const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.1.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "224.0.0.1",
    ]
  ) {
    assert(!isPublicIp(ip), `${ip} passou`);
  }
  for (const ip of ["179.236.255.4", "8.8.8.8", "2606:4700::1111"]) {
    assert(isPublicIp(ip), `${ip} bloqueado`);
  }
});

Deno.test("url: esquema, credencial, porta e host interno recusados", () => {
  for (
    const [url, code] of [
      ["file:///etc/passwd", "URL_SCHEME_NOT_ALLOWED"],
      ["https://user:pw@example.com", "URL_CREDENTIALS_NOT_ALLOWED"],
      ["https://example.com:8080/", "URL_PORT_NOT_ALLOWED"],
      ["http://localhost/", "URL_HOST_NOT_ALLOWED"],
      ["http://supabase-kong:8000/", "URL_PORT_NOT_ALLOWED"],
      ["http://supabase-kong/", "URL_HOST_NOT_ALLOWED"],
      ["not a url", "URL_INVALID"],
    ]
  ) {
    try {
      validatePublicUrl(url);
      throw new Error(`${url} passou`);
    } catch (error) {
      assert(
        error instanceof SafeFetchError && error.code === code,
        `${url}: ${(error as Error).message}`,
      );
    }
  }
});

const page = (
  body: string,
  headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
  },
  status = 200,
) => new Response(body, { status, headers });

Deno.test("fetch: host que resolve para IP privado e redirect para interno são recusados", async () => {
  await rejects(
    safeFetchText("https://evil.example/", {
      resolve: async () => ["10.0.0.5"],
      fetchImpl: async () => page("x"),
    }),
    "URL_HOST_NOT_ALLOWED",
  );
  const calls: string[] = [];
  await rejects(
    safeFetchText("https://ok.example/", {
      resolve: async (
        host,
      ) => (host === "ok.example" ? ["8.8.8.8"] : ["127.0.0.1"]),
      fetchImpl: async (input) => {
        calls.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: "http://internal.example/admin" },
        });
      },
    }),
    "URL_HOST_NOT_ALLOWED",
  );
  assert(calls.length === 1, "seguiu o redirect para o interno");
});

Deno.test("fetch: tipo de conteúdo, tamanho e status", async () => {
  const resolve = async () => ["8.8.8.8"];
  await rejects(
    safeFetchText("https://a.example/", {
      resolve,
      fetchImpl: async () => page("x", { "content-type": "application/pdf" }),
    }),
    "URL_CONTENT_TYPE_NOT_ALLOWED",
  );
  await rejects(
    safeFetchText("https://a.example/", {
      resolve,
      maxBytes: 10,
      fetchImpl: async () => page("x".repeat(50)),
    }),
    "URL_TOO_LARGE",
  );
  await rejects(
    safeFetchText("https://a.example/", {
      resolve,
      fetchImpl: async () => page("x", undefined, 404),
    }),
    "URL_HTTP_404",
  );
  const ok = await safeFetchText("https://a.example/", {
    resolve,
    fetchImpl: async () => page("<p>Hello</p>"),
  });
  assert(
    ok.body === "<p>Hello</p>" && ok.finalUrl === "https://a.example/",
    "página válida",
  );
});

Deno.test("extração: prefere o artigo, tira script/nav e decodifica entidades", () => {
  const article = "<p>" + "Remote work is changing cities. ".repeat(20) +
    "</p><p>Caf&eacute; &amp; more &#8217;s</p>";
  const html =
    `<html><head><title>News &amp; Views</title><script>alert(1)</script></head><body><nav>Menu Home</nav><article>${article}</article><footer>Copyright</footer></body></html>`;
  const { title, text } = extractReadableText(html);
  assert(title === "News & Views", `título: ${title}`);
  assert(
    text.includes("Remote work is changing cities.") &&
      !text.includes("alert") && !text.includes("Menu Home") &&
      !text.includes("Copyright"),
    "conteúdo",
  );
  assert(text.includes("& more ’s"), `entidades: ${text.slice(-30)}`);
});

Deno.test("ip: IPv4 mapeado em hex (como o new URL() normaliza) e faixas IPv6 não globais", () => {
  for (
    const raw of [
      "http://[::ffff:169.254.169.254]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
    ]
  ) {
    const host = new URL(raw).hostname;
    assert(!isPublicIp(host), `${raw} → ${host} passou`);
  }
  for (
    const ip of [
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:ffff:a00:1",
      "2001:db8::1",
      "2002::1",
      "2001::1",
      "100::1",
      "::",
      "fe80::1%eth0",
      "3fff::1:2:3:4:5:6:7:8",
    ]
  ) {
    assert(!isPublicIp(ip), `${ip} passou`);
  }
  assert(isPublicIp("::ffff:808:808"), "8.8.8.8 mapeado é público");
  assert(isPublicIp("2606:4700:4700::1111"), "IPv6 global bloqueado");
});

Deno.test("fetch: URL com IPv6 mapeado para loopback é recusada sem DNS", async () => {
  let fetched = false;
  await rejects(
    safeFetchText("http://[::ffff:127.0.0.1]/", {
      resolve: async () => ["8.8.8.8"],
      fetchImpl: async () => {
        fetched = true;
        return new Response("x");
      },
    }),
    "URL_HOST_NOT_ALLOWED",
  );
  assert(!fetched, "chegou a buscar");
});
