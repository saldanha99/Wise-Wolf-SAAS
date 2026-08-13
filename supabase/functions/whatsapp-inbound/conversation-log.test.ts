// Ver o comentário de topo de `trial-reschedule.test.ts` sobre esta diretiva.
/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { foiEntregue, historicoParaModelo } from "./conversation-log.ts";

Deno.test("linha antiga, sem o campo, continua valendo como entregue", () => {
  assertEquals(foiEntregue({ direction: "out", content: "oi", meta: {} }), true);
  assertEquals(foiEntregue({ direction: "out", content: "oi", meta: null }), true);
  assertEquals(foiEntregue({ direction: "out", content: "oi" }), true);
});

Deno.test("só entregue === false reprova", () => {
  assertEquals(foiEntregue({ meta: { entregue: false } }), false);
  assertEquals(foiEntregue({ meta: { entregue: true } }), true);
});

Deno.test("REGRESSÃO: resposta não entregue não volta como fala da atendente", () => {
  const rows = [
    { direction: "out", content: "essa aqui falhou no envio", meta: { entregue: false } },
    { direction: "in", content: "consigo às 16h?", meta: {} },
    { direction: "out", content: "qual horário fica melhor?", meta: { entregue: true } },
  ];
  assertEquals(historicoParaModelo(rows), [
    { role: "assistant", content: "qual horário fica melhor?" },
    { role: "user", content: "consigo às 16h?" },
  ]);
});

Deno.test("a ordem sai da mais antiga para a mais nova", () => {
  const rows = [
    { direction: "in", content: "terceira", meta: {} },
    { direction: "out", content: "segunda", meta: {} },
    { direction: "in", content: "primeira", meta: {} },
  ];
  assertEquals(historicoParaModelo(rows).map((m) => m.content), ["primeira", "segunda", "terceira"]);
});

Deno.test("mensagem recebida do lead nunca é filtrada pelo campo de entrega", () => {
  // `entregue` descreve o que a ESCOLA mandou. Se algum dia entrar numa linha
  // de entrada por engano, a fala do aluno não pode sumir da conversa.
  const rows = [{ direction: "in", content: "oi", meta: { entregue: true } }];
  assertEquals(historicoParaModelo(rows), [{ role: "user", content: "oi" }]);
});

Deno.test("conteúdo é cortado no limite e nunca vira null", () => {
  const rows = [
    { direction: "out", content: "x".repeat(1200), meta: {} },
    { direction: "in", content: null, meta: {} },
  ];
  const out = historicoParaModelo(rows);
  assertEquals(out[0].content, "");
  assertEquals(out[1].content.length, 900);
});

Deno.test("lista vazia não quebra", () => {
  assertEquals(historicoParaModelo([]), []);
});
