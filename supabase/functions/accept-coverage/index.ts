/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

// GET apenas apresenta o convite. A decisão só é registrada por POST, em um
// RPC service-only que resolve status e pagamento na mesma transação.

const TOKEN_PATTERN = /^[0-9a-fA-F]{32}$/;
const MAX_FORM_BYTES = 4_096;

const COLORS = {
  danger: "#f87171",
  neutral: "#e2e8f0",
  success: "#34d399",
  warning: "#fbbf24",
} as const;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, max-age=0, must-revalidate",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  Expires: "0",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

type Accent = keyof typeof COLORS;
type JsonObject = Record<string, unknown>;

function escapeHtml(value: unknown): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(value ?? "").replace(/[&<>"']/g, (char) => entities[char]);
}

function page(title: string, accent: Accent, content: string): string {
  return `<!doctype html>
<html lang="pt-BR"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}
    main{width:100%;max-width:420px;text-align:center;padding:40px;background:#1e293b;border-radius:24px;border:1px solid #334155;box-shadow:0 20px 50px rgb(0 0 0 / 25%)}
    .logo{font-size:48px;margin-bottom:8px}h1{font-size:20px;margin:0 0 12px;color:${COLORS[accent]}}
    p{font-size:14px;line-height:1.55;color:#94a3b8;margin:0}strong{color:#e2e8f0}
    form{display:grid;gap:10px;margin-top:24px}button{width:100%;border:0;border-radius:12px;padding:13px 16px;font:inherit;font-size:14px;font-weight:700;cursor:pointer}
    .accept{background:#34d399;color:#052e16}.decline{background:#334155;color:#e2e8f0}.hint{margin-top:16px;font-size:12px;color:#64748b}
  </style>
</head><body><main><div class="logo" aria-hidden="true">🐺</div>${content}</main></body></html>`;
}

function html(
  body: string,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function respond(
  title: string,
  message: string,
  accent: Accent,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const content = `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;
  return html(page(title, accent, content), status, headers);
}

function safeError(status = 500): Response {
  return respond(
    "Não foi possível concluir",
    "Tente novamente em alguns instantes. Se o problema continuar, avise a coordenação.",
    "danger",
    status,
  );
}

function normalizedToken(value: string | null): string | null {
  const token = value?.trim() ?? "";
  return TOKEN_PATTERN.test(token) ? token.toLowerCase() : null;
}

function formatDate(value: unknown): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(
    typeof value === "string" ? value : "",
  );
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(date);
}

function formatTime(value: unknown): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(
    typeof value === "string" ? value.trim() : "",
  );
  return match ? `${match[1]}:${match[2]}` : null;
}

function invitePage(
  token: string,
  actionPath: string,
  classDate: unknown,
  classTime: unknown,
): Response {
  const date = formatDate(classDate) ?? "data informada";
  const time = formatTime(classTime) ?? "horário informado";
  const content = `<h1>Convite para cobertura de aula</h1>
    <p>A coordenação precisa de uma cobertura em <strong>${escapeHtml(date)}</strong>, às <strong>${escapeHtml(time)}</strong>. Você pode assumir essa aula?</p>
    <form method="post" action="${escapeHtml(actionPath)}" autocomplete="off">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button class="accept" type="submit" name="decision" value="accept">Confirmar cobertura</button>
      <button class="decline" type="submit" name="decision" value="decline">Não posso cobrir</button>
    </form>
    <p class="hint">Sua decisão só será registrada depois que você tocar em um dos botões.</p>`;
  return html(page("Convite para cobertura de aula", "neutral", content));
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function asObject(value: unknown): JsonObject | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate)
    ? (candidate as JsonObject)
    : null;
}

function resolutionResponse(
  value: unknown,
  requestedAccept: boolean,
): Response {
  const result = asObject(value);
  if (!result || result.ok !== true) {
    return result?.ok === false
      ? respond(
          "Cobertura indisponível",
          "Este convite não pode mais ser utilizado. Fale com a coordenação se precisar confirmar a situação.",
          "warning",
          409,
        )
      : safeError(503);
  }

  const status =
    typeof result.status === "string" ? result.status.toLowerCase() : "";
  const date = formatDate(result.class_date);
  const time = formatTime(result.class_time);
  const when = date && time ? ` de ${date} às ${time}` : "";
  const already = result.already === true;

  if (status === "confirmed") {
    const conflict = !requestedAccept;
    return respond(
      conflict || already
        ? "Cobertura já confirmada"
        : "Cobertura confirmada! ✅",
      conflict
        ? "Esta cobertura já havia sido confirmada e não pode mais ser recusada por este link."
        : already
          ? "Você já havia confirmado esta cobertura. Obrigado! 💜"
          : `Você assumiu a aula${when}. Ela será contabilizada no seu pagamento. Obrigado! 🐺💜`,
      "success",
    );
  }

  if (status === "declined") {
    const conflict = requestedAccept;
    return respond(
      conflict || already ? "Cobertura já recusada" : "Cobertura recusada",
      conflict
        ? "Esta cobertura já havia sido recusada e não pode mais ser confirmada por este link."
        : already
          ? "Você já havia recusado esta cobertura."
          : `Tudo bem. A coordenação será avisada e buscará outro professor${when}.`,
      "warning",
    );
  }

  // Nunca inferir sucesso de um estado não previsto no contrato do RPC.
  return safeError(503);
}

async function readLimitedBody(req: Request): Promise<string | null> {
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES) {
    return null;
  }
  if (!req.body) return "";

  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return result + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_FORM_BYTES) {
      await reader.cancel();
      return null;
    }
    result += decoder.decode(value, { stream: true });
  }
}

async function handleGet(url: URL): Promise<Response> {
  const token = normalizedToken(url.searchParams.get("token"));
  if (!token)
    return respond(
      "Link inválido",
      "Este link de cobertura é inválido.",
      "danger",
      400,
    );

  const supabase = serviceClient();
  if (!supabase) return safeError(503);
  const { data: coverage, error } = await supabase
    .from("class_coverages")
    .select("status,class_date,class_time,invite_expires_at")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.error("accept-coverage preview failed", { code: error.code });
    return safeError(503);
  }
  if (!coverage) {
    return respond(
      "Convite indisponível",
      "Este convite não existe mais ou não está disponível.",
      "danger",
      404,
    );
  }
  if (coverage.status === "confirmed") {
    return respond(
      "Já confirmada",
      "Você já confirmou esta cobertura. Obrigado! 💜",
      "success",
    );
  }
  if (coverage.status === "declined") {
    return respond("Já recusada", "Esta cobertura já foi recusada.", "warning");
  }
  if (coverage.status !== "pending") {
    return respond(
      "Indisponível",
      "Esta cobertura não está mais disponível.",
      "warning",
      409,
    );
  }
  const explicitExpiry = Date.parse(String(coverage.invite_expires_at || ""));
  const classDate =
    typeof coverage.class_date === "string" ? coverage.class_date : "";
  const classTime = formatTime(coverage.class_time) || "";
  const classStart = Date.parse(`${classDate}T${classTime}:00-03:00`);
  if (
    (Number.isFinite(explicitExpiry) && explicitExpiry <= Date.now()) ||
    (Number.isFinite(classStart) && classStart <= Date.now())
  ) {
    return respond(
      "Convite expirado",
      "O prazo para responder a esta cobertura terminou. Fale com a coordenação.",
      "warning",
      410,
    );
  }
  return invitePage(
    token,
    url.pathname,
    coverage.class_date,
    coverage.class_time,
  );
}

async function handlePost(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/x-www-form-urlencoded")) {
    return respond(
      "Solicitação inválida",
      "Não foi possível interpretar sua decisão.",
      "danger",
      415,
    );
  }
  if (req.headers.get("sec-fetch-site") === "cross-site") {
    return respond(
      "Solicitação bloqueada",
      "Abra novamente o link enviado pela coordenação.",
      "danger",
      403,
    );
  }

  const rawBody = await readLimitedBody(req);
  if (rawBody === null) {
    return respond(
      "Solicitação inválida",
      "Os dados enviados são maiores que o permitido.",
      "danger",
      413,
    );
  }
  const form = new URLSearchParams(rawBody);
  const tokenValues = form.getAll("token");
  const decisionValues = form.getAll("decision");
  const token = normalizedToken(tokenValues[0] ?? null);
  const decision = decisionValues[0];
  if (
    tokenValues.length !== 1 ||
    decisionValues.length !== 1 ||
    !token ||
    (decision !== "accept" && decision !== "decline")
  ) {
    return respond(
      "Solicitação inválida",
      "O convite ou a decisão não são válidos.",
      "danger",
      400,
    );
  }

  const supabase = serviceClient();
  if (!supabase) return safeError(503);
  const accept = decision === "accept";
  const { data, error } = await supabase.rpc("resolve_coverage_invite", {
    p_token: token,
    p_accept: accept,
  });
  if (error) {
    console.error("resolve_coverage_invite failed", { code: error.code });
    return safeError(503);
  }
  return resolutionResponse(data, accept);
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET") return await handleGet(url);
    if (req.method === "POST") return await handlePost(req);
    return respond(
      "Método não permitido",
      "Use o link recebido para responder ao convite.",
      "danger",
      405,
      { Allow: "GET, POST" },
    );
  } catch (error) {
    console.error("accept-coverage unexpected failure", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return safeError();
  }
});
