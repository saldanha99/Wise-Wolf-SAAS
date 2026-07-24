import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { authorizedResumePath } from "../_shared/authorized-resume-path.ts";

// RITA — recrutadora de IA. Triagem de job_applications: lê o PDF do currículo
// (bucket privado via Storage API), avalia (score+resumo+flags+recomendação), muda
// status e envia pré-entrevista no WhatsApp. IA: Gemini free primeiro, OpenRouter fallback.
// Modos: { application_id, send_preinterview? } | { mode:'backfill', batch? }.

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const EVOLUTION_KEYS = Array.from(new Set([
  (Deno.env.get("EVOLUTION_API_KEY") || "").trim(),
].filter(Boolean)));

async function sendWhats(instance: string, payload: unknown): Promise<Response> {
  let last: Response | null = null;
  for (const key of EVOLUTION_KEYS) {
    const resp = await fetch(`${EVOLUTION_API_BASE}/${encodeURIComponent(instance)}`, { method: "POST", headers: { "Content-Type": "application/json", apikey: key }, body: JSON.stringify(payload) });
    if (resp.status !== 401) return resp;
    last = resp;
  }
  return last ?? new Response(
    JSON.stringify({ error: "Evolution integration is unavailable" }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

// ---- IA: Gemini (free) primeiro, OpenRouter (free) fallback. Retorna TEXTO (a saida
// eh JSON pedido no prompt; extractJson trata). OpenRouter free esgotou cota diária 04/07. ----
const GEMINI_KEY = (Deno.env.get("GEMINI_API_KEY") ?? "").trim();
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"];
const OR_MODELS = ["qwen/qwen3-next-80b-a3b-instruct:free", "nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-oss-120b:free", "meta-llama/llama-3.3-70b-instruct:free"];

async function callAI(system: string, user: string): Promise<string | null> {
  // 1) Gemini
  if (GEMINI_KEY) {
    for (const model of GEMINI_MODELS) {
      try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1200, responseMimeType: "application/json" } }),
          signal: AbortSignal.timeout(28000),
        });
        if (!resp.ok) continue;
        const d = await resp.json();
        const t = d.candidates?.[0]?.content?.parts?.[0]?.text;
        if (t && t.trim().length > 5) return t.trim();
      } catch { /* próximo */ }
    }
  }
  // 2) OpenRouter free
  const apiKey = (Deno.env.get("OPENROUTER_API_KEY") ?? "").trim();
  if (!apiKey) return null;
  for (const model of OR_MODELS) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}`, "HTTP-Referer": "https://system.wisewolflanguage.com.br", "X-Title": "WiseCore Rita RH" },
        body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 900, temperature: 0.3 }),
        signal: AbortSignal.timeout(25000),
      });
      if (!resp.ok) { if (resp.status === 401) break; continue; }
      const d = await resp.json();
      const t = d.choices?.[0]?.message?.content;
      if (t && t.trim().length > 5) return t.trim();
    } catch { /* próximo */ }
  }
  return null;
}

function extractJson(text: string): any | null {
  try {
    const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch { return null; }
}

async function downloadResume(
  sb: any,
  url: string,
  tenantId: string,
): Promise<{ buf: Uint8Array | null; note: string | null }> {
  try {
    const path = authorizedResumePath(url, tenantId);
    if (!path) return { buf: null, note: "caminho do currículo não pertence ao tenant" };
    const { data, error } = await sb.storage.from("resumes").download(path);
    if (error || !data) return { buf: null, note: `currículo não encontrado no storage (${error?.message || "vazio"})` };
    return { buf: new Uint8Array(await data.arrayBuffer()), note: null };
  } catch (e) { return { buf: null, note: `falha ao baixar currículo (${(e as Error).message.slice(0, 80)})` }; }
}

async function extractResumeText(
  sb: any,
  url: string,
  tenantId: string,
): Promise<{ text: string; note: string | null }> {
  const { buf, note } = await downloadResume(sb, url, tenantId);
  if (!buf) return { text: "", note };
  try {
    if (buf.length < 5 || String.fromCharCode(...buf.slice(0, 4)) !== "%PDF") return { text: "", note: "arquivo do currículo não é PDF" };
    const { getDocumentProxy, extractText } = await import("https://esm.sh/unpdf@0.12.1");
    const pdf = await getDocumentProxy(buf);
    const { text } = await extractText(pdf, { mergePages: true });
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (clean.length < 40) return { text: clean, note: "currículo com pouco texto legível (pode ser escaneado)" };
    return { text: clean.slice(0, 12000), note: null };
  } catch (e) { return { text: "", note: `falha ao ler o PDF (${(e as Error).message.slice(0, 80)})` }; }
}

const SCREENING_SYSTEM = `Você é Rita, recrutadora de IA da WISE WOLF LANGUAGE, escola de inglês em Santa Isabel/SP.
A vaga é PROFESSOR(A) DE INGLÊS como prestador de serviço PJ/MEI (perfil empreendedor), aulas online e presenciais, alunos adultos e crianças.
Critérios (peso decrescente): 1) nível de inglês/fluência e certificações; 2) experiência dando aulas; 3) disponibilidade; 4) perfil PJ/empreendedor; 5) comunicação/apresentação do currículo.
Avalie APENAS com os dados fornecidos. Não invente fatos.
Responda SOMENTE com JSON válido neste formato exato:
{"score": 0.0, "resumo": "5 linhas no máximo, pt-BR, direto", "pontos_fortes": ["..."], "red_flags": ["..."], "recomendacao": "ENTREVISTAR" | "TALVEZ" | "RECUSAR"}
Score 0-10 (uma casa decimal). Sem currículo legível: avalie com o que houver, cite nos red_flags e seja conservador (score <= 6).`;

interface AppRow { id: string; tenant_id: string; name: string; whatsapp: string; resume_url: string | null; status: string; created_at: string; notes: string | null; }

async function centralInstance(sb: any, tenantId: string): Promise<{ instance: string | null; ownerPhone: string | null }> {
  const { data } = await sb.from("profiles").select("phone, whatsapp_instance").eq("tenant_id", tenantId).in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"]).not("whatsapp_instance", "is", null).neq("whatsapp_instance", "").limit(1).maybeSingle();
  let phone = (data?.phone || "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
  return { instance: data?.whatsapp_instance || null, ownerPhone: phone.length >= 12 ? phone : null };
}

function cleanPhone(raw: string): string { let p = (raw || "").replace(/\D/g, ""); if (p.length === 10 || p.length === 11) p = "55" + p; return p; }

async function screenOne(sb: any, app: AppRow, sendPreinterview: boolean): Promise<any> {
  const resume = app.resume_url
    ? await extractResumeText(sb, app.resume_url, app.tenant_id)
    : { text: "", note: "candidato não anexou currículo" };
  const userMsg = [
    `Candidato: ${app.name}`, `WhatsApp: ${app.whatsapp}`, `Data da candidatura: ${app.created_at}`,
    app.notes ? `Observações do formulário: ${app.notes}` : null,
    resume.note ? `AVISO: ${resume.note}` : null,
    resume.text ? `--- TEXTO DO CURRÍCULO ---\n${resume.text}` : "(sem texto de currículo)",
  ].filter(Boolean).join("\n");

  const aiText = await callAI(SCREENING_SYSTEM, userMsg);
  const parsed = aiText ? extractJson(aiText) : null;
  const flags: string[] = parsed?.red_flags && Array.isArray(parsed.red_flags) ? parsed.red_flags.map(String) : [];
  if (resume.note) flags.push(resume.note);

  const update: Record<string, unknown> = {
    ai_score: parsed?.score != null && !isNaN(Number(parsed.score)) ? Math.max(0, Math.min(10, Number(parsed.score))) : null,
    ai_summary: parsed?.resumo ? String(parsed.resumo).slice(0, 2000) : "Triagem automática indisponível — revisar manualmente.",
    ai_flags: { red_flags: flags, pontos_fortes: parsed?.pontos_fortes || [] },
    ai_recommendation: ["ENTREVISTAR", "TALVEZ", "RECUSAR"].includes(parsed?.recomendacao) ? parsed.recomendacao : null,
    ai_screened_at: new Date().toISOString(),
  };
  if (app.status === "Novo") update.status = "Em Análise";
  await sb.from("job_applications").update(update).eq("id", app.id);

  let preinterviewSent = false;
  if (sendPreinterview) {
    const ageDays = (Date.now() - new Date(app.created_at).getTime()) / 86400000;
    const phone = cleanPhone(app.whatsapp);
    if (ageDays <= 14 && phone.length >= 12 && update.ai_recommendation !== "RECUSAR") {
      const { instance, ownerPhone } = await centralInstance(sb, app.tenant_id);
      if (instance) {
        const firstName = (app.name || "").trim().split(" ")[0];
        const msg = `Olá, ${firstName}! 👋 Sou a *Rita*, do RH da *Wise Wolf Language*.\n\nRecebemos sua candidatura para professor(a) de inglês e ela já está em análise! Para agilizar, me responde por aqui, no seu tempo:\n\n1️⃣ Quais dias e horários você tem disponíveis para dar aula?\n2️⃣ Qual sua pretensão de valor por aula (50 min)?\n3️⃣ Como você avalia seu inglês (nível/certificações)?\n4️⃣ Conte rapidinho sua experiência dando aulas (idades, online/presencial).\n5️⃣ To finish: please write a short paragraph in English introducing yourself. 😊\n\nPode responder uma por vez que eu vou anotando! 🐺`;
        const resp = await sendWhats(instance, { number: phone, text: msg, delay: 900, linkPreview: false });
        if (resp.ok) {
          preinterviewSent = true;
          await sb.from("job_applications").update({ preinterview_status: "SENT", preinterview_sent_at: new Date().toISOString() }).eq("id", app.id);
          await sb.from("ai_wa_messages").insert({ tenant_id: app.tenant_id, phone, agent: "rita", direction: "out", content: msg, meta: { application_id: app.id, kind: "preinterview_questions" } });
        }
        const score = Number(update.ai_score);
        if (ownerPhone && !isNaN(score) && score >= 7) await sendWhats(instance, { number: ownerPhone, text: `🧑‍💼 *Rita (RH):* candidatura nova triada!\n\n*${app.name}* — nota *${score.toFixed(1)}/10* (${update.ai_recommendation})\n${update.ai_summary}\n\nJá enviei a pré-entrevista pelo WhatsApp. Acompanhe no painel *Recursos Humanos*.`, delay: 900, linkPreview: false });
      }
    }
  }
  return { id: app.id, name: app.name, score: update.ai_score, recomendacao: update.ai_recommendation, preinterview_sent: preinterviewSent };
}

function isServiceRole(bearer: string, serviceKey: string): boolean {
  return Boolean(serviceKey && bearer === serviceKey);
}

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(url, serviceKey);
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.replace("Bearer ", "").trim();

    let authorized = isServiceRole(bearer, serviceKey);
    let tenantScope: string | null = null;
    if (!authorized) {
      const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
      const { data: auth } = await userClient.auth.getUser();
      if (auth?.user) {
        const { data: me } = await admin.from("profiles").select("role, tenant_id").eq("id", auth.user.id).maybeSingle();
        if (me && ["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(me.role)) { authorized = true; tenantScope = me.tenant_id; }
      }
    }
    if (!authorized) return json({ error: "forbidden" }, 403);

    if (body?.mode === "backfill") {
      const batch = Math.min(Number(body?.batch) || 8, 12);
      let q = admin.from("job_applications").select("*").is("ai_screened_at", null).order("created_at", { ascending: false }).limit(batch);
      if (tenantScope) q = q.eq("tenant_id", tenantScope);
      const { data: apps } = await q;
      const results = [];
      for (const app of (apps || [])) results.push(await screenOne(admin, app as AppRow, false));
      let cq = admin.from("job_applications").select("id", { count: "exact", head: true }).is("ai_screened_at", null);
      if (tenantScope) cq = cq.eq("tenant_id", tenantScope);
      const { count } = await cq;
      return json({ ok: true, processed: results.length, remaining: count ?? 0, results });
    }

    const appId = body?.application_id;
    if (!appId) return json({ error: "application_id obrigatório" }, 400);
    let q = admin.from("job_applications").select("*").eq("id", appId);
    if (tenantScope) q = q.eq("tenant_id", tenantScope);
    const { data: app } = await q.maybeSingle();
    if (!app) return json({ error: "candidatura não encontrada" }, 404);
    const result = await screenOne(admin, app as AppRow, body?.send_preinterview !== false);
    return json({ ok: true, result });
  } catch (e: any) { return json({ error: e.message }, 500); }
});
