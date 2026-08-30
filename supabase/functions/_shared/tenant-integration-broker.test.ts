import {
  authorizeAsaasHistoricalReversal,
  isPublicNetworkAddress,
  resolveAsaasIntegration,
  resolveEvolutionIntegration,
  resolvePlatformAsaasIntegration,
  TenantIntegrationBrokerError,
  type TenantIntegrationRpcClient,
} from "./tenant-integration-broker.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

function rpcClient(
  data: Record<string, unknown> | null,
  onCall?: (name: string, args: Record<string, unknown>) => void,
): TenantIntegrationRpcClient {
  return {
    async rpc(name, args) {
      onCall?.(name, args);
      return { data, error: null };
    },
  };
}

function resolution(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    integrationId: "00000000-0000-4000-8000-0000000000e1",
    tenantId: "tenant-a",
    provider: "evolution",
    mode: "PLATFORM_MANAGED",
    version: 1,
    baseUrl: null,
    apiKey: null,
    ...overrides,
  };
}

function asaasResolution(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    integrationId: "00000000-0000-4000-8000-0000000000a5",
    tenantId: "school-wise-wolf",
    provider: "asaas",
    mode: "PLATFORM_MANAGED_ROOT",
    version: 1,
    baseUrl: null,
    apiKey: null,
    environment: "platform",
    ...overrides,
  };
}

Deno.test("resolve Evolution gerenciada pelo tenant canônico", async () => {
  let rpcInput: Record<string, unknown> = {};
  const result = await resolveEvolutionIntegration(
    rpcClient(resolution(), (name, args) => {
      rpcInput = { name, ...args };
    }),
    "tenant-a",
    "message.send_text",
    {
      getEnv: (name) =>
        ({
          EVOLUTION_API_URL: "https://evolution.example.com/",
          EVOLUTION_API_KEY: "platform-secret",
        })[name],
      resolveDns: async (_hostname, type) =>
        type === "A" ? ["203.0.114.10"] : [],
    },
  );

  assertEquals(
    rpcInput,
    {
      name: "resolve_tenant_integration_for_service",
      p_tenant_id: "tenant-a",
      p_provider: "evolution",
      p_capability: "automation.whatsapp",
      p_purpose: "message.send_text",
    },
    "escopo enviado ao resolver interno",
  );
  assertEquals(
    {
      tenantId: result.tenantId,
      mode: result.mode,
      baseUrl: result.baseUrl,
      version: result.version,
    },
    {
      tenantId: "tenant-a",
      mode: "PLATFORM_MANAGED",
      baseUrl: "https://evolution.example.com",
      version: 1,
    },
    "configuração gerenciada",
  );
});

Deno.test("encaminha finalidades restritas da inbox ao resolver interno", async () => {
  const purposes = ["chat.list", "chat.history", "webhook.configure"] as const;

  for (const purpose of purposes) {
    let resolvedPurpose = "";
    await resolveEvolutionIntegration(
      rpcClient(resolution(), (_name, args) => {
        resolvedPurpose = String(args.p_purpose || "");
      }),
      "tenant-a",
      purpose,
      {
        getEnv: (name) =>
          ({
            EVOLUTION_API_URL: "https://evolution.example.com",
            EVOLUTION_API_KEY: "platform-secret",
          })[name],
        resolveDns: async (_hostname, type) =>
          type === "A" ? ["203.0.114.10"] : [],
      },
    );

    assertEquals(resolvedPurpose, purpose, `finalidade ${purpose} enviada`);
  }
});

Deno.test("resolve Evolution BYOK sem consultar segredo global", async () => {
  let environmentRead = false;
  let aLookups = 0;
  const result = await resolveEvolutionIntegration(
    rpcClient(resolution({
      mode: "TENANT_BYOK",
      version: 7,
      baseUrl: "https://tenant-evolution.example.com/api/",
      apiKey: "tenant-secret",
    })),
    "tenant-a",
    "instance.connection_state",
    {
      getEnv: () => {
        environmentRead = true;
        throw new Error("ambiente global não deve ser lido no BYOK");
      },
      resolveDns: async (_hostname, type) => {
        if (type === "A") aLookups += 1;
        return type === "A" ? ["203.0.114.20"] : [];
      },
    },
  );

  assert(!environmentRead, "BYOK consultou segredo global");
  assert(aLookups === 2, "BYOK deve confirmar estabilidade do DNS");
  assertEquals(
    {
      mode: result.mode,
      version: result.version,
      baseUrl: result.baseUrl,
      apiKey: result.apiKey,
    },
    {
      mode: "TENANT_BYOK",
      version: 7,
      baseUrl: "https://tenant-evolution.example.com/api",
      apiKey: "tenant-secret",
    },
    "configuração BYOK",
  );
});

