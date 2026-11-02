import { type ActiveTrial, brtSlotFromIso } from "./trial-reschedule.ts";

const fold = (text: string) =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Access is support, never a new commercial appointment. Includes the real typo “met”. */
export function asksLessonAccess(text: string): boolean {
  const q = fold(text);
  if (
    /\b(contrato|matricula|pagamento|boleto|pix|portal)\b/.test(q) &&
    !/\b(aula|meet|met|zoom)\b/.test(q)
  ) return false;
  if (
    /\b(link|acesso|entrar|acessar|conectar|sala)\b/.test(q) &&
    /\b(aula|experimental|meet|met|zoom|reuniao|teacher|professora?)\b/.test(q)
  ) return true;
  return /\b(cade|qual|manda|envia|tem|preciso|quero)\b.{0,35}\b(link|meet|met)\b/
    .test(q);
}

export function schoolModalityFacts(tenantId: string): string {
  return tenantId === "school-wise-wolf"
    ? "As aulas e a experimental desta escola são online. Não oferece experimental presencial. Cidade/endereço do cadastro não são local de aula. Não convide para visita presencial. Pedido de acesso é suporte: nunca agende outra experimental nem invente link."
    : "Não deduza modalidade, local de aula, público ou formato a partir do nome/endereço da escola. Só informe o que estiver confirmado no cadastro/treinamento. Nunca invente link de acesso.";
}

export function safeLessonAccessLink(value: unknown): string | null {
  if (typeof value !== "string" || /\s/.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || url.port) {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (
      host === "meet.google.com" &&
      /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)
    ) return url.href;
    if (
      (host === "zoom.us" || host.endsWith(".zoom.us")) &&
      /^\/(j|my)\//.test(url.pathname)
    ) return url.href;
    if (
      host === "teams.microsoft.com" && /^\/l\/meetup-join\//.test(url.pathname)
    ) return url.href;
  } catch { /* Not an authoritative meeting URL. */ }
  return null;
}

export type TrialAccess = { link: string | null; reason: string };

/** Read-only; never creates a room, changes consent, or falls back from a withheld official room. */
export async function loadTrialAccess(
  sb: any,
  tenantId: string,
  phone: string,
  trial: ActiveTrial | null,
  matchesPhone: (a: string, b: string) => boolean,
  nowMs = Date.now(),
): Promise<TrialAccess> {
  if (!trial) return { link: null, reason: "no_active_trial" };
  const { data: appt, error } = await sb.from("appointments")
    .select(
      "id,tenant_id,student_phone,teacher_id,professor_id,start_time,status,meeting_link,type",
    )
    .eq("tenant_id", tenantId).eq("id", trial.appointmentId).maybeSingle();
  if (error) throw new Error("trial_access_appointment_unavailable");
  if (
    !appt || appt.tenant_id !== tenantId || appt.type !== "experimental" ||
    !matchesPhone(String(appt.student_phone || ""), phone) ||
    (appt.teacher_id || appt.professor_id) !== trial.teacherId ||
    appt.start_time !== trial.startIso ||
    !["scheduled", "confirmed"].includes(String(appt.status).toLowerCase())
  ) {
    return { link: null, reason: "trial_changed" };
  }
  const startMs = Date.parse(appt.start_time);
  if (!Number.isFinite(startMs) || startMs < nowMs - 60 * 60_000) {
    return { link: null, reason: "trial_ended" };
  }
  const { data: occurrences, error: occurrenceError } = await sb.from(
    "lesson_occurrences",
  )
    .select("id").eq("tenant_id", tenantId).eq("source_type", "appointment")
    .eq("source_id", appt.id).neq("status", "SUPERSEDED").limit(1);
  if (occurrenceError) throw new Error("trial_access_room_state_unavailable");
  if (occurrences?.length) {
    const slot = brtSlotFromIso(appt.start_time);
    const { data: official, error: roomError } = await sb.rpc(
      "official_lesson_link",
      {
        p_tenant: tenantId,
        p_source_type: "appointment",
        p_source_id: appt.id,
        p_class_date: slot.date,
        p_teacher_id: trial.teacherId,
        p_start_time: slot.time,
        p_student_id: null,
      },
    );
    if (roomError) throw new Error("trial_access_official_room_unavailable");
    return { link: safeLessonAccessLink(official), reason: "official_room" };
  }
  const { data: teacher, error: teacherError } = await sb.from("profiles")
    .select("id,tenant_id,role,status,meeting_link").eq("tenant_id", tenantId)
    .eq("id", trial.teacherId).maybeSingle();
  if (teacherError) throw new Error("trial_access_teacher_unavailable");
  if (
    !teacher || teacher.tenant_id !== tenantId || teacher.role !== "TEACHER" ||
    !["Ativo", "ACTIVE"].includes(teacher.status)
  ) {
    return { link: null, reason: "teacher_unavailable" };
  }
  return {
    link: safeLessonAccessLink(appt.meeting_link) ||
      safeLessonAccessLink(teacher.meeting_link),
    reason: "registered_trial_link",
  };
}

export function trialAccessReply(
  tenantId: string,
  access: TrialAccess,
): string {
  if (access.link) {
    return `O link cadastrado para sua aula experimental é: ${access.link}`;
  }
  return `${
    tenantId === "school-wise-wolf" ? "A experimental é online. " : ""
  }Não tenho um link de acesso confirmado para essa aula. Vou encaminhar à equipe para conferir com o professor por aqui.`;
}

/** A second veto also protects non-access replies from old training/history. */
export function vetoInventedPresential(
  tenantId: string,
  reply: string,
): string {
  if (tenantId !== "school-wise-wolf") return reply;
  const q = fold(reply);
  if (
    /\bpresencia(?:l|is)\b|\b(?:venha|vir|visitar|visita|comparecer)\b.{0,50}\b(?:escola|unidade|aqui)\b|\b(?:aqui|voce|nos)\b.{0,35}\b(?:vier|visitar)\b/
      .test(q)
  ) {
    return "Nossas aulas, inclusive a experimental, são online. Não é necessário ir a uma unidade presencial.";
  }
  return reply;
}
