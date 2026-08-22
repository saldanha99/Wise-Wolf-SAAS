import {
  isOperationalTenantStatus,
  normalizeSettings,
  validateProviderCredential,
  verifyDnsOwnership,
} from "./index.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    name: "Escola Teste",
    slug: "escola-teste",
    branding: {
      primaryColor: "#123456",
      secondaryColor: "#ABCDEF",
      logoPath: "tenant-a/logo/00000000-0000-4000-8000-000000000001.png",
      faviconPath: "tenant-a/favicon/00000000-0000-4000-8000-000000000002.png",
    },
    schoolInfo: { legalName: "Escola Teste LTDA", state: "sp" },
    whatsappEnabled: true,
    financialCutoffDay: 5,
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    currency: "BRL",
    weekStartsOn: 1,
    defaultLessonDurationMinutes: 60,
    studentNotificationsEnabled: true,
    teacherNotificationsEnabled: true,
    ...overrides,
  };
}

Deno.test("normaliza configuracoes sem aceitar autoridade de tenant", () => {
  const normalized = normalizeSettings(settings(), "tenant-a", {});
  assert(normalized.schoolInfo?.state === "SP", "UF deve ser normalizada");
  assert(
    normalized.branding.logoUrl.includes("/tenant-a/logo/"),
    "branding deve permanecer no namespace do tenant",
  );

  let rejected = false;
  try {
    normalizeSettings(settings({ tenantId: "tenant-b" }), "tenant-a", {});
  } catch {
    rejected = true;
  }
  assert(rejected, "tenantId fornecido pelo cliente deve ser rejeitado");
});

Deno.test("aceita somente estados operacionais de tenant", () => {
  for (const status of ["active", "ACTIVE", " trial ", "trialing"]) {
    assert(
      isOperationalTenantStatus(status),
      `${status} deveria estar operacional`,
    );
  }
  for (const status of ["blocked", "past_due", "cancelled", "", null]) {
    assert(
      !isOperationalTenantStatus(status),
      `${status} nao deveria estar operacional`,
    );
  }
});

Deno.test("rejeita branding de outro tenant", () => {
  let rejected = false;
  try {
    normalizeSettings(
      settings({
        branding: {
          primaryColor: "#123456",
          secondaryColor: "#ABCDEF",
          logoPath: "tenant-b/logo/00000000-0000-4000-8000-000000000001.png",
          faviconPath: "",
        },
      }),
      "tenant-a",
      {},
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "arquivo de tenant divergente deve ser rejeitado");
});

Deno.test("valida CNPJ e caminho privado da assinatura do tenant", () => {
  const signaturePath =
    "tenant-a/legal-representative-signature/00000000-0000-4000-8000-000000000003.png";
  const normalized = normalizeSettings(
    settings({
      schoolInfo: {
        legalName: "Escola Teste LTDA",
        cnpj: "04.252.011/0001-10",
        state: "SP",
        legalRepresentativeSignaturePath: signaturePath,
      },
    }),
    "tenant-a",
    {},
  );
  assert(
    normalized.schoolInfo?.legalRepresentativeSignaturePath === signaturePath,
    "caminho privado do namespace juridico deve ser aceito",
  );

  for (
    const schoolInfo of [
      {
        legalName: "Escola Teste LTDA",
        cnpj: "11.111.111/1111-11",
        state: "SP",
      },
      {
        legalName: "Escola Teste LTDA",
        cnpj: "04.252.011/0001-10",
        state: "SP",
        legalRepresentativeSignatureUrl:
          "https://tracker.example.invalid/signature.png",
      },
      {
        legalName: "Escola Teste LTDA",
        cnpj: "04.252.011/0001-10",
        state: "SP",
        legalRepresentativeSignaturePath:
          "tenant-b/legal-representative-signature/00000000-0000-4000-8000-000000000003.png",
      },
    ]
  ) {
    let rejected = false;
    try {
      normalizeSettings(settings({ schoolInfo }), "tenant-a", {});
    } catch {
      rejected = true;
    }
    assert(rejected, "identidade juridica insegura deve ser rejeitada");
  }
});

Deno.test("valida credencial sem devolve-la", async () => {
  const secret = "sk-test-super-secret-value";
  const result = await validateProviderCredential(
    "openai",
    secret,
    "production",
    async (_input, init) => {
      assert(
        new Headers(init?.headers).get("authorization") === `Bearer ${secret}`,
        "credencial deve ser enviada apenas ao provedor esperado",
      );
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    },
  );
  assert(
    !JSON.stringify(result).includes(secret),
    "resposta nao pode conter segredo",
  );
  assert(result.environment === "production", "ambiente incorreto");
});

Deno.test("rejeita ambiente Asaas desconhecido antes de chamar o provedor", async () => {
  let providerCalled = false;
  let rejected = false;
  try {
    await validateProviderCredential(
      "asaas",
      "asaas-test-secret",
      "staging",
      async () => {
        providerCalled = true;
        return new Response("{}", { status: 200 });
      },
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "ambiente Asaas desconhecido deve ser rejeitado");
  assert(
    !providerCalled,
    "provedor nao deve ser chamado com ambiente invalido",
  );
});

Deno.test("dominio exige TXT e CNAME corretos", async () => {
  const result = await verifyDnsOwnership(
    "portal.example.com",
    "wwv-token",
    async (input) => {
      const url = new URL(String(input));
      const type = url.searchParams.get("type");
      const Answer = type === "TXT"
        ? [{ data: '"wwv-token"' }]
        : [{ data: "system.wisewolflanguage.com.br." }];
      return new Response(JSON.stringify({ Answer }), { status: 200 });
    },
  );
  assert(result.txtVerified, "TXT deveria ser validado");
  assert(result.cnameVerified, "CNAME deveria ser validado");
});
