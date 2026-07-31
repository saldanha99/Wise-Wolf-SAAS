/// <reference lib="deno.ns" />

import { localMonth, monthRange, recentMonths } from "../../lib/dateUtils.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("janela do mês inclui o último dia e não invade o mês seguinte", () => {
  // Regressão real: o fechamento usava new Date('2026-07') + setMonth(+1). Como
  // 'YYYY-MM' é lido como UTC, no fuso do Brasil a data caía em 30/06 21h e o
  // limite saía 31/07 — as aulas dadas no DIA 31 sumiam do fechamento do mês.
  const julho = monthRange("2026-07");
  assert(julho.start === "2026-07-01", `início errado: ${julho.start}`);
  assert(julho.endExclusive === "2026-08-01", `fim errado: ${julho.endExclusive}`);
  assert("2026-07-31" >= julho.start && "2026-07-31" < julho.endExclusive, "dia 31 ficou de fora");

  // Mês de 30 dias: o bug antigo estourava para 02/07 e contava aula de julho em junho.
  const junho = monthRange("2026-06");
  assert(junho.endExclusive === "2026-07-01", `junho terminou em ${junho.endExclusive}`);
  assert(!("2026-07-01" < junho.endExclusive), "1º de julho entrou no fechamento de junho");

  // Fevereiro (28 dias) chegava a incluir 1 a 3 de março.
  const fev = monthRange("2026-02");
  assert(fev.endExclusive === "2026-03-01", `fevereiro terminou em ${fev.endExclusive}`);

  // Virada de ano.
  const dez = monthRange("2026-12");
  assert(dez.endExclusive === "2027-01-01", `dezembro terminou em ${dez.endExclusive}`);
});

Deno.test("mês local não pula para o seguinte na noite do último dia", () => {
  // O professor fecha o mês à noite. Com toISOString(), 22h de 31/07 no Brasil
  // já é 01/08 em UTC: o modal abria agosto e julho nunca era confirmado.
  assert(localMonth(new Date(2026, 6, 31, 22, 30)) === "2026-07", "virou de mês às 22h30 do dia 31");
  assert(localMonth(new Date(2026, 6, 1, 0, 5)) === "2026-07", "errou o mês na primeira hora do dia 1º");
});

Deno.test("lista de meses recentes não repete nem pula mês quando hoje é dia 31", () => {
  // setMonth(getMonth()-1) em 31/07 pede 31/06, que não existe: o JS empurra
  // para 01/07 e a lista mostrava julho duas vezes e escondia junho.
  const meses = recentMonths(4, new Date(2026, 6, 31, 10, 0));
  assert(
    JSON.stringify(meses) === JSON.stringify(["2026-07", "2026-06", "2026-05", "2026-04"]),
    `lista errada: ${meses.join(", ")}`,
  );

  const viradaDeAno = recentMonths(3, new Date(2027, 0, 31, 10, 0));
  assert(
    JSON.stringify(viradaDeAno) === JSON.stringify(["2027-01", "2026-12", "2026-11"]),
    `virada de ano errada: ${viradaDeAno.join(", ")}`,
  );
});
