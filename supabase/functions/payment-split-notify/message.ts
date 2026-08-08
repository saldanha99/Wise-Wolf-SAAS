/**
 * Montagem da mensagem de rateio.
 *
 * Separado do index.ts porque o index chama serve() no import: importar aquele
 * arquivo para conferir o texto subiria um servidor. Aqui a função é pura, então
 * dá para rodar o template e ler a mensagem exata que vai para o grupo.
 */

const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** Formatação sem depender de ICU: o runtime da VPS não é o do navegador. */
export function money(v: unknown): string {
  const n = Number(v ?? 0);
  const seguro = Number.isFinite(n) ? n : 0;
  const [inteiro, decimal] = Math.abs(seguro).toFixed(2).split(".");
  const comPontos = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${seguro < 0 ? "-" : ""}R$ ${comPontos},${decimal}`;
}

export function pct(v: unknown): string {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return "0%";
  return `${String(n).replace(".", ",")}%`;
}

export function nomeDoMes(month: string): string {
  const idx = Number(String(month || "").split("-")[1]) - 1;
  return MESES[idx] ?? String(month);
}

/** dd/mm/aaaa a partir do YYYY-MM-DD que o Postgres devolve. */
export function dataCurta(iso: unknown): string {
  const s = String(iso ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

export interface Professor {
  teacher_name?: string;
  aulas?: number;
  custo?: number;
  /** false = pró-labore da direção: aparece na mensagem, mas não desconta. */
  descontado?: boolean;
}

export function montarMensagem(b: Record<string, unknown>): string {
  const professores = (Array.isArray(b.professores) ? b.professores : []) as Professor[];
  const mes = nomeDoMes(String(b.month ?? ""));
  const partes: string[] = [];

  // Fora da base (pagamento sem aluno vinculado): aviso curto. O dinheiro
  // aparece — esconder entrada seria pior que não ratear —, mas sem simular um
  // rateio que a direção decidiu não fazer. Aporte da dona não gera dízimo.
  if (b.na_base === false) {
    return [
      `💵 *Entrada de ${money(b.valor)}* — sem aluno vinculado`,
      `_confirmada em ${dataCurta(b.paid_at)}_`,
      "",
      `Fora da base do rateio: não gera dízimo nem investimento.`,
      `_Se for mensalidade de aluno, vincule no Financeiro para entrar na base._`,
    ].join("\n");
  }

  partes.push(`💰 *${String(b.student_name ?? "Aluno")} pagou ${money(b.valor)}*`);
  partes.push(`_fatura confirmada em ${dataCurta(b.paid_at)}_`);
  partes.push("");

  if (professores.length > 0) {
    // Uma linha por professor com o NOME: é o que o diretor lê primeiro
    // ("Professor Mateus, salário tal desse aluno").
    for (const p of professores) {
      if (p.descontado === false) {
        // Pró-labore da direção: o valor aparece, mas dizer "salário" e depois
        // não descontar faria a conta parecer errada. O motivo vai junto.
        partes.push(
          `👑 ${p.teacher_name ?? "—"} · pró-labore da direção: ${money(p.custo)}`,
        );
        partes.push(`      ${p.aulas ?? 0} aulas em ${mes} · não desconta da base`);
      } else {
        partes.push(
          `👨‍🏫 Professor ${p.teacher_name ?? "—"} · salário deste aluno: *${money(p.custo)}*`,
        );
        partes.push(`      ${p.aulas ?? 0} aulas previstas na agenda de ${mes}`);
      }
    }
  } else if (b.sem_aluno) {
    // Pagamento que chegou sem aluno vinculado: mostrar custo zero sem explicar
    // faria o líquido parecer lucro cheio de uma aula que ninguém deu.
    partes.push(`👨‍🏫 Professor: *${money(0)}* — pagamento sem aluno vinculado`);
  } else {
    partes.push(`👨‍🏫 Professor: *${money(0)}* — aluno sem aulas na agenda de ${mes}`);
  }

  partes.push(`➖ Base do rateio: *${money(b.liquido)}*`);
  partes.push("");
  partes.push(`🙏 Dízimo (${pct(b.dizimo_pct)}): *${money(b.dizimo)}*`);
  partes.push(`📈 Investimento (${pct(b.investimento_pct)}): *${money(b.investimento)}*`);
  partes.push(`✅ Fica na escola: *${money(b.sobra)}*`);

  // A ressalva vai SEMPRE. O custo do professor é o do calendário do mês, e o
  // mês ainda não terminou — quem ler isto como fechamento vai pagar dízimo
  // sobre um número que a folha ainda vai mudar.
  partes.push("");
  partes.push(
    `_Custo do professor é previsto pela agenda de ${mes} (calendário do mês) e pela tarifa vigente. O valor real fecha com as aulas lançadas._`,
  );

  return partes.join("\n");
}
