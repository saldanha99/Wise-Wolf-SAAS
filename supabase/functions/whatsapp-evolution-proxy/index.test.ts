import { handleRequest } from "./index.ts";

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
  role: "SUPER_ADMIN" | "SCHOOL_ADMIN" | "TEACHER",
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
              data: { id: "instance-row-a", user_id: userId },
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
              data: { id: "instance-row-a", user_id: userId },
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
    ["SUPER_ADMIN", "SCHOOL_ADMIN", "TEACHER"],
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
