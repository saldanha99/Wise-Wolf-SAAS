/// <reference lib="deno.ns" />

import {
  authenticateWhatsAppInboundBoundRequest,
  authenticateWhatsAppInboundRequest,
  deriveWhatsAppInboundInstanceToken,
  deriveWhatsAppInboundInstanceTokenV3,
  evolutionMessageItems,
  evolutionWebhookEventKey,
  findActiveProfileById,
  isEvolutionInboxJidAllowed,
  normalizeEvolutionEventName,
  parseEvolutionMessage,
  sanitizeEvolutionWebhook,
  storeEvolutionInboxMessage,
  whatsappInboundIntegrationBindingMatches,
  whatsappInboundMethodIsAllowed,
} from "./whatsapp-inbox.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("autentica segredo por instância e limita o legado à transição", async () => {
  const legacy = "token-raiz-de-transicao-seguro";
  const expected = await deriveWhatsAppInboundInstanceToken(
    legacy,
    "tenant-a",
    "escola-central",
  );
  const headerUrl = new URL(
    "https://api.example/functions/v1/whatsapp-inbound",
  );
  const headerMode = await authenticateWhatsAppInboundRequest(
    new Headers({ "x-whatsapp-inbound-token": expected }),
    headerUrl,
    expected,
    legacy,
  );
  const legacyUrl = new URL(
    `https://api.example/functions/v1/whatsapp-inbound?token=${legacy}`,
  );
  const legacyMode = await authenticateWhatsAppInboundRequest(
    new Headers(),
    legacyUrl,
    expected,
    legacy,
  );
  const legacyHeaderMode = await authenticateWhatsAppInboundRequest(
    new Headers({ "x-whatsapp-inbound-token": legacy }),
    headerUrl,
    expected,
    legacy,
  );
  const deniedMode = await authenticateWhatsAppInboundRequest(
    new Headers({ "x-whatsapp-inbound-token": "incorreto" }),
    new URL("https://api.example/functions/v1/whatsapp-inbound?token=errado"),
    expected,
    legacy,
  );
  const v2QueryMode = await authenticateWhatsAppInboundRequest(
    new Headers(),
    new URL(
      `https://api.example/functions/v1/whatsapp-inbound?token=${expected}`,
    ),
    expected,
  );

  assertEquals(headerMode, "instance-header", "header por instância");
  assertEquals(legacyHeaderMode, "legacy-header", "header legado");
  assertEquals(legacyMode, "legacy-query", "query de transição");
  assertEquals(v2QueryMode, null, "v2 não aceita segredo pela URL");
  assertEquals(deniedMode, null, "credencial inválida");
});

Deno.test("segredo derivado isola tenant e instância", async () => {
  const root = "token-raiz-com-entropia-suficiente";
  const first = await deriveWhatsAppInboundInstanceToken(
    root,
    "tenant-a",
    "central-a",
  );
  const same = await deriveWhatsAppInboundInstanceToken(
    root,
    "tenant-a",
    "CENTRAL-A",
  );
  const otherTenant = await deriveWhatsAppInboundInstanceToken(
    root,
    "tenant-b",
    "central-a",
  );
  const otherInstance = await deriveWhatsAppInboundInstanceToken(
    root,
    "tenant-a",
    "central-b",
  );

  assertEquals(first, same, "nome canônico estável");
  assertEquals(first === otherTenant, false, "tenant isolado");
  assertEquals(first === otherInstance, false, "instância isolada");
  assertEquals(/^[A-Za-z0-9_-]{43}$/.test(first), true, "base64url");
  assertEquals(
    first,
    "bZYMFbkYLzm4r-n6s5jsdu-I5Ap6FPG_1BPPmlIwRXQ",
    "vetor v2 permanece byte a byte compatível",
  );
});

