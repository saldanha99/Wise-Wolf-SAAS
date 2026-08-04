import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Endpoint público (token) onde o professor substituto confirma/recusa a cobertura.
// Link enviado por WhatsApp pelo coverage-admin. Token de uso único (status pending).

function page(title: string, msg: string, color: string) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
  <body style="font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
  <div style="max-width:380px;text-align:center;padding:40px;background:#1e293b;border-radius:24px;border:1px solid #334155">
  <div style="font-size:48px;margin-bottom:8px">🐺</div>
  <h1 style="font-size:20px;margin:0 0 12px;color:${color}">${title}</h1>
  <p style="font-size:14px;line-height:1.5;color:#94a3b8;margin:0">${msg}</p>
  </div></body></html>`;
}
function html(body: string, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');
    const decline = url.searchParams.get('decline') === '1';
    if (!token) return html(page('Link inválido', 'Token ausente.', '#f87171'), 400);

    const S = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: cov } = await S.from('class_coverages').select('*').eq('token', token).maybeSingle();
    if (!cov) return html(page('Não encontrado', 'Esta solicitação de cobertura não existe mais.', '#f87171'), 404);

    if (cov.status === 'confirmed') return html(page('Já confirmada', 'Você já confirmou esta cobertura. Obrigado! 💜', '#34d399'));
    if (cov.status === 'declined') return html(page('Já recusada', 'Esta cobertura já foi recusada.', '#fbbf24'));
    if (cov.status !== 'pending') return html(page('Indisponível', 'Esta cobertura não está mais disponível.', '#fbbf24'));

    const dataFmt = new Date(cov.class_date + 'T00:00:00').toLocaleDateString('pt-BR');
    if (decline) {
      await S.from('class_coverages').update({ status: 'declined', declined_at: new Date().toISOString() }).eq('id', cov.id);
      return html(page('Cobertura recusada', `Tudo bem. A coordenação será avisada e buscará outro professor para ${dataFmt} às ${cov.class_time}.`, '#fbbf24'));
    }
    await S.from('class_coverages').update({ status: 'confirmed', confirmed_at: new Date().toISOString() }).eq('id', cov.id);

    // O aceite tem que MOVER O PAGAMENTO, não só marcar a linha como confirmada.
    // Era exatamente o que faltava: a cobertura era registrada e a aula continuava
    // na folha de quem não deu. Se a aula já foi lançada, o class_log muda de
    // professor e os dois fechamentos pendentes são recalculados; se ainda é
    // futura, a linha confirmada redireciona o lançamento.
    const { error: applyErr } = await S.rpc('apply_coverage_acceptance', { p_coverage_id: cov.id });
    if (applyErr) {
      console.error('apply_coverage_acceptance falhou:', applyErr.message);
      return html(page('Cobertura confirmada, com pendência', `Você assumiu a aula de ${dataFmt} às ${cov.class_time}, mas o pagamento não foi transferido automaticamente. Avise a coordenação para conferir. Detalhe: ${applyErr.message}`, '#fbbf24'));
    }

    return html(page('Cobertura confirmada! ✅', `Você assumiu a aula de ${dataFmt} às ${cov.class_time}. Ela aparecerá na sua agenda e será contabilizada no seu pagamento. Obrigado! 🐺💜`, '#34d399'));
  } catch (e) {
    return html(page('Erro', (e as Error).message, '#f87171'), 500);
  }
});
