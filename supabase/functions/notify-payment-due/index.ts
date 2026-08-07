import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeAutomation } from "../_shared/automation-auth.ts";

// Cron diário: avisa o aluno X dias antes do vencimento da mensalidade (WhatsApp).
// Envia pela instância central da escola (admin do tenant). Idempotente via due_reminder_sent_at.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const EVOLUTION_API_BASE = "https://api.2b.app.br/message/sendText";
const API_TOKEN = Deno.env.get("EVOLUTION_API_KEY") || "";
const DAYS_AHEAD = 3; // avisa 3 dias antes

// Régua de vencidas: dias APÓS o vencimento em que o aluno é lembrado de novo.
//
// ⚠️ Antes desta régua, fatura vencida sumia para sempre. A consulta só pegava
// `status = 'PENDING'` com vencimento nos próximos 3 dias e marcava
// `due_reminder_sent_at` para nunca repetir — quando o boleto vencia e virava
// `OVERDUE`, ele saía do filtro e ninguém era cobrado mais. Foi assim que a
// fatura de 05/08 de uma aluna ficou parada em silêncio: um aviso no dia 2 e
// nada mais, enquanto ela seguia tendo aula.
//
// Três toques bastam. Mais que isso vira perseguição e o aluno bloqueia o
// número da escola — aí a escola perde o canal, não só a fatura.
const OVERDUE_MILESTONES = [3, 10, 20];