Deno.test("token v3 isola o recibo exato da integração", async () => {
  const root = "token-raiz-com-entropia-suficiente";
  const integrationId = "00000000-0000-4000-8000-0000000000e1";
  const first = await deriveWhatsAppInboundInstanceTokenV3(
    root,
    "tenant-a",
    "central-a",
    integrationId,
    1,
  );
  const same = await deriveWhatsAppInboundInstanceTokenV3(
    root,
    "tenant-a",
    "CENTRAL-A",
    integrationId.toUpperCase(),
    1,
  );
  const otherIntegration = await deriveWhatsAppInboundInstanceTokenV3(
    root,
    "tenant-a",
    "central-a",
    "00000000-0000-4000-8000-0000000000e2",
    1,
  );
  const otherVersion = await deriveWhatsAppInboundInstanceTokenV3(
    root,
    "tenant-a",
    "central-a",
    integrationId,
    2,
  );
  const v2 = await deriveWhatsAppInboundInstanceToken(
    root,
    "tenant-a",
    "central-a",
  );

  assertEquals(first, same, "escopo canônico v3");
  assertEquals(first === otherIntegration, false, "ID da integração isolado");
  assertEquals(first === otherVersion, false, "versão da integração isolada");
  assertEquals(first === v2, false, "domínio v3 separado do v2");
  assertEquals(
    first,
    "QJEj9ySFQIi8w04LiB0Y7jDbVkYv5THarVAHtaGjYVk",
    "vetor v3 estável",
  );
});

Deno.test("rollout autentica v1/v2/v3 sem reabrir credencial antiga", async () => {
  const rootToken = "token-raiz-com-entropia-suficiente";
  const binding = {
    tenantId: "tenant-a",
    instanceName: "central-a",
    integrationId: "00000000-0000-4000-8000-0000000000e1",
    integrationVersion: 1,
  };
  let resolutionCalls = 0;
  const current = () => {
    resolutionCalls += 1;
    return Promise.resolve({
      tenantId: "tenant-a",
      integrationId: binding.integrationId,
      version: 1,
    });
  };
  const url = new URL("https://api.example/functions/v1/whatsapp-inbound");
  const v2 = await deriveWhatsAppInboundInstanceToken(
    rootToken,
    binding.tenantId,
    binding.instanceName,
  );
  const v3 = await deriveWhatsAppInboundInstanceTokenV3(
    rootToken,
    binding.tenantId,
    binding.instanceName,
    binding.integrationId,
    binding.integrationVersion,
  );
  const authenticate = (version: 1 | 2 | 3, token: string) =>
    authenticateWhatsAppInboundBoundRequest(
      new Headers({ "x-whatsapp-inbound-token": token }),
      url,
      rootToken,
      version,
      binding,
      current,
    );

  assertEquals(await authenticate(1, rootToken), "legacy-header", "ponte v1");
  assertEquals(await authenticate(1, v2), "instance-header", "v1 aceita v2");
  assertEquals(
    await authenticate(1, v3),
    "instance-header",
    "v1 aceita v3 durante resposta upstream ambígua",
  );
  assertEquals(await authenticate(2, v2), "instance-header", "v2 preservado");
  assertEquals(
    await authenticate(2, v3),
    "instance-header",
    "v2 aceita v3 durante resposta upstream ambígua",
  );
  assertEquals(await authenticate(2, rootToken), null, "v2 fecha raiz");
  assertEquals(await authenticate(3, v3), "instance-header", "v3 vinculado");
  assertEquals(await authenticate(3, v2), null, "v3 revoga v2");
  assertEquals(await authenticate(3, rootToken), null, "v3 revoga raiz");

  const callsBeforeInvalid = resolutionCalls;
  assertEquals(
    await authenticateWhatsAppInboundBoundRequest(
      new Headers(),
      new URL(
        `https://api.example/functions/v1/whatsapp-inbound?token=${v3}`,
      ),
      rootToken,
      2,
      binding,
      current,
    ),
    null,
    "ponte v3 nunca aceita segredo pela URL",
  );
  assertEquals(
    await authenticate(2, "token-invalido"),
    null,
    "token inválido recusado",
  );
  assertEquals(
    resolutionCalls,
    callsBeforeInvalid,
    "broker não é consultado sem autenticação",
  );
});

