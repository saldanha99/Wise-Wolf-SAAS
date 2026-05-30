import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Página pública (verify_jwt=false) de confirmação de presença pelo ALUNO.
// Acesso via link 1-clique enviado por WhatsApp. Token único por aula.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Mapeia o parâmetro curto da URL para o enum interno
const R_MAP: Record<string, string> = {
  present: "STUDENT_PRESENT",
  noshow: "TEACHER_NO_SHOW",
  absent: "STUDENT_SELF_ABSENT",
};

function page(title: string, body: string): Response {
  const html = `<!DOCTYPE html><html lang="pt-BR"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  body{background:linear-gradient(160deg,#0f172a 0%,#1e1b4b 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;color:#e2e8f0}
  .card{background:#ffffff;color:#0f172a;border-radius:28px;max-width:420px;width:100%;padding:32px 28px;box-shadow:0 30px 60px -20px rgba(0,0,0,.5);text-align:center}
  .wolf{font-size:46px;margin-bottom:8px}
  h1{font-size:20px;font-weight:800;margin-bottom:8px;line-height:1.3}
  p{font-size:14px;color:#475569;line-height:1.55;margin-bottom:8px}
  .meta{background:#f1f5f9;border-radius:14px;padding:12px 14px;margin:16px 0;font-size:13px;color:#334155}
  .btns{display:flex;flex-direction:column;gap:12px;margin-top:20px}
  a.btn{display:block;text-decoration:none;padding:16px;border-radius:16px;font-weight:700;font-size:15px;transition:transform .1s}
  a.btn:active{transform:scale(.97)}
  .ok{background:#10b981;color:#fff}
  .bad{background:#ef4444;color:#fff}
  .neutral{background:#f1f5f9;color:#334155;border:1px solid #e2e8f0}
  .done{font-size:54px;margin-bottom:10px}
  .small{font-size:12px;color:#94a3b8;margin-top:18px}
</style></head><body><div class="card">${body}</div></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");
    const r = url.searchParams.get("r");

    if (!token) {
      return page("Link inválido", `<div class="wolf">🐺</div><h1>Link inválido</h1><p>Este link de confirmação não é válido.</p>`);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // Busca a confirmação para personalizar a página
    const { data: conf } = await supabase
      .from("attendance_confirmations")
      .select("teacher_name, class_date, class_time, student_name, student_response, status")
      .eq("token", token)
      .maybeSingle();

    if (!conf) {
      return page("Link inválido", `<div class="wolf">🐺</div><h1>Link inválido ou expirado</h1><p>Não encontramos esta confirmação.</p>`);
    }

    const prof = conf.teacher_name || "seu professor";
    const aluno = (conf.student_name || "").split(" ")[0] || "";
    const dataFmt = conf.class_date
      ? new Date(conf.class_date + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })
      : "";
    const hora = conf.class_time ? ` às ${String(conf.class_time).slice(0, 5)}` : "";

    // Já respondeu antes
    if (conf.student_response) {
      return page("Já registrado", `<div class="done">✅</div><h1>Você já respondeu</h1><p>Obrigado, ${aluno}! Sua confirmação sobre a aula com <b>${prof}</b> já foi registrada.</p><p class="small">Pode fechar esta página.</p>`);
    }

    // Resposta selecionada → grava
    if (r && R_MAP[r]) {
      const { data, error } = await supabase.rpc("apply_student_response", {
        p_token: token,
        p_response: R_MAP[r],
      });
      if (error || (data && data.ok === false)) {
        return page("Erro", `<div class="wolf">🐺</div><h1>Não foi possível registrar</h1><p>${error?.message || data?.error || "Tente novamente pelo link."}</p>`);
      }
      let msg = "Obrigado pela confirmação!";
      if (R_MAP[r] === "STUDENT_PRESENT") msg = "Que bom que sua aula aconteceu! 🎉";
      else if (R_MAP[r] === "TEACHER_NO_SHOW") msg = "Registramos que o professor não compareceu. Nossa equipe vai verificar. 🙏";
      else if (R_MAP[r] === "STUDENT_SELF_ABSENT") msg = "Tudo bem, registramos sua ausência. Te esperamos na próxima! 💪";
      return page("Confirmado", `<div class="done">✅</div><h1>Resposta registrada</h1><p>${msg}</p><p class="small">Obrigado, ${aluno}. Pode fechar esta página.</p>`);
    }

    // Página inicial com os botões
    const base = `${url.origin}${url.pathname}?token=${encodeURIComponent(token)}`;
    return page("Confirmar aula", `
      <div class="wolf">🐺</div>
      <h1>Oi ${aluno}! Sobre sua aula${dataFmt ? ` de ${dataFmt}${hora}` : ""}</h1>
      <p>Com <b>${prof}</b>. Pra gente manter a qualidade, confirme rapidinho o que aconteceu:</p>
      <div class="meta">Sua resposta é confidencial e ajuda a garantir que tudo ocorra certinho. 💜</div>
      <div class="btns">
        <a class="btn ok" href="${base}&r=present">✅ Sim, tive minha aula normalmente</a>
        <a class="btn bad" href="${base}&r=noshow">❌ O professor não apareceu</a>
        <a class="btn neutral" href="${base}&r=absent">🤷 Eu que não pude comparecer</a>
      </div>
      <p class="small">Wise Wolf · Escola de Idiomas</p>
    `);
  } catch (e) {
    return page("Erro", `<div class="wolf">🐺</div><h1>Algo deu errado</h1><p>Tente abrir o link novamente.</p>`);
  }
});
