import {
  leadFormLabel,
  leadOriginDetails,
  leadOriginHeadline,
  leadOriginJourney,
} from "./origin-description.ts";

export type Row = Record<string, unknown>;
const line = (v: unknown, max = 160) =>
  String(v ?? "").replace(/[\r\n*_`]/g, " ").slice(0, max);
const date = (v: unknown) =>
  new Date(String(v)).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    dateStyle: "short",
    timeStyle: "short",
  });
export function operationMessage(source: Row, portal: string): string {
  if (source.kind === "LEAD_ORIGIN") {
    const origin = source.origin && typeof source.origin === "object"
      ? source.origin as Row
      : {};
    const journey = leadOriginJourney(origin);
    return [
      "📍 *Novo lead*",
      `${line(source.name) || "Nome não informado"} · ${
        line(source.phone, 30) || "sem WhatsApp"
      }`,
      "",
      `*De onde veio:* ${leadOriginHeadline(origin)}`,
      ...(journey ? [journey] : []),
      `Como pediu contato: ${leadFormLabel(origin.form_source)}`,
      ...leadOriginDetails(origin),
      "",
      "_Pelos dados do acesso; não prova sozinho o resultado de um anúncio._",
      `CRM: ${portal}`,
    ].join("\n");
  }
  if (
    !["TEACHER_LATE", "STUDENT_LATE"].includes(String(source.kind)) ||
    !Number.isFinite(Number(source.late_minutes)) ||
    Number(source.late_minutes) < 1
  ) throw new Error("invalid_attendance_notice");
  return [
    `🕒 *Pontualidade da aula — ${
      source.kind === "TEACHER_LATE" ? "professor" : "aluno"
    }*`,
    `Pessoa: ${line(source.name)}`,
    `Aula com: ${line(source.counterpart)}`,
    `Previsto: ${date(source.scheduled_start_at)}`,
    `Primeira entrada: ${date(source.first_join_at)}`,
    `Atraso observado: ${Number(source.late_minutes)} min`,
    "",
    "Fonte: relatório nativo de participação do Google Meet.",
    "Registro para conferência e contestação; não determina culpa, desconto ou multa.",
    `Central de Qualidade: ${portal}`,
    `Evidência: ${line(source.evidence_id, 40)}`,
  ].join("\n");
}
