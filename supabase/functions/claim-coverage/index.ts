/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { sendWhatsText } from "../_shared/evolution-send.ts";
import {
  loadTenantWhatsAppRoute,
  resolveTenantConfiguredWhatsAppDestination,
} from "../_shared/tenant-communication.ts";
import { resolveEvolutionIntegration } from "../_shared/tenant-integration-broker.ts";

// Página de aceite de uma OPORTUNIDADE de cobertura (aula de professor
// ausente oferecida a vários professores; o primeiro que aceita leva).
//
// Irmã da `accept-coverage` (convite individual): GET só apresenta, POST
// decide numa RPC service-only (`claim_coverage_opportunity`) que cria a
// class_coverages e aplica o financeiro na mesma transação. Depois do aceite,
// avisa o grupo da Gestão e o professor ausente — falha no aviso não desfaz
// a cobertura.

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
    .logo{font-size:48px;margin-bottom:8px}h1{font-size:20px;margin:0 0 12px;color:${
    COLORS[accent]
  }}
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
  return html(
    page(
      title,
      accent,
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`,
    ),
    status,
    headers,
  );
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
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(date);
}

function formatTime(value: unknown): string | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(
    typeof value === "string" ? value.trim() : "",
  );
  return match ? `${match[1]}:${match[2]}` : null;
}

function firstName(value: unknown): string {
  return String(value ?? "").trim().split(/\s+/)[0] || "";
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

/**
 * Avisos depois do aceite: grupo da Gestão (destino configurado em
 * dre_report_settings, validado como pertencente à escola) e o professor
 * ausente. Melhor esforço — a cobertura já está registrada.
 */
async function notifyAfterClaim(
  supabase: any,
  result: JsonObject,
): Promise<void> {
  const tenantId = String(result.tenant_id || "");
  if (!tenantId) return;
  try {
    const route = await loadTenantWhatsAppRoute(supabase, tenantId, "general");
    if (!route) return;
    const integration = await resolveEvolutionIntegration(
      supabase,
      tenantId,
      "message.send_text",
    );
    const send = (to: string, text: string) =>
      sendWhatsText({
        base: integration.baseUrl,
        keys: [integration.apiKey],
        instance: route.instanceName,
        to,
        text,
      });

    const data = formatDate(result.class_date) ??
      String(result.class_date || "");
    const hora = formatTime(result.class_time) ??
      String(result.class_time || "");
    const aluno = String(result.student_name || "Aluno").trim();
    const cobre = String(result.cover_teacher_name || "Professor").trim();
    const ausente = String(result.original_teacher_name || "Professor").trim();

    const { data: conf } = await supabase.from("dre_report_settings")
      .select("destino,is_active").eq("tenant_id", tenantId).maybeSingle();
    const destino = conf?.is_active
      ? resolveTenantConfiguredWhatsAppDestination(route, conf.destino)
      : null;
    if (destino) {
      await send(
        destino,
        `✅ *Cobertura aceita:* a aula de *${aluno}* em ${data} às *${hora}* (de ${
          firstName(ausente)
        }) será dada por *${cobre}*. A aula já conta para ${
          firstName(cobre)
        } e não entra no pagamento de ${firstName(ausente)}.`,
      );
    }

    const { data: original } = await supabase.from("profiles")
      .select("phone,attendance_phone").eq(
        "id",
        String(result.original_teacher_id || ""),
      ).maybeSingle();
    const phone = String(original?.attendance_phone || original?.phone || "")
      .replace(/\D/g, "");
    if (phone.length >= 10) {
      await send(
        phone,
        `Olá ${
          firstName(ausente)
        }! 🐺\n\nSua aula de *${aluno}* em ${data} às *${hora}* será coberta por *${cobre}*. Ela não entra no seu pagamento deste mês. Melhoras! 💜`,
      );
    }
  } catch (error) {
    console.warn("[claim-coverage] aviso pós-aceite falhou", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function claimPage(
  token: string,
  actionPath: string,
  opp: JsonObject,
): Response {
  const date = formatDate(opp.class_date) ?? "data informada";
  const time = formatTime(opp.class_time) ?? "horário informado";
  const aluno = String(opp.student_name || "aluno").trim();
  const ausente = firstName(opp.original_teacher_name) || "o professor";
  const content = `<h1>Cobertura disponível</h1>
    <p>${escapeHtml(ausente)} não poderá dar a aula de <strong>${
    escapeHtml(aluno)
  }</strong> em <strong>${escapeHtml(date)}</strong>, às <strong>${
    escapeHtml(time)
  }</strong>. Quem aceitar primeiro fica com a aula — e ela conta no seu pagamento.</p>
    <form method="post" action="${escapeHtml(actionPath)}" autocomplete="off">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button class="accept" type="submit" name="decision" value="accept">Eu cubro essa aula</button>
      <button class="decline" type="submit" name="decision" value="decline">Não posso</button>
    </form>
    <p class="hint">Sua decisão só será registrada depois que você tocar em um dos botões.</p>`;
  return html(page("Cobertura disponível", "neutral", content));
}

async function handleGet(url: URL): Promise<Response> {
  const token = normalizedToken(url.searchParams.get("token"));
  if (!token) {
    return respond(
      "Link inválido",
      "Este link de cobertura é inválido.",
      "danger",
      400,
    );
  }
  const supabase = serviceClient();
  if (!supabase) return safeError(503);

  const { data: invite, error } = await supabase
    .from("coverage_opportunity_invites")
    .select(
      "status,opportunity:opportunity_id(status,class_date,class_time,expires_at,student_id,original_teacher_id)",
    )
    .eq("token", token)
    .maybeSingle();
  if (error) {
    console.error("claim-coverage preview failed", { code: error.code });
    return safeError(503);
  }
  const opp = asObject(invite?.opportunity);
  if (!invite || !opp) {
    return respond(
      "Convite indisponível",
      "Este convite não existe mais.",
      "danger",
      404,
    );
  }
  if (invite.status === "ACCEPTED") {
    return respond(
      "Aula é sua",
      "Você já aceitou esta cobertura. Obrigado! 💜",
      "success",
    );
  }
  if (invite.status === "DECLINED") {
    return respond(
      "Já recusada",
      "Você já respondeu que não pode cobrir esta aula.",
      "warning",
    );
  }
  if (invite.status === "LOST" || opp.status === "CLAIMED") {
    return respond(
      "Já coberta",
      "Outro professor já assumiu esta aula. Obrigado por olhar! 🐺",
      "warning",
      409,
    );
  }
  const expiry = Date.parse(String(opp.expires_at || ""));
  if (
    opp.status !== "OPEN" || (Number.isFinite(expiry) && expiry <= Date.now())
  ) {
    return respond(
      "Cobertura encerrada",
      "O prazo para esta cobertura terminou. Fale com a coordenação.",
      "warning",
      410,
    );
  }

  const [{ data: student }, { data: original }] = await Promise.all([
    supabase.from("profiles").select("full_name").eq(
      "id",
      String(opp.student_id || ""),
    ).maybeSingle(),
    supabase.from("profiles").select("full_name").eq(
      "id",
      String(opp.original_teacher_id || ""),
    ).maybeSingle(),
  ]);
  return claimPage(token, url.pathname, {
    ...opp,
    student_name: student?.full_name,
    original_teacher_name: original?.full_name,
  });
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
    tokenValues.length !== 1 || decisionValues.length !== 1 || !token ||
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
  const { data, error } = await supabase.rpc("claim_coverage_opportunity", {
    p_token: token,
    p_accept: accept,
  });
  if (error) {
    console.error("claim_coverage_opportunity failed", { code: error.code });
    return safeError(503);
  }
  const result = asObject(data) ?? {};
  if (!accept) {
    return result.ok
      ? respond(
        "Registrado",
        "Obrigado por avisar. Vamos oferecer a aula a outro professor.",
        "neutral",
      )
      : respond(
        "Indisponível",
        "Este convite não está mais aberto.",
        "warning",
        409,
      );
  }
  if (result.ok === true) {
    if (result.already !== true) await notifyAfterClaim(supabase, result);
    const date = formatDate(result.class_date) ?? "";
    const time = formatTime(result.class_time) ?? "";
    return respond(
      "Aula é sua! 🎉",
      `Você cobre a aula de ${
        String(result.student_name || "aluno")
      } em ${date} às ${time}. Ela já aparece na sua lista para lançar e conta no seu pagamento.`,
      "success",
    );
  }
  const code = String(result.error || "");
  if (code === "ja_coberta" || code === "convite_encerrado") {
    return respond(
      "Já coberta",
      "Outro professor aceitou antes. Obrigado por se dispor! 🐺",
      "warning",
      409,
    );
  }
  if (code === "expirada") {
    return respond(
      "Cobertura encerrada",
      "O prazo para esta cobertura terminou.",
      "warning",
      410,
    );
  }
  if (code === "conflito") {
    return respond(
      "Não foi possível",
      "Você já tem compromisso nesse horário ou o cadastro não permite esta cobertura. Fale com a coordenação.",
      "warning",
      409,
    );
  }
  return safeError(500);
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    if (req.method === "GET") return await handleGet(url);
    if (req.method === "POST") return await handlePost(req);
    return respond(
      "Método não permitido",
      "Use o link recebido para responder.",
      "danger",
      405,
      { Allow: "GET, POST" },
    );
  } catch (error) {
    console.error("claim-coverage unexpected failure", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return safeError();
  }
});
