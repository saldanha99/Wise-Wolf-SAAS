/// <reference lib="deno.ns" />
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { montarMensagem, money } from "./message.ts";

// Números medidos na produção em 13/08/2026, com as duas réguas.
const AULA_DA_DIRECAO = {
  student_name: "Felipe Augusto de Oliveira Torres",
  valor: 271.00, paid_at: "2026-08-13", month: "2026-08", na_base: true,
  professores: [{ teacher_name: "Debora Alves Fernandes", aulas: 17, custo: null, descontado: false }],
  liquido: 271.00, dizimo: 27.10, investimento: 27.10, pro_labore: 216.80, sobra: 0,
  dizimo_pct: 10, investimento_pct: 10, regra: "direcao",
};

const AULA_DE_PROFESSOR = {
  student_name: "Ana Clara Sant'Ana",
  valor: 261.00, paid_at: "2026-08-13", month: "2026-08", na_base: true,
  professores: [{ teacher_name: "Mateus", aulas: 13, custo: 104.00, descontado: true }],
  liquido: 157.00, dizimo: 15.70, investimento: 109.90, pro_labore: 31.40, sobra: 0,
  dizimo_pct: 10, investimento_pct: 70, regra: "professor",
};

/** Soma os valores das quatro linhas de destino da base. */
function somaDestinos(b: Record<string, unknown>): number {
  return Number(b.dizimo) + Number(b.investimento) + Number(b.pro_labore) + Number(b.sobra);
}

Deno.test("aula da direção: pró-labore fica com o líquido menos dízimo e investimento", () => {
  const msg = montarMensagem(AULA_DA_DIRECAO);
  assertStringIncludes(msg, "Pró-labore da direção: *R$ 216,80*");
  assertStringIncludes(msg, "Dízimo (10%): *R$ 27,10*");
  assertStringIncludes(msg, "Investimento que fica na escola (10%): *R$ 27,10*");
  assertStringIncludes(msg, "sem salário a descontar");
  assertEquals(somaDestinos(AULA_DA_DIRECAO), Number(AULA_DA_DIRECAO.liquido));
});

Deno.test("aula de professor contratado: investimento 70% e pró-labore 20%", () => {
  const msg = montarMensagem(AULA_DE_PROFESSOR);
  assertStringIncludes(msg, "Investimento que fica na escola (70%): *R$ 109,90*");
  assertStringIncludes(msg, "Pró-labore da direção: *R$ 31,40*");
  assertStringIncludes(msg, "salário deste aluno: *R$ 104,00*");
  assertEquals(somaDestinos(AULA_DE_PROFESSOR), Number(AULA_DE_PROFESSOR.liquido));
});

Deno.test("investimento e sobra viram UMA linha só", () => {
  // Eram duas ("Investimento" e "Fica na escola") para o mesmo dinheiro, e a
  // segunda dava sempre zero na régua do professor.
  const msg = montarMensagem(AULA_DE_PROFESSOR);
  assertEquals(msg.includes("Fica na escola"), false);
  assertEquals((msg.match(/Investimento/g) || []).length, 1);
});

Deno.test("REGRESSÃO: linha única soma investimento + sobra e mostra o % da base", () => {
  // Régua antiga (investimento 10% + sobra 70%) tem de aparecer como 80% numa
  // linha só — senão o diretor lê 10% ao lado de um valor que é 80% da base.
  const msg = montarMensagem({
    ...AULA_DE_PROFESSOR, investimento: 15.70, sobra: 109.90, pro_labore: 15.70,
  });
  assertStringIncludes(msg, "Investimento que fica na escola (80%): *R$ 125,60*");
});

Deno.test("REGRESSÃO: o centavo do arredondamento não vira sobra negativa", () => {
  // O rateio devolve pró-labore já ajustado; a mensagem nunca deve exibir
  // valor negativo em nenhuma das três linhas.
  const msg = montarMensagem({ ...AULA_DE_PROFESSOR, sobra: 0, pro_labore: 31.39 });
  assertEquals(msg.includes("-R$"), false);
});

Deno.test("entrada sem aluno vinculado não simula rateio", () => {
  const msg = montarMensagem({ na_base: false, valor: 2000, paid_at: "2026-08-13" });
  assertStringIncludes(msg, "sem aluno vinculado");
  assertStringIncludes(msg, "não gera dízimo nem investimento");
  assertEquals(msg.includes("Pró-labore"), false);
});

Deno.test("aluno partido entre as duas réguas mostra os dois professores", () => {
  const msg = montarMensagem({
    ...AULA_DA_DIRECAO,
    student_name: "Verônica",
    professores: [
      { teacher_name: "Debora Alves Fernandes", aulas: 4, custo: null, descontado: false },
      { teacher_name: "Mateus", aulas: 4, custo: 32.00, descontado: true },
    ],
  });
  assertStringIncludes(msg, "(direção)");
  assertStringIncludes(msg, "Professor Mateus");
});

