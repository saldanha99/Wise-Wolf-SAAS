import {
  authenticateWhatsAppInboundBoundRequest,
  deriveWhatsAppInboundInstanceTokenV3,
} from "../_shared/whatsapp-inbox.ts";
import type {
  ResolvedEvolutionIntegration,
  TenantIntegrationRpcClient,
} from "../_shared/tenant-integration-broker.ts";
import {
  EVOLUTION_INBOX_WEBHOOK_EVENTS,
  parseReconcileWhatsAppWebhookOptions,
  type ReconcileWhatsAppWebhookInstance,
  reconcileWhatsAppWebhooks,
} from "./core.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

const rootToken = "whatsapp-inbound-root-token-for-tests";
const getEnv = (name: string) =>
  ({
    WHATSAPP_INBOUND_TOKEN: rootToken,
    WHATSAPP_INBOUND_PUBLIC_URL:
      "https://api.wisewolflanguage.com.br/functions/v1/whatsapp-inbound",
  })[name];

function integrationId(suffix: string): string {
  const value = [...suffix].reduce(
    (accumulator, character) =>
      (accumulator * 131n + BigInt(character.charCodeAt(0))) % 0xffffffffffffn,
    1n,
  );
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function integration(
  tenantId: string,
  suffix: string,
): ResolvedEvolutionIntegration {
  return {
    integrationId: integrationId(suffix),
    tenantId,
    provider: "evolution",
    mode: "TENANT_BYOK",
    version: 1,
    baseUrl: `https://evolution-${suffix}.invalid`,
    apiKey: `api-key-${suffix}-ultrassecreta`,
  };
}

function boundInstance(
  tenantId: string,
  instanceName: string,
  suffix: string,
  webhookAuthVersion: 1 | 2 | 3 = 1,
): ReconcileWhatsAppWebhookInstance {
  return {
    tenantId,
    instanceName,
    webhookAuthVersion,
    integrationId: integrationId(suffix),
    integrationVersion: 1,
  };
}

Deno.test("opções priorizam legado e all habilita reconciliação idempotente", () => {
  assertEquals(
    parseReconcileWhatsAppWebhookOptions({}),
    { ok: true, value: { includeAll: false, limit: 25 } },
    "padrão legado",
  );
  assertEquals(
    parseReconcileWhatsAppWebhookOptions({ all: true, limit: 100 }),
    { ok: true, value: { includeAll: true, limit: 100 } },
    "modo all",
  );
  assertEquals(
    parseReconcileWhatsAppWebhookOptions({ all: true, limit: 101 }),
    { ok: false, code: "INVALID_REQUEST" },
    "limite máximo",
  );
});

Deno.test("núcleo mantém limite defensivo de cem instâncias", async () => {
  let receivedLimit = 0;
  const admin: TenantIntegrationRpcClient = {
    rpc() {
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const result = await reconcileWhatsAppWebhooks(
    { includeAll: true, limit: 1_000 },
    {
      admin,
      getEnv,
      loadInstances: (options) => {
        receivedLimit = options.limit;
        return Promise.resolve([]);
      },
    },
  );

  assertEquals(receivedLimit, 100, "limite entregue à consulta");
  assertEquals(result.selected, 0, "nenhuma instância retornada");
});

Deno.test("isola credenciais e token derivado entre tenants A e B", async () => {
  const instances: ReconcileWhatsAppWebhookInstance[] = [
    boundInstance("tenant-a", "instance-a", "a"),
    boundInstance("tenant-b", "instance-b", "b", 2),
  ];
  const upstream: Array<{
    url: string;
    apiKey: string;
    contentType: string;
    token: string;
    webhookUrl: string;
    enabled: boolean;
    byEvents: boolean;
    base64: boolean;
    events: unknown;
  }> = [];
  const markers: Array<Record<string, unknown>> = [];
  const purposes: Array<{ tenantId: string; purpose: string }> = [];
  const admin: TenantIntegrationRpcClient = {
    rpc(functionName, args) {
      assertEquals(
        functionName,
        "set_whatsapp_webhook_auth_version",
        "RPC do marker",
      );
      markers.push(args);
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };

  const result = await reconcileWhatsAppWebhooks(
    { includeAll: true, limit: 10 },
    {
      admin,
      getEnv,
      loadInstances: (options) => {
        assertEquals(options.includeAll, true, "all chega à seleção");
        return Promise.resolve(instances);
      },
      resolveIntegration: (_admin, tenantId, purpose) => {
        purposes.push({ tenantId, purpose });
        return Promise.resolve(
          tenantId === "tenant-a"
            ? integration(tenantId, "a")
            : integration(tenantId, "b"),
        );
      },
      fetchUpstream: (input, init) => {
        const body = JSON.parse(String(init?.body));
        upstream.push({
          url: String(input),
          apiKey: String((init?.headers as Record<string, string>).apikey),
          contentType: String(
            (init?.headers as Record<string, string>)["Content-Type"],
          ),
          token: String(body.webhook.headers["x-whatsapp-inbound-token"]),
          webhookUrl: String(body.webhook.url),
          enabled: body.webhook.enabled === true,
          byEvents: body.webhook.byEvents === true,
          base64: body.webhook.base64 === true,
          events: body.webhook.events,
        });
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    },
  );

  const expectedA = await deriveWhatsAppInboundInstanceTokenV3(
    rootToken,
    "tenant-a",
    "instance-a",
    integrationId("a"),
    1,
  );
  const expectedB = await deriveWhatsAppInboundInstanceTokenV3(
    rootToken,
    "tenant-b",
    "instance-b",
    integrationId("b"),
    1,
  );
  upstream.sort((left, right) => left.url.localeCompare(right.url));
  markers.sort((left, right) =>
    String(left.p_tenant_id).localeCompare(String(right.p_tenant_id))
  );
  purposes.sort((left, right) => left.tenantId.localeCompare(right.tenantId));

  assertEquals(result.configured, 2, "duas configurações");
  assertEquals(result.failed, 0, "sem falhas");
  assertEquals(purposes, [
    { tenantId: "tenant-a", purpose: "webhook.configure" },
    { tenantId: "tenant-b", purpose: "webhook.configure" },
  ], "broker tenant-aware");
  assertEquals(
    upstream[0].url,
    "https://evolution-a.invalid/webhook/set/instance-a",
    "URL A",
  );
  assertEquals(upstream[0].apiKey, "api-key-a-ultrassecreta", "chave A");
  assertEquals(upstream[0].contentType, "application/json", "content type A");
  assertEquals(upstream[0].token, expectedA, "token A");
  assertEquals(
    upstream[1].url,
    "https://evolution-b.invalid/webhook/set/instance-b",
    "URL B",
  );
  assertEquals(upstream[1].apiKey, "api-key-b-ultrassecreta", "chave B");
  assertEquals(upstream[1].token, expectedB, "token B");
  assertEquals(
    upstream.map((request) => request.webhookUrl),
    [
      "https://api.wisewolflanguage.com.br/functions/v1/whatsapp-inbound",
      "https://api.wisewolflanguage.com.br/functions/v1/whatsapp-inbound",
    ],
    "mesma URL pública do inbox/enable",
  );
  assertEquals(
    upstream.map((request) => ({
      enabled: request.enabled,
      byEvents: request.byEvents,
      base64: request.base64,
    })),
    [
      { enabled: true, byEvents: false, base64: false },
      { enabled: true, byEvents: false, base64: false },
    ],
    "mesmas flags do inbox/enable",
  );
  assertEquals(expectedA === expectedB, false, "tokens isolados");
  assertEquals(
    expectedA === rootToken || expectedB === rootToken,
    false,
    "raiz não exposta",
  );
  assertEquals(upstream[0].events, EVOLUTION_INBOX_WEBHOOK_EVENTS, "eventos A");
  assertEquals(upstream[1].events, EVOLUTION_INBOX_WEBHOOK_EVENTS, "eventos B");
  assertEquals(markers, [
    {
      p_tenant_id: "tenant-a",
      p_instance_name: "instance-a",
      p_version: 3,
      p_integration_id: integrationId("a"),
      p_integration_version: 1,
    },
    {
      p_tenant_id: "tenant-b",
      p_instance_name: "instance-b",
      p_version: 3,
      p_integration_id: integrationId("b"),
      p_integration_version: 1,
    },
  ], "markers isolados");
});

Deno.test("marca versão 3 somente depois de resposta 2xx", async () => {
  const order: string[] = [];
  const admin: TenantIntegrationRpcClient = {
    rpc() {
      order.push("marker");
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const result = await reconcileWhatsAppWebhooks(
    { includeAll: false, limit: 1 },
    {
      admin,
      getEnv,
      loadInstances: () =>
        Promise.resolve([boundInstance("tenant-a", "instance-a", "a")]),
      resolveIntegration: () => Promise.resolve(integration("tenant-a", "a")),
      fetchUpstream: () => {
        order.push("upstream-2xx");
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    },
  );

  assertEquals(order, ["upstream-2xx", "marker"], "ordem segura");
  assertEquals(result.configured, 1, "configurada");
});

Deno.test("rollout padrão promove instância v2 para v3", async () => {
  let marker: Record<string, unknown> = {};
  const admin: TenantIntegrationRpcClient = {
    rpc(_functionName, args) {
      marker = args;
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const result = await reconcileWhatsAppWebhooks(
    { includeAll: false, limit: 1 },
    {
      admin,
      getEnv,
      loadInstances: (options) => {
        assertEquals(options.includeAll, false, "lote incremental");
        return Promise.resolve([
          boundInstance("tenant-a", "instance-a", "a", 2),
        ]);
      },
      resolveIntegration: () => Promise.resolve(integration("tenant-a", "a")),
      fetchUpstream: () => Promise.resolve(new Response(null, { status: 204 })),
    },
  );

  assertEquals(result.configured, 1, "v2 reconciliada");
  assertEquals(marker, {
    p_tenant_id: "tenant-a",
    p_instance_name: "instance-a",
    p_version: 3,
    p_integration_id: integrationId("a"),
    p_integration_version: 1,
  }, "promoção usa CAS do binding");
});

Deno.test("falha do provedor não marca webhook_auth_version 3", async () => {
  let markerCalled = false;
  const admin: TenantIntegrationRpcClient = {
    rpc() {
      markerCalled = true;
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const result = await reconcileWhatsAppWebhooks(
    { includeAll: false, limit: 1 },
    {
      admin,
      getEnv,
      loadInstances: () =>
        Promise.resolve([boundInstance("tenant-a", "instance-a", "a")]),
      resolveIntegration: () => Promise.resolve(integration("tenant-a", "a")),
      fetchUpstream: () => Promise.resolve(new Response("{}", { status: 503 })),
    },
  );

  assertEquals(markerCalled, false, "marker não chamado");
  assertEquals(result.configured, 0, "nenhuma configuração");
  assertEquals(result.failed, 1, "falha contabilizada");
  assertEquals(result.results[0].error, "UPSTREAM_REJECTED", "erro sanitizado");
  assertEquals(result.results[0].upstreamStatus, 503, "status do provedor");
});

Deno.test("resposta perdida após aceite preserva inbound v3 no marker antigo", async () => {
  const instance = boundInstance("tenant-a", "instance-a", "a", 2);
  let providerAccepted = false;
  let configuredToken = "";
  let markerCalled = false;
  const admin: TenantIntegrationRpcClient = {
    rpc() {
      markerCalled = true;
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const result = await reconcileWhatsAppWebhooks(
    { includeAll: false, limit: 1 },
    {
      admin,
      getEnv,
      loadInstances: () => Promise.resolve([instance]),
      resolveIntegration: () => Promise.resolve(integration("tenant-a", "a")),
      fetchUpstream: (_input, init) => {
        const body = JSON.parse(String(init?.body));
        configuredToken = String(
          body.webhook.headers["x-whatsapp-inbound-token"],
        );
        providerAccepted = true;
        return Promise.reject(new DOMException("response lost", "AbortError"));
      },
    },
  );

  assertEquals(providerAccepted, true, "provedor recebeu a configuração v3");
  assertEquals(markerCalled, false, "resposta perdida não promove marker");
  assertEquals(result.configured, 0, "configuração permanece inconclusiva");
  assertEquals(result.failed, 1, "falha é reconciliável");
  assertEquals(
    result.results[0].error,
    "UPSTREAM_UNAVAILABLE",
    "timeout sanitizado",
  );
  assertEquals(
    await authenticateWhatsAppInboundBoundRequest(
      new Headers({ "x-whatsapp-inbound-token": configuredToken }),
      new URL("https://api.example/functions/v1/whatsapp-inbound"),
      rootToken,
      instance.webhookAuthVersion,
      instance,
      () =>
        Promise.resolve({
          tenantId: instance.tenantId,
          integrationId: instance.integrationId,
          version: instance.integrationVersion,
        }),
    ),
    "instance-header",
    "header v3 continua válido até a reconciliação do marker",
  );
});

Deno.test("não configura instância criada em outra versão da integração", async () => {
  let upstreamCalled = false;
  const admin: TenantIntegrationRpcClient = {
    rpc() {
      throw new Error("marker não deveria ser chamado");
    },
  };
  const stale = boundInstance("tenant-a", "instance-a", "a");
  stale.integrationVersion = 7;
  const result = await reconcileWhatsAppWebhooks(
    { includeAll: false, limit: 1 },
    {
      admin,
      getEnv,
      loadInstances: () => Promise.resolve([stale]),
      resolveIntegration: () => Promise.resolve(integration("tenant-a", "a")),
      fetchUpstream: () => {
        upstreamCalled = true;
        return Promise.resolve(new Response("{}", { status: 200 }));
      },
    },
  );

  assertEquals(upstreamCalled, false, "nenhum POST com binding obsoleto");
  assertEquals(result.failed, 1, "falha fechada");
  assertEquals(
    result.results[0].error,
    "INTEGRATION_BINDING_STALE",
    "erro sanitizado",
  );
});

Deno.test("limita concorrência de reconciliação a três instâncias", async () => {
  const instances = Array.from({ length: 8 }, (_, index) =>
    boundInstance(
      `tenant-${index}`,
      `instance-${index}`,
      `tenant-${index}`,
    ));
  let active = 0;
  let maximumActive = 0;
  const admin: TenantIntegrationRpcClient = {
    rpc() {
      return Promise.resolve({ data: { ok: true }, error: null });
    },
  };
  const result = await reconcileWhatsAppWebhooks(
    { includeAll: true, limit: 100 },
    {
      admin,
      getEnv,
      loadInstances: () => Promise.resolve(instances),
      resolveIntegration: (_admin, tenantId) =>
        Promise.resolve(integration(tenantId, tenantId)),
      fetchUpstream: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return new Response("{}", { status: 200 });
      },
    },
  );

  assertEquals(maximumActive, 3, "concorrência máxima");
  assertEquals(result.configured, 8, "lote concluído");
});
