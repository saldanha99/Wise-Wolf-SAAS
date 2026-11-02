/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { CatalogPrice } from "./trial-closing.ts";
import {
  asksFullPriceList,
  complainsAboutRepetition,
  detectFrequencyRequest,
  extractPricesBrl,
  formatFrequencyAnswer,
  formatPriceList,
  hasForeignPrice,
  hasUnansweredPriceQuestion,
  isFollowUpNudge,
  mentionsSchedule,
  priceListAlreadySent,
} from "./lead-pricing.ts";
import { isPriceRequest } from "./commercial-response-policy.ts";

// O catálogo real da Wise Wolf em 17/09/2026 (`student_pricing_plans`).
export const CATALOGO: CatalogPrice[] = [
  { frequency: 2, duration: 1, value: 220 },
  { frequency: 3, duration: 1, value: 290 },
  { frequency: 4, duration: 1, value: 390 },
  { frequency: 5, duration: 1, value: 450 },
  { frequency: 2, duration: 6, value: 198 },
  { frequency: 3, duration: 6, value: 261 },
  { frequency: 4, duration: 6, value: 355 },
  { frequency: 5, duration: 6, value: 377 },
  { frequency: 6, duration: 6, value: 429 },
  { frequency: 2, duration: 12, value: 169 },
  { frequency: 3, duration: 12, value: 229 },
  { frequency: 4, duration: 12, value: 299 },
  { frequency: 5, duration: 12, value: 339 },
  { frequency: 6, duration: 12, value: 389 },
];

Deno.test("frequência: as formas que o lead escreve", () => {
  assertEquals(detectFrequencyRequest("4 vezes na semana qual valor ?"), 4);
  assertEquals(
    detectFrequencyRequest("Qual o valor de 4 aulas de 30 mim por semana?"),
    4,
  );
  assertEquals(detectFrequencyRequest("quero 3x por semana"), 3);
  assertEquals(detectFrequencyRequest("2x/semana fica quanto"), 2);
  assertEquals(detectFrequencyRequest("duas vezes na semana"), 2);
  assertEquals(detectFrequencyRequest("por semana, 5 aulas"), 5);
});

Deno.test("frequência: não confunde duração nem horário com frequência", () => {
  assertEquals(detectFrequencyRequest("aulas de 30 minutos"), null);
  assertEquals(
    detectFrequencyRequest("Vc pode me passar estimativa de valores ?"),
    null,
  );
  assertEquals(detectFrequencyRequest("sábado às 10"), null);
  assertEquals(detectFrequencyRequest("semana que vem às 9"), null);
});

Deno.test("pedido de tabela e cobrança de resposta", () => {
  assert(asksFullPriceList("Vc pode me passar estimativa de valores ?"));
  assert(asksFullPriceList("me manda a tabela"));
  assert(asksFullPriceList("quais são os planos?"));
  assert(!asksFullPriceList("quanto custa?"));
  assert(isFollowUpNudge("??"));
  assert(isFollowUpNudge("E aí?"));
  assert(!isFollowUpNudge("Entendi"));
  assert(
    complainsAboutRepetition(
      "Quero uma empresa que me passe os valores e não que fique me tirando como idiota com essas mensagens repetidas",
    ),
  );
  assert(
    complainsAboutRepetition(
      "Se vc não me passar o valor não tenho interesse na aula",
    ),
  );
});

Deno.test("preços na resposta: lê R$ e reais; barra o que não é do catálogo", () => {
  assertEquals(extractPricesBrl("São R$ 169 por mês ou R$355/mês"), [169, 355]);
  assertEquals(extractPricesBrl("fica 299 reais"), [299]);
  assertEquals(extractPricesBrl("R$ 1.200,50"), [1200.5]);
  const allowed = new Set(CATALOGO.map((p) => p.value));
  assert(!hasForeignPrice("4x por semana fica R$355/mês", allowed));
  assert(hasForeignPrice("4x por semana fica R$350/mês", allowed));
});

Deno.test("a tabela sai no formato da direção (6 e 12 meses; sem o mensal)", () => {
  const lista = formatPriceList(CATALOGO);
  assert(
    lista.startsWith("🔹 Planos de 6 meses\n✅ 2x por semana – R$198/mês"),
    lista,
  );
  assert(lista.includes("🔹 Planos de 12 meses (com desconto)"), lista);
  assert(lista.includes("✅ 4x por semana – R$299/mês"), lista);
  assert(!lista.includes("R$390"), "o mensal não entra na tabela padrão");
  assert(!lista.includes("R$220"), lista);
  assert(priceListAlreadySent([{ role: "assistant", content: lista }]));
  assert(!priceListAlreadySent([{ role: "assistant", content: "oi" }]));
});

Deno.test("resposta por frequência", () => {
  assertEquals(
    formatFrequencyAnswer(CATALOGO, 4),
    "4x por semana fica R$355/mês no plano de 6 meses ou R$299/mês no de 12 meses.",
  );
  assertEquals(formatFrequencyAnswer(CATALOGO, 7), null);
});

Deno.test("pergunta de preço em aberto: só fecha quando uma resposta traz valor", () => {
  const semResposta = [
    { role: "user", content: "4 vezes na semana qual valor ?" },
    {
      role: "assistant",
      content: "Esse horário já está aguardando o aceite de um professor.",
    },
  ];
  assert(hasUnansweredPriceQuestion(semResposta, isPriceRequest));
  const respondida = [
    ...semResposta,
    { role: "assistant", content: "4x por semana fica R$355/mês" },
  ];
  assert(!hasUnansweredPriceQuestion(respondida, isPriceRequest));
  assert(!hasUnansweredPriceQuestion([], isPriceRequest));
});

Deno.test("mensagem fala de horário?", () => {
  assert(mentionsSchedule("As 10"));
  assert(mentionsSchedule("pode ser sábado às 10:30?"));
  assert(mentionsSchedule("amanhã de manhã"));
  assert(!mentionsSchedule("4 vezes na semana qual valor ?"));
  assert(!mentionsSchedule("Qual o valor de 4 aulas de 30 mim por semana?"));
  assert(!mentionsSchedule("??"));
});
