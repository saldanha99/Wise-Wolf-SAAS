import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeAutomation } from "../_shared/automation-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import {
  claimOutboundMessage,
  finishOutboundMessage,
  markOutboundMessageSubmittingDecision,
} from "../_shared/student-billing-period-guard.ts";
import {
  loadTenantCentralWhatsAppContext,
  type TenantCentralWhatsAppContext,
} from "../_shared/tenant-communication.ts";
import {
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
} from "../_shared/tenant-integration-broker.ts";
import {
  overdueNotificationKind,
  paymentNotificationFinish,
  resolvePaymentRecipient,
} from "./core.ts";

// Cron diário: avisa o aluno X dias antes do vencimento da mensalidade (WhatsApp).
// Envia pela instância central da escola (admin do tenant). Idempotente via due_reminder_sent_at.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
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

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const authError = await authorizeAutomation(req, corsHeaders);
  if (authError) return authError;
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    const today = new Date();
    const limit = new Date(today.getTime() + DAYS_AHEAD * 86400_000);
    const todayISO = today.toISOString().split("T")[0];
    const limitISO = limit.toISOString().split("T")[0];

    // Cobranças pendentes que vencem nos próximos DAYS_AHEAD dias e ainda não foram avisadas
    const { data: charges, error } = await supabase
      .from("student_payments")
      .select(
        "id, student_id, tenant_id, value, due_date, invoice_url, description",
      )
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
    const instCache: Record<string, TenantCentralWhatsAppContext | null> = {};
    const integrationCache: Record<string, ResolvedEvolutionIntegration> = {};

    // `|| []` é obrigatório: sem o return antecipado, `charges` nulo (nenhuma
    // cobrança a vencer) faria o for-of lançar e a régua de vencidas nunca
    // rodaria — justamente nos dias mais tranquilos.
    for (const c of charges || []) {
      try {
        const dest = await resolveRecipient(supabase, c, instCache);
        if (!dest.ok) {
          failures.push(`${c.id}: ${dest.motivo}`);
          continue;
        }
        const integration = await resolveTenantEvolutionIntegration(
          supabase,
          c.tenant_id,
          integrationCache,
        );

        let text = `Oi ${dest.nome}! Aqui é a ${dest.brandName}.\n\n` +
          `Sua mensalidade de *${brl(c.value)}* vence em *${
            dataBR(c.due_date)
          }*.`;
        if (c.invoice_url) text += `\n\nPague pelo link: ${c.invoice_url}`;
        text += `\n\nQualquer dúvida, é só chamar. Bons estudos! 💜`;

        const delivery = await deliverPaymentNotification(supabase, {
          tenantId: c.tenant_id,
          studentId: c.student_id,
          paymentId: c.id,
          notificationKind: "PAYMENT_DUE_REMINDER",
          integration,
          instance: dest.instance,
          phone: dest.phone,
          text,
        });
        if (delivery.status === "SENT") {
          await markDueReminder(supabase, c);
          if (delivery.sentNow) sent++;
        } else {
          failures.push(`${c.id}: ${delivery.reason}`);
        }
      } catch (e) {
        failures.push(`${c.id}: ${(e as Error).message}`);
      }
    }

    // Segunda passada: faturas que JÁ venceram (a régua). Roda sempre, mesmo
    // quando não há nada a vencer — são fluxos independentes.
    const regua = await reguaVencidas(
      supabase,
      instCache,
      integrationCache,
    );

    return new Response(
      JSON.stringify({
        sent,
        overdue_sent: regua.enviados,
        failures: failures.length + regua.motivos.length,
        reasons: [...failures, ...regua.motivos].slice(0, 10),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function markDueReminder(
  supabase: any,
  charge: { id: string; tenant_id: string; student_id: string },
) {
  const { error } = await supabase.from("student_payments")
    .update({ due_reminder_sent_at: new Date().toISOString() })
    .eq("id", charge.id)
    .eq("tenant_id", charge.tenant_id)
    .eq("student_id", charge.student_id);
  if (error) throw new Error("due_reminder_marker_failed");
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
  brandName: string;
  /** Preenchido quando ok=false. */
  motivo: string;
}

async function resolveRecipient(
  supabase: any,
  charge: { id: string; student_id: string; tenant_id: string | null },
  instCache: Record<string, TenantCentralWhatsAppContext | null>,
): Promise<Recipient> {
  if (!charge.tenant_id || !charge.student_id) {
    return {
      ok: false,
      phone: "",
      instance: "",
      nome: "",
      brandName: "",
      motivo: "escopo aluno/escola inválido",
    };
  }
  const { data: student, error: studentError } = await supabase.from("profiles")
    .select(
      "full_name, phone, guardian_id, guardian_cpf, guardian_name, guardian_phone, status, status_financial, lifecycle_status, is_test_account",
    )
    .eq("id", charge.student_id)
    .eq("tenant_id", charge.tenant_id)
    .eq("role", "STUDENT")
    .maybeSingle();
  if (studentError) throw new Error("student_recipient_lookup_failed");
  if (!student) {
    return {
      ok: false,
      phone: "",
      instance: "",
      nome: "",
      brandName: "",
      motivo: "aluno fora da escola",
    };
  }
  if (student?.is_test_account === true) {
    return {
      ok: false,
      phone: "",
      instance: "",
      nome: "",
      brandName: "",
      motivo: "conta de teste (sem notificar)",
    };
  }

  // Aluno inativo/arquivado/suspenso/desligado: o diretor optou por NÃO notificar.
  // Pula SEM marcar como enviado → se reativar, volta a receber o aviso.
  const st = student?.status || "Ativo";
  const inativo =
    ["Inativo", "INACTIVE", "Inactive", "Arquivado", "Cancelado", "Trancado"]
      .includes(st) ||
    student?.status_financial === "ARCHIVED" ||
    ["suspended", "offboarded"].includes(student?.lifecycle_status || "");
  if (inativo) {
    return {
      ok: false,
      phone: "",
      instance: "",
      nome: "",
      brandName: "",
      motivo: "aluno inativo (sem notificar)",
    };
  }

  const recipient = resolvePaymentRecipient(student);
  if (!recipient.ok) {
    return {
      ok: false,
      phone: "",
      instance: "",
      nome: "",
      brandName: "",
      motivo: recipient.reason,
    };
  }

  const tk = charge.tenant_id || "_";
  if (!(tk in instCache)) {
    instCache[tk] = charge.tenant_id
      ? await loadTenantCentralWhatsAppContext(
        supabase,
        charge.tenant_id,
        "student",
      )
      : null;
  }
  const context = instCache[tk];
  if (!context) {
    return {
      ok: false,
      phone: "",
      instance: "",
      nome: "",
      brandName: "",
      motivo: "escola sem WhatsApp central",
    };
  }

  return {
    ok: true,
    phone: recipient.phone,
    instance: context.instanceName,
    nome: recipient.firstName,
    brandName: context.identity.brandName,
    motivo: "",
  };
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
async function aindaEstuda(
  supabase: any,
  tenantId: string,
  studentId: string,
): Promise<boolean> {
  const { count: agenda } = await supabase.from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("student_id", studentId).eq("status", "SCHEDULED");
  if ((agenda ?? 0) > 0) return true;

  const limite =
    new Date(Date.now() - 90 * 86400_000).toISOString().split("T")[0];
  const { count: aulas } = await supabase.from("class_logs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("student_id", studentId).gte("class_date", limite);
  return (aulas ?? 0) > 0;
}

const brl = (v: unknown) => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
const dataBR = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("pt-BR");

/**
 * Régua de faturas já vencidas.
 *
 * Idempotência por `automation_sent` (kind, subject_id, ref_date) — a mesma
 * tabela das outras automações. `ref_date` é o VENCIMENTO da fatura, não a data
 * de hoje: assim cada marco é enviado uma vez por fatura, e não uma vez por dia.
 */
async function reguaVencidas(
  supabase: any,
  instCache: Record<string, TenantCentralWhatsAppContext | null>,
  integrationCache: Record<string, ResolvedEvolutionIntegration>,
) {
  const hoje = new Date();
  const maisAntigo = new Date(
    hoje.getTime() - (Math.max(...OVERDUE_MILESTONES) + 15) * 86400_000,
  );

  const { data: vencidas, error: overdueError } = await supabase
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
  if (overdueError) {
    return {
      enviados,
      motivos: ["consulta de cobranças vencidas indisponível"],
    };
  }

  for (const c of vencidas || []) {
    try {
      const diasVencida = Math.floor(
        (hoje.getTime() - new Date(c.due_date + "T00:00:00").getTime()) /
          86400_000,
      );
      // O maior marco já atingido: se o cron falhou alguns dias, manda o marco
      // atual em vez de disparar os três atrasados de uma vez.
      const marco = [...OVERDUE_MILESTONES].reverse().find((m) =>
        diasVencida >= m
      );
      if (!marco) continue;

      const kind = overdueNotificationKind(marco);
      const { data: jaEnviado, error: markerError } = await supabase.from(
        "automation_sent",
      )
        .select("id").eq("kind", kind).eq("subject_id", c.id).eq(
          "ref_date",
          c.due_date,
        ).maybeSingle();
      if (markerError) {
        motivos.push(`${c.id}: marcador legado indisponível`);
        continue;
      }
      if (jaEnviado) continue;

      if (!(await aindaEstuda(supabase, c.tenant_id, c.student_id))) {
        motivos.push(`${c.id}: aluno sem agenda/aula 90d (decisão do diretor)`);
        continue;
      }

      const dest = await resolveRecipient(supabase, c, instCache);
      if (!dest.ok) {
        motivos.push(`${c.id}: ${dest.motivo}`);
        continue;
      }
      const integration = await resolveTenantEvolutionIntegration(
        supabase,
        c.tenant_id,
        integrationCache,
      );

      let text = `Oi ${dest.nome}! Aqui é a ${dest.brandName}.\n\n` +
        `Sua mensalidade de *${brl(c.value)}*, com vencimento em *${
          dataBR(c.due_date)
        }*, ` +
        `consta como *em aberto* por aqui.`;
      if (c.invoice_url) {
        text +=
          `\n\nSe já pagou, pode ignorar. Se ainda não, o link está aqui: ${c.invoice_url}`;
      } else {text +=
          `\n\nSe já pagou, pode ignorar. Se ainda não, é só chamar que a gente te ajuda.`;}
      text += `\n\nQualquer dúvida, estamos por aqui. 💜`;

      const delivery = await deliverPaymentNotification(supabase, {
        tenantId: c.tenant_id,
        studentId: c.student_id,
        paymentId: c.id,
        notificationKind: kind,
        integration,
        instance: dest.instance,
        phone: dest.phone,
        text,
      });
      if (delivery.status === "SENT") {
        await recordAutomationSent(supabase, kind, c.id, c.due_date);
        if (delivery.sentNow) enviados++;
      } else {
        motivos.push(`${c.id}: ${delivery.reason}`);
      }
    } catch (e) {
      motivos.push(`${c.id}: ${(e as Error).message}`);
    }
  }

  return { enviados, motivos };
}

type DurableDelivery = {
  status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED" | "SKIPPED";
  sentNow: boolean;
  reason: string;
};

async function resolveTenantEvolutionIntegration(
  supabase: any,
  tenantId: string,
  cache: Record<string, ResolvedEvolutionIntegration>,
): Promise<ResolvedEvolutionIntegration> {
  if (!cache[tenantId]) {
    cache[tenantId] = await resolveEvolutionIntegration(
      supabase,
      tenantId,
      "message.send_text",
    );
  }
  return cache[tenantId];
}

async function deliverPaymentNotification(
  supabase: any,
  input: {
    tenantId: string;
    studentId: string;
    paymentId: string;
    notificationKind: string;
    integration: ResolvedEvolutionIntegration;
    instance: string;
    phone: string;
    text: string;
  },
): Promise<DurableDelivery> {
  const claim = await claimOutboundMessage(supabase, {
    tenantId: input.tenantId,
    studentId: input.studentId,
    providerEntityId: input.paymentId,
    notificationKind: input.notificationKind,
  });
  if (claim.action === "ALREADY_FINAL") {
    const status = String(claim.status || "UNKNOWN").toUpperCase();
    return {
      status: status === "SENT"
        ? "SENT"
        : status === "FAILED"
        ? "FAILED"
        : status === "SUPPRESSED"
        ? "SUPPRESSED"
        : "UNKNOWN",
      sentNow: false,
      reason: `durable_${status.toLowerCase()}`,
    };
  }
  if (claim.action !== "SUBMIT_ONCE") {
    return {
      status: "SKIPPED",
      sentNow: false,
      reason: claim.reason || claim.action.toLowerCase(),
    };
  }

  const mark = await markOutboundMessageSubmittingDecision(supabase, claim);
  if (mark.ok !== true || mark.status !== "SUBMITTING") {
    return {
      status: mark.status === "SUPPRESSED" ? "SUPPRESSED" : "SKIPPED",
      sentNow: false,
      reason: mark.reason || "outbound_message_suppressed_before_send",
    };
  }

  const providerResult = await sendWhatsTextDetailed({
    base: input.integration.baseUrl,
    keys: [input.integration.apiKey],
    instance: input.instance,
    to: input.phone,
    text: input.text,
    delayMs: 800,
  });
  const finish = paymentNotificationFinish(providerResult);
  try {
    await finishOutboundMessage(supabase, claim, finish);
  } catch {
    // SUBMITTING + submit_attempt_count=1 is already durable. Never retry an
    // external POST merely because persisting its response was interrupted.
    return {
      status: "UNKNOWN",
      sentNow: false,
      reason: "outbound_message_finish_failed",
    };
  }
  return {
    status: finish.status,
    sentNow: finish.status === "SENT",
    reason: finish.error || "sent",
  };
}

async function recordAutomationSent(
  supabase: any,
  kind: string,
  paymentId: string,
  dueDate: string,
) {
  const { error } = await supabase.from("automation_sent").upsert({
    kind,
    subject_id: paymentId,
    ref_date: dueDate,
  }, {
    onConflict: "kind,subject_id,ref_date",
    ignoreDuplicates: true,
  });
  if (error) throw new Error("overdue_notification_marker_failed");
}
