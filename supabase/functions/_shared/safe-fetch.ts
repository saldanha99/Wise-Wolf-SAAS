// Busca de página pública pedida por usuário (Hub, adaptação de material
// autêntico). Protege o servidor contra SSRF: só http/https nas portas 80/443,
// sem credencial na URL, host resolvido só para IP público (cada redirect é
// conferido de novo), teto de tempo e de bytes, e só HTML/texto.

export class SafeFetchError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  // Injetáveis para teste.
  resolve?: (host: string) => Promise<string[]>;
  fetchImpl?: typeof fetch;
}

export interface SafeFetchResult {
  finalUrl: string;
  contentType: string;
  body: string;
}

const parseIpv4 = (ip: string): number[] | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((
    part,
  ) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? nums
    : null;
};

// IPv6 em 8 hextets (aceita "::", zona e IPv4 no fim); inválido = null.
export function parseIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!ip.includes(":")) return null;
  const tail = ip.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const v4 = parseIpv4(tail[1]);
    if (!v4) return null;
    ip = ip.slice(0, -tail[1].length) +
      `${((v4[0] << 8) | v4[1]).toString(16)}:${
        ((v4[2] << 8) | v4[3]).toString(16)
      }`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const part = (text: string) => (text ? text.split(":") : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [
    ...head,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...rest,
  ];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
    return null;
  }
  return groups.map((g) => parseInt(g, 16));
}

export function isPublicIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local / metadados de nuvem
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a >= 224) return false; // multicast e reservado
    return true;
  }
  const v6 = parseIpv6(ip);
  if (!v6) return false;
  // ::ffff:a.b.c.d (IPv4 mapeado), em qualquer grafia (o new URL() normaliza
  // para hex: [::ffff:7f00:1]): vale a regra do IPv4.
  if (v6.slice(0, 5).every((h) => h === 0) && v6[5] === 0xffff) {
    return isPublicIp(
      `${v6[6] >> 8}.${v6[6] & 0xff}.${v6[7] >> 8}.${v6[7] & 0xff}`,
    );
  }
  // Só unicast global (2000::/3), fora documentação, 6to4 e Teredo.
  if ((v6[0] & 0xe000) !== 0x2000) return false;
  if (v6[0] === 0x2001 && v6[1] === 0x0db8) return false;
  if (v6[0] === 0x2002) return false;
  if (v6[0] === 0x2001 && v6[1] === 0x0000) return false;
  return true;
}

export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new SafeFetchError("URL_INVALID");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SafeFetchError("URL_SCHEME_NOT_ALLOWED");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("URL_CREDENTIALS_NOT_ALLOWED");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new SafeFetchError("URL_PORT_NOT_ALLOWED");
  }
  const host = url.hostname.toLowerCase();
  if (
    !host || host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal") ||
    !host.includes(".") && !host.includes(":")
  ) {
    throw new SafeFetchError("URL_HOST_NOT_ALLOWED");
  }
  return url;
}

async function defaultResolve(host: string): Promise<string[]> {
  const out: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    try {
      out.push(...(await Deno.resolveDns(host, type)));
    } catch {
      // sem registro deste tipo
    }
  }
  return out;
}

async function assertPublicHost(
  url: URL,
  resolve: (host: string) => Promise<string[]>,
) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = parseIpv4(host) || host.includes(":");
  const ips = literal ? [host] : await resolve(host);
  if (!ips.length) throw new SafeFetchError("URL_HOST_UNRESOLVED");
  if (!ips.every(isPublicIp)) throw new SafeFetchError("URL_HOST_NOT_ALLOWED");
}

export async function safeFetchText(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const resolve = options.resolve ?? defaultResolve;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = validatePublicUrl(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      await assertPublicHost(url, resolve);
      let response: Response;
      try {
        response = await fetchImpl(url.href, {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
            "User-Agent": "Mozilla/5.0 (compatible; WiseWolfHubReader/1.0)",
          },
        });
      } catch (error) {
        if (controller.signal.aborted) throw new SafeFetchError("URL_TIMEOUT");
        throw new SafeFetchError(
          error instanceof SafeFetchError ? error.code : "URL_FETCH_FAILED",
        );
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new SafeFetchError("URL_FETCH_FAILED");
        url = validatePublicUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new SafeFetchError(`URL_HTTP_${response.status}`);
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .toLowerCase();
      if (
        !contentType.startsWith("text/html") &&
        !contentType.startsWith("application/xhtml+xml") &&
        !contentType.startsWith("text/plain")
      ) {
        await response.body?.cancel();
        throw new SafeFetchError("URL_CONTENT_TYPE_NOT_ALLOWED");
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > maxBytes) {
        await response.body?.cancel();
        throw new SafeFetchError("URL_TOO_LARGE");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new SafeFetchError("URL_FETCH_FAILED");
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new SafeFetchError("URL_TOO_LARGE");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const charset = contentType.match(/charset=([\w-]+)/)?.[1] ?? "utf-8";
      let body: string;
      try {
        body = new TextDecoder(charset).decode(bytes);
      } catch {
        body = new TextDecoder("utf-8").decode(bytes);
      }
      return { finalUrl: url.href, contentType, body };
    }
    throw new SafeFetchError("URL_TOO_MANY_REDIRECTS");
  } catch (error) {
    if (error instanceof SafeFetchError) throw error;
    if (controller.signal.aborted) throw new SafeFetchError("URL_TIMEOUT");
    throw new SafeFetchError("URL_FETCH_FAILED");
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  hellip: "…",
};

const decodeEntities = (value: string): string =>
  value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x"
        ? parseInt(code.slice(2), 16)
        : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });

// Texto principal de uma página: prefere <article>/<main>, tira script, estilo,
// navegação, cabeçalho, rodapé, formulários e comentários.
export function extractReadableText(
  html: string,
): { title: string; text: string } {
  const title = decodeEntities(
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(
      /\s+/g,
      " ",
    ).trim(),
  ).slice(0, 200);
  let source = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template)\b[\s\S]*?<\/\1>/gi,
      " ",
    );
  const article = source.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ??
    source.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
  if (article && article.replace(/<[^>]+>/g, " ").trim().length > 400) {
    source = article;
  }
  const text = decodeEntities(
    source
      .replace(
        /<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote|\/section)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return { title, text };
}
