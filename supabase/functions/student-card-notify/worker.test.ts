import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { type Row, type SendResult } from "./core.ts";
import { type CardWorkerDependencies, runStudentCardSweep } from "./worker.ts";

const source = {
  tenant_id: "school-test",
  student_id: "student-test",
  payment_id: "payment-test",
  provider_payment_id: "pay_test",
  customer_id: "cus_test",
  subscription_id: "sub_test",
  value: 100,
  due_date: "2026-09-14",
  event_id: "evt_test",
  event_hash: "a".repeat(64),
  event_at: "2026-09-14T12:00:00Z",
  billing_type: "CREDIT_CARD",
  recipient_phone: "5511999990000",
  recipient_name: "Responsável QA",
  student_name: "Aluno QA",
  card_last4: "1234",
};
const payment = {
  id: "pay_test",
  customer: "cus_test",
  subscription: "sub_test",
  value: 100,
  dueDate: "2026-09-14",
  status: "OVERDUE",
  billingType: "CREDIT_CARD",
  deleted: false,
  creditCard: { creditCardNumber: "1234", creditCardToken: "SECRET_MARKER" },
};
const subscription = {
  id: "sub_test",
  customer: "cus_test",
  status: "ACTIVE",
  billingType: "CREDIT_CARD",
  deleted: false,
  creditCard: { creditCardNumber: "1234", creditCardToken: "SECRET_MARKER" },
};
const route = {
  tenantId: "school-test",
  instanceName: "qa",
  integrationId: "evolution-test",
  integrationVersion: 1,
  mode: "PLATFORM_MANAGED",
  baseUrl: "https://whatsapp.example.invalid",
  apiKey: "test-secret",
  brandName: "Escola QA",
  portalUrl: "https://portal.example.invalid",
};
const integration = {
  tenantId: "school-test",
  integrationId: "asaas-test",
  version: 1,
  environment: "platform",
  mode: "PLATFORM_MANAGED_ROOT",
  baseUrl: "https://provider.example.invalid",
  apiKey: "test-asaas-secret",
};

function harness(options: {
  paymentChange?: Row;
  sourceChange?: Row | null;
  asaasRotation?: Row;
  routeRotation?: Row;
  denyAt?: string;
  failAt?: string;
  throwSend?: boolean;
  staleProof?: boolean;
  wrongEnvelope?: boolean;
  outcome?: SendResult["outcome"];
  delivery?: boolean;
  missingMessageId?: boolean;
  invalidClaimTenant?: boolean;
} = {}) {
  const calls: string[] = [];
  const rpcArgs: { name: string; args: Row }[] = [];
  let sourceReads = 0, paymentReads = 0, asaasReads = 0, routeReads = 0;
  let message = "", clockCalls = 0;
  const dependencies: CardWorkerDependencies = {
    now() {
      clockCalls++;
      return Date.parse("2026-09-14T13:00:00Z") +
        (options.staleProof && clockCalls > 2 ? 16000 : 0);
    },
    client: {
      rpc(name, args) {
        calls.push(name);
        rpcArgs.push({ name, args });
        if (name === options.failAt) {
          return Promise.resolve({
            data: null,
            error: { message: `${source.recipient_phone} SECRET_MARKER` },
          });
        }
        if (name === options.denyAt) {
          return Promise.resolve({ data: { ok: false }, error: null });
        }
        let data: unknown = { ok: true };
        if (name === "student_card_notification_pending") {
          data = [{ id: "notice", tenant_id: source.tenant_id }];
        }
        if (name === "claim_student_card_notification") {
          data = {
            ok: true,
            id: "notice",
            tenant_id: options.invalidClaimTenant ? "other" : source.tenant_id,
            claim_token: "claim",
          };
        }
        if (name === "student_card_notification_source") {
          sourceReads++;
          data = sourceReads === 2 && options.sourceChange !== undefined
            ? (options.sourceChange === null
              ? null
              : { ...source, ...options.sourceChange })
            : source;
        }
        if (name === "prepare_student_card_notification") {
          message = String(args.p_message_body);
        }
        if (name === "authorize_student_card_notification") {
          data = {
            ok: true,
            id: "notice",
            instance_name: route.instanceName,
            destination: options.wrongEnvelope
              ? "5511888880000"
              : source.recipient_phone,
            message_body: message,
          };
        }
        if (name === "finish_student_card_notification") {
          data = {
            ok: true,
            status: options.delivery
              ? "SENT"
              : args.p_outcome === "accepted" && !options.missingMessageId
              ? "SUBMITTING"
              : args.p_outcome === "rejected"
              ? "FAILED"
              : "UNKNOWN",
            delivery_status: options.delivery ? "delivered" : "pending",
          };
        }
        return Promise.resolve({ data, error: null });
      },
    },
    resolveRoute() {
      calls.push("route");
      routeReads++;
      return Promise.resolve(
        routeReads > 1 ? { ...route, ...options.routeRotation } : route,
      );
    },
    resolveAsaas() {
      calls.push("asaas");
      asaasReads++;
      return Promise.resolve(
        asaasReads > 2
          ? { ...integration, ...options.asaasRotation }
          : integration,
      );
    },
    readPayment(_, id) {
      calls.push("payment_get");
      assertEquals(id, source.provider_payment_id);
      paymentReads++;
      return Promise.resolve(
        paymentReads === 2 ? { ...payment, ...options.paymentChange } : payment,
      );
    },
    readSubscription(_, id) {
      calls.push("subscription_get");
      assertEquals(id, source.subscription_id);
      return Promise.resolve(subscription);
    },
    hash(value) {
      calls.push("hash");
      return Promise.resolve(`hash:${value.length}`);
    },
    send(_, destination, text) {
      calls.push("send");
      assertEquals(destination, source.recipient_phone);
      assertEquals(text, message);
      if (options.throwSend) throw new Error(`${destination} SECRET_MARKER`);
      return Promise.resolve({
        outcome: options.outcome ?? "accepted",
        messageId: options.missingMessageId ? null : "message-test",
        httpStatus: 201,
      });
    },
  };
  return { calls, rpcArgs, dependencies };
}

