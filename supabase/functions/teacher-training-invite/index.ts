import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { renderTrainingInvite } from "./page.ts";

Deno.serve(async (req: Request) => {
  const headers = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  };
  if (!["GET", "POST"].includes(req.method)) {
    return new Response("Método não permitido.", { status: 405, headers });
  }
  const url = new URL(req.url);
  // Sem checagem de Origin de propósito (removida em 16/09/2026). Com
  // `Referrer-Policy: no-referrer` o navegador manda `Origin: null` no POST do
  // formulário (medido no Chromium), e a checagem antiga devolvia 403 "Origem
  // inválida" para TODO aceite — nenhum convite de treinamento jamais foi aceito
  // por esta página. O que protege o aceite é o token de 64 hex no corpo, que só
  // quem recebeu o convite tem — o mesmo desenho da `accept-coverage`, que funciona.
  // `form-action 'self'` no CSP já impede o formulário de postar para fora.
  if (Number(req.headers.get("content-length") || 0) > 2048) {
    return new Response("Pedido inválido.", { status: 413, headers });
  }
  let token = url.searchParams.get("token") || "";
  let decision: string | null = null;
  if (req.method === "POST") {
    try {
      const form = new URLSearchParams(await req.text());
      token = form.get("token") || "";
      decision = form.get("decision");
    } catch {
      return new Response(
        renderTrainingInvite({ ok: false, error: "Resposta inválida." }, ""),
        { status: 400, headers },
      );
    }
    if (!["accept", "decline"].includes(decision || "")) {
      return new Response(
        renderTrainingInvite({
          ok: false,
          error: "Selecione aceitar ou recusar.",
        }, ""),
        { status: 400, headers },
      );
    }
  }
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return new Response(
      renderTrainingInvite({ ok: false, error: "Convite inválido." }, ""),
      { status: 400, headers },
    );
  }
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data, error } = await sb.rpc("teacher_training_invite", {
    p_token: token,
    p_decision: decision,
  });
  const payload = error
    ? {
      ok: false,
      error: error.message?.startsWith("Um dos teachers")
        ? "Um dos teachers já possui compromisso nesse horário. Peça outro horário à gestão."
        : "Não foi possível confirmar agora. Tente novamente ou fale com a gestão.",
    }
    : data;
  return new Response(renderTrainingInvite(payload, token), {
    status: payload?.ok ? 200 : 400,
    headers,
  });
});
