import { handleRequest } from "./index.ts";
import { deriveWhatsAppInboundInstanceTokenV3 } from "../_shared/whatsapp-inbox.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function authorizedContext(
  admin: unknown,
  role: "SUPER_ADMIN" | "SCHOOL_ADMIN" | "COORDINATOR" | "TEACHER",
  tenantId: string | null,
  userId = "00000000-0000-4000-8000-000000000001",
) {
  return {
    ok: true as const,
    context: {
      admin,
      isService: false,
      profile: { id: userId, role, tenant_id: tenantId },
      user: { id: userId },
      userId,
    },
  } as any;
}

type InboxAdminOptions = {
  userId?: string;
  inboxEnabled?: boolean;
  conversation?: { id: string; remoteJid: string } | null;
  managementGroupJid?: string | null;
  managementGroupActive?: boolean;
  ownerIsSchoolAdmin?: boolean;
  ownerLifecycleStatus?: string;
  rpc?: (
    functionName: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { code?: string } | null }>;
};

function inboxAdmin(options: InboxAdminOptions = {}) {
  const userId = options.userId || "00000000-0000-4000-8000-000000000001";
  return {
    from(table: string) {
      const filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        limit() {
          return builder;
        },
        async maybeSingle() {
          if (table === "tenants") {
            return {
              data: { id: "tenant-a", saas_status: "active" },
              error: null,
            };
          }
          if (table === "whatsapp_instances") {
            return {
              data: {
                id: "10000000-0000-4000-8000-000000000001",
                user_id: userId,
                inbox_enabled: options.inboxEnabled ?? true,
                integration_id: "00000000-0000-4000-8000-0000000000e1",
                integration_version: 1,
              },
              error: null,
            };
          }
          if (table === "whatsapp_conversations") {
            return {
              data: options.conversation
                ? {
                  id: options.conversation.id,
                  instance_id: "10000000-0000-4000-8000-000000000001",
                  remote_jid: options.conversation.remoteJid,
                }
                : null,
              error: null,
            };
          }
          if (table === "dre_report_settings") {
            return {
              data: options.managementGroupJid
                ? {
                  destino: options.managementGroupJid,
                  is_active: options.managementGroupActive ?? true,
                }
                : null,
              error: null,
            };
          }
          if (table === "tenant_memberships") {
            const role = filters.find((filter) => filter.column === "role")
              ?.value;
            return {
              data: options.ownerIsSchoolAdmin !== false &&
                  role === "SCHOOL_ADMIN"
                ? { user_id: userId }
                : null,
              error: null,
            };
          }
          if (table === "profiles") {
            return {
              data: (options.ownerLifecycleStatus || "active") === "active"
                ? { id: userId }
                : null,
              error: null,
            };
          }
          throw new Error(`Tabela inesperada: ${table}`);
        },
      };
      return builder;
    },
    async rpc(functionName: string, args: Record<string, unknown>) {
      if (options.rpc) return await options.rpc(functionName, args);
      throw new Error(`RPC inesperada: ${functionName}`);
    },
  };
}

