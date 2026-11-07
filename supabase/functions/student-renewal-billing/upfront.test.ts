import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  invoiceUrlOf,
  parseUpfrontSource,
  processUpfrontCharge,
  type UpfrontDeps,
  upfrontDescription,
  upfrontPaymentMatches,
  type UpfrontSource,
} from "./upfront.ts";
import type { ResolvedAsaasIntegration } from "../_shared/tenant-integration-broker.ts";

const STUDENT = "7e1a0000-0000-4000-8000-000000000011";
const OFFER = "7e1a0000-0000-4000-8000-0000000000aa";
const source: UpfrontSource = {
  offerId: OFFER,
  tenantId: "renewal-qa",
  studentId: STUDENT,
  customerId: null,
  billingType: "PIX",
  termMonths: 12,
  firstDueDate: "2027-02-17",
  lastDueDate: "2028-01-17",
  totalCents: 224400,
  dueDate: "2026-11-10",
  billingName: "Aluno Sintetico",
  billingCpf: "11122233344",
  billingPhone: "5511999998888",
  billingEmail: "aluno@example.invalid",
  postalCode: "",
  address: "",
  addressNumber: "",
};
const integration: ResolvedAsaasIntegration = {
  integrationId: "i-1",
  tenantId: "renewal-qa",
  provider: "asaas",
  mode: "TENANT_BYOK",
  version: 1,
  environment: "sandbox",
  baseUrl: "https://asaas.example.invalid/v3",
  apiKey: "fake",
};

type Call = {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
};

