/**
 * Precificação da escola — a conta da simulação de preço na tela.
 *
 * O servidor (`finance_pricing_overview`) devolve o custo de cada plano; aqui só
 * se refaz a conta para um preço digitado, sem ir ao banco. Mesma fórmula do SQL:
 *
 *   margem = preço − repasse − IA − Asaas − (preço × imposto%) − DAS rateado
 *   preço mínimo (lucro zero) = (repasse + IA + Asaas + DAS rateado) ÷ (1 − imposto%)
 *
 * O "divisor" (1 − imposto%) é o do MotoFix (`lib/precificacao.ts`): imposto
 * sobre o preço não se soma ao custo, divide.
 */

export interface PlanCost {
  repasse: number;
  ia: number;
  asaas: number;
  /** % do imposto sobre a receita (0 quando o regime é DAS fixo ou não configurado). */
  impostoPct: number;
  /** DAS fixo do mês ÷ alunos pagantes (0 fora do regime de DAS fixo). */
  dasRateado: number;
}

export interface PriceSimulation {
  preco: number;
  imposto: number;
  custoTotal: number;
  margem: number;
  margemPct: number | null;
  precoMinimo: number;
  status: 'lucro' | 'empate' | 'prejuizo';
}

const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

const safe = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function minimumPrice(c: PlanCost): number {
  const pct = Math.min(Math.max(safe(c.impostoPct), 0), 90) / 100;
  return round2((safe(c.repasse) + safe(c.ia) + safe(c.asaas) + safe(c.dasRateado)) / (1 - pct));
}

export function simulatePrice(price: number, c: PlanCost): PriceSimulation {
  const preco = Math.max(safe(price), 0);
  const pct = Math.min(Math.max(safe(c.impostoPct), 0), 90) / 100;
  const imposto = round2(preco * pct + safe(c.dasRateado));
  const custoTotal = round2(safe(c.repasse) + safe(c.ia) + safe(c.asaas) + imposto);
  const margem = round2(preco - custoTotal);
  return {
    preco,
    imposto,
    custoTotal,
    margem,
    margemPct: preco > 0 ? Math.round((margem / preco) * 1000) / 10 : null,
    precoMinimo: minimumPrice(c),
    // Centavos de diferença contam como empate: arredondamento, não lucro.
    status: Math.abs(margem) < 0.5 ? 'empate' : margem > 0 ? 'lucro' : 'prejuizo',
  };
}

/**
 * Ponto de equilíbrio: quantos alunos pagantes cobrem os custos fixos.
 * null quando a margem de contribuição não é positiva (nunca empata).
 */
export function breakEvenStudents(fixedCosts: number, contributionPerStudent: number): number | null {
  const fixos = Math.max(safe(fixedCosts), 0);
  const contrib = safe(contributionPerStudent);
  if (contrib <= 0) return null;
  return Math.ceil(fixos / contrib);
}
