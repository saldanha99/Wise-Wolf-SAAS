/// <reference lib="deno.ns" />
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DUPLICATE_WINDOW_MS,
  formWelcomeMessage,
  greetFirstName,
  leadOpeningMessage,
  recentlyMessaged,
  sdrAgentName,
  sdrEnabled,
} from "./first-touch.ts";

Deno.test("a resposta ao formulário já pergunta dias e horários", () => {
  const msg = leadOpeningMessage({
    name: "Maria Souza",
    sdrName: "Bia",
    brandName: "Escola Teste",
  });
  assert(msg.startsWith("Oi, Maria! Aqui é Bia, da Escola Teste"));
  assert(msg.includes("quais dias e horários ficam bons pra você?"));
  assert(msg.includes("experimental e gratuita"));
});

Deno.test("sem nome de atendente, fala em nome da equipe", () => {
  const msg = leadOpeningMessage({
    name: null,
    sdrName: null,
    brandName: "Escola Teste",
  });
  assert(msg.startsWith("Oi! Aqui é a equipe da Escola Teste"));
});

Deno.test("nome em caixa alta vira nome próprio; lixo não vira saudação", () => {
  assertEquals(greetFirstName("MARIA SILVA"), "Maria");
  assertEquals(greetFirstName("joão"), "João");
  assertEquals(greetFirstName("123"), "");
  assertEquals(greetFirstName("  "), "");
});

Deno.test("first_touch desligado não cala a resposta ao formulário", () => {
  assertEquals(sdrEnabled(null), true);
  assertEquals(sdrEnabled({}), true);
  assertEquals(sdrEnabled({ sdr: { first_touch: false } }), true);
  assertEquals(sdrEnabled({ sdr: { enabled: false } }), false);
});

Deno.test("com a atendente desligada, a mensagem antiga continua", () => {
  const msg = formWelcomeMessage("ana", "Escola Teste");
  assert(msg.startsWith("*Olá Ana, bem-vindo(a) à Escola Teste!*"));
});

Deno.test("nome da atendente sai da configuração da escola", () => {
  assertEquals(sdrAgentName({ agents: { atendente: { name: "Bia" } } }), "Bia");
  assertEquals(sdrAgentName({ agents: [] }), undefined);
  assertEquals(sdrAgentName("x"), undefined);
});

Deno.test("segundo cadastro do mesmo telefone em sequência não gera outra mensagem", () => {
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  assertEquals(recentlyMessaged(null, now), false);
  assertEquals(recentlyMessaged(ago(3600 * 1000), now), true);
  assertEquals(recentlyMessaged(ago(DUPLICATE_WINDOW_MS + 1000), now), false);
  assertEquals(recentlyMessaged("não é data", now), false);
});