Deno.test("bloqueia endpoint Evolution com esquema, host ou porta inseguros", async () => {
  const endpoints = [
    "http://evolution.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://metadata.google.internal",
    "https://user:password@evolution.example.com",
    "https://evolution.example.com:8443",
  ];

  for (const baseUrl of endpoints) {
    let rejectedCode = "";
    try {
      await resolveEvolutionIntegration(
        rpcClient(resolution({
          mode: "TENANT_BYOK",
          baseUrl,
          apiKey: "tenant-secret",
        })),
        "tenant-a",
        "group.list",
        {
          getEnv: () => undefined,
          resolveDns: async () => {
            throw new Error("DNS não deve autorizar host inválido");
          },
        },
      );
    } catch (error) {
      rejectedCode = error instanceof TenantIntegrationBrokerError
        ? error.code
        : "unexpected";
    }
    assertEquals(
      rejectedCode,
      "INTEGRATION_ENDPOINT_BLOCKED",
      `endpoint inseguro ${baseUrl}`,
    );
  }
});

Deno.test("bloqueia DNS privado, link-local, documentação e metadata", async () => {
  const blockedAddresses = [
    "10.0.0.8",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.4.2",
    "192.168.1.2",
    "192.0.2.10",
    "198.51.100.5",
    "203.0.113.9",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "::8.8.8.8",
    "64:ff9b::a00:1",
    "100::1",
  ];

  for (const address of blockedAddresses) {
    assert(
      !isPublicNetworkAddress(address),
      `${address} foi tratado como público`,
    );
  }
  assert(isPublicNetworkAddress("8.8.8.8"), "IPv4 público foi bloqueado");
  assert(
    isPublicNetworkAddress("2606:4700:4700::1111"),
    "IPv6 público foi bloqueado",
  );
});

Deno.test("falha fechado quando DNS muda entre as resoluções BYOK", async () => {
  let aLookups = 0;
  let rejectedCode = "";
  try {
    await resolveEvolutionIntegration(
      rpcClient(resolution({
        mode: "TENANT_BYOK",
        baseUrl: "https://tenant-evolution.example.com",
        apiKey: "tenant-secret",
      })),
      "tenant-a",
      "instance.connect",
      {
        getEnv: () => undefined,
        resolveDns: async (_hostname, type) => {
          if (type === "AAAA") return [];
          aLookups += 1;
          return aLookups === 1 ? ["203.0.114.30"] : ["203.0.114.31"];
        },
      },
    );
  } catch (error) {
    rejectedCode = error instanceof TenantIntegrationBrokerError
      ? error.code
      : "unexpected";
  }
  assertEquals(
    rejectedCode,
    "INTEGRATION_DNS_REBINDING",
    "mudança de DNS deve ser recusada",
  );
});

Deno.test("erro do resolver interno não lê ambiente nem DNS", async () => {
  let externalStateRead = false;
  const admin: TenantIntegrationRpcClient = {
    async rpc() {
      return { data: null, error: { code: "42501" } };
    },
  };
  let rejectedCode = "";
  try {
    await resolveEvolutionIntegration(
      admin,
      "tenant-a",
      "instance.delete",
      {
        getEnv: () => {
          externalStateRead = true;
          return undefined;
        },
        resolveDns: async () => {
          externalStateRead = true;
          return [];
        },
      },
    );
  } catch (error) {
    rejectedCode = error instanceof TenantIntegrationBrokerError
      ? error.code
      : "unexpected";
  }
  assert(!externalStateRead, "falha de escopo leu segredo ou DNS");
  assertEquals(
    rejectedCode,
    "INTEGRATION_UNAVAILABLE",
    "falha interna deve ser sanitizada",
  );
});

Deno.test("resolve conta Asaas raiz somente para o tenant de referência", async () => {
  let rpcInput: Record<string, unknown> = {};
  const result = await resolveAsaasIntegration(
    rpcClient(asaasResolution(), (name, args) => {
      rpcInput = { name, ...args };
    }),
    "school-wise-wolf",
    "payment.create",
    {
      getEnv: (name) =>
        ({
          ASAAS_API_URL: "https://api.asaas.com/",
          ASAAS_ACCESS_TOKEN: "platform-asaas-secret-token",
        })[name],
    },
  );

  assertEquals(
    rpcInput,
    {
      name: "resolve_tenant_integration_for_service",
      p_tenant_id: "school-wise-wolf",
      p_provider: "asaas",
      p_capability: "billing.school",
      p_purpose: "payment.create",
    },
    "escopo Asaas enviado ao resolver interno",
  );
  assertEquals(
    {
      tenantId: result.tenantId,
      mode: result.mode,
      environment: result.environment,
      baseUrl: result.baseUrl,
    },
    {
      tenantId: "school-wise-wolf",
      mode: "PLATFORM_MANAGED_ROOT",
      environment: "platform",
      baseUrl: "https://api.asaas.com/v3",
    },
    "conta raiz Asaas normalizada",
  );
});

