/// <reference lib="deno.ns" />

import {
  contractPeriod,
  contractReferenceDate,
  formatSignatureDate,
} from "../../lib/contractDates.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("contrato de aluno que ainda não assinou nunca cai em 1970/1971", () => {
  // Regressão real: accepted_at é nulo até a assinatura. `new Date(null)` vira
  // o epoch (31/12/1969 no fuso de Brasília), a conta pulava um mês e o
  // contrato saía impresso com "Vigência: 10/01/1970 a 10/01/1971".
  const agora = new Date(2026, 6, 30);
  for (const ausente of [null, undefined, ""]) {
    const referencia = contractReferenceDate(ausente, agora);
    const { start, end } = contractPeriod(referencia, 10, 12);
    assert(
      start.getFullYear() >= 2026,
      `início regrediu para ${start.getFullYear()} com valor ausente`,
    );
    assert(
      end.getFullYear() === 2027,
      `término deveria ser 2027, veio ${end.getFullYear()}`,
    );
  }
});

Deno.test("data inválida também não regride para o epoch", () => {
  const agora = new Date(2026, 6, 30);
  for (const lixo of ["não é data", "0000-00-00", Number.NaN]) {
    const referencia = contractReferenceDate(lixo, agora);
    assert(
      !Number.isNaN(referencia.getTime()),
      `valor inválido produziu Invalid Date: ${String(lixo)}`,
    );
    assert(
      referencia.getFullYear() === 2026,
      `valor inválido deveria cair para hoje, veio ${referencia.getFullYear()}`,
    );
  }
});

Deno.test("data válida é preservada exatamente", () => {
  const assinado = contractReferenceDate("2026-07-30T12:00:00.000Z");
  assert(assinado.getUTCFullYear() === 2026, "ano da assinatura deve valer");
  assert(assinado.getUTCMonth() === 6, "mês da assinatura deve valer");
});

Deno.test("matrícula após o vencimento começa no ciclo seguinte", () => {
  // Matriculou dia 30, vencimento dia 10 → primeiro ciclo é do mês seguinte.
  const depois = contractPeriod(new Date(2026, 6, 30), 10, 12);
  assert(depois.start.getMonth() === 7, "deveria começar em agosto");
  assert(
    depois.end.getFullYear() === 2027 && depois.end.getMonth() === 7,
    "12 meses depois deveria ser agosto de 2027",
  );

  // Matriculou dia 5, vencimento dia 10 → ainda pega o ciclo do mês corrente.
  const antes = contractPeriod(new Date(2026, 6, 5), 10, 12);
  assert(antes.start.getMonth() === 6, "deveria começar em julho");
});

Deno.test("dia de vencimento fora da faixa não corrompe a vigência", () => {
  const referencia = new Date(2026, 6, 15);
  for (const invalido of [0, -3, 99, Number.NaN]) {
    const { start, end } = contractPeriod(referencia, invalido, 12);
    assert(
      start.getDate() >= 1 && start.getDate() <= 31,
      `dia de início inválido com dueDay=${invalido}: ${start.getDate()}`,
    );
    assert(
      end.getFullYear() >= start.getFullYear(),
      "término nunca pode ser anterior ao início",
    );
  }
});

Deno.test("serviço avulso (0 meses) mantém início e término coerentes", () => {
  const { start, end } = contractPeriod(new Date(2026, 6, 5), 10, 0);
  assert(
    start.getTime() === end.getTime(),
    "sem duração, início e término coincidem",
  );
});


Deno.test("REGRESSÃO: a tela nunca imprime 31/12/1969 para quem não assinou", () => {
  // Era `new Date(student.accepted_at).toLocaleDateString()` na coluna
  // "Matrícula": com accepted_at nulo, o epoch em Brasília vira 31/12/1969.
  // 13 alunos migrados em fev/2026 aparecem assim.
  assert(formatSignatureDate(null) === "—", "nulo tem de virar traço");
  assert(formatSignatureDate(undefined) === "—", "indefinido tem de virar traço");
  assert(formatSignatureDate("") === "—", "vazio tem de virar traço");
  assert(formatSignatureDate("nao é data") === "—", "data inválida tem de virar traço");
  assert(formatSignatureDate(0) === "—", "epoch exato tem de virar traço");
});

Deno.test("data de assinatura real continua sendo mostrada em pt-BR", () => {
  const formatada = formatSignatureDate("2026-02-28T15:10:41.501664+00:00");
  assert(/^\d{2}\/\d{2}\/2026$/.test(formatada), `esperava dd/mm/2026, veio ${formatada}`);
});

Deno.test("o texto de ausência é configurável, para caber em cada tela", () => {
  assert(formatSignatureDate(null, "não assinado") === "não assinado", "deveria aceitar rótulo próprio");
});
