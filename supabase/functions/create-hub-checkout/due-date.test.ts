/// <reference lib="deno.ns" />

import { hubFirstDueDate } from "./due-date.ts";

const assertEquals = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("compra às 23:30 de Brasília vence no dia de Brasília, não no dia UTC", () => {
  // 23:30 de 02/11 em Brasília = 02:30Z de 03/11.
  assertEquals(
    hubFirstDueDate("2026-11-03T02:30:00Z"),
    "2026-11-02",
    "Z",
  );
  // Mesmo instante no formato que o PostgREST devolve (microssegundos).
  assertEquals(
    hubFirstDueDate("2026-11-03T02:30:00.123456+00:00"),
    "2026-11-02",
    "PostgREST",
  );
  // E no formato do psql (espaço e fuso curto).
  assertEquals(
    hubFirstDueDate("2026-11-03 02:30:00.123456+00"),
    "2026-11-02",
    "psql",
  );
  // Mesmo instante já escrito no fuso de Brasília.
  assertEquals(
    hubFirstDueDate("2026-11-02T23:30:00-03:00"),
    "2026-11-02",
    "offset -03",
  );
});

Deno.test("compra de dia e na virada da meia-noite de Brasília", () => {
  assertEquals(hubFirstDueDate("2026-11-03T14:00:00Z"), "2026-11-03", "tarde");
  // 20:59:59 de Brasília ainda é o mesmo dia nas duas réguas.
  assertEquals(
    hubFirstDueDate("2026-11-03T23:59:59Z"),
    "2026-11-03",
    "20:59 BRT",
  );
  // 00:00 de Brasília = 03:00Z: já é o dia seguinte.
  assertEquals(
    hubFirstDueDate("2026-11-04T03:00:00Z"),
    "2026-11-04",
    "meia-noite BRT",
  );
  assertEquals(
    hubFirstDueDate("2026-11-04T02:59:59.999Z"),
    "2026-11-03",
    "23:59:59 BRT",
  );
  // Virada de mês e de ano.
  assertEquals(hubFirstDueDate("2027-01-01T02:00:00Z"), "2026-12-31", "ano");
});

Deno.test("valor sem instante confiável é recusado", () => {
  for (
    const value of [
      null,
      undefined,
      "",
      "   ",
      "2026-11-03",
      "2026-11-03T02:30:00",
      "não é data",
      "2026-13-40T02:30:00Z",
      20261103,
    ]
  ) {
    assertEquals(hubFirstDueDate(value), null, JSON.stringify(value));
  }
});

Deno.test("a criação e a conferência da 1ª cobrança usam a mesma data", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  if (!source.includes("hubFirstDueDate(checkout.created_at)")) {
    throw new Error("o vencimento tem de sair de hubFirstDueDate");
  }
  if (/text\(\s*checkout\.created_at\s*,\s*10\s*\)/.test(source)) {
    throw new Error("sobrou vencimento pela data UTC de created_at");
  }
  // Toda conferência compara com a mesma variável calculada uma vez.
  for (
    const snippet of [
      "nextDueDate: checkoutCreatedDate",
      "text(candidate.dueDate, 10) === checkoutCreatedDate",
      "dueDate: checkoutCreatedDate",
    ]
  ) {
    if (!source.includes(snippet)) {
      throw new Error(`conferência sem a data de Brasília: ${snippet}`);
    }
  }
});