Deno.test("produto de plataforma resolve explicitamente a conta raiz", async () => {
  let rpcInput: Record<string, unknown> = {};
  const result = await resolvePlatformAsaasIntegration(
    rpcClient(asaasResolution(), (name, args) => {
      rpcInput = { name, ...args };
    }),
    "payment.read",
    {
      getEnv: (name) =>
        ({
          ASAAS_API_URL: "https://api.asaas.com/v3",
          ASAAS_ACCESS_TOKEN: "platform-secret-token",
        })[name],
    },
  );
  assertEquals(result.tenantId, "school-wise-wolf", "tenant raiz explícito");
  assertEquals(result.mode, "PLATFORM_MANAGED_ROOT", "modo raiz explícito");
  assertEquals(
    rpcInput.p_purpose,
    "payment.read",
    "capability de leitura preservada",
  );
});

Deno.test(
  "autoriza estorno histórico sem resolver endpoint ou credencial Asaas",
  async () => {
    let rpcInput: Record<string, unknown> = {};
    const result = await authorizeAsaasHistoricalReversal(
      rpcClient(
        asaasResolution({
          mode: "HISTORICAL_WEBHOOK",
          environment: null,
        }),
        (name, args) => {
          rpcInput = { name, ...args };
        },
      ),
      "school-wise-wolf",
    );

    assertEquals(
      rpcInput,
      {
        name: "resolve_tenant_integration_for_service",
        p_tenant_id: "school-wise-wolf",
        p_provider: "asaas",
        p_capability: "webhook.consume",
        p_purpose: "payment.reversal",
      },
      "escopo mínimo de estorno enviado ao resolver interno",
    );
    assertEquals(
      result,
      {
        integrationId: "00000000-0000-4000-8000-0000000000a5",
        tenantId: "school-wise-wolf",
        provider: "asaas",
        mode: "HISTORICAL_WEBHOOK",
        version: 1,
      },
      "autorização histórica sem segredo",
    );
  },
);

Deno.test("estorno histórico rejeita resolução operacional", async () => {
  let rejectedCode = "";
  try {
    await authorizeAsaasHistoricalReversal(
      rpcClient(asaasResolution()),
      "school-wise-wolf",
    );
  } catch (error) {
    rejectedCode = error instanceof TenantIntegrationBrokerError
      ? error.code
      : "unexpected";
  }
  assertEquals(
    rejectedCode,
    "INTEGRATION_RESOLUTION_INVALID",
    "estorno histórico não aceitou uma resolução com credencial operacional",
  );
});

Deno.test("bloqueia Asaas BYOK ate existir binding financeiro por tenant", async () => {
  let environmentRead = false;
  let rejectedCode = "";
  try {
    await resolveAsaasIntegration(
      rpcClient(asaasResolution({
        tenantId: "tenant-byok",
        mode: "TENANT_BYOK",
        apiKey: "tenant-asaas-secret-token",
        environment: "sandbox",
      })),
      "tenant-byok",
      "transfer.read",
      {
        getEnv: () => {
          environmentRead = true;
          return "should-not-be-read";
        },
      },
    );
  } catch (error) {
    rejectedCode = error instanceof TenantIntegrationBrokerError
      ? error.code
      : "unexpected";
  }

  assert(!environmentRead, "Asaas BYOK bloqueado consultou segredo global");
  assertEquals(
    rejectedCode,
    "INTEGRATION_RESOLUTION_INVALID",
    "BYOK deve falhar fechado enquanto IDs Asaas forem globais",
  );
});

Deno.test("bloqueia conta Asaas raiz resolvida para outro tenant", async () => {
  let environmentRead = false;
  let rejectedCode = "";
  try {
    await resolveAsaasIntegration(
      rpcClient(asaasResolution({ tenantId: "tenant-b" })),
      "tenant-b",
      "payment.read",
      {
        getEnv: () => {
          environmentRead = true;
          return "should-not-be-read";
        },
      },
    );
  } catch (error) {
    rejectedCode = error instanceof TenantIntegrationBrokerError
      ? error.code
      : "unexpected";
  }
  assert(!environmentRead, "escopo raiz inválido leu segredo global");
  assertEquals(
    rejectedCode,
    "INTEGRATION_RESOLUTION_INVALID",
    "conta raiz fora do tenant de referência",
  );
});

Deno.test("bloqueia endpoint Asaas global fora dos hosts oficiais", async () => {
  for (
    const endpoint of [
      "http://api.asaas.com",
      "https://api.asaas.com.evil.example",
      "https://api.asaas.com:8443",
      "https://api.asaas.com/v3/payments",
      "https://user:secret@api.asaas.com",
    ]
  ) {
    let rejectedCode = "";
    try {
      await resolveAsaasIntegration(
        rpcClient(asaasResolution()),
        "school-wise-wolf",
        "payment.list",
        {
          getEnv: (name) =>
            name === "ASAAS_API_URL" ? endpoint : "platform-asaas-secret-token",
        },
      );
    } catch (error) {
      rejectedCode = error instanceof TenantIntegrationBrokerError
        ? error.code
        : "unexpected";
    }
    assertEquals(
      rejectedCode,
      "INTEGRATION_ENDPOINT_BLOCKED",
      `endpoint Asaas inseguro ${endpoint}`,
    );
  }
});