Deno.test("binding stale fecha também a ponte v3 dos markers antigos", async () => {
  const rootToken = "token-raiz-com-entropia-suficiente";
  const binding = {
    tenantId: "tenant-a",
    instanceName: "central-a",
    integrationId: "00000000-0000-4000-8000-0000000000e1",
    integrationVersion: 1,
  };
  const token = await deriveWhatsAppInboundInstanceTokenV3(
    rootToken,
    binding.tenantId,
    binding.instanceName,
    binding.integrationId,
    binding.integrationVersion,
  );
  let effects = 0;
  const authenticate = (version: 1 | 2 | 3) =>
    authenticateWhatsAppInboundBoundRequest(
      new Headers({ "x-whatsapp-inbound-token": token }),
      new URL("https://api.example/functions/v1/whatsapp-inbound"),
      rootToken,
      version,
      binding,
      () =>
        Promise.resolve({
          tenantId: "tenant-a",
          integrationId: binding.integrationId,
          version: 2,
        }),
    );
  for (const version of [1, 2, 3] as const) {
    const authenticated = await authenticate(version);
    if (authenticated) effects += 1;
    assertEquals(
      authenticated,
      null,
      `binding obsoleto recusado no marker v${version}`,
    );
  }

  assertEquals(effects, 0, "nenhum efeito depois do gate");
  assertEquals(
    whatsappInboundIntegrationBindingMatches(binding, {
      tenantId: "tenant-a",
      integrationId: binding.integrationId,
      version: 2,
    }),
    false,
    "cache também distingue versão",
  );
});

Deno.test("webhook aceita somente POST e preflight OPTIONS", () => {
  assertEquals(whatsappInboundMethodIsAllowed("POST"), true, "POST");
  assertEquals(whatsappInboundMethodIsAllowed("OPTIONS"), true, "OPTIONS");
  assertEquals(whatsappInboundMethodIsAllowed("GET"), false, "GET");
  assertEquals(whatsappInboundMethodIsAllowed("PUT"), false, "PUT");
});

Deno.test("perfil ativo multi-escola não depende do tenant legado", async () => {
  const legacyProfile = {
    id: "00000000-0000-4000-8000-000000000099",
    tenant_id: "tenant-a",
    lifecycle_status: "active",
  };
  const filters: Array<{ column: string; value: string }> = [];
  const query = {
    eq(column: string, value: string) {
      filters.push({ column, value });
      return query;
    },
    maybeSingle() {
      const matches = filters.every(({ column, value }) =>
        String(legacyProfile[column as keyof typeof legacyProfile]) === value
      );
      return Promise.resolve({
        data: matches ? { id: legacyProfile.id } : null,
        error: null,
      });
    },
  };
  const client = {
    from(table: "profiles") {
      assertEquals(table, "profiles", "tabela de perfil");
      return {
        select(columns: "id") {
          assertEquals(columns, "id", "projeção mínima");
          return query;
        },
      };
    },
  };

  const result = await findActiveProfileById(client, legacyProfile.id);

  assertEquals(result.data, { id: legacyProfile.id }, "perfil ativo");
  assertEquals(filters, [
    { column: "id", value: legacyProfile.id },
    { column: "lifecycle_status", value: "active" },
  ], "filtros sem tenant legado");
});

Deno.test("normaliza mensagem de texto recebida da Evolution", () => {
  const parsed = parseEvolutionMessage({
    key: {
      id: "wamid-in-1",
      remoteJid: "5511999999999@s.whatsapp.net",
      fromMe: false,
    },
    pushName: "Maria",
    messageTimestamp: 1_725_000_000,
    message: { conversation: "Olá, escola" },
  });

  assertEquals(parsed?.providerMessageId, "wamid-in-1", "id do provedor");
  assertEquals(parsed?.remoteJid, "5511999999999@s.whatsapp.net", "jid");
  assertEquals(parsed?.phone, "5511999999999", "telefone");
  assertEquals(parsed?.direction, "in", "direção");
  assertEquals(parsed?.senderKind, "contact", "autor");
  assertEquals(parsed?.messageType, "text", "tipo");
  assertEquals(parsed?.body, "Olá, escola", "texto");
  assertEquals(parsed?.status, "received", "status");
});

