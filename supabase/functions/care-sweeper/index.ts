// O `tsconfig.json` da raiz (lib DOM, do Vite) é lido pelo Deno e apaga `deno.ns`.
/// <reference lib="deno.ns" />
//
// CARE-SWEEPER — acompanhamento de aluno e professor (cron a cada 15 min).
//
// A manutenção de conversa que a direção fazia no gogó (17/09/2026): quem
// faltou ontem recebe um "sentimos sua falta" com o direito à reposição e um
// horário livre; na sexta, "como foi a semana?"; a cada 30 dias, "o curso está
// te atendendo?"; o professor recebe a cobrança de comparecimento do aluno que
// não respondeu, o lembrete da política de remarcação e o check-in do mês.
//
// QUEM decide o que está vencido é o banco (`care_due_*`, migration
// 20260917180000) — aqui só se manda e registra. A conversa que vem depois é do
// `whatsapp-inbound` (agente `care`).
//
// Regras de silêncio: contatos proativos a aluno e professor em horário comercial;
// nada em domingo; semanal só sexta à tarde. A marca (`care_touchpoints`) é
// gravada ANTES do envio e apagada se o envio falha — como em `automation_sent`.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendWhatsText } from "../_shared/evolution-send.ts";
import {
  loadTenantWhatsAppRoute,
  resolveTenantCommunicationIdentity,
} from "../_shared/tenant-communication.ts";
import {
  absenceFollowupMessage,
  type CareQuota,
  type CareSlot,
  monthlyCheckinMessage,
  teacherAbsenceNudgeMessage,
  teacherMonthlyCheckinMessage,
  teacherReschedulePolicyMessage,
  weeklyCheckinMessage,
} from "../whatsapp-inbound/care-messages.ts";

const EVOLUTION_API_URL = "https://api.2b.app.br";
const EVOLUTION_KEYS = Array.from(
  new Set([(Deno.env.get("EVOLUTION_API_KEY") || "").trim()].filter(Boolean)),
);

const nowBRT = () => new Date(Date.now() - 3 * 3600 * 1000);

function cleanPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
}

function isServiceRole(bearer: string, serviceKey: string): boolean {
  return Boolean(serviceKey && bearer === serviceKey);
}

async function sendWhats(
  instance: string,
  number: string,
  text: string,
): Promise<boolean> {
  return await sendWhatsText({
    base: EVOLUTION_API_URL,
    keys: EVOLUTION_KEYS,
    instance,
    to: number,
    text,
  });
}

type Route = {
  studentInstance: string | null;
  teacherInstance: string | null;
  centralInstance: string;
};

