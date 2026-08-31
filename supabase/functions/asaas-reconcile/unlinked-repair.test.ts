import {
  customerBindingSnapshot,
  parseAuthoritativeUnlinkedRepairTarget,
  paymentBindingSnapshot,
  sameIntegrationIdentity,
  subscriptionBindingSnapshot,
} from "./unlinked-repair.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("unlinked repair accepts only two UUIDs and one explicit due-day choice", () => {
  const valid = parseAuthoritativeUnlinkedRepairTarget({
    localPaymentId: "c4a61d84-6b8e-4714-94b2-0bfcfbd3cba0",
    studentId: "67f36111-2c18-4a49-a30e-de8594a806e4",
    syncContractDueDay: false,
  });
  assert(valid?.syncContractDueDay === false, "valid target rejected");
  assert(
    parseAuthoritativeUnlinkedRepairTarget({
      localPaymentId: "c4a61d84-6b8e-4714-94b2-0bfcfbd3cba0",
      studentId: "67f36111-2c18-4a49-a30e-de8594a806e4",
      syncContractDueDay: false,
      providerPaymentId: "pay_forbidden_authority",
    }) === null,
    "provider authority was accepted from the request",
  );
  assert(
    parseAuthoritativeUnlinkedRepairTarget({
      localPaymentId: "not-a-uuid",
      studentId: "67f36111-2c18-4a49-a30e-de8594a806e4",
      syncContractDueDay: false,
    }) === null,
    "invalid local id accepted",
  );
});

Deno.test("all provider capabilities must resolve to one exact integration", () => {
  const identity = {
    integrationId: "00000000-0000-4000-8000-000000000001",
    tenantId: "school-wise-wolf",
    mode: "PLATFORM_MANAGED_ROOT",
    version: 7,
    environment: "platform",
    baseUrl: "https://api.asaas.com/v3",
  };
  assert(sameIntegrationIdentity(identity, { ...identity }), "exact mismatch");
  assert(
    !sameIntegrationIdentity(identity, { ...identity, version: 8 }),
    "rotated integration accepted",
  );
  assert(
    !sameIntegrationIdentity(identity, {
      ...identity,
      tenantId: "another-school",
    }),
    "cross-tenant integration accepted",
  );
});

Deno.test("provider binding snapshots detect every authoritative identity drift", () => {
  const payment = {
    id: "pay_exact",
    customer: "cus_exact",
    subscription: "sub_exact",
    status: "RECEIVED",
    value: 169,
    dueDate: "2026-08-10",
    paymentDate: "2026-08-09",
    estimatedCreditDate: "2026-08-10",
    billingType: "PIX",
    deleted: false,
  };
  assert(
    paymentBindingSnapshot(payment) === paymentBindingSnapshot({ ...payment }),
    "stable payment changed",
  );
  assert(
    paymentBindingSnapshot(payment) !== paymentBindingSnapshot({
      ...payment,
      customer: "cus_changed",
    }),
    "payment customer drift hidden",
  );
  const customer = {
    id: "cus_exact",
    cpfCnpj: "00000000000",
    email: "student@example.test",
    mobilePhone: "11999999999",
    phone: null,
    deleted: false,
  };
  assert(
    customerBindingSnapshot(customer) !== customerBindingSnapshot({
      ...customer,
      email: "changed@example.test",
    }),
    "customer identity drift hidden",
  );
  const subscription = {
    id: "sub_exact",
    customer: "cus_exact",
    status: "ACTIVE",
    nextDueDate: "2026-09-10",
    deleted: false,
  };
  assert(
    subscriptionBindingSnapshot(subscription) !== subscriptionBindingSnapshot({
      ...subscription,
      nextDueDate: "2026-09-11",
    }),
    "subscription schedule drift hidden",
  );
});