function request(body: Record<string, unknown>): Request {
  return new Request("http://localhost/whatsapp-evolution-proxy", {
    method: "POST",
    headers: {
      authorization: "Bearer jwt-de-teste",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function superAdminScopeAdmin(
  contextTenantId: string | null,
  membershipActive: boolean,
  queries: Array<{
    table: string;
    filters: Array<{ column: string; value: unknown }>;
  }> = [],
) {
  return {
    from(table: string) {
      const filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        async maybeSingle() {
          queries.push({ table, filters: [...filters] });
          if (table === "tenant_user_contexts") {
            return {
              data: contextTenantId ? { tenant_id: contextTenantId } : null,
              error: null,
            };
          }
          if (table === "tenant_memberships") {
            return {
              data: membershipActive && contextTenantId
                ? { tenant_id: contextTenantId }
                : null,
              error: null,
            };
          }
          throw new Error(`Tabela inesperada: ${table}`);
        },
      };
      return builder;
    },
  };
}

Deno.test("rejeita requisição sem bearer antes de ler segredos", async () => {
  let authorizationCalled = false;
  let upstreamCalled = false;
  const response = await handleRequest(
    new Request("http://localhost/whatsapp-evolution-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "instance/connectionState",
        tenantId: "tenant-a",
        instanceName: "instance-abc",
      }),
    }),
    {
      getEnv: () => {
        throw new Error("Segredos não devem ser lidos sem autenticação");
      },
      authorize: async () => {
        authorizationCalled = true;
        throw new Error("Autorizador não deve ser chamado sem bearer");
      },
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada sem autenticação");
      },
    },
  );

  const body = await response.json();
  assertEquals(response.status, 401, "status sem token");
  assertEquals(body.code, "UNAUTHENTICATED", "código sem token");
  assertEquals(authorizationCalled, false, "chamada ao autorizador");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("interrompe acesso quando a associação ativa foi recusada", async () => {
  let upstreamCalled = false;
  const response = await handleRequest(
    request({
      action: "message/sendText",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { number: "5511999999999", text: "Teste" },
    }),
    {
      getEnv: () => {
        throw new Error("Segredos não devem ser lidos após recusa");
      },
      authorize: async () => ({
        ok: false,
        response: new Response(
          JSON.stringify({
            error: "Tenant membership is not active",
          }),
          { status: 403 },
        ),
      }),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada por membro suspenso");
      },
    },
  );

  assertEquals(response.status, 403, "status da associação suspensa");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("professor não pode criar, conectar, sair ou excluir instância", async () => {
  const managementActions = [
    "instance/create",
    "instance/connect",
    "instance/logout",
    "instance/delete",
  ];

  for (const action of managementActions) {
    let upstreamCalled = false;
    const response = await handleRequest(
      request({ action, tenantId: "tenant-a", instanceName: "instance-abc" }),
      {
        getEnv: () => {
          throw new Error("Segredos não devem ser lidos para ação proibida");
        },
        authorize: async () => authorizedContext({}, "TEACHER", "tenant-a"),
        fetchUpstream: async () => {
          upstreamCalled = true;
          throw new Error("Evolution não deve receber gestão do professor");
        },
      },
    );
    const body = await response.json();

    assertEquals(response.status, 403, `status de ${action}`);
    assertEquals(
      body.code,
      "INSTANCE_MANAGEMENT_FORBIDDEN",
      `código de ${action}`,
    );
    assertEquals(upstreamCalled, false, `chamada externa de ${action}`);
  }
});

Deno.test("superadmin não pode escolher tenant pelo body", async () => {
  const queries: Array<{
    table: string;
    filters: Array<{ column: string; value: unknown }>;
  }> = [];
  const userId = "00000000-0000-4000-8000-000000000010";
  const admin = superAdminScopeAdmin("tenant-a", true, queries);
  let upstreamCalled = false;

  const response = await handleRequest(
    request({
      action: "instance/connectionState",
      tenantId: "tenant-b",
      instanceName: "instance-abc",
    }),
    {
      getEnv: () => {
        throw new Error("Segredos não devem ser lidos para tenant divergente");
      },
      authorize: async () =>
        authorizedContext(admin, "SUPER_ADMIN", null, userId),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve usar tenant escolhido no body");
      },
    },
  );

  const body = await response.json();
  assertEquals(response.status, 403, "status do tenant injetado");
  assertEquals(body.code, "TENANT_FORBIDDEN", "código do tenant injetado");
  assertEquals(
    queries,
    [
      {
        table: "tenant_user_contexts",
        filters: [{ column: "user_id", value: userId }],
      },
      {
        table: "tenant_memberships",
        filters: [
          { column: "user_id", value: userId },
          { column: "tenant_id", value: "tenant-a" },
          { column: "status", value: "ACTIVE" },
        ],
      },
    ],
    "derivação server-side do tenant",
  );
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("superadmin exige contexto selecionado e associação ativa", async () => {
  const cases = [
    {
      contextTenantId: null,
      membershipActive: false,
      code: "TENANT_CONTEXT_REQUIRED",
    },
    {
      contextTenantId: "tenant-a",
      membershipActive: false,
      code: "TENANT_MEMBERSHIP_INACTIVE",
    },
  ];

  for (const testCase of cases) {
    const admin = superAdminScopeAdmin(
      testCase.contextTenantId,
      testCase.membershipActive,
    );
    const response = await handleRequest(
      request({
        action: "instance/connectionState",
        instanceName: "instance-abc",
      }),
      {
        getEnv: () => {
          throw new Error("Segredos não devem ser lidos sem escopo ativo");
        },
        authorize: async () => authorizedContext(admin, "SUPER_ADMIN", null),
        fetchUpstream: async () => {
          throw new Error("Evolution não deve ser chamada sem escopo ativo");
        },
      },
    );
    const body = await response.json();

    assertEquals(response.status, 403, `status de ${testCase.code}`);
    assertEquals(body.code, testCase.code, `código de ${testCase.code}`);
  }
});

Deno.test("rejeita tenant divergente antes de consultar dados", async () => {
  let databaseCalled = false;
  let upstreamCalled = false;
  const admin = {
    from() {
      databaseCalled = true;
      throw new Error("Banco não deve ser consultado para outro tenant");
    },
  };

  const response = await handleRequest(
    request({
      action: "instance/connectionState",
      tenantId: "tenant-b",
      instanceName: "instance-abc",
    }),
    {
      getEnv: () => {
        throw new Error("Segredos não devem ser lidos para outro tenant");
      },
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada por outro tenant");
      },
    },
  );

  const body = await response.json();
  assertEquals(response.status, 403, "status para tenant divergente");
  assertEquals(body.code, "TENANT_FORBIDDEN", "código para tenant divergente");
  assertEquals(databaseCalled, false, "consulta ao banco");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("bloqueia escola com assinatura inativa", async () => {
  let secretsRead = false;
  let upstreamCalled = false;
  const admin = {
    from(table: string) {
      if (table !== "tenants") {
        throw new Error(`Tabela inesperada: ${table}`);
      }
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        async maybeSingle() {
          return {
            data: { id: "tenant-a", saas_status: "blocked" },
            error: null,
          };
        },
      };
      return builder;
    },
  };

  const response = await handleRequest(
    request({
      action: "instance/connectionState",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
    }),
    {
      getEnv: () => {
        secretsRead = true;
        return "segredo";
      },
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada para escola bloqueada");
      },
    },
  );

  const body = await response.json();
  assertEquals(response.status, 403, "status da escola inativa");
  assertEquals(body.code, "TENANT_INACTIVE", "código da escola inativa");
  assertEquals(secretsRead, false, "leitura de segredos");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("falha do broker é sanitizada e não alcança a Evolution", async () => {
  const userId = "00000000-0000-4000-8000-000000000019";
  let upstreamCalled = false;
  const admin = {
    from(table: string) {
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        limit() {
          return builder;
        },
        async maybeSingle() {
          if (table === "tenants") {
            return {
              data: { id: "tenant-a", saas_status: "active" },
              error: null,
            };
          }
          if (table === "whatsapp_instances") {
            return {
              data: {
                id: "instance-row-a",
                user_id: userId,
                integration_id: "00000000-0000-4000-8000-0000000000e1",
                integration_version: 1,
              },
              error: null,
            };
          }
          throw new Error(`Tabela inesperada: ${table}`);
        },
      };
      return builder;
    },
  };

  const response = await handleRequest(
    request({
      action: "message/sendText",
      instanceName: "instance-abc",
      payload: { number: "5511999999999", text: "Teste" },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "TEACHER", "tenant-a", userId),
      resolveIntegration: async () => {
        throw new Error("segredo-que-nao-pode-vazar");
      },
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada");
      },
    },
  );
  const responseText = await response.text();

  assertEquals(response.status, 503, "status de falha do broker");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
  assertEquals(
    responseText.includes("segredo-que-nao-pode-vazar"),
    false,
    "segredo na resposta",
  );
});

Deno.test("professor envia somente pela instância canônica do próprio tenant", async () => {
  const userId = "00000000-0000-4000-8000-000000000009";
  const queries: Array<{
    table: string;
    filters: Array<{ column: string; value: unknown }>;
  }> = [];
  let authorizationRoles: readonly string[] = [];
  let upstreamUrl = "";
  let upstreamRedirect = "";
  let brokerScope: Record<string, unknown> = {};

  const admin = {
    from(table: string) {
      const filters: Array<{ column: string; value: unknown }> = [];
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        limit() {
          return builder;
        },
        async maybeSingle() {
          queries.push({ table, filters: [...filters] });
          if (table === "tenants") {
            return {
              data: { id: "tenant-a", saas_status: "ACTIVE" },
              error: null,
            };
          }
          if (table === "whatsapp_instances") {
            return {
              data: {
                id: "instance-row-a",
                user_id: userId,
                integration_id: "00000000-0000-4000-8000-0000000000e1",
                integration_version: 1,
              },
              error: null,
            };
          }
          throw new Error(`Tabela legada consultada: ${table}`);
        },
      };
      return builder;
    },
  };

  const response = await handleRequest(
    request({
      action: "message/sendText",
      instanceName: "instance-abc",
      payload: { number: "5511999999999", text: "Mensagem isolada" },
    }),
    {
      authorize: async (_req, options) => {
        authorizationRoles = options.allowedRoles;
        return authorizedContext(admin, "TEACHER", "tenant-a", userId);
      },
      resolveIntegration: async (_admin, tenantId, purpose) => {
        brokerScope = { tenantId, purpose };
        return {
          integrationId: "00000000-0000-4000-8000-0000000000e1",
          tenantId,
          provider: "evolution",
          mode: "PLATFORM_MANAGED",
          version: 1,
          baseUrl: "https://evolution.invalid",
          apiKey: "segredo-de-teste",
        };
      },
      fetchUpstream: async (input, init) => {
        upstreamUrl = String(input);
        upstreamRedirect = String(init?.redirect || "");
        return new Response(JSON.stringify({ key: { id: "message-1" } }), {
          status: 200,
        });
      },
    },
  );

  const body = await response.json();
  const ownershipQuery = queries.find((query) =>
    query.table === "whatsapp_instances"
  );

  assertEquals(response.status, 200, "status do envio isolado");
  assertEquals(body.messageId, "message-1", "id da mensagem");
  assertEquals(
    authorizationRoles,
    ["SUPER_ADMIN", "SCHOOL_ADMIN", "COORDINATOR", "TEACHER"],
    "papéis passados ao autorizador central",
  );
  assertEquals(
    ownershipQuery?.filters,
    [
      { column: "tenant_id", value: "tenant-a" },
      { column: "instance_name", value: "instance-abc" },
      { column: "user_id", value: userId },
    ],
    "filtros de posse canônica",
  );
  assertEquals(
    upstreamUrl,
    "https://evolution.invalid/message/sendText/instance-abc",
    "rota upstream",
  );
  assertEquals(upstreamRedirect, "error", "redirecionamento upstream");
  assertEquals(
    brokerScope,
    { tenantId: "tenant-a", purpose: "message.send_text" },
    "broker deve receber apenas o tenant canônico e a finalidade",
  );
});

Deno.test("bloqueia envio quando a integração mudou após criar a instância", async () => {
  let upstreamCalled = false;
  const admin = inboxAdmin();
  const response = await handleRequest(
    request({
      action: "message/sendText",
      instanceName: "instance-abc",
      payload: { number: "5511999999999", text: "Não pode cruzar contas" },
    }),
    {
      authorize: async () => authorizedContext(admin, "TEACHER", "tenant-a"),
      resolveIntegration: async (_admin, tenantId) => ({
        integrationId: "00000000-0000-4000-8000-0000000000e1",
        tenantId,
        provider: "evolution",
        mode: "TENANT_BYOK",
        version: 2,
        baseUrl: "https://outra-conta.invalid",
        apiKey: "outra-chave-de-teste",
      }),
      fetchUpstream: async () => {
        upstreamCalled = true;
        return new Response("{}", { status: 200 });
      },
    },
  );
  const body = await response.json();

  assertEquals(response.status, 409, "binding obsoleto falha fechado");
  assertEquals(body.code, "INTEGRATION_BINDING_STALE", "código do binding");
  assertEquals(upstreamCalled, false, "nenhum POST para a conta nova");
});

Deno.test("recriação reseta autenticação do webhook para reconciliação v3", async () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  let persisted: Record<string, unknown> = {};
  const admin = {
    from(table: string) {
      const builder: any = {
        error: null,
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        limit() {
          return builder;
        },
        update(value: Record<string, unknown>) {
          persisted = value;
          return builder;
        },
        async maybeSingle() {
          if (table === "tenants") {
            return {
              data: { id: "tenant-a", saas_status: "active" },
              error: null,
            };
          }
          if (table === "tenant_memberships") {
            return {
              data: { user_id: userId, role: "SCHOOL_ADMIN" },
              error: null,
            };
          }
          if (table === "whatsapp_instances") {
            return {
              data: {
                id: "10000000-0000-4000-8000-000000000001",
                instance_name: "instance-abc",
              },
              error: null,
            };
          }
          throw new Error(`Tabela inesperada: ${table}`);
        },
      };
      return builder;
    },
  };

  const response = await handleRequest(
    request({
      action: "instance/create",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { recreate: true },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a", userId),
      resolveIntegration: async (_admin, tenantId) => ({
        integrationId: "00000000-0000-4000-8000-0000000000e1",
        tenantId,
        provider: "evolution",
        mode: "TENANT_BYOK",
        version: 2,
        baseUrl: "https://evolution.invalid",
        apiKey: "chave-ultrassecreta",
      }),
      fetchUpstream: async () =>
        new Response(JSON.stringify({
          instance: { instanceId: "provider-instance", status: "created" },
        })),
    },
  );

  assertEquals(response.status, 200, "recriação aceita");
  assertEquals(
    persisted.integration_id,
    "00000000-0000-4000-8000-0000000000e1",
    "binding ID",
  );
  assertEquals(persisted.integration_version, 2, "binding version");
  assertEquals(
    persisted.webhook_auth_version,
    1,
    "cron precisa reconfigurar o webhook novo",
  );
});

Deno.test("professor não pode executar nenhuma ação da inbox", async () => {
  for (
    const action of [
      "inbox/enable",
      "inbox/sync",
      "inbox/sendText",
      "inbox/markRead",
      "inbox/setHandoff",
    ]
  ) {
    let databaseCalled = false;
    let upstreamCalled = false;
    const response = await handleRequest(
      request({
        action,
        tenantId: "tenant-a",
        instanceName: "instance-abc",
      }),
      {
        authorize: async () =>
          authorizedContext(
            {
              from() {
                databaseCalled = true;
                throw new Error("Banco não deve ser consultado");
              },
            },
            "TEACHER",
            "tenant-a",
          ),
        fetchUpstream: async () => {
          upstreamCalled = true;
          throw new Error("Evolution não deve ser chamada");
        },
      },
    );
    const body = await response.json();

    assertEquals(response.status, 403, `status de ${action}`);
    assertEquals(body.code, "INBOX_FORBIDDEN", `código de ${action}`);
    assertEquals(databaseCalled, false, `banco em ${action}`);
    assertEquals(upstreamCalled, false, `provedor em ${action}`);
  }
});

Deno.test("ações operacionais exigem opt-in da inbox", async () => {
  for (
    const action of [
      "inbox/sync",
      "inbox/sendText",
      "inbox/markRead",
      "inbox/setHandoff",
    ]
  ) {
    let rpcCalled = false;
    let upstreamCalled = false;
    const admin = inboxAdmin({
      inboxEnabled: false,
      rpc: async () => {
        rpcCalled = true;
        throw new Error("RPC operacional não deve executar sem opt-in");
      },
    });
    const response = await handleRequest(
      request({
        action,
        tenantId: "tenant-a",
        instanceName: "instance-abc",
        payload: {},
      }),
      {
        authorize: async () =>
          authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
        fetchUpstream: async () => {
          upstreamCalled = true;
          throw new Error("Evolution não deve ser chamada sem opt-in");
        },
      },
    );
    const body = await response.json();

    assertEquals(response.status, 409, `status de ${action}`);
    assertEquals(body.code, "INBOX_DISABLED", `código de ${action}`);
    assertEquals(rpcCalled, false, `RPC de ${action}`);
    assertEquals(upstreamCalled, false, `provedor de ${action}`);
  }
});

Deno.test("bloqueia sync e envio quando responsável perde vínculo institucional", async () => {
  const cases = [
    {
      action: "inbox/sync",
      options: { ownerLifecycleStatus: "offboarded" },
      payload: {},
      code: "INBOX_REQUIRES_ACTIVE_SCHOOL_ADMIN",
    },
    {
      action: "inbox/sendText",
      options: { ownerIsSchoolAdmin: false },
      payload: {
        conversationId: "20000000-0000-4000-8000-000000000002",
        clientRequestId: "40000000-0000-4000-8000-000000000004",
        text: "Não enviar",
      },
      code: "INBOX_REQUIRES_SCHOOL_ADMIN_INSTANCE",
    },
  ] as const;

  for (const testCase of cases) {
    let rpcCalled = false;
    let brokerCalled = false;
    let upstreamCalled = false;
    const admin = inboxAdmin({
      ...testCase.options,
      rpc: async () => {
        rpcCalled = true;
        throw new Error("RPC não deve executar sem owner institucional ativo");
      },
    });
    const response = await handleRequest(
      request({
        action: testCase.action,
        tenantId: "tenant-a",
        instanceName: "instance-abc",
        payload: testCase.payload,
      }),
      {
        authorize: async () =>
          authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
        resolveIntegration: async () => {
          brokerCalled = true;
          throw new Error("Broker não deve ser chamado");
        },
        fetchUpstream: async () => {
          upstreamCalled = true;
          throw new Error("Evolution não deve ser chamada");
        },
      },
    );
    const body = await response.json();

    assertEquals(response.status, 403, `status de ${testCase.action}`);
    assertEquals(body.code, testCase.code, `código de ${testCase.action}`);
    assertEquals(rpcCalled, false, `RPC de ${testCase.action}`);
    assertEquals(brokerCalled, false, `broker de ${testCase.action}`);
    assertEquals(upstreamCalled, false, `provedor de ${testCase.action}`);
  }
});

Deno.test("gestor multi-escola usa contexto e associação, não tenant legado do perfil", async () => {
  const callerId = "00000000-0000-4000-8000-000000000010";
  const ownerId = "00000000-0000-4000-8000-000000000020";
  const instanceId = "10000000-0000-4000-8000-000000000001";
  const conversationId = "20000000-0000-4000-8000-000000000002";
  const activeTenantId = "tenant-b";
  const legacyProfile = {
    id: ownerId,
    tenant_id: "tenant-a",
    lifecycle_status: "active",
  };
  const queries: Array<{
    table: string;
    filters: Array<{ column: string; value: unknown }>;
  }> = [];
  const markReadCalls: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      const filters: Array<{ column: string; value: unknown }> = [];
      const filterValue = (column: string) =>
        filters.find((filter) => filter.column === column)?.value;
      const builder = {
        select() {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push({ column, value });
          return builder;
        },
        limit() {
          return builder;
        },
        async maybeSingle() {
          queries.push({ table, filters: [...filters] });
          if (table === "tenant_user_contexts") {
            return {
              data: filterValue("user_id") === callerId
                ? { tenant_id: activeTenantId }
                : null,
              error: null,
            };
          }
          if (table === "tenant_memberships") {
            const inActiveTenant = filterValue("tenant_id") === activeTenantId;
            const active = filterValue("status") === "ACTIVE";
            if (
              inActiveTenant && active &&
              filterValue("user_id") === callerId &&
              filterValue("role") === undefined
            ) {
              return { data: { tenant_id: activeTenantId }, error: null };
            }
            if (
              inActiveTenant && active &&
              filterValue("user_id") === ownerId &&
              filterValue("role") === "SCHOOL_ADMIN"
            ) {
              return { data: { user_id: ownerId }, error: null };
            }
            return { data: null, error: null };
          }
          if (table === "tenants") {
            return {
              data: filterValue("id") === activeTenantId
                ? { id: activeTenantId, saas_status: "active" }
                : null,
              error: null,
            };
          }
          if (table === "whatsapp_instances") {
            return {
              data: filterValue("tenant_id") === activeTenantId
                ? {
                  id: instanceId,
                  user_id: ownerId,
                  inbox_enabled: true,
                  integration_id: "00000000-0000-4000-8000-0000000000e1",
                  integration_version: 1,
                }
                : null,
              error: null,
            };
          }
          if (table === "profiles") {
            const row = legacyProfile as Record<string, unknown>;
            const matches = filters.every(({ column, value }) =>
              row[column] === value
            );
            return {
              data: matches ? { id: legacyProfile.id } : null,
              error: null,
            };
          }
          if (table === "whatsapp_conversations") {
            const matches = filterValue("tenant_id") === activeTenantId &&
              filterValue("instance_id") === instanceId &&
              filterValue("id") === conversationId;
            return {
              data: matches
                ? {
                  id: conversationId,
                  instance_id: instanceId,
                  remote_jid: "5511999999999@s.whatsapp.net",
                }
                : null,
              error: null,
            };
          }
          throw new Error(`Tabela inesperada: ${table}`);
        },
      };
      return builder;
    },
    rpc(functionName: string, args: Record<string, unknown>) {
      assertEquals(
        functionName,
        "mark_whatsapp_conversation_read",
        "RPC de leitura",
      );
      markReadCalls.push(args);
      return Promise.resolve({
        data: { ok: true, last_read_at: "2026-08-28T12:00:00.000Z" },
        error: null,
      });
    },
  };

  const response = await handleRequest(
    request({
      action: "inbox/markRead",
      tenantId: activeTenantId,
      instanceName: "instance-abc",
      payload: { conversationId },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "SUPER_ADMIN", "tenant-a", callerId),
    },
  );
  const body = await response.json();

  assertEquals(response.status, 200, "status multi-escola");
  assertEquals(body.ok, true, "operação permitida");
  assertEquals(
    markReadCalls[0]?.p_tenant_id,
    activeTenantId,
    "tenant canônico",
  );
  const profileQuery = queries.find((query) => query.table === "profiles");
  assertEquals(profileQuery?.filters, [
    { column: "id", value: ownerId },
    { column: "lifecycle_status", value: "active" },
  ], "perfil validado somente por identidade e ciclo de vida");
  assertEquals(
    queries.some((query) =>
      query.table === "tenant_user_contexts" &&
      query.filters.some((filter) =>
        filter.column === "user_id" && filter.value === callerId
      )
    ),
    true,
    "contexto ativo consultado",
  );
  assertEquals(
    queries.some((query) =>
      query.table === "whatsapp_instances" &&
      query.filters.some((filter) =>
        filter.column === "tenant_id" && filter.value === activeTenantId
      )
    ),
    true,
    "instância limitada ao tenant ativo",
  );
});