Deno.test("test and dry-run modes touch no queue, provider, hashing or messages", async () => {
  for (const options of [{ testMode: true }, { dryRun: true }]) {
    const test = harness();
    const result = await runStudentCardSweep(test.dependencies, options);
    assertEquals(test.calls, []);
    assertEquals(result.considered, 0);
  }
});

Deno.test("happy path double-checks exact provider objects then fences one POST; HTTP acceptance is not delivery", async () => {
  const test = harness();
  const result = await runStudentCardSweep(test.dependencies);
  assertEquals(test.calls.filter((call) => call === "payment_get").length, 2);
  assertEquals(
    test.calls.filter((call) => call === "subscription_get").length,
    2,
  );
  assertEquals(test.calls.filter((call) => call === "send").length, 1);
  const fence = test.calls.indexOf("authorize_student_card_notification");
  assertEquals(test.calls[fence + 1], "send");
  assertEquals(test.calls[fence + 2], "finish_student_card_notification");
  assertEquals(JSON.stringify(test.rpcArgs).includes("SECRET_MARKER"), false);
  assertEquals(result.accepted, 1);
  assertEquals(result.delivered, 0);
});

for (
  const [name, options, reason] of [
    ["payment settled after prepare", {
      paymentChange: { status: "CONFIRMED" },
    }, "provider_settled"],
    [
      "refund after prepare",
      { paymentChange: { refunds: [{ value: 100 }] } },
      "provider_reversal",
    ],
    [
      "deleted after prepare",
      { paymentChange: { deleted: true } },
      "provider_deleted",
    ],
    [
      "cross-student customer",
      { paymentChange: { customer: "cus_other" } },
      "identity_mismatch",
    ],
    [
      "subscription changed",
      { paymentChange: { subscription: "sub_other" } },
      "identity_mismatch",
    ],
    ["amount changed", { paymentChange: { value: 101 } }, "snapshot_changed"],
    ["card changed", {
      paymentChange: { creditCard: { creditCardNumber: "4321" } },
    }, "snapshot_changed"],
    ["guardian contact changed", {
      sourceChange: { recipient_phone: "5511888880000" },
    }, "source_changed"],
    [
      "paid or covered in final source",
      { sourceChange: null },
      "source_changed",
    ],
    ["Asaas key rotation without version", {
      asaasRotation: { apiKey: "rotated" },
    }, "integration_changed"],
    [
      "Asaas tenant changed",
      { asaasRotation: { tenantId: "other" } },
      "integration_changed",
    ],
    [
      "Asaas environment changed",
      { asaasRotation: { environment: "sandbox" } },
      "integration_changed",
    ],
    [
      "Asaas mode changed",
      { asaasRotation: { mode: "TENANT_BYOK" } },
      "integration_changed",
    ],
    ["Evolution key rotation without version", {
      routeRotation: { apiKey: "rotated" },
    }, "integration_changed"],
    [
      "Evolution instance changed",
      { routeRotation: { instanceName: "other" } },
      "integration_changed",
    ],
    [
      "observation stale after slow lookup",
      { staleProof: true },
      "provider_unavailable",
    ],
  ] as const
) {
  Deno.test(`worker does not send when ${name}`, async () => {
    const test = harness(options);
    await runStudentCardSweep(test.dependencies);
    assertEquals(test.calls.includes("send"), false);
    assertEquals(
      test.calls.includes("authorize_student_card_notification"),
      false,
    );
    assertEquals(
      test.rpcArgs.find((call) =>
        call.name === "defer_student_card_notification"
      )?.args.p_reason,
      reason,
    );
  });
}

