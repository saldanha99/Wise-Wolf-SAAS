/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { montarMensagemFolha, monthLabel } from "./payroll-message.ts";

Deno.test("folha sem cobertura: uma linha por professor e o total", () => {
  const txt = montarMensagemFolha("Wise Wolf", {
    month: "2026-08",
    total_amount: 3828,
    total_lessons: 481,
    teachers: [
      {
        name: "Debora Alves Fernandes",
        lessons: 137,
        amount: 1096,
        status: "PENDENTE",
        projected: 1096,
        received: { count: 0, amount: 0, items: [] },
        ceded: { count: 0, items: [] },
      },
      {
        name: "Flávio Henrique Dias Romão",
        lessons: 126,
        amount: 968,
        status: "PAGO",
        projected: 968,
        received: { count: 0, amount: 0, items: [] },
        ceded: { count: 0, items: [] },
      },
    ],
  });
  assertStringIncludes(txt, "Folha de agosto/2026 — Wise Wolf");
  assertStringIncludes(txt, "*Debora* — 137 aulas · *R$ 1096,00* (a pagar)");
  assertStringIncludes(txt, "*Flávio* — 126 aulas · *R$ 968,00* (pago)");
  assertStringIncludes(txt, "Total da folha: *R$ 3828,00* em 481 aulas.");
  assertEquals(txt.includes("previsto pela agenda"), false);
});

Deno.test("cobertura aparece linha a linha, com o previsto e a diferença", () => {
  const txt = montarMensagemFolha("Wise Wolf", {
    month: "2026-09",
    total_amount: 100,
    total_lessons: 12,
    teachers: [
      {
        name: "Debora Alves",
        lessons: 7,
        amount: 56,
        status: "PENDENTE",
        projected: 48,
        received: {
          count: 1,
          amount: 8,
          items: [{
            date: "2026-09-16",
            time: "09:30",
            student: "THEO LEVI",
            from: "Flávio Henrique",
            amount: 8,
          }],
        },
        ceded: { count: 0, items: [] },
      },
      {
        name: "Flávio Henrique",
        lessons: 5,
        amount: 44,
        status: "PENDENTE",
        projected: 52,
        received: { count: 0, amount: 0, items: [] },
        ceded: {
          count: 1,
          items: [{
            date: "2026-09-16",
            time: "09:30",
            student: "THEO LEVI",
            to: "Debora Alves",
          }],
        },
      },
    ],
  });
  assertStringIncludes(
    txt,
    "*Debora* — 7 aulas · *R$ 56,00* (a pagar) · previsto pela agenda R$ 48,00, +R$ 8,00",
  );
  assertStringIncludes(
    txt,
    "↪ cobriu THEO LEVI de Flávio em 16/09 09:30: +R$ 8,00",
  );
  assertStringIncludes(
    txt,
    "*Flávio* — 5 aulas · *R$ 44,00* (a pagar) · previsto pela agenda R$ 52,00, −R$ 8,00",
  );
  assertStringIncludes(txt, "↩ cedeu THEO LEVI para Debora em 16/09 09:30");
});

Deno.test("mês sem fechamento diz isso em vez de mandar lista vazia", () => {
  const txt = montarMensagemFolha("Wise Wolf", {
    month: "2026-10",
    teachers: [],
    total_amount: 0,
    total_lessons: 0,
  });
  assertStringIncludes(txt, "Nenhum fechamento de professor neste mês ainda.");
  assertEquals(monthLabel("2026-10"), "outubro/2026");
});
