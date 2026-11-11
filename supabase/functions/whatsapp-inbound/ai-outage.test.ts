/// <reference lib="deno.ns" />
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  AI_OUTAGE_GIVE_UP_MS,
  aiFailureAction,
  classifyAiFailure,
  delayedReplyInstruction,
  planAiOutage,
} from "./ai-outage.ts";

// Diag real de 11/11/2026 (encurtado).
const diag = [
  'gemini/gemini-2.5-flash: HTTP 429 { "error": { "code": 429, "message": "You exceeded your current quota',
  'google/gemini-2.5-flash-lite: HTTP 402 {"error":{"message":"This request requires more credits',
  'openai/gpt-4o-mini: HTTP 402 {"error":{"message":"This request requires more credits',
  'meta-llama/llama-3.3-70b-instruct: HTTP 402 {"error":{"message":"This request requires more credits',
];

Deno.test("queda de 11/11: Gemini sem cota e OpenRouter sem crédito", () => {
  const f = classifyAiFailure(diag);
  assertEquals(f.causes.sort(), ["cota_excedida", "sem_credito"]);
  assertEquals(
    f.summary,
    "Gemini (Google): cota excedida · OpenRouter: sem crédito",
  );
  const action = aiFailureAction(f);
  assert(action.includes("OpenRouter"));
  assert(action.includes("Gemini"));
});

Deno.test("chave ausente e resposta inválida são distinguidas", () => {
  const f = classifyAiFailure([
    "GEMINI_API_KEY ausente",
    "openai/gpt-4o-mini: sem JSON",
    "meta-llama/llama-3.3-70b-instruct: HTTP 503 upstream",
  ]);
  assertEquals(f.causes.sort(), ["chave_ausente", "instavel", "resposta_invalida"]);
  assert(aiFailureAction(f).includes("chaves"));
});

Deno.test("diag vazio não quebra", () => {
  assertEquals(classifyAiFailure([]).summary, "nenhum provedor respondeu");
});

Deno.test("primeira falha: um aviso ao lead, alerta à direção, nova tentativa", () => {
  const p = planAiOutage({ now: 1_000_000, lastHoldToLeadAt: null, lastTenantAlertAt: null });
  assertEquals(p, { sendHold: true, alertDirection: true, giveUp: false, retryInSeconds: 120 });
});

Deno.test("nova tentativa não repete aviso ao lead nem alerta dentro da hora", () => {
  const now = 10_000_000;
  const p = planAiOutage({ now, lastHoldToLeadAt: now - 5 * 60_000, lastTenantAlertAt: now - 10 * 60_000 });
  assertEquals(p.sendHold, false);
  assertEquals(p.alertDirection, false);
  assertEquals(p.giveUp, false);
});

Deno.test("alerta da escola volta a sair depois de uma hora", () => {
  const now = 10_000_000;
  const p = planAiOutage({ now, lastHoldToLeadAt: now - 60_000, lastTenantAlertAt: now - 3_600_000 });
  assertEquals(p.alertDirection, true);
});

Deno.test("depois de 6 h sem IA, o contato vai para humano", () => {
  const now = 100_000_000;
  const p = planAiOutage({ now, lastHoldToLeadAt: now - AI_OUTAGE_GIVE_UP_MS, lastTenantAlertAt: now });
  assertEquals(p.giveUp, true);
  assertEquals(p.sendHold, false);
});

Deno.test("instrução de atraso pede desculpas sem motivo técnico", () => {
  const line = delayedReplyInstruction(37.4);
  assert(line.includes("37 min"));
  assert(line.includes("desculpas"));
});
