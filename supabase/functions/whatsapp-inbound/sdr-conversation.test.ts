/// <reference lib="deno.ns" />
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isLatestSdrTurn,
  isWaitingAcknowledgement,
  sameReply,
  waitingReply,
} from "./sdr-conversation.ts";

Deno.test("aguardo e agradecimento não são novo pedido de horário", () => {
  for (
    const text of [
      "Estou aguardando",
      "Fico no aguardo",
      "Ok, fico no aguardo!",
      "Obrigado",
      "🆗",
      "Combinado 👍",
    ]
  ) {
    assertEquals(isWaitingAcknowledgement(text), true, text);
  }
  for (
    const text of [
      "",
      "Obrigado, mas pode ser às 19h?",
      "Ok, quero falar com o diretor",
      "Estou aguardando há uma hora, pode ser amanhã?",
      "Não quero mais",
    ]
  ) {
    assertEquals(isWaitingAcknowledgement(text), false, text);
  }
});

Deno.test("agradecimento imediato fica sem nova bolha; cobrança posterior recebe estado real", () => {
  const now = Date.parse("2026-09-04T17:45:00Z");
  const request = {
    status: "PENDING",
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 3600_000).toISOString(),
  };
  assertEquals(waitingReply(request, now + 20_000), null);
  assertStringIncludes(waitingReply(request, now + 180_000)!, "já foi enviado");
  assertStringIncludes(waitingReply(request, now + 3600_000)!, "outra opção");
  assertStringIncludes(
    waitingReply(
      { ...request, expires_at: "2026-09-05T17:45:00Z" },
      now + 3600_000,
    )!,
    "outra opção",
  );
});

Deno.test("caso de 04/09 às 20h24 não promete verificar novamente 18h30", () => {
  const reply = waitingReply({
    status: "PENDING",
    created_at: "2026-09-04T17:45:51Z",
    expires_at: "2026-09-04T21:30:00Z",
  }, Date.parse("2026-09-04T23:24:15Z"))!;
  assertStringIncludes(reply, "outro dia e horário");
  assertEquals(reply.includes("Vou confirmar com"), false);
});

Deno.test("resposta obsoleta é descartada quando chega outra mensagem durante a geração", async () => {
  let latest = "first";
  let unavailable = false;
  const query: any = {};
  for (const method of ["select", "eq", "not", "order", "limit"]) {
    query[method] = () => query;
  }
  query.maybeSingle = () =>
    Promise.resolve({
      data: { meta: { msg_id: latest } },
      error: unavailable ? {} : null,
    });
  const sb = { from: () => query };
  assertEquals(await isLatestSdrTurn(sb, "tenant", "phone", "first"), true);
  latest = "second";
  assertEquals(await isLatestSdrTurn(sb, "tenant", "phone", "first"), false);
  assertEquals(await isLatestSdrTurn(sb, "tenant", "phone", "second"), true);
  unavailable = true;
  assertEquals(await isLatestSdrTurn(sb, "tenant", "phone", "second"), false);
});

Deno.test("formatação ou emoji não transformam texto repetido em resposta nova", () => {
  assertEquals(
    sameReply("O pedido já foi enviado! 😊", "O pedido já foi enviado."),
    true,
  );
  assertEquals(sameReply("Pedido enviado", "Pedido confirmado"), false);
});