Deno.test("under-lock DB paid/prepayment/opt-out guard denies final authorization without POST", async () => {
  const test = harness({ denyAt: "authorize_student_card_notification" });
  await runStudentCardSweep(test.dependencies);
  assertEquals(test.calls.includes("send"), false);
});

Deno.test("another worker already claimed or wrong tenant claim never reads the payer", async () => {
  for (
    const options of [{ denyAt: "claim_student_card_notification" }, {
      invalidClaimTenant: true,
    }]
  ) {
    const test = harness(options);
    await runStudentCardSweep(test.dependencies);
    assertEquals(
      test.calls.includes("student_card_notification_source"),
      false,
    );
    assertEquals(test.calls.includes("send"), false);
  }
});

Deno.test("changed authorization envelope becomes UNKNOWN with no POST", async () => {
  const test = harness({ wrongEnvelope: true });
  const result = await runStudentCardSweep(test.dependencies);
  assertEquals(test.calls.includes("send"), false);
  assertEquals(result.unknown, 1);
  assertEquals(
    test.rpcArgs.find((call) =>
      call.name === "finish_student_card_notification"
    )?.args.p_outcome,
    "ambiguous",
  );
});

Deno.test("network ambiguity and finish RPC outage never resend the POST or leak payer", async () => {
  for (
    const options of [
      { throwSend: true },
      { failAt: "finish_student_card_notification" },
      { outcome: "ambiguous" as const },
      { missingMessageId: true },
    ]
  ) {
    const test = harness(options);
    const result = await runStudentCardSweep(test.dependencies);
    assertEquals(test.calls.filter((call) => call === "send").length, 1);
    assertEquals(result.unknown, 1);
    assertEquals(
      JSON.stringify(result).includes(source.recipient_phone),
      false,
    );
    assertEquals(JSON.stringify(result).includes("SECRET_MARKER"), false);
  }
});

Deno.test("delivered only when durable DB receipt says delivered", async () => {
  const test = harness({ delivery: true });
  const result = await runStudentCardSweep(test.dependencies);
  assertEquals(result.delivered, 1);
  assertEquals(result.accepted, 0);
});

Deno.test("provider read failure defers safely and exposes no provider exception", async () => {
  const test = harness();
  test.dependencies.readPayment = () => {
    throw new Error(`${source.recipient_name} SECRET_MARKER`);
  };
  const result = await runStudentCardSweep(test.dependencies);
  assertEquals(test.calls.includes("send"), false);
  assertEquals(result.deferred, 1);
  assertEquals(result.errors, ["card_notification_unavailable"]);
});