Deno.test("normaliza mídia e atualização de status sem guardar URL", () => {
  const audio = parseEvolutionMessage({
    key: { id: "wamid-audio", remoteJid: "5511888888888@s.whatsapp.net" },
    message: {
      audioMessage: { url: "https://segredo.invalid/audio", ptt: true },
    },
  });
  const update = parseEvolutionMessage({
    key: {
      id: "wamid-out-1",
      remoteJid: "5511777777777@s.whatsapp.net",
      fromMe: true,
    },
    update: { status: "DELIVERY_ACK" },
  });
  const numericUpdate = parseEvolutionMessage({
    key: {
      id: "wamid-out-2",
      remoteJid: "5511777777777@s.whatsapp.net",
      fromMe: true,
    },
    update: { status: 4 },
  });
  const evolutionV24Update = parseEvolutionMessage({
    keyId: "wamid-out-v24",
    remoteJid: "5511777777777@s.whatsapp.net",
    fromMe: true,
    status: "DELIVERED",
  });

  assertEquals(audio?.messageType, "audio", "tipo de áudio");
  assertEquals(audio?.body, "[Áudio]", "placeholder de áudio");
  assertEquals(update?.status, "delivered", "status entregue");
  assertEquals(numericUpdate?.status, "read", "status numérico lido");
  assertEquals(
    evolutionV24Update?.providerMessageId,
    "wamid-out-v24",
    "id top-level da Evolution v2.4",
  );
  assertEquals(
    evolutionV24Update?.status,
    "delivered",
    "recibo top-level da Evolution v2.4",
  );
  assertEquals(update?.senderKind, "system", "autor outbound desconhecido");
});

Deno.test("usa o JID telefônico alternativo quando a Evolution envia @lid", () => {
  const parsed = parseEvolutionMessage({
    key: {
      id: "wamid-lid",
      remoteJid: "123456789012345@lid",
      remoteJidAlt: "5511555555555@s.whatsapp.net",
      fromMe: false,
    },
    message: { conversation: "Mensagem via LID" },
  });

  assertEquals(
    parsed?.remoteJid,
    "5511555555555@s.whatsapp.net",
    "jid canônico",
  );
  assertEquals(parsed?.phone, "5511555555555", "telefone alternativo");
  assertEquals(
    parsed?.metadata.originalRemoteJid,
    "123456789012345@lid",
    "jid original auditável",
  );
});

Deno.test("extrai registros paginados de findMessages", () => {
  const records = [{ key: { id: "1" } }, { key: { id: "2" } }];
  assertEquals(
    evolutionMessageItems({ messages: { total: 2, records } }),
    records,
    "records paginados",
  );
  assertEquals(
    normalizeEvolutionEventName("MESSAGES_UPSERT"),
    "messages.upsert",
    "evento",
  );
});

Deno.test("limita grupos da inbox ao grupo de gestão autorizado", () => {
  assertEquals(
    isEvolutionInboxJidAllowed("5511999999999@s.whatsapp.net", null),
    true,
    "conversa direta",
  );
  assertEquals(
    isEvolutionInboxJidAllowed(
      "120000000000001@g.us",
      "120000000000001@g.us",
    ),
    true,
    "grupo de gestão",
  );
  assertEquals(
    isEvolutionInboxJidAllowed(
      "120000000000002@g.us",
      "120000000000001@g.us",
    ),
    false,
    "outro grupo",
  );
  assertEquals(
    isEvolutionInboxJidAllowed("status@broadcast", "120000000000001@g.us"),
    false,
    "status/broadcast",
  );
});

Deno.test("redige credenciais do webhook e gera chave estável", async () => {
  const event = {
    event: "MESSAGES_UPSERT",
    instance: "escola-central",
    apikey: "evolution-secret",
    server_url: "https://internal.invalid",
    data: [{
      key: { id: "wamid-1", remoteJid: "5511999999999@s.whatsapp.net" },
      message: {
        imageMessage: {
          url: "https://signed.invalid",
          directPath: "/encrypted/media/path",
          mediaKey: "media-decryption-secret",
          fileSha256: "binary-file-hash",
          jpegThumbnail: "base64-thumbnail",
          caption: "Foto",
        },
      },
    }],
  };
  const sanitized = sanitizeEvolutionWebhook(event);
  const serialized = JSON.stringify(sanitized);
  const firstKey = await evolutionWebhookEventKey(event);
  const secondKey = await evolutionWebhookEventKey(event);

  assertEquals(
    serialized.includes("evolution-secret"),
    false,
    "apikey redigida",
  );
  assertEquals(
    serialized.includes("signed.invalid"),
    false,
    "url de mídia redigida",
  );
  assertEquals(
    serialized.includes("internal.invalid"),
    false,
    "url interna redigida",
  );
  assertEquals(
    serialized.includes("media-decryption-secret") ||
      serialized.includes("encrypted/media") ||
      serialized.includes("base64-thumbnail") ||
      serialized.includes("binary-file-hash"),
    false,
    "segredos e binários de mídia redigidos",
  );
  assertEquals(firstKey, secondKey, "chave idempotente");
  assertEquals(firstKey.length, 64, "sha-256 hexadecimal");
});