Deno.test("coordenador sincroniza contatos e somente o grupo de gestão", async () => {
  const managementGroupJid = "120363000000000001@g.us";
  let purposeSeen = "";
  let upstreamUrl = "";
  let upstreamPayload: unknown;
  let storedMessages: unknown[] = [];
  const admin = inboxAdmin({
    managementGroupJid,
    rpc: async (functionName, args) => {
      assertEquals(
        functionName,
        "store_whatsapp_provider_messages",
        "RPC de lote",
      );
      storedMessages = args.p_messages as unknown[];
      return { data: { ok: true, stored: storedMessages.length }, error: null };
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/sync",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: {},
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "COORDINATOR", "tenant-a"),
      resolveIntegration: async (_admin, tenantId, purpose) => {
        purposeSeen = purpose;
        return {
          integrationId: "00000000-0000-4000-8000-0000000000e1",
          tenantId,
          provider: "evolution",
          mode: "PLATFORM_MANAGED",
          version: 1,
          baseUrl: "https://evolution.invalid",
          apiKey: "api-key-secreta",
        };
      },
      fetchUpstream: async (input, init) => {
        upstreamUrl = String(input);
        upstreamPayload = JSON.parse(String(init?.body));
        const chat = (remoteJid: string, id: string, text: string) => ({
          remoteJid,
          name: `Contato ${id}`,
          lastMessage: {
            key: { id, remoteJid, fromMe: false },
            message: { conversation: text },
            messageTimestamp: 1_725_000_000,
          },
        });
        return new Response(JSON.stringify([
          chat("5511999999999@s.whatsapp.net", "direct-1", "Olá"),
          chat(managementGroupJid, "group-ok", "Gestão"),
          chat("120363000000000002@g.us", "group-other", "Privado"),
          chat("status@broadcast", "status-1", "Status"),
        ]));
      },
    },
  );
  const body = await response.json();
  const storedJids = storedMessages.map((message) =>
    (message as Record<string, unknown>).remoteJid
  );

  assertEquals(response.status, 200, "status da sincronização");
  assertEquals(purposeSeen, "chat.list", "finalidade no broker");
  assertEquals(
    upstreamUrl,
    "https://evolution.invalid/chat/findChats/instance-abc",
    "endpoint de chats",
  );
  assertEquals(upstreamPayload, { take: 100, skip: 0 }, "paginação inicial");
  assertEquals(
    storedJids,
    ["5511999999999@s.whatsapp.net", managementGroupJid],
    "filtro de privacidade",
  );
  assertEquals(body.mode, "chats", "modo da sincronização");
  assertEquals(body.received, 4, "chats recebidos");
  assertEquals(body.stored, 2, "mensagens gravadas");
  assertEquals(body.ignored, 2, "chats ignorados");
  assertEquals(
    JSON.stringify(body).includes("api-key-secreta"),
    false,
    "segredo na resposta",
  );
});

