/**
 * Textos do passivo de reposição — resumo de segunda no grupo de coordenação,
 * cobrança da reposição vencida (professor + linha no grupo) e o comando
 * "reposições" do grupo. Puro: recebe o que as RPCs devolvem
 * (`reschedule_backlog_summary`, `reschedule_overdue_rows`) e monta a mensagem.
 *
 * Medido em 18/09/2026: 122 de 138 reposições dos últimos 60 dias sem data
 * (Mateus 127 abertas). Passivo invisível vira dívida com o aluno — e aula que
 * ninguém lança não paga o professor.
 */

export interface RescheduleBacklogRow {
  professor: string;
  teacher_id: string;
  sem_data: number;
  vencidas: number;
  marcadas_7d: number;
  mais_antiga: string | null;
  por_falta_do_professor: number;
}

export interface RescheduleOverdueRow {
  reschedule_id: string;
  date: string;
  time: string;
  fault_type: string | null;
  teacher_id: string;
  teacher_name: string;
  teacher_phone: string | null;
  student_id: string;
  student_name: string;
}

const firstName = (raw: string | null | undefined): string =>
  String(raw || "").trim().split(/\s+/)[0] || "professor";

function ddmm(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${m[3]}/${m[2]}` : String(iso || "");
}

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
function slotLabel(date: string, time: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return `${date} ${time}`.trim();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `${WEEKDAY_SHORT[d.getDay()]} ${m[3]}/${m[2]} ${time}`.trim();
}

/** Resumo por professor (segunda de manhã e comando "reposições"). */
export function rescheduleBacklogMessage(
  rows: RescheduleBacklogRow[],
  opts: { schoolName?: string; heading?: string } = {},
): string {
  const heading = opts.heading || "🔁 *Reposições em aberto por professor*";
  const active = rows.filter((r) =>
    Number(r.sem_data) + Number(r.vencidas) + Number(r.marcadas_7d) > 0
  );
  if (!active.length) {
    return `${heading}\n\nNenhuma reposição em aberto. 🐺`;
  }
  const totalSemData = active.reduce((acc, r) => acc + Number(r.sem_data), 0);
  const totalVencidas = active.reduce((acc, r) => acc + Number(r.vencidas), 0);
  const totalMarcadas = active.reduce(
    (acc, r) => acc + Number(r.marcadas_7d),
    0,
  );
  const lines: string[] = [heading, ""];
  for (const r of active) {
    const parts: string[] = [];
    if (Number(r.sem_data) > 0) parts.push(`${r.sem_data} sem data`);
    if (Number(r.vencidas) > 0) {
      parts.push(
        `⚠️ ${r.vencidas} vencida${
          Number(r.vencidas) > 1 ? "s" : ""
        } sem lançamento`,
      );
    }
    if (Number(r.marcadas_7d) > 0) {
      parts.push(
        `${r.marcadas_7d} marcada${
          Number(r.marcadas_7d) > 1 ? "s" : ""
        } nos próximos 7 dias`,
      );
    }
    const extra = Number(r.por_falta_do_professor) > 0
      ? ` · ${r.por_falta_do_professor} por falta do professor`
      : "";
    const oldest = r.mais_antiga ? ` · mais antiga ${ddmm(r.mais_antiga)}` : "";
    lines.push(
      `• *${firstName(r.professor)}*: ${parts.join(" · ")}${extra}${oldest}`,
    );
  }
  lines.push("");
  lines.push(
    `Total: ${totalSemData} sem data · ${totalVencidas} vencida${
      totalVencidas === 1 ? "" : "s"
    } · ${totalMarcadas} marcada${totalMarcadas === 1 ? "" : "s"} na semana.`,
  );
  lines.push(
    'Reposição sem data não acontece: o professor marca em *Reposições* (ou manda "a reposição do <aluno> ficou <dia> <hora>" para este número).',
  );
  return lines.join("\n");
}

/** Cobrança ao professor: reposição com data passada e sem lançamento. */
export function rescheduleOverdueTeacherMessage(
  teacherName: string,
  rows: RescheduleOverdueRow[],
): string {
  const lines = [
    `Oi, ${firstName(teacherName)}! 🐺 ${
      rows.length === 1
        ? "Uma reposição passou da data"
        : `${rows.length} reposições passaram da data`
    } e ainda não ${rows.length === 1 ? "foi lançada" : "foram lançadas"}:`,
    "",
  ];
  for (const r of rows) {
    lines.push(`• ${slotLabel(r.date, r.time)} — ${r.student_name}`);
  }
  lines.push("");
  lines.push(
    'Se a aula aconteceu, lance em *Lançar Aula* (ela conta no seu pagamento). Se não aconteceu, remarque ou desmarque em *Reposições* — ou responda aqui: "a reposição do <aluno> passou para <dia> <hora>".',
  );
  return lines.join("\n");
}

/** Linha do grupo de coordenação com as vencidas do dia (uma por professor). */
export function rescheduleOverdueGroupMessage(
  rows: RescheduleOverdueRow[],
): string {
  if (!rows.length) return "";
  const byTeacher = new Map<string, RescheduleOverdueRow[]>();
  for (const r of rows) {
    const list = byTeacher.get(r.teacher_name) || [];
    list.push(r);
    byTeacher.set(r.teacher_name, list);
  }
  const lines = [
    `⏰ *Reposições vencidas sem lançamento* (${rows.length}) — professores cobrados hoje:`,
  ];
  for (const [teacher, list] of byTeacher) {
    lines.push(
      `• *${firstName(teacher)}*: ${
        list.map((r) =>
          `${slotLabel(r.date, r.time)} ${firstName(r.student_name)}`
        ).join("; ")
      }`,
    );
  }
  return lines.join("\n");
}