async function centralInstance(supabase: any, tenantId: string | null): Promise<string | null> {
  if (!tenantId) return null;
  const { data } = await supabase.from("profiles").select("whatsapp_instance")
    .eq("tenant_id", tenantId).in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
    .not("whatsapp_instance", "is", null).neq("whatsapp_instance", "").limit(1).maybeSingle();
  return data?.whatsapp_instance || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;
  try {
    const supabase = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");

    const today = new Date();
    const limit = new Date(today.getTime() + DAYS_AHEAD * 86400_000);
    const todayISO = today.toISOString().split("T")[0];
    const limitISO = limit.toISOString().split("T")[0];

    // Cobranças pendentes que vencem nos próximos DAYS_AHEAD dias e ainda não foram avisadas
    const { data: charges, error } = await supabase
      .from("student_payments")
      .select("id, student_id, tenant_id, value, due_date, invoice_url, description")
      .eq("status", "PENDING")
      .gte("due_date", todayISO)
      .lte("due_date", limitISO)
      .is("due_reminder_sent_at", null)
      .limit(100);

    if (error) throw error;
    // ⚠️ Sem `return` aqui. A versão anterior encerrava quando não havia nada a
    // vencer nos próximos 3 dias — e a régua de vencidas, que roda depois,
    // nunca seria alcançada nos dias em que ninguém vence. São dois fluxos
    // independentes: "vai vencer" e "já venceu".
    let sent = 0;
    const failures: string[] = [];
    const instCache: Record<string, string | null> = {};

    // `|| []` é obrigatório: sem o return antecipado, `charges` nulo (nenhuma
    // cobrança a vencer) faria o for-of lançar e a régua de vencidas nunca
    // rodaria — justamente nos dias mais tranquilos.
    for (const c of charges || []) {
      try {
        const dest = await resolveRecipient(supabase, c, instCache);
        if (!dest.ok) {
          failures.push(`${c.id}: ${dest.motivo}`);
          if (dest.marcar) await mark(supabase, c.id);
          continue;
        }

        let text = `Oi ${dest.nome}! 🐺 Aqui é a Wise Wolf.\n\n`
          + `Sua mensalidade de *${brl(c.value)}* vence em *${dataBR(c.due_date)}*.`;
        if (c.invoice_url) text += `\n\nPague pelo link: ${c.invoice_url}`;
        text += `\n\nQualquer dúvida, é só chamar. Bons estudos! 💜`;

        const status = await sendWhats(dest.instance, dest.phone, text);
        if (status < 200 || status >= 300) { failures.push(`${c.id}: evolution ${status}`); continue; }
        await mark(supabase, c.id);
        sent++;
      } catch (e) { failures.push(`${c.id}: ${(e as Error).message}`); }
    }

    // Segunda passada: faturas que JÁ venceram (a régua). Roda sempre, mesmo
    // quando não há nada a vencer — são fluxos independentes.
    const regua = await reguaVencidas(supabase, instCache);

    return new Response(JSON.stringify({
      sent,
      overdue_sent: regua.enviados,
      failures: failures.length + regua.motivos.length,
      reasons: [...failures, ...regua.motivos].slice(0, 10),
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});

async function mark(supabase: any, id: string) {
  await supabase.from("student_payments").update({ due_reminder_sent_at: new Date().toISOString() }).eq("id", id);
}

/**
 * Destinatário de uma cobrança: telefone normalizado + instância central.
 *
 * Vive numa função só porque a checagem de "aluno inativo" é a mesma para o
 * aviso de vencimento e para a régua de vencidas. Duplicá-la é como as duas
 * telas de lançamento de aula divergiram — e ali a cópia errada custou
 * dinheiro do professor.
 */
// Forma plana em vez de união discriminada: o `deno check` deste projeto não
// estreita `if (!dest.ok)` e acusaria `motivo` como inexistente. Campos sempre
// presentes evitam tanto o erro quanto o `!` non-null espalhado pelo código.
interface Recipient {
  ok: boolean;
  phone: string;
  instance: string;
  nome: string;
  /** Preenchido quando ok=false. */
  motivo: string;
  /** Só quando ok=false: marcar a cobrança como avisada mesmo sem enviar. */
  marcar: boolean;
}

async function resolveRecipient(
  supabase: any,
  charge: { id: string; student_id: string; tenant_id: string | null },
  instCache: Record<string, string | null>,
): Promise<Recipient> {
  const { data: student } = await supabase.from("profiles")
    .select("full_name, phone, status, status_financial, lifecycle_status")
    .eq("id", charge.student_id).maybeSingle();

  // Aluno inativo/arquivado/suspenso/desligado: o diretor optou por NÃO notificar.
  // Pula SEM marcar como enviado → se reativar, volta a receber o aviso.
  const st = student?.status || "Ativo";
  const inativo = ["Inativo", "INACTIVE", "Inactive", "Arquivado", "Cancelado", "Trancado"].includes(st)
    || student?.status_financial === "ARCHIVED"
    || ["suspended", "offboarded"].includes(student?.lifecycle_status || "");
  if (inativo) return { ok: false, phone: "", instance: "", nome: "", motivo: "aluno inativo (sem notificar)", marcar: false };

  let phone = (student?.phone || "").replace(/\D/g, "");
  if (phone.length === 10 || phone.length === 11) phone = "55" + phone;
  if (phone.length < 12) return { ok: false, phone: "", instance: "", nome: "", motivo: "sem telefone", marcar: true };

  const tk = charge.tenant_id || "_";
  if (!(tk in instCache)) instCache[tk] = await centralInstance(supabase, charge.tenant_id);
  const instance = instCache[tk];
  if (!instance) return { ok: false, phone: "", instance: "", nome: "", motivo: "escola sem WhatsApp central", marcar: false };

  return { ok: true, phone, instance, nome: (student?.full_name || "").split(" ")[0] || "", motivo: "", marcar: false };
}

/**
 * O aluno ainda estuda? (agenda ativa OU aula lançada nos últimos 90 dias)
 *
 * ⚠️ Trava DELIBERADA da régua de vencidas, e só dela — o aviso de "vai vencer"
 * continua indo para todo mundo.
 *
 * Motivo: na simulação contra a produção, 2 dos 3 alvos eram alunos que já
 * tinham parado (0 aula em 90 dias) e cuja cobrança segue aberta só porque
 * ninguém encerrou o contrato. Eles aparecem no bloco "cobrado sem estudar" da
 * Reconciliação esperando decisão do diretor. Mandar um robô cobrar quem já foi
 * embora, antes da escola decidir se cancela, reabre uma relação encerrada do
 * pior jeito possível.
 *
 * Não é perdão de dívida: o valor continua no painel, para uma pessoa decidir.
 */
async function aindaEstuda(supabase: any, studentId: string): Promise<boolean> {
  const { count: agenda } = await supabase.from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("student_id", studentId).eq("status", "SCHEDULED");
  if ((agenda ?? 0) > 0) return true;

  const limite = new Date(Date.now() - 90 * 86400_000).toISOString().split("T")[0];
  const { count: aulas } = await supabase.from("class_logs")
    .select("id", { count: "exact", head: true })
    .eq("student_id", studentId).gte("class_date", limite);
  return (aulas ?? 0) > 0;
}

async function sendWhats(instance: string, phone: string, text: string): Promise<number> {
  const resp = await fetch(`${EVOLUTION_API_BASE}/${instance}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: API_TOKEN },
    body: JSON.stringify({ number: phone, text, delay: 800, linkPreview: true }),
  });
  return resp.status;
}

const brl = (v: unknown) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
const dataBR = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString("pt-BR");

/**
 * Régua de faturas já vencidas.
 *
 * Idempotência por `automation_sent` (kind, subject_id, ref_date) — a mesma
 * tabela das outras automações. `ref_date` é o VENCIMENTO da fatura, não a data
 * de hoje: assim cada marco é enviado uma vez por fatura, e não uma vez por dia.
 */
async function reguaVencidas(supabase: any, instCache: Record<string, string | null>) {
  const hoje = new Date();
  const maisAntigo = new Date(hoje.getTime() - (Math.max(...OVERDUE_MILESTONES) + 15) * 86400_000);

  const { data: vencidas } = await supabase
    .from("student_payments")
    .select("id, student_id, tenant_id, value, due_date, invoice_url")
    .in("status", ["OVERDUE", "PENDING"])
    .lt("due_date", hoje.toISOString().split("T")[0])
    // Janela fechada: não perseguir dívida antiga indefinidamente. Fatura mais
    // velha que o último marco + folga é caso para o diretor, não para robô.
    .gte("due_date", maisAntigo.toISOString().split("T")[0])
    .limit(200);

  let enviados = 0;
  const motivos: string[] = [];

  for (const c of vencidas || []) {
    try {
      const diasVencida = Math.floor(
        (hoje.getTime() - new Date(c.due_date + "T00:00:00").getTime()) / 86400_000,
      );
      // O maior marco já atingido: se o cron falhou alguns dias, manda o marco
      // atual em vez de disparar os três atrasados de uma vez.
      const marco = [...OVERDUE_MILESTONES].reverse().find((m) => diasVencida >= m);
      if (!marco) continue;

      const kind = `PAYMENT_OVERDUE_${marco}`;
      const { data: jaEnviado } = await supabase.from("automation_sent")
        .select("id").eq("kind", kind).eq("subject_id", c.id).eq("ref_date", c.due_date).maybeSingle();
      if (jaEnviado) continue;

      if (!(await aindaEstuda(supabase, c.student_id))) {
        motivos.push(`${c.id}: aluno sem agenda/aula 90d (decisão do diretor)`);
        continue;
      }

      const dest = await resolveRecipient(supabase, c, instCache);
      if (!dest.ok) { motivos.push(`${c.id}: ${dest.motivo}`); continue; }

      let text = `Oi ${dest.nome}! 🐺 Aqui é a Wise Wolf.\n\n`
        + `Sua mensalidade de *${brl(c.value)}*, com vencimento em *${dataBR(c.due_date)}*, `
        + `consta como *em aberto* por aqui.`;
      if (c.invoice_url) text += `\n\nSe já pagou, pode ignorar. Se ainda não, o link está aqui: ${c.invoice_url}`;
      else text += `\n\nSe já pagou, pode ignorar. Se ainda não, é só chamar que a gente te ajuda.`;
      text += `\n\nQualquer dúvida, estamos por aqui. 💜`;

      const status = await sendWhats(dest.instance, dest.phone, text);
      if (status < 200 || status >= 300) { motivos.push(`${c.id}: evolution ${status}`); continue; }

      await supabase.from("automation_sent").insert({ kind, subject_id: c.id, ref_date: c.due_date });
      enviados++;
    } catch (e) {
      motivos.push(`${c.id}: ${(e as Error).message}`);
    }
  }

  return { enviados, motivos };
}