function harness(options: {
  claimAction?: string;
  customers?: Record<string, unknown>[];
  payments?: Record<string, unknown>[];
  postPaymentStatus?: number;
  bindCustomer?: boolean;
} = {}) {
  const calls: Call[] = [];
  const rpcs: string[] = [];
  const states: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname.replace("/v3/", ""), body });
    const json = (value: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(value), { status }));
    if (method === "POST" && url.pathname.endsWith("/customers")) {
      return json({ id: "cus_novo", ...body });
    }
    if (method === "POST" && url.pathname.endsWith("/payments")) {
      const status = options.postPaymentStatus ?? 200;
      return status === 200
        ? json({
          id: "pay_novo",
          status: "PENDING",
          invoiceUrl: "https://pay.example.invalid/i/x",
          ...body,
        })
        : json({ errors: [{ code: "x" }] }, status);
    }
    if (url.pathname.endsWith("/customers")) {
      return json({ data: options.customers ?? [], hasMore: false });
    }
    if (url.pathname.endsWith("/payments")) {
      return json({ data: options.payments ?? [], hasMore: false });
    }
    if (url.pathname.includes("/customers/")) {
      return json({
        id: "cus_antigo",
        cpfCnpj: source.billingCpf,
        externalReference: "",
      });
    }
    return json({}, 404);
  }) as typeof fetch;
  const query = (data: unknown) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data, error: null }),
    };
    return chain;
  };
  const admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push(name);
      if (name === "claim_asaas_provider_creation") {
        return Promise.resolve({
          data: {
            ok: true,
            action: options.claimAction ?? "SUBMIT_ONCE",
            attempt_id: `a-${args.p_operation}`,
            claim_token: "c",
          },
          error: null,
        });
      }
      if (name === "record_asaas_provider_creation_state") states.push(args);
      return Promise.resolve({ data: { ok: true }, error: null });
    },
    from: (table: string) =>
      query(
        table === "tenants"
          ? { asaas_wallet_id: null, asaas_split_percentage: null }
          : null,
      ),
  };
  const deps: UpfrontDeps = {
    admin,
    resolve: () => Promise.resolve(integration),
    revalidate: () => Promise.resolve(integration),
    bindCustomer: () => Promise.resolve(options.bindCustomer ?? true),
  };
  return {
    calls,
    rpcs,
    states,
    deps,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const posts = (calls: Call[], path: string) =>
  calls.filter((c) => c.method === "POST" && c.path === path);

Deno.test("aluno sem cliente: cria o cliente uma vez e uma cobrança pelo total", async () => {
  const h = harness();
  try {
    const out = await processUpfrontCharge(h.deps, source);
    assertEquals(out.status, "SYNCED");
    assertEquals(out.customerId, "cus_novo");
    assertEquals(out.paymentId, "pay_novo");
    assertEquals(out.invoiceUrl, "https://pay.example.invalid/i/x");
    assertEquals(posts(h.calls, "customers").length, 1);
    const [payment] = posts(h.calls, "payments");
    assertEquals(posts(h.calls, "payments").length, 1);
    assertEquals(payment.body?.value, 2244);
    assertEquals(payment.body?.dueDate, "2026-11-10");
    assertEquals(payment.body?.externalReference, STUDENT);
    assertEquals(payment.body?.billingType, "PIX");
    assert(!("subscription" in (payment.body ?? {})));
  } finally {
    h.restore();
  }
});

Deno.test("cliente já vinculado não passa por criação", async () => {
  const h = harness();
  try {
    const out = await processUpfrontCharge(h.deps, {
      ...source,
      customerId: "cus_antigo",
    });
    assertEquals(out.status, "SYNCED");
    assertEquals(posts(h.calls, "customers").length, 0);
    assertEquals(posts(h.calls, "payments")[0].body?.customer, "cus_antigo");
  } finally {
    h.restore();
  }
});

Deno.test("CPF já usado por outro cadastro no Asaas para em revisão, sem POST", async () => {
  const h = harness({
    customers: [{
      id: "cus_outro",
      cpfCnpj: source.billingCpf,
      externalReference: "outra",
    }],
  });
  try {
    const out = await processUpfrontCharge(h.deps, source);
    assertEquals(out.status, "REVIEW");
    assertEquals(out.error, "customer_cpf_conflict");
    assertEquals(h.calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    h.restore();
  }
});

Deno.test("cobrança já existente no provedor é reaproveitada, nunca duplicada", async () => {
  const existing = {
    id: "pay_existente",
    customer: "cus_antigo",
    externalReference: STUDENT,
    value: 2244,
    description: upfrontDescription(source),
    status: "PENDING",
    invoiceUrl: "https://pay.example.invalid/i/ex",
  };
  const h = harness({ payments: [existing] });
  try {
    const out = await processUpfrontCharge(h.deps, {
      ...source,
      customerId: "cus_antigo",
    });
    assertEquals(out.status, "SYNCED");
    assertEquals(out.paymentId, "pay_existente");
    assertEquals(posts(h.calls, "payments").length, 0);
  } finally {
    h.restore();
  }
});

Deno.test("resultado incerto do POST vira revisão sem segunda tentativa", async () => {
  const h = harness({ postPaymentStatus: 503 });
  try {
    const out = await processUpfrontCharge(h.deps, {
      ...source,
      customerId: "cus_antigo",
    });
    assertEquals(out.status, "REVIEW");
    assertEquals(out.error, "payment_post_outcome_unknown");
    assertEquals(posts(h.calls, "payments").length, 1);
    assertEquals(h.states.at(-1)?.p_status, "UNKNOWN");
  } finally {
    h.restore();
  }
});

Deno.test("recusa definitiva do Asaas é falha, não incerteza", async () => {
  const h = harness({ postPaymentStatus: 400 });
  try {
    const out = await processUpfrontCharge(h.deps, {
      ...source,
      customerId: "cus_antigo",
    });
    assertEquals(out.status, "FAILED");
    assertEquals(out.error, "payment_create_400");
  } finally {
    h.restore();
  }
});

Deno.test("reconciliar sem achar a cobrança não dispara POST", async () => {
  const h = harness({ claimAction: "RECONCILE_REQUIRED" });
  try {
    const out = await processUpfrontCharge(h.deps, {
      ...source,
      customerId: "cus_antigo",
    });
    assertEquals(out.status, "REVIEW");
    assertEquals(out.error, "payment_not_yet_observed");
    assertEquals(posts(h.calls, "payments").length, 0);
  } finally {
    h.restore();
  }
});

Deno.test("cadastro sem CPF ou WhatsApp nem chega ao provedor", async () => {
  const h = harness();
  try {
    const out = await processUpfrontCharge(h.deps, {
      ...source,
      billingCpf: "",
    });
    assertEquals(out.status, "REVIEW");
    assertEquals(out.error, "billing_identity_incomplete");
    assertEquals(h.calls.length, 0);
  } finally {
    h.restore();
  }
});

Deno.test("vínculo do cliente recusado impede a cobrança", async () => {
  const h = harness({ bindCustomer: false });
  try {
    const out = await processUpfrontCharge(h.deps, source);
    assertEquals(out.status, "REVIEW");
    assertEquals(out.error, "customer_binding_changed");
    assertEquals(posts(h.calls, "payments").length, 0);
  } finally {
    h.restore();
  }
});

Deno.test("descrição continua sendo mensalidade para a cobertura aceitar", () => {
  const text = upfrontDescription(source).toLowerCase();
  assert(text.includes("12 meses (02/2027 a 01/2028)"));
  for (
    const word of [
      "taxa",
      "multa",
      "cancelamento",
      "extra",
      "material",
      "reposição",
      "matrícula",
      "proporcional",
      "reembolso",
    ]
  ) {
    assert(!text.includes(word), word);
  }
});

Deno.test("só aceita a cobrança exata: cliente, valor, referência e sem assinatura", () => {
  const ok = {
    id: "p",
    customer: "cus",
    externalReference: STUDENT,
    value: 2244,
    description: upfrontDescription(source),
  };
  assert(upfrontPaymentMatches(ok, source, "cus"));
  assert(!upfrontPaymentMatches({ ...ok, value: 187 }, source, "cus"));
  assert(!upfrontPaymentMatches({ ...ok, customer: "x" }, source, "cus"));
  assert(
    !upfrontPaymentMatches({ ...ok, subscription: "sub_1" }, source, "cus"),
  );
  assert(!upfrontPaymentMatches({ ...ok, deleted: true }, source, "cus"));
  assert(
    !upfrontPaymentMatches({ ...ok, description: "outra" }, source, "cus"),
  );
});

Deno.test("link de pagamento só passa com https", () => {
  assertEquals(invoiceUrlOf({ invoiceUrl: "http://x" }), null);
  assertEquals(invoiceUrlOf({ bankSlipUrl: "https://x/y" }), "https://x/y");
});

Deno.test("fonte malformada não vira cobrança", () => {
  const valid = {
    id: OFFER,
    tenant_id: "t",
    student_id: STUDENT,
    strategy: "UPFRONT_CHARGE",
    customer_id: null,
    billing_type: "PIX",
    term_months: 12,
    first_due_date: "2027-02-17",
    last_due_date: "2028-01-17",
    upfront: { total_cents: 224400, due_date: "2026-11-10" },
  };
  assert(parseUpfrontSource(valid));
  assertEquals(parseUpfrontSource({ ...valid, term_months: 7 }), null);
  assertEquals(parseUpfrontSource({ ...valid, billing_type: "EXTERNO" }), null);
  assertEquals(parseUpfrontSource({ ...valid, customer_id: "x" }), null);
  assertEquals(
    parseUpfrontSource({
      ...valid,
      upfront: { total_cents: 0, due_date: "2026-11-10" },
    }),
    null,
  );
  assertEquals(parseUpfrontSource({ ...valid, strategy: "CREATE_NEW" }), null);
});
