import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { operationMessage } from "./core.ts";
Deno.test("lead origin is explicit about uncertainty and never invents paid acquisition", () => {
  const msg = operationMessage({
    kind: "LEAD_ORIGIN",
    name: "Fixture",
    origin: { channel: "DIRECT_UNKNOWN", form_source: "blog_form" },
  }, "https://example.invalid");
  assert(msg.includes("Sem pista de origem"));
  assert(msg.includes("Formulário do blog"));
  assert(!msg.includes("Campanha:"));
  assert(!msg.includes("Anúncio"));
});
Deno.test("lead origin reads as a sentence: search, article read and the form used", () => {
  const msg = operationMessage({
    kind: "LEAD_ORIGIN",
    name: "Fixture",
    phone: "5511999990000",
    origin: {
      channel: "ORGANIC_SEARCH",
      surface: "BLOG",
      form_source: "level_quiz",
      first_landing_path: "/blog/ingles-para-product-managers",
      last_landing_path: "/",
      first_referrer_host: "www.google.com",
    },
  }, "https://example.invalid");
  assert(msg.includes("Pesquisa no Google (orgânico, sem anúncio)"));
  assert(
    msg.includes(
      'Entrou por: artigo do blog "ingles para product managers" → pediu contato em: Página inicial',
    ),
  );
  assert(msg.includes("Como pediu contato: Teste de nível"));
  assert(!msg.includes("level_quiz") && !msg.includes("BLOG"));
});
Deno.test("WhatsApp entry points are named, and a Meta click-to-WhatsApp ad shows its title", () => {
  const ad = operationMessage({
    kind: "LEAD_ORIGIN",
    origin: {
      channel: "PAID",
      paid_platform: "META_WHATSAPP",
      form_source: "WhatsApp (IA)",
      whatsapp_ad_title: "Inglês para o trabalho",
    },
  }, "https://example.invalid");
  assert(
    ad.includes(
      "Anúncio do Meta (Instagram/Facebook) com botão para o WhatsApp",
    ),
  );
  assert(ad.includes("Anúncio: Inglês para o trabalho"));
  assert(ad.includes("Como pediu contato: Mensagem no WhatsApp"));
  const link = operationMessage({
    kind: "LEAD_ORIGIN",
    origin: { channel: "WHATSAPP_LINK", form_source: "WhatsApp (IA)" },
  }, "https://example.invalid");
  assert(link.includes("Clicou num link para o WhatsApp da escola"));
  const search = operationMessage({
    kind: "LEAD_ORIGIN",
    origin: { channel: "WHATSAPP_DIRECT", form_source: "WhatsApp (IA)" },
  }, "https://example.invalid");
  assert(search.includes("Procurou o número da escola direto no WhatsApp"));
  assert(!search.includes("Anúncio do"));
});
Deno.test("attendance notice preserves measured times, asks review and does not determine a sanction", () => {
  const msg = operationMessage({
    kind: "TEACHER_LATE",
    name: "Fixture\n*admin*",
    scheduled_start_at: "2026-10-27T12:00:00Z",
    first_join_at: "2026-10-27T12:07:00Z",
    late_minutes: 7,
  }, "https://example.invalid");
  assert(msg.includes("27/10/2026, 09:07"));
  assert(msg.includes("7 min"));
  assert(msg.includes("não determina culpa"));
  assert(!msg.includes("\n*admin*"));
});
Deno.test("unverified evidence cannot be rendered as late attendance", () => {
  assertThrows(() =>
    operationMessage(
      { kind: "UNVERIFIED", late_minutes: null },
      "https://example.invalid",
    )
  );
  assertThrows(() =>
    operationMessage(
      { kind: "STUDENT_LATE", late_minutes: 0 },
      "https://example.invalid",
    )
  );
  assertEquals(
    operationMessage({
      kind: "LEAD_ORIGIN",
      origin: { channel: "PAID", utm_campaign: "campaign" },
    }, "https://example.invalid").includes("Anúncio pago"),
    true,
  );
});