Deno.test("permite histórico somente do grupo de gestão atual validado", async () => {
  const conversationId = "20000000-0000-4000-8000-000000000002";
  const remoteJid = "120363000000000001@g.us";
  let upstreamPayload: unknown;
  let storedMessages: unknown[] = [];
  const admin = inboxAdmin({
    conversation: { id: conversationId, remoteJid },
    managementGroupJid: remoteJid,
    rpc: async (functionName, args) => {
      assertEquals(
        functionName,
        "store_whatsapp_provider_messages",
        "RPC de lote",
      );
      storedMessages = args.p_messages as unknown[];
      return { data: { ok: true, stored: storedMessages.length }, error: null };
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/sync",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { conversationId, page: 2 },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      resolveIntegration: async (_admin, tenantId, purpose) => {
        assertEquals(purpose, "chat.history", "finalidade do histórico");
        return {
          integrationId: "00000000-0000-4000-8000-0000000000e1",
          tenantId,
          provider: "evolution",
          mode: "PLATFORM_MANAGED",
          version: 1,
          baseUrl: "https://evolution.invalid",
          apiKey: "segredo",
        };
      },
      fetchUpstream: async (_input, init) => {
        upstreamPayload = JSON.parse(String(init?.body));
        const message = (jid: string, id: string) => ({
          key: { id, remoteJid: jid, fromMe: false },
          message: { conversation: id },
          messageTimestamp: 1_725_000_000,
        });
        return new Response(JSON.stringify({
          messages: {
            total: 2,
            pages: 1,
            currentPage: 2,
            records: [
              message(remoteJid, "history-ok"),
              message("5511777777777@s.whatsapp.net", "history-other"),
            ],
          },
        }));
      },
    },
  );
  const body = await response.json();

  assertEquals(response.status, 200, "status do histórico");
  assertEquals(upstreamPayload, {
    where: { key: { remoteJid } },
    page: 2,
    offset: 100,
  }, "filtro canônico do histórico");
  assertEquals(storedMessages.length, 1, "somente conversa validada");
  assertEquals(body.stored, 1, "histórico gravado");
  assertEquals(body.ignored, 1, "registro divergente ignorado");
});

