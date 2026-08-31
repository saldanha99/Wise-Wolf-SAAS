import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizeScopedAutomation,
  scopeAutomationRows,
} from "../_shared/automation-auth.ts";
import {
  buildDailyAutomationQueueRow,
  dateInSaoPaulo,
  isQueueDuplicateError,
} from "./core.ts";

// Cron diário (manhã): automações por tenant, entregues pela fila transacional da escola.
//   1. BIRTHDAY        — aniversário de alunos E professores
//   2. TEACHER_AGENDA  — agenda de aulas do dia para cada professor
// O follow-up experimental legado foi aposentado: ele inferia que a aula aconteceu
// apenas pelo appointment e concorria com o post-trial-pipeline, que exige class_log,
// feedback, oportunidade aberta e ausência de proposta válida.
// Idempotência forte: índice único da notification_queue por tenant+idempotency_key.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface BirthdayAutomationRow {
  id: string;
  tenant_id: string;
  phone: string;
  name?: string;
  role?: string;
}

interface AgendaAutomationRow {
  teacher_id: string;
  tenant_id: string;
  phone: string;
  name?: string;
  classes?: Array<{ time?: string; student?: string }>;
}

function normPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  if (p.length === 10 || p.length === 11) p = "55" + p;
  return p;
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
    const now = new Date();
    const today = dateInSaoPaulo(now);
    const scheduledAt = now.toISOString();

    const metaCache: Record<string, { name: string }> = {};
    async function meta(tenantId: string) {
      const key = tenantId;
      if (!(key in metaCache)) {
        const { data: tenant } = await supabase.from("tenants").select("name")
          .eq("id", tenantId).maybeSingle();
        metaCache[key] = { name: tenant?.name || "Escola de idiomas" };
      }
      return metaCache[key];
    }
    async function already(kind: string, subj: string) {
      const { data } = await supabase.from("automation_sent").select("id")
        .eq("kind", kind).eq("subject_id", subj).eq("ref_date", today)
        .maybeSingle();
      return !!data;
    }
    async function enqueue(
      input: Parameters<typeof buildDailyAutomationQueueRow>[0],
    ) {
      const { error } = await supabase.from("notification_queue").insert(
        buildDailyAutomationQueueRow(input),
      );
      if (!error) return "queued" as const;
      if (isQueueDuplicateError(error)) return "duplicate" as const;
      throw new Error(`daily_queue_insert_failed:${error.code || "query"}`);
    }

    const result = {
      birthdays: 0,
      agendas: 0,
      trials: 0,
      skipped: 0,
      failures: [] as string[],
    };

    // ───────────────────────────── 1. ANIVERSÁRIOS (aluno + professor)
    const { data: bdays, error: bdaysError } = await supabase.rpc(
      "birthdays_today",
    );
    if (bdaysError) throw bdaysError;
    for (
      const b of scopeAutomationRows<BirthdayAutomationRow>(bdays, tenantId)
    ) {
      const subj = b.id;
      if (await already("BIRTHDAY", subj)) {
        result.skipped++;
        continue;
      }
      const isTeacher = String(b.role || "").toUpperCase() === "TEACHER";
      const { name: escola } = await meta(b.tenant_id);
      const phone = normPhone(b.phone);
      if (phone.length < 12) {
        result.failures.push(`bday ${subj}: telefone inválido`);
        continue;
      }
      const nome = (b.name || "").trim().split(" ")[0];
      const text = isTeacher
        ? `Feliz aniversário, ${nome}! 🎉\n\nToda a equipe da ${escola} agradece por ensinar com tanto carinho. Que seu dia seja incrível e cheio de alegria!`
        : `Feliz aniversário, ${nome}! 🎉\n\nA ${escola} deseja um dia maravilhoso pra você. Continue brilhando nos estudos — estamos com você!`;
      try {
        const outcome = await enqueue({
          tenantId: b.tenant_id,
          subjectId: subj,
          kind: isTeacher ? "TEACHER_BIRTHDAY" : "BIRTHDAY",
          destination: phone,
          message: text,
          refDate: today,
          scheduledAt,
          teacherId: isTeacher ? subj : null,
          studentId: isTeacher ? null : subj,
          studentName: b.name || null,
        });
        if (outcome === "queued") result.birthdays++;
        else result.skipped++;
      } catch (error) {
        result.failures.push(`bday ${subj}: ${(error as Error).message}`);
      }
    }

    // ───────────────────────────── 2. AGENDA DIÁRIA DO PROFESSOR
    const { data: agendas, error: agendasError } = await supabase.rpc(
      "teacher_agendas_today",
    );
    if (agendasError) throw agendasError;
    const scopedAgendas = scopeAutomationRows<AgendaAutomationRow>(
      agendas,
      tenantId,
    );
    const agendaTeacherIds = Array.from(
      new Set(scopedAgendas.map((agenda) => agenda.teacher_id).filter(Boolean)),
    );
    const { data: agendaTeachers, error: agendaTeachersError } =
      agendaTeacherIds.length
        ? await supabase.from("profiles").select(
          "id,tenant_id,role,lifecycle_status,is_test_account,date_automation_enabled",
        ).in("id", agendaTeacherIds)
        : { data: [], error: null };
    if (agendaTeachersError) throw agendaTeachersError;
    const agendaTeacherById = new Map(
      (agendaTeachers || []).map((teacher: any) => [teacher.id, teacher]),
    );

    for (const a of scopedAgendas) {
      const subj = a.teacher_id;
      const teacher = agendaTeacherById.get(subj) as any;
      if (
        !teacher || teacher.tenant_id !== a.tenant_id ||
        String(teacher.role || "").toUpperCase() !== "TEACHER" ||
        String(teacher.lifecycle_status || "").toLowerCase() !== "active" ||
        teacher.is_test_account === true ||
        teacher.date_automation_enabled === false
      ) {
        result.skipped++;
        continue;
      }
      if (await already("TEACHER_AGENDA", subj)) {
        result.skipped++;
        continue;
      }
      const phone = normPhone(a.phone);
      if (phone.length < 12) {
        result.failures.push(`agenda ${subj}: telefone inválido`);
        continue;
      }
      const nome = (a.name || "").trim().split(" ")[0];
      const aulas = a.classes || [];
      const lista = aulas.map((c) =>
        `• ${c.time || "--:--"} — ${(c.student || "aluno").trim()}`
      ).join("\n");
      const n = aulas.length;
      const text = `Bom dia, ${nome}! ☀️\n\nVocê tem *${n} ${
        n === 1 ? "aula" : "aulas"
      }* hoje:\n\n${lista}\n\nBom trabalho!`;
      try {
        const outcome = await enqueue({
          tenantId: a.tenant_id,
          subjectId: subj,
          kind: "TEACHER_AGENDA",
          destination: phone,
          message: text,
          refDate: today,
          scheduledAt,
          teacherId: subj,
          studentName: a.name || null,
        });
        if (outcome === "queued") result.agendas++;
        else result.skipped++;
      } catch (error) {
        result.failures.push(`agenda ${subj}: ${(error as Error).message}`);
      }
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
