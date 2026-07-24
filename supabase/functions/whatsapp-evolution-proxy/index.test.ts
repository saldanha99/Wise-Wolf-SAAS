import { handleRequest } from "./index.ts";

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${message}: esperado ${String(expected)}, recebido ${String(actual)}`,
    );
  }
}

function mockAuthenticatedClient(profile: Record<string, unknown>) {
  const profileQuery = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    async single() {
      return { data: profile, error: null };
    },
  };

  return {
    auth: {
      async getUser() {
        return { data: { user: { id: profile.id } }, error: null };
      },
    },
    from(table: string) {
      if (table !== "profiles") {
        throw new Error(`Tabela inesperada no teste: ${table}`);
      }
      return profileQuery;
    },
  };
}

Deno.test("rejeita requisição sem bearer token antes de qualquer acesso externo", async () => {
  let clientCreated = false;
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
      createSupabaseClient: () => {
        clientCreated = true;
        throw new Error("Cliente não deve ser criado sem autenticação");
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
  assertEquals(clientCreated, false, "criação do cliente");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("rejeita tenant ausente para usuário autenticado sem chamar a Evolution", async () => {
  let upstreamCalled = false;
  const profile = {
    id: "00000000-0000-4000-8000-000000000001",
    role: "SCHOOL_ADMIN",
    tenant_id: "tenant-a",
    whatsapp_instance: "instance-abc",
  };

  const response = await handleRequest(
    new Request("http://localhost/whatsapp-evolution-proxy", {
      method: "POST",
      headers: {
        authorization: "Bearer jwt-de-teste",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "instance/connectionState",
        instanceName: "instance-abc",
      }),
    }),
    {
      getEnv: (name) =>
        ({
          SUPABASE_URL: "http://supabase.invalid",
          SUPABASE_ANON_KEY: "anon-de-teste",
          SUPABASE_SERVICE_ROLE_KEY: "service-role-de-teste",
          EVOLUTION_API_URL: "http://evolution.invalid",
          EVOLUTION_API_KEY: "segredo-de-teste",
        })[name],
      createSupabaseClient: () => mockAuthenticatedClient(profile),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada sem tenant");
      },
    },
  );

  const body = await response.json();
  assertEquals(response.status, 403, "status sem tenant");
  assertEquals(body.code, "TENANT_FORBIDDEN", "código sem tenant");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("rejeita papel sem permissão antes de chamar a Evolution", async () => {
  let upstreamCalled = false;
  const profile = {
    id: "00000000-0000-4000-8000-000000000002",
    role: "STUDENT",
    tenant_id: "tenant-a",
    whatsapp_instance: "instance-abc",
  };

  const response = await handleRequest(
    new Request("http://localhost/whatsapp-evolution-proxy", {
      method: "POST",
      headers: {
        authorization: "Bearer jwt-de-teste",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "instance/connectionState",
        tenantId: "tenant-a",
        instanceName: "instance-abc",
      }),
    }),
    {
      getEnv: () => "valor-de-teste",
      createSupabaseClient: () => mockAuthenticatedClient(profile),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada por papel proibido");
      },
    },
  );

  const body = await response.json();
  assertEquals(response.status, 403, "status para papel proibido");
  assertEquals(body.code, "ROLE_FORBIDDEN", "código para papel proibido");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});

Deno.test("rejeita tenant divergente antes de chamar a Evolution", async () => {
  let upstreamCalled = false;
  const profile = {
    id: "00000000-0000-4000-8000-000000000003",
    role: "TEACHER",
    tenant_id: "tenant-a",
    whatsapp_instance: "instance-abc",
  };

  const response = await handleRequest(
    new Request("http://localhost/whatsapp-evolution-proxy", {
      method: "POST",
      headers: {
        authorization: "Bearer jwt-de-teste",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "instance/connectionState",
        tenantId: "tenant-b",
        instanceName: "instance-abc",
      }),
    }),
    {
      getEnv: () => "valor-de-teste",
      createSupabaseClient: () => mockAuthenticatedClient(profile),
      fetchUpstream: async () => {
        upstreamCalled = true;
        throw new Error("Evolution não deve ser chamada por outro tenant");
      },
    },
  );

  const body = await response.json();
  assertEquals(response.status, 403, "status para tenant divergente");
  assertEquals(body.code, "TENANT_FORBIDDEN", "código para tenant divergente");
  assertEquals(upstreamCalled, false, "chamada ao provedor");
});