Deno.test("bloqueia histórico de grupo antigo e envio para grupo desativado", async () => {
  const conversationId = "20000000-0000-4000-8000-000000000002";
  const clientRequestId = "40000000-0000-4000-8000-000000000004";
  const oldGroupJid = "120363000000000001@g.us";
  const currentGroupJid = "120363000000000002@g.us";
  const cases = [
    {
      label: "histórico do grupo antigo",
      action: "inbox/sync",
      payload: { conversationId, page: 1 },
      managementGroupJid: currentGroupJid,
      managementGroupActive: true,
    },
    {
      label: "envio ao grupo desativado",
      action: "inbox/sendText",
      payload: { conversationId, clientRequestId, text: "Não enviar" },
      managementGroupJid: oldGroupJid,
      managementGroupActive: false,
    },
  ] as const;

  for (const testCase of cases) {
    let rpcCalled = false;
    let brokerCalled = false;
    let upstreamCalled = false;
    const admin = inboxAdmin({
      conversation: { id: conversationId, remoteJid: oldGroupJid },
      managementGroupJid: testCase.managementGroupJid,
      managementGroupActive: testCase.managementGroupActive,
      rpc: async () => {
        rpcCalled = true;
        throw new Error("RPC não deve executar para grupo revogado");
      },
    });
    const response = await handleRequest(
      request({
        action: testCase.action,
        tenantId: "tenant-a",
        instanceName: "instance-abc",
        payload: testCase.payload,
      }),
      {
        authorize: async () =>
          authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
        resolveIntegration: async () => {
          brokerCalled = true;
          throw new Error("Broker não deve ser chamado para grupo revogado");
        },
        fetchUpstream: async () => {
          upstreamCalled = true;
          throw new Error("Evolution não deve receber grupo revogado");
        },
      },
    );
    const body = await response.json();

    assertEquals(response.status, 403, `status de ${testCase.label}`);
    assertEquals(
      body.code,
      "INBOX_GROUP_FORBIDDEN",
      `código de ${testCase.label}`,
    );
    assertEquals(rpcCalled, false, `RPC de ${testCase.label}`);
    assertEquals(brokerCalled, false, `broker de ${testCase.label}`);
    assertEquals(upstreamCalled, false, `provedor de ${testCase.label}`);
  }
});

