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
  assertStringIncludes(msg, "Investimento (10%): *R$ 27,10*");
  assertStringIncludes(msg, "sem salário a descontar");
  assertEquals(somaDestinos(AULA_DA_DIRECAO), Number(AULA_DA_DIRECAO.liquido));
});

Deno.test("aula de professor contratado: investimento 70% e pró-labore 20%", () => {
  const msg = montarMensagem(AULA_DE_PROFESSOR);
  assertStringIncludes(msg, "Investimento (70%): *R$ 109,90*");
  assertStringIncludes(msg, "Pró-labore da direção: *R$ 31,40*");
  assertStringIncludes(msg, "salário deste aluno: *R$ 104,00*");
  assertEquals(somaDestinos(AULA_DE_PROFESSOR), Number(AULA_DE_PROFESSOR.liquido));
});

Deno.test("REGRESSÃO: 'fica na escola' aparece mesmo valendo zero", () => {
  // Some a linha e as quatro parcelas deixam de fechar com a base na tela de
  // quem confere — foi por isso que ela passou a ser incondicional.
  assertStringIncludes(montarMensagem(AULA_DE_PROFESSOR), "Fica na escola: *R$ 0,00*");
  assertStringIncludes(montarMensagem(AULA_DA_DIRECAO), "Fica na escola: *R$ 0,00*");
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

Deno.test("dinheiro é formatado em pt-BR sem depender de ICU", () => {
  assertEquals(money(1201.76), "R$ 1.201,76");
  assertEquals(money(0), "R$ 0,00");
  assertEquals(money(null), "R$ 0,00");
});
