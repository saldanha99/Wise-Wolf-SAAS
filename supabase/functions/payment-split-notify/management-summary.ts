import { dataCurta, money, nomeDoMes } from "./message.ts";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Record<
      string,
      unknown
    >[]
    : [];
}

export function paymentConfirmedManagementMessage(
  payment: Record<string, unknown>,
): string {
  const billingType = String(payment.billing_type ?? "").trim().toUpperCase();
  const method = billingType === "CREDIT_CARD"
    ? "cartão"
    : billingType === "PIX"
    ? "PIX"
    : billingType === "BOLETO"
    ? "boleto"
    : "pagamento";
  return [
    `✅ *Pagamento confirmado no ${method}*`,
    `Aluno: *${String(payment.student_name ?? "Aluno")}*`,
    `Valor: *${money(payment.value)}*`,
    `Vencimento: ${dataCurta(payment.due_date)}`,
    "",
    "_Confirmação do cliente registrada. Este valor ainda não entrou no caixa._",
    "_O rateio de dízimo e investimento será enviado quando o Asaas informar o recebimento efetivo._",
  ].join("\n");
}

export function paymentReceivedManagementMessage(
  payment: Record<string, unknown>,
): string {
  const billingType = String(payment.billing_type ?? "").trim().toUpperCase();
  const method = billingType === "CREDIT_CARD"
    ? "cartão"
    : billingType === "PIX"
    ? "PIX"
    : billingType === "BOLETO"
    ? "boleto"
    : "pagamento";
  return [
    `💰 *Pagamento recebido via ${method}*`,
    `Aluno: *${String(payment.student_name ?? "Aluno")}*`,
    `Valor recebido: *${money(payment.value)}*`,
    `Crédito confirmado em: ${
      dataCurta(
        payment.credited_at ?? payment.paid_at ?? payment.payment_date,
      )
    }`,
    "",
    "_O rateio detalhado está desativado. Esta é a confirmação simples da entrada no caixa._",
  ].join("\n");
}

export function monthlyPaymentCloseMessage(
  snapshot: Record<string, unknown>,
): string {
  const roster = object(snapshot.roster);
  const competence = object(snapshot.competence);
  const cash = object(snapshot.cash);
  const dre = object(snapshot.dre);
  const period = String(snapshot.period_start ?? "");
  const month = nomeDoMes(period.slice(0, 7));
  const year = period.slice(0, 4);
  const expected = Math.trunc(number(roster.expected_students));
  const settled = Math.trunc(number(roster.settled_students));
  const outsideBase = number(cash.fora_da_base);
  const operatingResult = number(dre.resultado);
  const operatingExpenses = array(dre.linhas)
    .filter((line) =>
      String(line.kind ?? "").toUpperCase() === "DESPESA" &&
      number(line.valor) > 0
    )
    .sort((left, right) => number(right.valor) - number(left.valor))
    .slice(0, 4);

  const lines = [
    `🎉 *Fechamento inteligente de ${month}/${year}*`,
    `✅ Todos os alunos da competência estão quitados: *${settled}/${expected}*`,
    "",
    `📚 Mensalidades faturadas: *${money(competence.billed)}*`,
    `💳 Mensalidades quitadas: *${money(competence.settled)}*`,
    "",
    "📊 *Resultado operacional por competência*",
    `💵 Receita líquida: *${money(dre.receita_liquida)}*`,
    `👨‍🏫 Custo operacional dos serviços: *${money(dre.custo_servicos)}*`,
    `🏷️ Despesas operacionais: *${money(dre.despesas_operacionais)}*`,
  ];
  for (const expense of operatingExpenses) {
    lines.push(
      `      • ${String(expense.label ?? "Despesa")}: ${money(expense.valor)}`,
    );
  }
  lines.push(
    `${operatingResult >= 0 ? "✅" : "🔻"} Resultado operacional: *${
      money(operatingResult)
    }*`,
    "",
    "💰 *Caixa e rateio pelas regras da escola*",
    `🏦 Caixa efetivamente recebido no mês: *${money(cash.recebido)}*`,
    `👨‍🏫 Custo docente projetado usado no rateio: *${
      money(cash.custo_professor)
    }*`,
    `➖ Base do rateio: *${money(cash.liquido)}*`,
    `🙏 Dízimo: *${money(cash.dizimo)}*`,
    `📈 Investimento: *${money(cash.investimento)}*`,
    `🏫 Saldo destinado à escola: *${money(cash.sobra)}*`,
    `👑 Pró-labore da direção: *${money(cash.pro_labore)}*`,
  );
  if (outsideBase !== 0) {
    lines.push(
      `📎 Receitas fora da base do rateio: *${money(outsideBase)}*`,
    );
  }
  lines.push(
    "",
    "_Competência e caixa aparecem separados: pagamento antecipado ou atrasado não distorce o mês._",
    `_O DRE mostra custos, despesas e resultado; o rateio mostra o destino do caixa. Os dois blocos não devem ser somados entre si._`,
    `_Qualquer alteração posterior abre revisão, sem duplicar esta mensagem._`,
  );
  return lines.join("\n");
}