serve(async (req) => {
  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const bearer = (req.headers.get("Authorization") || "").replace(
      "Bearer ",
      "",
    ).trim();
    if (!isServiceRole(bearer, serviceKey)) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
      });
    }
    const sb = createClient(url, serviceKey);
    const now = nowBRT();
    const hour = now.getUTCHours();
    const dow = now.getUTCDay();
    const studentHours = dow !== 0 && hour >= 9 && hour < 20;
    const teacherHours = dow !== 0 && hour >= 9 && hour < 20;
    // Sexta entre 15h e 19h: "como foi a semana?" — depois da última aula da
    // maioria, antes do fim de semana.
    const weeklyWindow = dow === 5 && hour >= 15 && hour < 19;

    const result = {
      absence_followups: 0,
      weekly_checkins: 0,
      monthly_checkins: 0,
      teacher_touchpoints: 0,
      skipped: 0,
      failures: [] as string[],
    };

    const { data: tenants, error: tenantsError } = await sb.from("tenants")
      .select(
        "id,name,domain,slug,custom_domain,custom_domain_verified,branding,school_info,saas_status,talent_group_link,whatsapp_enabled,ai_team_config",
      );
    if (tenantsError) throw tenantsError;
    const routes: Record<string, Route> = {};
    const careEnabled: Record<string, boolean> = {};
    for (const tenant of (tenants || [])) {
      const tenantId = String(tenant.id || "");
      if (!resolveTenantCommunicationIdentity(tenant, tenantId)) continue;
      careEnabled[tenantId] =
        (tenant.ai_team_config as Record<string, unknown> | null)?.care !==
          false &&
        ((tenant.ai_team_config as
            | Record<string, Record<string, unknown>>
            | null)?.care as Record<string, unknown> | undefined)?.enabled !==
          false;
      try {
        const [route, studentRoute, teacherRoute] = await Promise.all([
          loadTenantWhatsAppRoute(sb, tenantId),
          loadTenantWhatsAppRoute(sb, tenantId, "student"),
          loadTenantWhatsAppRoute(sb, tenantId, "teacher"),
        ]);
        if (!route) continue;
        routes[tenantId] = {
          centralInstance: route.instanceName,
          studentInstance: studentRoute?.instanceName || null,
          teacherInstance: teacherRoute?.instanceName || null,
        };
      } catch (error) {
        result.failures.push(
          `whatsapp_route ${tenantId}: ${(error as Error).message}`,
        );
      }
    }

    // Abre o toque, manda, e confirma ou desfaz — a marca nunca fica sem envio.
    const deliver = async (input: {
      tenantId: string;
      role: "STUDENT" | "TEACHER";
      subjectId: string;
      phone: string;
      kind: string;
      trigger: string;
      context: Record<string, unknown>;
      message: string;
      instance: string;
    }): Promise<boolean> => {
      const { data: touchpointId, error: openError } = await sb.rpc(
        "care_touchpoint_open",
        {
          p_tenant: input.tenantId,
          p_role: input.role,
          p_subject: input.subjectId,
          p_phone: input.phone,
          p_kind: input.kind,
          p_trigger: input.trigger,
          p_context: input.context,
        },
      );
      if (openError) {
        result.failures.push(`open ${input.kind} ${input.subjectId}`);
        return false;
      }
      if (!touchpointId) {
        result.skipped++;
        return false;
      }
      const delivered = await sendWhats(
        input.instance,
        input.phone,
        input.message,
      );
      await sb.rpc("care_touchpoint_delivery", {
        p_id: touchpointId,
        p_delivered: delivered,
      });
      // O histórico da conversa (que o agente `care` lê) registra o que saiu.
      await sb.from("ai_wa_messages").insert({
        tenant_id: input.tenantId,
        phone: input.phone,
        agent: "care",
        direction: "out",
        content: input.message,
        meta: {
          kind: input.kind.toLowerCase(),
          touchpoint_id: touchpointId,
          subject_role: input.role,
          subject_id: input.subjectId,
          entregue: delivered,
        },
      });
      if (!delivered) {
        result.failures.push(`send ${input.kind} ${input.subjectId}`);
      }
      return delivered;
    };

    // ── 1) Faltou ontem ──
    if (studentHours) {
      const { data: rows, error } = await sb.rpc("care_due_absence_followups", {
        p_limit: 20,
      });
      if (error) throw new Error(`absence: ${error.message}`);
      // Duas faltas seguidas (ontem e anteontem) são UMA conversa: o segundo
      // toque do mesmo aluno fica para a rodada seguinte, que o segura pelo
      // `care_subject_on_hold`.
      const touchedStudents = new Set<string>();
      for (const row of (rows || [])) {
        const route = routes[row.tenant_id];
        if (!route?.studentInstance || careEnabled[row.tenant_id] === false) {
          continue;
        }
        if (touchedStudents.has(String(row.student_id))) continue;
        const phone = cleanPhone(row.phone || "");
        if (phone.length < 12) continue;
        touchedStudents.add(String(row.student_id));
        const ok = await deliver({
          tenantId: row.tenant_id,
          role: "STUDENT",
          subjectId: row.student_id,
          phone,
          kind: "ABSENCE_FOLLOWUP",
          trigger: String(row.class_log_id),
          context: {
            class_date: row.class_date,
            teacher_id: row.teacher_id,
            teacher_name: row.teacher_name,
            reschedule_id: row.reschedule_id,
            quota: row.quota,
            free_slots: row.free_slots,
          },
          message: absenceFollowupMessage({
            studentName: row.student_name,
            teacherName: row.teacher_name,
            classDate: String(row.class_date),
            quota: row.quota as CareQuota | null,
            freeSlots: (row.free_slots || []) as CareSlot[],
          }),
          instance: route.studentInstance,
        });
        if (ok) result.absence_followups++;
      }
    }

    // ── 2) Sexta: como foi a semana ──
    if (weeklyWindow) {
      const { data: rows, error } = await sb.rpc("care_due_weekly_checkins", {
        p_limit: 25,
      });
      if (error) throw new Error(`weekly: ${error.message}`);
      for (const row of (rows || [])) {
        const route = routes[row.tenant_id];
        if (!route?.studentInstance || careEnabled[row.tenant_id] === false) {
          continue;
        }
        const phone = cleanPhone(row.phone || "");
        if (phone.length < 12) continue;
        const ok = await deliver({
          tenantId: row.tenant_id,
          role: "STUDENT",
          subjectId: row.student_id,
          phone,
          kind: "WEEKLY_CHECKIN",
          trigger: String(row.week_ref),
          context: {
            teacher_name: row.teacher_name,
            classes_this_week: row.classes_this_week,
          },
          message: weeklyCheckinMessage({
            studentName: row.student_name,
            teacherName: row.teacher_name,
            classesThisWeek: Number(row.classes_this_week || 0),
          }),
          instance: route.studentInstance,
        });
        if (ok) result.weekly_checkins++;
      }
    }

    // ── 3) A cada 30 dias: o curso está te atendendo? (poucos por rodada) ──
    if (studentHours && hour >= 10 && hour < 18 && dow !== 6) {
      // Poucos por rodada (4 rodadas/hora): o mensal se espalha pelos dias em
      // vez de sair em rajada no primeiro dia.
      const { data: rows, error } = await sb.rpc("care_due_monthly_checkins", {
        p_limit: 2,
      });
      if (error) throw new Error(`monthly: ${error.message}`);
      for (const row of (rows || [])) {
        const route = routes[row.tenant_id];
        if (!route?.studentInstance || careEnabled[row.tenant_id] === false) {
          continue;
        }
        const phone = cleanPhone(row.phone || "");
        if (phone.length < 12) continue;
        const ok = await deliver({
          tenantId: row.tenant_id,
          role: "STUDENT",
          subjectId: row.student_id,
          phone,
          kind: "MONTHLY_CHECKIN",
          trigger: String(row.month_ref),
          context: {
            teacher_name: row.teacher_name,
            months_enrolled: row.months_enrolled,
          },
          message: monthlyCheckinMessage({
            studentName: row.student_name,
            teacherName: row.teacher_name,
            monthsEnrolled: Number(row.months_enrolled || 1),
          }),
          instance: route.studentInstance,
        });
        if (ok) result.monthly_checkins++;
      }
    }

    // ── 4) Professor ──
    if (teacherHours) {
      const { data: rows, error } = await sb.rpc(
        "care_due_teacher_touchpoints",
        { p_limit: 20 },
      );
      if (error) throw new Error(`teacher: ${error.message}`);
      for (const row of (rows || [])) {
        const route = routes[row.tenant_id];
        const instance = route?.teacherInstance || route?.centralInstance;
        if (!instance || careEnabled[row.tenant_id] === false) continue;
        const phone = cleanPhone(row.phone || "");
        if (phone.length < 12) continue;
        const ctx = (row.context || {}) as Record<string, unknown>;
        let message: string;
        if (row.kind === "TEACHER_STUDENT_ABSENCE_NUDGE") {
          message = teacherAbsenceNudgeMessage({
            teacherName: row.teacher_name,
            studentName: String(ctx.student_name || ""),
            classDate: String(ctx.class_date || ""),
            quota: (ctx.quota || null) as CareQuota | null,
            freeSlots: (ctx.free_slots || []) as CareSlot[],
          });
        } else if (row.kind === "TEACHER_RESCHEDULE_POLICY") {
          message = teacherReschedulePolicyMessage({
            teacherName: row.teacher_name,
            reschedules30d: Number(ctx.reschedules_30d || 2),
          });
        } else {
          message = teacherMonthlyCheckinMessage({
            teacherName: row.teacher_name,
            classes30d: Number(ctx.classes_30d || 0),
          });
        }
        const ok = await deliver({
          tenantId: row.tenant_id,
          role: "TEACHER",
          subjectId: row.teacher_id,
          phone,
          kind: String(row.kind),
          trigger: String(row.trigger_ref),
          context: ctx,
          message,
          instance,
        });
        if (ok) result.teacher_touchpoints++;
      }
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
