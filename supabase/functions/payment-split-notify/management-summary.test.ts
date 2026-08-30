import {
  monthlyPaymentCloseMessage,
  paymentConfirmedManagementMessage,
} from "./management-summary.ts";

Deno.test("confirmation does not present authorized card as cash", () => {
  const message = paymentConfirmedManagementMessage({
    student_name: "Aluno Teste",
    value: 229,
    billing_type: "CREDIT_CARD",
    due_date: "2026-08-30",
  });
  if (!message.includes("Pagamento confirmado no cartão")) {
    throw new Error(message);
  }
  if (!message.includes("ainda não entrou no caixa")) throw new Error(message);
  if (!message.includes("R$ 229,00")) throw new Error(message);
});

Deno.test("monthly close separates competence from cash and applies frozen totals", () => {
  const message = monthlyPaymentCloseMessage({
    period_start: "2026-08-01",
    roster: { expected_students: 39, settled_students: 39 },
    competence: { billed: 8000, settled: 8000 },
    dre: {
      receita_liquida: 8327.04,
      custo_servicos: 3320,
      despesas_operacionais: 827,
      resultado: 4180.04,
      linhas: [
        { kind: "DESPESA", label: "Ferramentas e software", valor: 110 },
        {
          kind: "DESPESA",
          label: "Plano de saúde e benefícios",
          valor: 717,
        },
      ],
    },
    cash: {
      recebido: 8327.04,
      custo_professor: 1776,
      liquido: 4249.14,
      dizimo: 424.92,
      investimento: 1769.42,
      sobra: 125.5,
      fora_da_base: 233,
      pro_labore: 2054.8,
    },
  });
  for (
    const expected of [
      "39/39",
      "Mensalidades faturadas",
      "Resultado operacional por competência",
      "Custo operacional dos serviços: *R$ 3.320,00*",
      "Despesas operacionais: *R$ 827,00*",
      "Plano de saúde e benefícios: R$ 717,00",
      "Resultado operacional: *R$ 4.180,04*",
      "Caixa efetivamente recebido",
      "R$ 424,92",
      "R$ 1.769,42",
      "Saldo destinado à escola: *R$ 125,50*",
      "Receitas fora da base do rateio: *R$ 233,00*",
    ]
  ) {
    if (!message.includes(expected)) throw new Error(message);
  }
  if (message.includes("R$ 1.894,92")) {
    throw new Error(
      `investimento e saldo foram somados indevidamente: ${message}`,
    );
  }
});
