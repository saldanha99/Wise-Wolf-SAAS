/**
 * Texto da folha do mês por professor, para o grupo da Gestão.
 *
 * Um compositor só, usado pelo cron do dia 1º (`management-payroll-report`)
 * e pelo comando do grupo ("folha de agosto") — dois textos divergiriam no
 * primeiro ajuste. Puro: recebe o retorno de `gestao_payroll_summary`.
 *
 * As coberturas aparecem LINHA A LINHA de propósito: é o que explica por que
 * a folha de um professor ficou diferente do previsto pela agenda.
 */

export interface PayrollCoverageItem {
  date?: string;
  time?: string;
  student?: string;
  from?: string;
  to?: string;
  amount?: number | string | null;
}

export interface PayrollTeacherRow {
  name: string;
  lessons: number;
  amount: number | string;
  status: string;
  projected?: number | string;
  received?: {
    count: number;
    amount: number | string;
    items?: PayrollCoverageItem[];
  };
  ceded?: { count: number; items?: PayrollCoverageItem[] };
}

export interface PayrollSummary {
  ok?: boolean;
  month: string;
  teachers: PayrollTeacherRow[];
  total_amount: number | string;
  total_lessons: number;
}

const MESES = [
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

export const money = (v: unknown): string =>
  `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;

export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${MESES[Number(m[2]) - 1]}/${m[1]}` : month;
}

const firstName = (v: unknown) => String(v ?? "").trim().split(/\s+/)[0] || "—";
const shortDate = (iso: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}` : String(iso ?? "");
};

function statusLabel(status: string): string {
  const s = String(status || "").toUpperCase();
  if (s === "PAGO") return "pago";
  if (s === "PENDENTE") return "a pagar";
  if (s === "SEM_FECHAMENTO") return "sem fechamento";
  return s.toLowerCase();
}

export function montarMensagemFolha(brand: string, s: PayrollSummary): string {
  const linhas: string[] = [];
  linhas.push(`📊 *Folha de ${monthLabel(s.month)} — ${brand}*`);
  linhas.push("");
  if (!s.teachers.length) {
    linhas.push("Nenhum fechamento de professor neste mês ainda.");
    return linhas.join("\n");
  }
  for (const t of s.teachers) {
    const rec = t.received?.count || 0;
    const ced = t.ceded?.count || 0;
    const projected = Number(t.projected ?? t.amount);
    const amount = Number(t.amount);
    let cabecalho = `*${firstName(t.name)}* — ${t.lessons} aula${
      t.lessons === 1 ? "" : "s"
    } · *${money(amount)}* (${statusLabel(t.status)})`;
    if (rec || ced) {
      const delta = amount - projected;
      cabecalho += ` · previsto pela agenda ${money(projected)}, ${
        delta >= 0 ? "+" : "−"
      }${money(Math.abs(delta)).replace("R$ ", "R$ ")}`;
    }
    linhas.push(cabecalho);
    for (const it of t.received?.items || []) {
      linhas.push(
        `   ↪ cobriu ${it.student || "aluno"} de ${firstName(it.from)} em ${
          shortDate(it.date)
        } ${it.time || ""}: +${money(it.amount)}`,
      );
    }
    for (const it of t.ceded?.items || []) {
      linhas.push(
        `   ↩ cedeu ${it.student || "aluno"} para ${firstName(it.to)} em ${
          shortDate(it.date)
        } ${it.time || ""}`,
      );
    }
  }
  linhas.push("");
  linhas.push(
    `Total da folha: *${money(s.total_amount)}* em ${s.total_lessons} aulas.`,
  );
  linhas.push(
    "Os valores são os do fechamento oficial de cada professor; cobertura muda o dono da aula, não a tarifa de quem a deu.",
  );
  return linhas.join("\n");
}