Deno.test("chave do webhook ignora ordem recursiva, mas distingue status", async () => {
  const first = {
    event: "MESSAGES_UPDATE",
    instance: "escola-central",
    data: [{
      key: {
        id: "wamid-status-1",
        remoteJid: "5511999999999@s.whatsapp.net",
        fromMe: true,
      },
      update: { status: "DELIVERY_ACK", timestamp: 1_725_000_000 },
    }],
  };
  const reordered = {
    data: [{
      update: { timestamp: 1_725_000_000, status: "DELIVERY_ACK" },
      key: {
        fromMe: true,
        remoteJid: "5511999999999@s.whatsapp.net",
        id: "wamid-status-1",
      },
    }],
    instance: "escola-central",
    event: "MESSAGES_UPDATE",
  };
  const read = {
    ...reordered,
    data: [{
      ...reordered.data[0],
      update: { timestamp: 1_725_000_000, status: "READ" },
    }],
  };

  const firstKey = await evolutionWebhookEventKey(first);
  const reorderedKey = await evolutionWebhookEventKey(reordered);
  const readKey = await evolutionWebhookEventKey(read);

  assertEquals(firstKey, reorderedKey, "ordem de campos irrelevante");
  assertEquals(firstKey === readKey, false, "status integra a identidade");
});

Deno.test("persiste somente o contrato canônico da mensagem", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const parsed = parseEvolutionMessage({
    key: {
      id: "wamid-2",
      remoteJid: "5511666666666@s.whatsapp.net",
      fromMe: false,
    },
    message: { extendedTextMessage: { text: "Preciso de ajuda" } },
  });
  if (!parsed) throw new Error("mensagem deveria ser válida");

  await storeEvolutionInboxMessage(
    client,
    "tenant-a",
    "escola-central",
    parsed,
    "webhook",
  );

  const call = calls[0];
  if (!call) throw new Error("RPC deveria ter sido chamada");
  assertEquals(call.name, "store_whatsapp_provider_message", "RPC");
  assertEquals(call.args.p_tenant_id, "tenant-a", "tenant");
  assertEquals(call.args.p_instance_name, "escola-central", "instância");
  assertEquals(call.args.p_provider_message_id, "wamid-2", "provider id");
  assertEquals(call.args.p_body, "Preciso de ajuda", "conteúdo");
  assertEquals(call.args.p_metadata, {
    source: "webhook",
    fromMe: false,
  }, "metadados mínimos");
});

Deno.test("recibo outbound reconcilia automações pelo id do provedor", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const parsed = parseEvolutionMessage({
    keyId: "wamid-delivery-1",
    remoteJid: "5511666666666@s.whatsapp.net",
    fromMe: true,
    status: "DELIVERY_ACK",
    timestamp: 1_725_000_000,
  });
  if (!parsed) throw new Error("recibo deveria ser válido");

  const result = await storeEvolutionInboxMessage(
    client,
    "tenant-a",
    "escola-central",
    parsed,
    "sync",
  );

  assertEquals(result.error, null, "recibo persistido");
  assertEquals(
    calls.map((call) => call.name),
    [
      "store_whatsapp_provider_message",
      "reconcile_whatsapp_provider_delivery",
    ],
    "ordem de persistência e reconciliação",
  );
  assertEquals(
    calls[1]?.args,
    {
      p_tenant_id: "tenant-a",
      p_instance_name: "escola-central",
      p_provider_message_id: "wamid-delivery-1",
      p_provider_status: "delivered",
      p_occurred_at: parsed.occurredAt,
    },
    "contrato do recibo",
  );
});
