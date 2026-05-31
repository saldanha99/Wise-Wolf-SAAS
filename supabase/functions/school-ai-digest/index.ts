import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Resumo executivo da escola por IA (on-demand, só admin).
// Reusa list_students_overview (escopo por papel via JWT do chamador) + observações recentes.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Modelos OpenRouter (free first), mesma estratégia do wolfie-brain
const MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "google/gemini-flash-1.5",
  "meta-llama/llama-3.3-70b-instruct:free",
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

    // Client com o JWT do usuário → list_students_overview respeita papel/RLS
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: auth } = await userClient.auth.getUser();
    if (!auth?.user) return json({ error: "nao_autenticado" }, 401);

    const { data: me } = await userClient.from("profiles").select("role, tenant_id, full_name").eq("id", auth.user.id).maybeSingle();
    if (!me || !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(me.role)) {
      return json({ error: "sem_permissao" }, 403);
    }

    const { data: rows } = await userClient.rpc("list_students_overview");
    const list: any[] = Array.isArray(rows) ? rows : [];

    const { data: notes } = await userClient
      .from("student_teacher_notes")
      .select("category, note, author_name, created_at")
      .gte("created_at", new Date(Date.now() - 14 * 86400_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(25);

    // Agregados
    const total = list.length;
    const high = list.filter(r => r.risk_level === "HIGH");
    const medium = list.filter(r => r.risk_level === "MEDIUM");
    const overdue = list.filter(r => (r.overdue_count || 0) > 0);
    const rated = list.filter(r => r.attendance_rate != null);
    const avgRate = rated.length ? Math.round(rated.reduce((s, r) => s + r.attendance_rate, 0) / rated.length) : null;

    // por professor
    const byTeacher: Record<string, { n: number; risk: number }> = {};
    list.forEach(r => {
      const k = r.professor_name || "Sem professor";
      byTeacher[k] = byTeacher[k] || { n: 0, risk: 0 };
      byTeacher[k].n++; if (r.risk_level !== "LOW") byTeacher[k].risk++;
    });

    const riskLines = [...high, ...medium].slice(0, 20).map(r =>
      `- ${r.full_name} (${r.module || "s/ nível"}, prof. ${r.professor_name || "—"}): ${r.risk_level} — ${(r.risk_reasons || []).join("; ") || "—"}; freq ${r.attendance_rate ?? "?"}%`
    ).join("\n");

    const teacherLines = Object.entries(byTeacher).map(([k, v]) => `- ${k}: ${v.n} alunos, ${v.risk} em risco`).join("\n");
    const noteLines = (notes || []).map((n: any) => `- [${n.category}] ${n.note} (${n.author_name})`).join("\n") || "Nenhuma observação recente.";

    const dataBlock = `DADOS DA ESCOLA (gerado em ${new Date().toLocaleDateString("pt-BR")}):
Total de alunos: ${total}
Alunos em ALTO risco: ${high.length}
Alunos em ATENÇÃO: ${medium.length}
Inadimplentes: ${overdue.length}
Frequência média: ${avgRate ?? "?"}%

ALUNOS EM RISCO (com motivos):
${riskLines || "Nenhum aluno em risco."}

CARGA POR PROFESSOR:
${teacherLines}

OBSERVAÇÕES PEDAGÓGICAS RECENTES (14 dias):
${noteLines}`;

    const prompt = `Você é um consultor de gestão para escolas de idiomas. Com base nos dados abaixo, escreva um RESUMO EXECUTIVO semanal para o diretor, em português do Brasil, em markdown, curto e acionável.

Estruture em:
## 📊 Panorama
2-3 frases sobre o estado geral (alunos, risco, frequência, inadimplência).

## 🚨 Prioridades da semana
Liste 3 a 5 alunos/situações que exigem ação imediata, com a ação recomendada (ex: ligar, oferecer reposição, renegociar). Seja específico citando nomes.

## 👩‍🏫 Professores
Observações sobre distribuição de carga e professores com muitos alunos em risco.

## 💡 Recomendações
2-3 ações concretas para reduzir evasão e melhorar engajamento.

Não invente dados além dos fornecidos. Seja direto e prático.

${dataBlock}`;

    const apiKey = (Deno.env.get("OPENROUTER_API_KEY") ?? "").trim();
    if (!apiKey) return json({ error: "OPENROUTER_API_KEY ausente no Supabase" }, 500);

    let digest = "";
    let lastErr = "";
    for (const model of MODELS) {
      try {
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "HTTP-Referer": "https://system.wisewolflanguage.com.br",
            "X-Title": "WiseCore School Digest",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 1100,
            temperature: 0.5,
          }),
          signal: AbortSignal.timeout(25000),
        });
        if (!resp.ok) {
          lastErr = `${model} → ${resp.status}`;
          if (resp.status === 401) break;
          continue;
        }
        const d = await resp.json();
        const t = d.choices?.[0]?.message?.content;
        if (t && t.trim()) { digest = t.trim(); break; }
      } catch (e) { lastErr = `${model}: ${(e as Error).message}`; }
    }

    if (!digest) return json({ error: "IA indisponível no momento. " + lastErr }, 502);

    return json({
      digest,
      stats: { total, high: high.length, medium: medium.length, overdue: overdue.length, avgRate },
      generated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
