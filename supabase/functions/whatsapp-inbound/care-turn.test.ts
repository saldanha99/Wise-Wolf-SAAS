import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type CareInboxMessage, mergeCareTurn } from "./care-turn.ts";

const message = (
  id: string,
  body: string,
  seconds: number,
  direction = "in",
): CareInboxMessage => ({
  provider_message_id: id,
  body,
  direction,
  message_type: "text",
  created_at: new Date(Date.UTC(2026, 8, 30, 18, 46, seconds)).toISOString(),
});

Deno.test("cancelamento fragmentado invalida resposta à saudação e junta o pedido", () => {
  const rows = [
    message("cancel", "Gostaria de fazer o cancelamento do curso", 17),
    message("greeting", "Boa tarde", 10),
    message("old", "Lembrete", 0, "out"),
  ];
  assertEquals(mergeCareTurn(rows, "greeting"), null);
  assertEquals(
    mergeCareTurn(rows, "cancel"),
    "Boa tarde\nGostaria de fazer o cancelamento do curso",
  );
});

Deno.test("resposta posterior não ressuscita pedido já respondido e arquivo bloqueia inferência", () => {
  const rows = [
    message("ok", "Ok", 55),
    message("handoff", "A coordenação retorna", 27, "out"),
    message("cancel", "cancelamento", 17),
  ];
  assertEquals(mergeCareTurn(rows, "ok"), "Ok");
  assertEquals(
    mergeCareTurn([{
      ...message("audio", "[Áudio]", 56),
      message_type: "audio",
    }, ...rows], "audio"),
    null,
  );
});