Deno.test("desabilita inbox localmente sem substituir o webhook", async () => {
  let upstreamCalled = false;
  let rpcArgs: Record<string, unknown> = {};
  const admin = inboxAdmin({
    rpc: async (functionName, args) => {
      assertEquals(functionName, "enable_whatsapp_inbox", "RPC local");
      rpcArgs = args;
      return {
        data: {
          ok: true,
          instanceId: "10000000-0000-4000-8000-000000000001",
          instanceName: "instance-abc",
          inboxEnabled: false,
        },
        error: null,
      };
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/enable",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { enabled: false },
    }),
    {
      getEnv: () => {
        throw new Error("Desabilitar não deve ler segredo");
      },
      authorize: async () =>
        authorizedContext(admin, "COORDINATOR", "tenant-a"),
      resolveIntegration: async () => {
        throw new Error("Desabilitar não deve resolver integração");
      },
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Desabilitar não deve alterar webhook");
      },
    },
  );
  const body = await response.json();

  assertEquals(response.status, 200, "status ao desabilitar");
  assertEquals(body.inboxEnabled, false, "estado local");
  assertEquals(rpcArgs.p_enabled, false, "estado enviado à RPC");
  assertEquals(upstreamCalled, false, "webhook preservado");
});

Deno.test("habilita inbox institucional somente após configurar webhook seguro", async () => {
  const inboundToken = "token-inbound-ultrassecreto";
  const expectedInstanceToken = await deriveWhatsAppInboundInstanceTokenV3(
    inboundToken,
    "tenant-a",
    "instance-abc",
    "00000000-0000-4000-8000-0000000000e1",
    1,
  );
  let webhookRequest: Record<string, unknown> = {};
  let markerArgs: Record<string, unknown> = {};
  const callOrder: string[] = [];
  const admin = inboxAdmin({
    ownerIsSchoolAdmin: true,
    rpc: async (functionName, args) => {
      callOrder.push(functionName);
      if (functionName === "set_whatsapp_webhook_auth_version") {
        markerArgs = args;
      }
      return {
        data: {
          ok: true,
          instanceId: "10000000-0000-4000-8000-000000000001",
          instanceName: "instance-abc",
          inboxEnabled: true,
          inboxEnabledAt: "2026-08-28T12:00:00.000Z",
        },
        error: null,
      };
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/enable",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { enabled: true },
    }),
    {
      getEnv: (name) =>
        ({
          SUPABASE_URL: "http://kong:8000",
          WHATSAPP_INBOUND_PUBLIC_URL:
            "https://api.wisewolflanguage.com.br/functions/v1/whatsapp-inbound",
          WHATSAPP_INBOUND_TOKEN: inboundToken,
        })[name],
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      resolveIntegration: async (_admin, tenantId, purpose) => {
        assertEquals(purpose, "webhook.configure", "finalidade do webhook");
        return {
          integrationId: "00000000-0000-4000-8000-0000000000e1",
          tenantId,
          provider: "evolution",
          mode: "PLATFORM_MANAGED",
          version: 1,
          baseUrl: "https://evolution.invalid",
          apiKey: "api-key-ultrassecreta",
        };
      },
      fetchUpstream: async (input, init) => {
        callOrder.push("webhook.upstream");
        webhookRequest = {
          url: String(input),
          apikey: (init?.headers as Record<string, string>).apikey,
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify({ webhook: { enabled: true } }));
      },
    },
  );
  const responseText = await response.text();
  const webhookBody = webhookRequest.body as Record<string, unknown>;
  const webhook = webhookBody.webhook as Record<string, unknown>;

  assertEquals(response.status, 200, "status ao habilitar");
  assertEquals(
    callOrder,
    [
      "webhook.upstream",
      "set_whatsapp_webhook_auth_version",
      "enable_whatsapp_inbox",
    ],
    "ordem segura",
  );
  assertEquals(markerArgs, {
    p_tenant_id: "tenant-a",
    p_instance_name: "instance-abc",
    p_version: 3,
    p_integration_id: "00000000-0000-4000-8000-0000000000e1",
    p_integration_version: 1,
  }, "marker CAS inclui binding exato");
  assertEquals(
    webhookRequest.url,
    "https://evolution.invalid/webhook/set/instance-abc",
    "endpoint do webhook",
  );
  assertEquals(
    webhook.url,
    "https://api.wisewolflanguage.com.br/functions/v1/whatsapp-inbound",
    "URL do inbound",
  );
  assertEquals(webhook.byEvents, false, "webhook único");
  assertEquals(webhook.base64, false, "sem mídia em base64");
  assertEquals(
    (webhook.headers as Record<string, string>)[
      "x-whatsapp-inbound-token"
    ],
    expectedInstanceToken,
    "token isolado enviado no header configurado",
  );
  assertEquals(
    (webhook.headers as Record<string, string>)[
      "x-whatsapp-inbound-token"
    ] === inboundToken,
    false,
    "token raiz nunca é entregue ao tenant BYOK",
  );
  assertEquals(
    (webhook.events as unknown[]).includes("MESSAGES_UPSERT"),
    true,
    "evento de mensagem",
  );
  assertEquals(
    (webhook.events as unknown[]).includes("GROUP_UPDATE"),
    true,
    "evento de atualização de grupo",
  );
  assertEquals(
    (webhook.events as unknown[]).includes("GROUPS_UPDATE"),
    false,
    "não envia o nome inválido rejeitado pela Evolution v2.3.x",
  );
  assertEquals(
    (webhook.events as unknown[]).includes("SEND_MESSAGE_UPDATE"),
    false,
    "mantém o webhook compatível com Evolution v2.2+",
  );
  assertEquals(responseText.includes(inboundToken), false, "token na resposta");
  assertEquals(
    responseText.includes("api-key-ultrassecreta"),
    false,
    "apikey na resposta",
  );
});