// Pagamento completo (migration 20260914100000). Nomes fictícios.
const PAGAMENTO_COMPLETO_MENSAL = {
  student_name: "Aluno Ficticio", na_base: true,
  month: "2026-09", competencia: "2026-09", vencimento: "2026-09-08",
  paid_at: "2026-09-08T12:00:00+00:00", recebido_em: "2026-09-08",
  valor: 216.67, parcela: 216.67, recebido_total: 1300.00, reservado: 1083.33,
  meses: 6, sequencia: 1, modo: "MENSAL",
  cobertura_inicio: "2026-09", cobertura_fim: "2027-02",
  professores: [{ teacher_name: "Professor Ficticio", aulas: 4, custo: 32.00, descontado: true }],
  liquido: 184.67, dizimo: 18.47, investimento: 129.27, pro_labore: 36.93, sobra: 0,
  dizimo_pct: 10, investimento_pct: 70, regra: "professor", eh_matricula: false,
};

Deno.test("pagamento completo MENSAL: diz que recebeu tudo e rateia só a parcela", () => {
  const msg = montarMensagem(PAGAMENTO_COMPLETO_MENSAL);
  assertStringIncludes(msg, "Aluno Ficticio pagou R$ 1.300,00* — pagamento completo de 6 meses");
  assertStringIncludes(msg, "recebido por completo em 08/09/2026");
  assertStringIncludes(msg, "cobre setembro/2026 a fevereiro/2027");
  assertStringIncludes(msg, "parcela 1/6 de *R$ 216,67*");
  assertStringIncludes(msg, "Segue reservado para os próximos meses: *R$ 1.083,33*");
  assertStringIncludes(msg, "Base do rateio: *R$ 184,67*");
  assertEquals(msg.includes("pagou R$ 216,67"), false);
  // Soma em centavos: 18,47 + 129,27 + 36,93 em ponto flutuante não dá 184,67 exato.
  assertEquals(Math.round(somaDestinos(PAGAMENTO_COMPLETO_MENSAL) * 100), 18467);
});

Deno.test("parcela k de pagamento completo: rateio do mês com o dinheiro já recebido", () => {
  const msg = montarMensagem({
    ...PAGAMENTO_COMPLETO_MENSAL, month: "2026-10", competencia: "2026-10",
    sequencia: 2, reservado: 866.66,
  });
  assertStringIncludes(msg, "Rateio de outubro: Aluno Ficticio* — parcela 2/6");
  assertStringIncludes(msg, "pagamento completo de R$ 1.300,00 já recebido em 08/09/2026");
  assertStringIncludes(msg, "Segue reservado para os próximos meses: *R$ 866,66*");
  assertEquals(msg.includes(" pagou "), false);
});

Deno.test("pagamento completo LEGADO: valor cheio rateado, meses só cobertos", () => {
  const msg = montarMensagem({
    ...AULA_DE_PROFESSOR, student_name: "Aluno Ficticio", valor: 600.00,
    recebido_total: 600.00, parcela: 600.00, reservado: 0, meses: 3, modo: "LEGADO",
    cobertura_inicio: "2026-07", cobertura_fim: "2026-09", recebido_em: "2026-07-10",
  });
  assertStringIncludes(msg, "pagou R$ 600,00* — pagamento completo de 3 meses");
  assertStringIncludes(msg, "cobre julho/2026 a setembro/2026");
  assertStringIncludes(msg, "sem novo rateio");
  assertEquals(msg.includes("reservado"), false);
});

Deno.test("taxa de matrícula não aparece como aluno sem agenda", () => {
  const msg = montarMensagem({
    ...AULA_DE_PROFESSOR, student_name: "Aluno Ficticio", valor: 59.90, professores: [],
    eh_matricula: true, liquido: 59.90, dizimo: 5.99, investimento: 41.93, pro_labore: 11.98,
  });
  assertStringIncludes(msg, "Taxa de matrícula: não desconta salário de professor");
  assertEquals(msg.includes("sem aulas na agenda"), false);
});

Deno.test("REGRESSÃO: fatura de agosto creditada em setembro diz de que mês é a fatura", () => {
  // Cartão de vencimento 05/08 creditado em 08/09: a caixinha é a agenda de
  // AGOSTO, e o aviso tem de dizer isso, senão parece erro de mês.
  const msg = montarMensagem({
    ...AULA_DE_PROFESSOR, student_name: "Aluno Ficticio", month: "2026-08",
    competencia: "2026-08", vencimento: "2026-08-05",
    paid_at: "2026-09-08T12:00:00+00:00", recebido_em: "2026-09-08", meses: 1,
  });
  assertStringIncludes(msg, "_fatura de agosto/2026 (vencimento 05/08/2026) confirmada em 08/09/2026_");
  assertStringIncludes(msg, "agenda de agosto");
});

Deno.test("pagamento comum do mês continua com a linha de sempre", () => {
  const msg = montarMensagem({
    ...AULA_DE_PROFESSOR, competencia: "2026-08", recebido_em: "2026-08-13", meses: 1,
  });
  assertStringIncludes(msg, "pagou R$ 261,00*\n_fatura confirmada em 13/08/2026_");
  assertEquals(msg.includes("pagamento completo"), false);
});

Deno.test("dinheiro é formatado em pt-BR sem depender de ICU", () => {
  assertEquals(money(1201.76), "R$ 1.201,76");
  assertEquals(money(0), "R$ 0,00");
  assertEquals(money(null), "R$ 0,00");
});
