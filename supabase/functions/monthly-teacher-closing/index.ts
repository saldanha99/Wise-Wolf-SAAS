import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeScopedAutomation,
  scopeAutomationRows,
} from "../_shared/automation-auth.ts";
import { sendWhatsTextDetailed } from "../_shared/evolution-send.ts";
import {
  claimFinancialReportMessage,
  financialReportMessageFinish,
  finishFinancialReportMessage,
  markFinancialReportMessageSubmitting,
  monthlyTeacherClosingSubject,
} from "../_shared/financial-report-message-fence.ts";
import { loadTenantCentralWhatsAppInstance } from "../_shared/tenant-communication.ts";
import {
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
} from "../_shared/tenant-integration-broker.ts";
import {
  normalizeClosingMonth,
  runTenantMonthlyTeacherClosing,
} from "./tenant-closing.ts";

// Fechamento dos professores + aviso WhatsApp.
// - Cron dia 1º (06:30 UTC): gera os fechamentos do mês anterior e avisa cada professor.
// - Cron diário wisewolf-closing-recalc (11:30 UTC): reprocessa M-1 e M-2 (janela retroativa
//   de 45 dias do LessonLauncher). A RPC recalcula totais enquanto status='PENDENTE' e, se o
//   valor mudou, apaga o dedupe — aí esta função reavisa com o texto de "atualizado".
// O POST irreversível usa um fence durável versionado pelo snapshot financeiro.
// automation_sent permanece só como marcador de compatibilidade legado.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};
const MONTHS_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

interface ClosingGenerationResult {
  month?: string;
  created?: number;
  updated?: number;
  updated_teacher_ids?: string[];
}

interface ClosingNotificationRow {
  tenant_id: string;
  teacher_id: string;
}

interface ClosingSnapshot {
  id: string;
  tenant_id: string;
  teacher_id: string;
  month_year: string;
  total_lessons: number | string | null;
  total_amount: number | string | null;
  status: string | null;
}

interface TeacherContact {
  id: string;
  tenant_id: string;
  role: string;
  full_name: string | null;
  phone: string | null;
  lifecycle_status: string | null;
  is_test_account: boolean | null;
}

function normPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}
const money = (v: unknown) =>
  `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
function monthLabel(m: string) {
  const [y, mo] = (m || "").split("-");
  return mo ? `${MONTHS_PT[Number(mo) - 1]} de ${y}` : m;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const auth = await authorizeScopedAutomation(req, corsHeaders, {
    allowAdmin: true,
  });
  if (auth.ok === false) return auth.response;
  try {
    const supabase = auth.context.admin;
    const tenantId = auth.context.tenantId;

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
    const updatedIds: string[] = Array.isArray(gen?.updated_teacher_ids)
      ? gen.updated_teacher_ids
      : [];

    const { data: closings, error: closingsError } = await supabase.rpc(
      "monthly_closings_to_notify",
      { p_month: targetMonth },
    );
    if (closingsError) throw closingsError;
    const result = {
      month: targetMonth,
      generated: gen?.created ?? 0,
      updated: gen?.updated ?? 0,
      notified: 0,
      skipped: 0,
      failures: [] as string[],
    };

    const instCache: Record<string, string | null> = {};
    const integrationCache: Record<string, ResolvedEvolutionIntegration> = {};
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
    async function integration(tenantId: string) {
      if (!(tenantId in integrationCache)) {
        integrationCache[tenantId] = await resolveEvolutionIntegration(
          supabase,
          tenantId,
          "message.send_text",
        );
      }
      return integrationCache[tenantId];
    }

    for (
      const c of scopeAutomationRows<ClosingNotificationRow>(
        closings,
        tenantId,
      )
    ) {
      try {
        const [closingResult, teacherResult] = await Promise.all([
          supabase.from("teacher_closings")
            .select(
              "id,tenant_id,teacher_id,month_year,total_lessons,total_amount,status",
            )
            .eq("tenant_id", c.tenant_id)
            .eq("teacher_id", c.teacher_id)
            .eq("month_year", targetMonth)
            .limit(2),
          supabase.from("profiles")
            .select(
              "id,tenant_id,role,full_name,phone,lifecycle_status,is_test_account",
            )
            .eq("id", c.teacher_id)
            .eq("tenant_id", c.tenant_id)
            .eq("role", "TEACHER")
            .maybeSingle(),
        ]);
        if (closingResult.error || teacherResult.error) {
          throw new Error("monthly_closing_scope_lookup_failed");
        }
        const snapshots = (closingResult.data || []) as ClosingSnapshot[];
        const teacher = teacherResult.data as TeacherContact | null;
        if (snapshots.length !== 1 || !teacher) {
          result.failures.push(`${c.teacher_id}: fechamento fora da escola`);
          continue;
        }
        const closing = snapshots[0];
        const lessons = Number(closing.total_lessons || 0);
        const amount = Number(closing.total_amount || 0);
        if (
          closing.tenant_id !== c.tenant_id ||
          closing.teacher_id !== c.teacher_id ||
          closing.month_year !== targetMonth ||
          String(closing.status || "").toUpperCase() !== "PENDENTE" ||
          !Number.isInteger(lessons) || lessons <= 0 ||
          !Number.isFinite(amount)
        ) {
          result.skipped++;
          continue;
        }
        if (
          teacher.is_test_account === true ||
          String(teacher.lifecycle_status || "").toLowerCase() !== "active"
        ) {
          result.skipped++;
          continue;
        }

        const legacySubject = `${c.teacher_id}:${targetMonth}`;
        const { data: dup, error: dupError } = await supabase.from(
          "automation_sent",
        ).select("id")
          .eq("kind", "MONTHLY_CLOSING")
          .eq("subject_id", legacySubject)
          .limit(1)
          .maybeSingle();
        if (dupError) {
          result.failures.push(`${c.teacher_id}: marcador legado indisponível`);
          continue;
        }
        if (dup) {
          result.skipped++;
          continue;
        }

        const phone = normPhone(teacher.phone || "");
        if (phone.length < 12 || phone.length > 15) {
          result.failures.push(`${c.teacher_id}: telefone inválido`);
          continue;
        }
        const inst = await instance(c.tenant_id);
        if (!inst) {
          result.failures.push(
            `${c.teacher_id}: tenant sem WhatsApp central`,
          );
          continue;
        }
        let tenantIntegration: ResolvedEvolutionIntegration;
        try {
          tenantIntegration = await integration(c.tenant_id);
        } catch {
          result.failures.push(`${c.teacher_id}: integração indisponível`);
          continue;
        }

        const subject = monthlyTeacherClosingSubject({
          teacherId: c.teacher_id,
          month: targetMonth,
          closingId: closing.id,
          lessons,
          amount,
        });
        const refDate = `${targetMonth}-01`;
        const claim = await claimFinancialReportMessage(supabase, {
          tenantId: c.tenant_id,
          notificationKind: "MONTHLY_CLOSING",
          subjectId: subject,
          refDate,
        });
        if (claim.action === "ALREADY_FINAL") {
          if (String(claim.status || "").toUpperCase() === "SENT") {
            try {
              await recordMonthlyClosingSent(
                supabase,
                legacySubject,
                refDate,
              );
            } catch {
              result.failures.push(
                `${c.teacher_id}: marcador legado indisponível`,
              );
            }
          } else {
            result.failures.push(
              `${c.teacher_id}: resultado durável ${claim.status} requer revisão`,
            );
          }
          result.skipped++;
          continue;
        }
        if (claim.action !== "SUBMIT_ONCE") {
          if (claim.action === "REVIEW_REQUIRED") {
            result.failures.push(
              `${c.teacher_id}: ${claim.reason || "escopo inativo"}`,
            );
          } else {
            result.skipped++;
          }
          continue;
        }

        const submit = await markFinancialReportMessageSubmitting(
          supabase,
          claim,
        );
        if (submit.ok !== true || submit.status !== "SUBMITTING") {
          if (submit.status === "SUPPRESSED") {
            result.skipped++;
          } else {
            result.failures.push(
              `${c.teacher_id}: ${
                submit.reason || "claim perdido antes do envio"
              }`,
            );
          }
          continue;
        }

        const nome = (teacher.full_name || "").trim().split(" ")[0];
        const isUpdate = updatedIds.includes(c.teacher_id);
        const intro = isUpdate
          ? `Seu fechamento de *${
            monthLabel(targetMonth)
          }* foi *atualizado* (novas aulas contabilizadas):`
          : `Seu fechamento de *${monthLabel(targetMonth)}* já está pronto:`;
        const text = `Olá ${nome}!\n\n${intro}\n\n` +
          `📚 Aulas pagas: *${lessons}*\n` +
          `💰 Total a receber: *${money(amount)}*\n\n` +
          `Você pode conferir o relatório completo e baixar o PDF na plataforma, em *Financeiro → Meu Relatório (PDF)*.\n\n` +
          `Qualquer dúvida, é só chamar. Obrigado pelo seu trabalho! 💜`;

        const providerResult = await sendWhatsTextDetailed({
          base: tenantIntegration.baseUrl,
          keys: [tenantIntegration.apiKey],
          instance: inst,
          to: phone,
          text,
          delayMs: 800,
        });
        const finish = financialReportMessageFinish(providerResult);
        try {
          await finishFinancialReportMessage(supabase, claim, finish);
        } catch {
          result.failures.push(
            `${c.teacher_id}: resultado do envio não pôde ser persistido`,
          );
          continue;
        }
        if (finish.status !== "SENT") {
          result.failures.push(
            `${c.teacher_id}: ${finish.error || finish.status.toLowerCase()}`,
          );
          continue;
        }

        try {
          await recordMonthlyClosingSent(supabase, legacySubject, refDate);
          result.notified++;
        } catch {
          result.failures.push(`${c.teacher_id}: marcador legado indisponível`);
        }
      } catch (error) {
        result.failures.push(
          `${c.teacher_id}: ${
            error instanceof Error ? error.message : "automation_failed"
          }`,
        );
      }
    }

    return new Response(JSON.stringify(result), {
      status: result.failures.length === 0 ? 200 : 503,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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

async function recordMonthlyClosingSent(
  supabase: any,
  legacySubject: string,
  refDate: string,
) {
  const { error } = await supabase.from("automation_sent").upsert({
    kind: "MONTHLY_CLOSING",
    subject_id: legacySubject,
    ref_date: refDate,
  }, {
    onConflict: "kind,subject_id,ref_date",
    ignoreDuplicates: true,
  });
  if (error) throw new Error("monthly_closing_legacy_marker_failed");
}