Deno.test("não publica o endereço interno da VPS como webhook", async () => {
  const inboundToken = "token-inbound-ultrassecreto";
  let brokerCalled = false;
  let upstreamCalled = false;
  let rpcCalled = false;
  const admin = inboxAdmin({
    ownerIsSchoolAdmin: true,
    rpc: async () => {
      rpcCalled = true;
      throw new Error("Inbox não deve ser habilitada sem URL pública");
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/enable",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { enabled: true },
    }),
    {
      getEnv: (name) =>
        ({
          SUPABASE_URL: "http://api-gw:8000",
          WHATSAPP_INBOUND_TOKEN: inboundToken,
        })[name],
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      resolveIntegration: async () => {
        brokerCalled = true;
        throw new Error("Broker não deve ser chamado");
      },
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve receber URL interna");
      },
    },
  );
  const responseText = await response.text();
  const body = JSON.parse(responseText);

  assertEquals(response.status, 503, "status sem URL pública");
  assertEquals(body.code, "INBOX_WEBHOOK_UNAVAILABLE", "código seguro");
  assertEquals(brokerCalled, false, "broker não chamado");
  assertEquals(upstreamCalled, false, "webhook não configurado");
  assertEquals(rpcCalled, false, "inbox não habilitada");
  assertEquals(responseText.includes(inboundToken), false, "token não vazou");
  assertEquals(
    responseText.includes("api-gw"),
    false,
    "host interno não vazou",
  );
});

Deno.test("não habilita inbox para instância pessoal", async () => {
  let upstreamCalled = false;
  let rpcCalled = false;
  const admin = inboxAdmin({
    ownerIsSchoolAdmin: false,
    rpc: async () => {
      rpcCalled = true;
      throw new Error("RPC não deve habilitar instância pessoal");
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/enable",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { enabled: true },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Webhook não deve ser configurado");
      },
    },
  );
  const body = await response.json();

  assertEquals(response.status, 403, "status de instância pessoal");
  assertEquals(
    body.code,
    "INBOX_REQUIRES_SCHOOL_ADMIN_INSTANCE",
    "código de opt-in institucional",
  );
  assertEquals(upstreamCalled, false, "provedor não chamado");
  assertEquals(rpcCalled, false, "inbox não habilitada");
});

