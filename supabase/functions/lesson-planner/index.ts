import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Planner de aula PERSONALIZADO por aluno (IA real).
// Junta perfil + pontos fracos (wolfie_corrections) + histórico de aulas + materiais aprovados
// + plano anterior (continuidade) e pede ao modelo um plano estruturado.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "google/gemini-flash-1.5",
  "meta-llama/llama-3.3-70b-instruct:free",
];

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { student_id, custom_prompt } = await req.json();
    if (!student_id) return json({ error: "student_id obrigatório" }, 400);

    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const authHeader = req.headers.get("Authorization") || "";

    // Autenticação + papel
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: auth } = await userClient.auth.getUser();
    if (!auth?.user) return json({ error: "nao_autenticado" }, 401);
    const { data: me } = await userClient.from("profiles").select("role, tenant_id").eq("id", auth.user.id).maybeSingle();
    if (!me || !["TEACHER", "SCHOOL_ADMIN", "SUPER_ADMIN"].includes(me.role)) return json({ error: "sem_permissao" }, 403);

    const db = createClient(url, service);

    // 1. Perfil do aluno
    const { data: s } = await db.from("profiles").select("*").eq("id", student_id).maybeSingle();
    if (!s) return json({ error: "aluno_nao_encontrado" }, 404);

    // 2. Pontos fracos (correções recorrentes do Wolfie)
    const { data: sess } = await db.from("wolfie_sessions").select("id, overall_score, summary, topic, created_at").eq("student_id", student_id).order("created_at", { ascending: false }).limit(30);
    const sessIds = (sess || []).map((x: any) => x.id);
    let weak: Record<string, number> = {};
    if (sessIds.length) {
      const { data: corr } = await db.from("wolfie_corrections").select("error_type").in("session_id", sessIds).limit(200);
      (corr || []).forEach((c: any) => { const k = (c.error_type || "Outros").trim() || "Outros"; weak[k] = (weak[k] || 0) + 1; });
    }
    const weakList = Object.entries(weak).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${k} (${n}x)`);
    const lastSession = (sess || [])[0];

    // 3. Histórico de aulas (continuidade)
    const { data: logs } = await db.from("class_logs").select("class_date, presence, content_covered, student_difficulties, homework_assigned")
      .eq("student_id", student_id).order("class_date", { ascending: false }).limit(5);

    // 4. Plano anterior (continuidade)
    const { data: prevPlans } = await db.from("lesson_plans").select("objectives, content, ai_memory, created_at")
      .eq("student_id", student_id).order("created_at", { ascending: false }).limit(2);

    // 5. Materiais aprovados disponíveis (do nível/nicho)
    const { data: mats } = await db.from("pedagogical_materials").select("title, type, level_tag, niche")
      .eq("tenant_id", s.tenant_id).eq("approval_status", "APPROVED").limit(40);

    // ─── Monta o contexto ───
    const ctx = `ALUNO: ${s.full_name || "—"}
Nível/Módulo: ${s.module || "?"} | Idioma p/: ${s.english_for || s.learning_objective || "—"} | Profissão: ${s.occupation || "—"}
Perfil/personalidade: ${s.personality || "—"} | KIDS: ${s.is_kids ? "sim (criança)" : "não"}
Interesses: ${(Array.isArray(s.interests) ? s.interests.join(", ") : s.interests) || "—"}
Tópicos preferidos: ${(s.preferred_topics || []).join(", ") || "—"} | Evitar: ${(s.avoided_topics || []).join(", ") || "—"}
Objetivo curto: ${s.short_term_goal || "—"} | longo: ${s.long_term_goal || "—"}

PONTOS FRACOS RECORRENTES (do tutor IA): ${weakList.length ? weakList.join("; ") : "sem dados ainda"}
Última sessão do tutor: nota ${lastSession?.overall_score ?? "—"} | tópico ${lastSession?.topic || "—"} | resumo: ${(lastSession?.summary || "").slice(0, 200)}

ÚLTIMAS AULAS (mais recente primeiro):
${(logs || []).map((l: any) => `- ${l.class_date} [${l.presence}] conteúdo: ${l.content_covered || "—"} | dificuldades: ${l.student_difficulties || "—"} | tarefa: ${l.homework_assigned || "—"}`).join("\n") || "sem histórico"}

PLANO ANTERIOR (p/ dar continuidade):
${(prevPlans || []).map((p: any) => `- Objetivos: ${(p.objectives || "").slice(0, 150)} | Memória: ${(p.ai_memory || "").slice(0, 150)}`).join("\n") || "nenhum"}

MATERIAIS APROVADOS DISPONÍVEIS (sugira SOMENTE destes pelo título):
${(mats || []).map((m: any) => `- "${m.title}" [${m.type}, ${m.level_tag || "?"}, ${m.niche || "geral"}]`).join("\n") || "nenhum material cadastrado"}

PEDIDO DO PROFESSOR (priorize): ${custom_prompt || "(nenhum — siga o diagnóstico)"}`;

    const prompt = `Você é um coordenador pedagógico de inglês. Monte UM plano de aula de ~50 min PERSONALIZADO para este aluno específico, em português do Brasil, atacando os PONTOS FRACOS recorrentes e dando CONTINUIDADE à última aula (não repita o que já foi visto). Use o nível CEFR correto e o perfil/interesses do aluno. Sugira materiais APENAS da lista fornecida (pelo título exato). Seja concreto e prático — nada genérico.

Responda APENAS em JSON válido, sem markdown, no formato:
{
  "objectives": "1 a 2 frases com o objetivo central da aula (focado no que o aluno precisa)",
  "content": "Plano em seções com tempos: \\n🔥 Aquecimento (5min): ...\\n📚 Atividade principal (25min): ... (focada no ponto fraco X)\\n🗣️ Prática (15min): ...\\n📝 Lição de casa: ...\\n🚫 Evitar: ...\\n🔗 Continuidade: (o que retomar da última aula)",
  "materials": "lista curta de materiais sugeridos (só os da lista fornecida) separados por vírgula, ou 'Nenhum material específico'",
  "ai_memory_reflection": "1-2 frases de insight sobre como ESTE aluno aprende melhor, para a próxima aula"
}

CONTEXTO:
${ctx}`;

    const apiKey = (Deno.env.get("OPENROUTER_API_KEY") ?? "").trim();
    if (!apiKey) return json({ error: "OPENROUTER_API_KEY ausente" }, 500);

    let raw = "";
    let lastErr = "";
    for (const model of MODELS) {
      try {
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "HTTP-Referer": "https://system.wisewolflanguage.com.br", "X-Title": "WiseCore Lesson Planner" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 1200, temperature: 0.6 }),
          signal: AbortSignal.timeout(25000),
        });
        if (!resp.ok) { lastErr = `${model} ${resp.status}`; if (resp.status === 401) break; continue; }
        const d = await resp.json();
        const t = d.choices?.[0]?.message?.content;
        if (t && t.trim()) { raw = t.trim(); break; }
      } catch (e) { lastErr = `${model}: ${(e as Error).message}`; }
    }
    if (!raw) return json({ error: "IA indisponível. " + lastErr }, 502);

    // Sanitiza e parseia o JSON
    let cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
    let plan;
    try { plan = JSON.parse(cleaned); } catch { plan = { objectives: "Plano gerado", content: raw, materials: "", ai_memory_reflection: "" }; }

    return json({
      objectives: plan.objectives || "",
      content: plan.content || "",
      materials: plan.materials || "",
      ai_memory_reflection: plan.ai_memory_reflection || "",
      weak_points: weakList,
    });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
});

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
