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
    const channels: Record<string, string> = {
      PAID: "Tráfego pago (marcação observada)",
      ORGANIC_SEARCH: "Busca orgânica (referência observada)",
      REFERRAL: "Referência externa",
      TAGGED: "Link identificado por UTM",
      WHATSAPP_UNKNOWN: "WhatsApp — campanha não identificada",
      DIRECT_UNKNOWN: "Direto / não identificado",
    };
    return [
      "📍 *Origem de novo lead*",
      `Nome: ${line(source.name) || "Não informado"}`,
      `WhatsApp: ${line(source.phone, 30) || "Não informado"}`,
      `Canal: ${channels[String(origin.channel)] || channels.DIRECT_UNKNOWN}`,
      `Entrada: ${line(origin.surface) || "Não identificada"}`,
      `Formulário: ${line(origin.form_source) || "Não informado"}`,
      `Campanha: ${line(origin.utm_campaign) || "Não informada"}`,
      `Fonte / mídia: ${line(origin.utm_source) || "—"} / ${
        line(origin.utm_medium) || "—"
      }`,
      `Página inicial: ${
        line(origin.first_landing_path || origin.landing_path) ||
        "Não informada"
      }`,
      `Página do contato: ${
        line(origin.last_landing_path || origin.landing_path) || "Não informada"
      }`,
      `Referência: ${
        line(origin.first_referrer_host || origin.referrer_host) ||
        "Não informada"
      }`,
      "",
      "Metadados do acesso; não comprovam autoria ou resultado de anúncio.",
      `CRM: ${portal}`,
      `Referência: ${line(source.lead_id, 40)}`,
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
