import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeScopedAutomation,
  scopeAutomationRows,
} from "../_shared/automation-auth.ts";
import { loadTenantCentralWhatsAppInstance } from "../_shared/tenant-communication.ts";
import {
  normalizeClosingMonth,
  runTenantMonthlyTeacherClosing,
} from "./tenant-closing.ts";

// Fechamento dos professores + aviso WhatsApp.
// - Cron dia 1º (06:30 UTC): gera os fechamentos do mês anterior e avisa cada professor.
// - Cron diário wisewolf-closing-recalc (11:30 UTC): reprocessa M-1 e M-2 (janela retroativa
//   de 45 dias do LessonLauncher). A RPC recalcula totais enquanto status='PENDENTE' e, se o
//   valor mudou, apaga o dedupe — aí esta função reavisa com o texto de "atualizado".
// Dedupe: automation_sent (kind=MONTHLY_CLOSING, subject_id=`teacher:month`), ignora ref_date.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";
const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

interface ClosingGenerationResult {
  month?: string;
  created?: number;
  updated?: number;
  updated_teacher_ids?: string[];
}

interface ClosingNotificationRow {
  tenant_id: string;
  teacher_id: string;
  phone?: string;
  name?: string;
  lessons?: number;
  amount?: number;
}

function normPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}
const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
function monthLabel(m: string) {
  const [y, mo] = (m || "").split("-");
  return mo ? `${MONTHS_PT[Number(mo) - 1]} de ${y}` : m;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = await authorizeScopedAutomation(req, corsHeaders, {
    allowAdmin: true,
  });
  if (auth.ok === false) return auth.response;
  try {
    const supabase = auth.context.admin;
    const tenantId = auth.context.tenantId;
    const today = new Date().toISOString().split("T")[0];

    let requestedMonth: unknown = null;
    try {
      const body = await req.json();
      requestedMonth = body?.month ?? null;
    } catch { /* sem body */ }

    const normalizedMonth = normalizeClosingMonth(requestedMonth);
    let gen: ClosingGenerationResult;
    if (auth.context.isService) {
      const { data, error } = await supabase.rpc(
        "run_monthly_teacher_closing",
        { p_month: requestedMonth || null },
      );
      if (error) throw error;
      gen = (data ?? {}) as ClosingGenerationResult;
    } else {
      if (!tenantId) throw new Error("tenant_context_required");
      gen = await runTenantMonthlyTeacherClosing(
        supabase,
        tenantId,
        normalizedMonth,
      );
    }
    const targetMonth: string = gen?.month || normalizedMonth;
    const updatedIds: string[] = Array.isArray(gen?.updated_teacher_ids) ? gen.updated_teacher_ids : [];

    const { data: closings, error: closingsError } = await supabase.rpc(
      "monthly_closings_to_notify",
      { p_month: targetMonth },
    );
    if (closingsError) throw closingsError;
    const result = { month: targetMonth, generated: gen?.created ?? 0, updated: gen?.updated ?? 0, notified: 0, skipped: 0, failures: [] as string[] };

    const instCache: Record<string, string | null> = {};
    async function instance(tenantId: string) {
      if (!(tenantId in instCache)) {
        instCache[tenantId] = await loadTenantCentralWhatsAppInstance(
          supabase,
          tenantId,
          "teacher",
        );
      }
      return instCache[tenantId];
    }

    for (const c of scopeAutomationRows<ClosingNotificationRow>(closings, tenantId)) {
      if (!Number(c.lessons)) { result.skipped++; continue; }
      const subj = `${c.teacher_id}:${targetMonth}`;

      const { data: dup } = await supabase.from("automation_sent").select("id")
        .eq("kind", "MONTHLY_CLOSING").eq("subject_id", subj).maybeSingle();
      if (dup) { result.skipped++; continue; }

      const phone = normPhone(c.phone || "");
      if (phone.length < 12) { result.failures.push(`${c.teacher_id}: telefone inválido`); continue; }

      const inst = await instance(c.tenant_id);
      if (!inst) { result.failures.push(`${c.teacher_id}: tenant sem WhatsApp central`); continue; }

      const nome = (c.name || "").trim().split(" ")[0];
      // Se a RPC atualizou os totais deste professor nesta passada, é um reaviso de valor novo
      const isUpdate = updatedIds.includes(c.teacher_id);
      const intro = isUpdate
        ? `Seu fechamento de *${monthLabel(targetMonth)}* foi *atualizado* (novas aulas contabilizadas):`
        : `Seu fechamento de *${monthLabel(targetMonth)}* já está pronto:`;
      const text = `Olá ${nome}!\n\n${intro}\n\n` +
        `📚 Aulas pagas: *${c.lessons}*\n` +
        `💰 Total a receber: *${money(c.amount)}*\n\n` +
        `Você pode conferir o relatório completo e baixar o PDF na plataforma, em *Financeiro → Meu Relatório (PDF)*.\n\n` +
        `Qualquer dúvida, é só chamar. Obrigado pelo seu trabalho! 💜`;

      const resp = await fetch(`${EVOLUTION_API_BASE}/${inst}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: API_TOKEN },
        body: JSON.stringify({ number: phone, text, delay: 800, linkPreview: false }),
      });
      if (!resp.ok) { result.failures.push(`${c.teacher_id}: evolution ${resp.status}`); continue; }
      await supabase.from("automation_sent").insert({ kind: "MONTHLY_CLOSING", subject_id: subj, ref_date: today });
      result.notified++;
    }

    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    const message = e instanceof Error ? e.message : "automation_failed";
    const invalidMonth = message === "invalid_month";
    if (!invalidMonth) {
      console.error("Monthly teacher closing failed", { message });
    }
    return new Response(
      JSON.stringify({ error: invalidMonth ? message : "automation_failed" }),
      {
        status: invalidMonth ? 400 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