Deno.test("não configura webhook para responsável institucional suspenso", async () => {
  let upstreamCalled = false;
  let rpcCalled = false;
  const admin = inboxAdmin({
    ownerIsSchoolAdmin: true,
    ownerLifecycleStatus: "suspended",
    rpc: async () => {
      rpcCalled = true;
      throw new Error("RPC não deve habilitar responsável suspenso");
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/enable",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { enabled: true },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Webhook não deve ser configurado");
      },
    },
  );
  const body = await response.json();

  assertEquals(response.status, 403, "status de responsável suspenso");
  assertEquals(
    body.code,
    "INBOX_REQUIRES_ACTIVE_SCHOOL_ADMIN",
    "código de ciclo de vida",
  );
  assertEquals(upstreamCalled, false, "provedor não chamado");
  assertEquals(rpcCalled, false, "inbox não habilitada");
});

Deno.test("broker indisponível não cria mensagem queued", async () => {
  const conversationId = "20000000-0000-4000-8000-000000000002";
  const clientRequestId = "40000000-0000-4000-8000-000000000004";
  let rpcCalled = false;
  let upstreamCalled = false;
  const admin = inboxAdmin({
    conversation: {
      id: conversationId,
      remoteJid: "5511999999999@s.whatsapp.net",
    },
    rpc: async () => {
      rpcCalled = true;
      throw new Error("Outbox não deve ser criada sem integração");
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/sendText",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { conversationId, clientRequestId, text: "Olá" },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "COORDINATOR", "tenant-a"),
      resolveIntegration: async () => {
        throw new Error("segredo-do-broker");
      },
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada");
      },
    },
  );
  const responseText = await response.text();

  assertEquals(response.status, 503, "status de broker indisponível");
  assertEquals(rpcCalled, false, "nenhuma outbox queued");
  assertEquals(upstreamCalled, false, "sem dispatch");
  assertEquals(
    responseText.includes("segredo-do-broker"),
    false,
    "erro do broker sanitizado",
  );
});

Deno.test("repetição idempotente de envio não despacha na Evolution", async () => {
  const messageId = "30000000-0000-4000-8000-000000000003";
  const conversationId = "20000000-0000-4000-8000-000000000002";
  const clientRequestId = "40000000-0000-4000-8000-000000000004";
  const rpcCalls: string[] = [];
  let brokerCalled = false;
  let upstreamCalled = false;
  const admin = inboxAdmin({
    conversation: {
      id: conversationId,
      remoteJid: "5511999999999@s.whatsapp.net",
    },
    rpc: async (functionName) => {
      rpcCalls.push(functionName);
      return {
        data: { ok: true, duplicate: true, messageId, status: "sent" },
        error: null,
      };
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/sendText",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { conversationId, clientRequestId, text: "Olá" },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "COORDINATOR", "tenant-a"),
      resolveIntegration: async (_admin, tenantId) => {
        brokerCalled = true;
        return {
          integrationId: "00000000-0000-4000-8000-0000000000e1",
          tenantId,
          provider: "evolution",
          mode: "PLATFORM_MANAGED",
          version: 1,
          baseUrl: "https://evolution.invalid",
          apiKey: "segredo",
        };
      },
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Repetição não deve reenviar");
      },
    },
  );
  const body = await response.json();

  assertEquals(response.status, 200, "status idempotente");
  assertEquals(body.duplicate, true, "resposta idempotente");
  assertEquals(body.status, "sent", "status preservado");
  assertEquals(brokerCalled, true, "integração validada antes da outbox");
  assertEquals(rpcCalls, ["prepare_whatsapp_outbound"], "somente prepara");
  assertEquals(upstreamCalled, false, "sem reenvio");
});

Deno.test("falha de rede após dispatch finaliza envio como incerto sem retry", async () => {
  const messageId = "30000000-0000-4000-8000-000000000003";
  const conversationId = "20000000-0000-4000-8000-000000000002";
  const clientRequestId = "40000000-0000-4000-8000-000000000004";
  let dispatches = 0;
  let finalStatus = "";
  const admin = inboxAdmin({
    conversation: {
      id: conversationId,
      remoteJid: "5511999999999@s.whatsapp.net",
    },
    rpc: async (functionName, args) => {
      if (functionName === "prepare_whatsapp_outbound") {
        return {
          data: { ok: true, duplicate: false, messageId, status: "queued" },
          error: null,
        };
      }
      if (functionName === "claim_whatsapp_outbound") {
        return {
          data: {
            ok: true,
            claimed: true,
            messageId,
            conversationId,
            instanceName: "instance-abc",
            remoteJid: "5511999999999@s.whatsapp.net",
            body: "Texto canônico",
            status: "dispatching",
          },
          error: null,
        };
      }
      if (functionName === "finalize_whatsapp_outbound") {
        finalStatus = String(args.p_status);
        return {
          data: { ok: true, messageId, status: finalStatus },
          error: null,
        };
      }
      throw new Error(`RPC inesperada: ${functionName}`);
    },
  });
  const response = await handleRequest(
    request({
      action: "inbox/sendText",
      tenantId: "tenant-a",
      instanceName: "instance-abc",
      payload: { conversationId, clientRequestId, text: "Texto do cliente" },
    }),
    {
      authorize: async () =>
        authorizedContext(admin, "SCHOOL_ADMIN", "tenant-a"),
      resolveIntegration: async (_admin, tenantId) => ({
        integrationId: "00000000-0000-4000-8000-0000000000e1",
        tenantId,
        provider: "evolution",
        mode: "PLATFORM_MANAGED",
        version: 1,
        baseUrl: "https://evolution.invalid",
        apiKey: "segredo",
      }),
      fetchUpstream: async (_input, init) => {
        dispatches += 1;
        assertEquals(
          JSON.parse(String(init?.body)),
          {
            number: "5511999999999@s.whatsapp.net",
            text: "Texto canônico",
            linkPreview: true,
          },
          "payload canônico reservado",
        );
        throw new TypeError("network failed");
      },
    },
  );
  const body = await response.json();

  assertEquals(response.status, 202, "status de resultado incerto");
  assertEquals(body.status, "uncertain", "estado incerto");
  assertEquals(finalStatus, "uncertain", "finalização local");
  assertEquals(dispatches, 1, "sem retry automático");
});
