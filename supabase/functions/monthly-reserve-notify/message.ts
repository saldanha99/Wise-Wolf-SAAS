import {
  mesAno,
  money,
  montarMensagem,
} from "../payment-split-notify/message.ts";

type RecordValue = Record<string, unknown>;
const reasonLabels: Record<string, string> = {
  AGENDA_DESATUALIZADA: "agenda desatualizada",
  PAGOU_SEM_AGENDA: "pagamento sem agenda",
  ALUNO_SEM_PAGAMENTO: "aluno sem pagamento",
  PAGAMENTO_NAO_LIQUIDADO: "pagamento não liquidado",
  PAGAMENTO_REPETIDO: "avisos repetidos",
  AULA_NAO_LANCADA: "aula não lançada",
  AULA_SEM_ALUNO: "aula sem aluno vinculado",
  AVISO_DE_OUTRO_MES: "aviso de outra competência",
  PREPAGO_SEM_RESERVA: "pagamento LEGADO sem nova reserva",
  SEM_AVISO: "sem aviso confirmado",
  RESERVA_EM_REVISAO: "reserva cancelada/estornada em revisão",
};
const safeLine = (value: unknown, length = 120) =>
  String(value ?? "").replace(/[\r\n]/g, " ").slice(0, length);

function teacherReasons(teacher: RecordValue): string[] {
  const groups = new Map<string, { count: number; difference: number }>();
  const items = Array.isArray(teacher.itens) ? teacher.itens : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const key = String(item.motivo || "OUTRO");
    const group = groups.get(key) || { count: 0, difference: 0 };
    group.count += 1;
    const difference = Number(item.diferenca);
    if (Number.isFinite(difference)) group.difference += difference;
    groups.set(key, group);
  }
  const summaries = [...groups].slice(0, 4).map(([key, group]) =>
    `  • ${
      reasonLabels[key] || safeLine(key, 70)
    }: ${group.count} registro(s), diferença ${money(group.difference)}`
  );
  if (groups.size > 4) {
    summaries.push(`  • Mais ${groups.size - 4} motivos no painel.`);
  }
  return summaries;
}

export function reserveNotificationMessage(
  kind: string,
  source: RecordValue,
): string {
  if (kind === "INSTALLMENT_SPLIT") {
    if (
      source.modo !== "MENSAL" || Number(source.sequencia) < 2 ||
      Number(source.sequencia) > Number(source.meses)
    ) throw new Error("invalid_monthly_installment");
    return montarMensagem(source);
  }
  if (kind !== "CAIXINHA_CLOSE") throw new Error("invalid_notification_kind");
  const totals = (source.totais ?? {}) as RecordValue;
  const teachers =
    (Array.isArray(source.professores)
      ? source.professores
      : []) as RecordValue[];
  const hasReview = Number(totals.caixinha_revisao) > 0 ||
    teachers.some((teacher) =>
      Number(teacher.caixinha_revisao) > 0 ||
      (Array.isArray(teacher.itens) &&
        teacher.itens.some((item) => item?.motivo === "RESERVA_EM_REVISAO"))
    );
  const lines = [
    `📋 *Caixinha × folha — ${mesAno(source.month)}*`,
    "_Posição apurada no fechamento; correções posteriores ficam auditáveis no painel._",
    "",
    `Folha: *${money(totals.folha)}*`,
    `Reserva com entrega de aviso comprovada: *${money(totals.caixinha)}*`,
    `Reserva calculada sem aviso comprovado: *${
      money(totals.caixinha_sem_aviso)
    }*`,
    `${
      hasReview
        ? "Diferença positiva a revisar"
        : "A completar, após conferência"
    }: *${money(totals.completar)}* · ${
      hasReview
        ? "Diferença negativa a revisar"
        : "A devolver, após conferência"
    }: *${money(totals.devolver)}*`,
    "",
  ];
  if (hasReview) {
    lines.push(
      `⚠️ *Reserva histórica em revisão: ${money(totals.caixinha_revisao)}.*`,
      "Há cobertura cancelada ou pagamento estornado/contestado ligado a aviso anterior. Não transfira, complete ou devolva valores automaticamente: a Gestão deve conciliar essa revisão primeiro.",
      "",
    );
  }
  let renderedTeachers = 0;
  for (const teacher of teachers.slice(0, 30)) {
    const difference = Number(teacher.diferenca ?? 0);
    const teacherLines = [
      `👨‍🏫 ${safeLine(teacher.teacher_name ?? "Professor")}`,
      `Folha ${money(teacher.folha)} · aviso confirmado ${
        money(teacher.caixinha)
      } · ${
        teacher.pro_labore === true
          ? "direção — fora da caixinha de contratados"
          : Number(teacher.caixinha_revisao) > 0
          ? `diferença ${money(difference)} — revisar antes de ajustar`
          : difference > 0
          ? `conferir complemento ${money(difference)}`
          : difference < 0
          ? `conferir devolução ${money(Math.abs(difference))}`
          : "diferença zero"
      }`,
    ];
    if (Number(teacher.caixinha_sem_aviso) > 0) {
      teacherLines.push(
        `  Previsão sem aviso confirmado: ${
          money(teacher.caixinha_sem_aviso)
        } (fora da reserva confirmada).`,
      );
    }
    if (Number(teacher.caixinha_revisao) > 0) {
      teacherLines.push(
        `  Reserva histórica em revisão: ${money(teacher.caixinha_revisao)}.`,
      );
    }
    teacherLines.push(...teacherReasons(teacher));
    // The final API rejects >8000 characters. Preserve complete teacher
    // blocks and the safety footer, instead of silently losing the warning.
    if (lines.join("\n").length + teacherLines.join("\n").length > 7200) break;
    lines.push(...teacherLines);
    renderedTeachers += 1;
  }
  if (teachers.length > renderedTeachers) {
    lines.push(
      `Mais ${
        teachers.length - renderedTeachers
      } professores detalhados no painel.`,
    );
  }
  lines.push(
    "",
    "Valores sem aviso comprovado não são tratados como reserva já comunicada. Aviso confirmado não comprova separação bancária. A apuração não movimenta dinheiro nem quita a folha.",
    "Motivos por aluno, ajustes e histórico de entrega: Financeiro → Caixinha × Folha.",
  );
  return lines.join("\n");
}
