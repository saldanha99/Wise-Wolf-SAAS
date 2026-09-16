/// <reference lib="deno.ns" />
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TYPING_MAX_MS, TYPING_MIN_MS, typingDelayMs } from "./typing-delay.ts";

Deno.test("mensagem curta ainda leva o tempo mínimo", () => {
  assertEquals(typingDelayMs("Oi!"), TYPING_MIN_MS);
  assertEquals(typingDelayMs(""), TYPING_MIN_MS);
});

Deno.test("mensagem média cresce com o tamanho", () => {
  const texto = "a".repeat(400);
  assertEquals(typingDelayMs(texto), 16_000);
});

Deno.test("mensagem longa respeita o teto", () => {
  assertEquals(typingDelayMs("a".repeat(5000)), TYPING_MAX_MS);
});

Deno.test("texto ausente não quebra o cálculo", () => {
  assertEquals(typingDelayMs(undefined as unknown as string), TYPING_MIN_MS);
});
