/// <reference lib="deno.ns" />

import {
  hasUsableMeetingLink,
  normalizeMeetingLink,
  safeMeetingLink,
} from "../../lib/meetingLink.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("aceita links reais dos provedores usados pela escola", () => {
  const casos: Array<[string, string]> = [
    ["https://meet.google.com/abc-defg-hij", "meet"],
    ["https://calendar.app.google/abcd1234", "meet"],
    ["https://us05web.zoom.us/j/1234567890", "zoom"],
    ["https://teams.microsoft.com/l/meetup-join/xyz", "teams"],
    ["https://whereby.com/wise-wolf", "whereby"],
  ];
  for (const [link, provider] of casos) {
    const info = normalizeMeetingLink(link);
    assert(info !== null, `rejeitou link válido: ${link}`);
    assert(
      info.provider === provider,
      `provedor errado para ${link}: ${info.provider}`,
    );
  }
});

Deno.test("aceita link colado sem protocolo — é como as pessoas copiam", () => {
  const info = normalizeMeetingLink("meet.google.com/abc-defg-hij");
  assert(info !== null, "deveria aceitar sem https://");
  assert(
    info.url.startsWith("https://"),
    `precisa normalizar o protocolo: ${info?.url}`,
  );
});

Deno.test("rejeita a home do Meet, que não leva a sala nenhuma", () => {
  for (const link of [
    "https://meet.google.com",
    "https://meet.google.com/",
    "https://meet.google.com/new",
  ]) {
    assert(
      normalizeMeetingLink(link) === null,
      `deveria rejeitar ${link}: não é uma sala`,
    );
  }
});

Deno.test("rejeita texto solto que o usuário digitou achando que era link", () => {
  for (const lixo of ["a combinar", "pergunte ao professor", "sala 3", "-"]) {
    assert(
      normalizeMeetingLink(lixo) === null,
      `deveria rejeitar texto solto: ${JSON.stringify(lixo)}`,
    );
  }
});

Deno.test("vazio e nulo não viram link", () => {
  for (const vazio of ["", "   ", null, undefined]) {
    assert(
      normalizeMeetingLink(vazio) === null,
      `valor vazio virou link: ${JSON.stringify(vazio)}`,
    );
    assert(!hasUsableMeetingLink(vazio), "vazio não é sala utilizável");
  }
});

Deno.test("rejeita protocolo perigoso", () => {
  // Um javascript: no href do aluno seria execução de código na sessão dele.
  for (const perigoso of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    assert(
      normalizeMeetingLink(perigoso) === null,
      `protocolo perigoso aceito: ${perigoso}`,
    );
  }
});

Deno.test("safeMeetingLink devolve só a URL, pronta para href", () => {
  assert(
    safeMeetingLink("https://meet.google.com/abc-defg-hij")
      ?.startsWith("https://meet.google.com/"),
    "deveria devolver a URL utilizável",
  );
  assert(safeMeetingLink("nada") === null, "lixo vira null");
});
