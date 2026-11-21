import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  asaasViewedAtIso,
  isPaymentViewEvent,
  PAYMENT_VIEW_ALERT_KIND,
  paymentViewAlertText,
  processPaymentViewEvent,
  schoolClock,
} from "./payment-view-alert.ts";
import { isValidAsaasWebhookToken } from "./event-contract.ts";

Deno.test("Asaas webhook token: valid, invalid and missing", () => {
  assert(isValidAsaasWebhookToken("token-fixture-1234", "token-fixture-1234"));
  assertEquals(
    isValidAsaasWebhookToken("token-fixture-1234", "token-fixture-1235"),
    false,
  );
  assertEquals(isValidAsaasWebhookToken("token-fixture-1234", null), false);
  assertEquals(isValidAsaasWebhookToken("token-fixture-1234", ""), false);
  // Sem token configurado, nada passa (nem cabeçalho vazio).
  assertEquals(isValidAsaasWebhookToken("", ""), false);
  assertEquals(isValidAsaasWebhookToken(undefined, "x"), false);
});

Deno.test("only the two Asaas view events are view events", () => {
  assert(isPaymentViewEvent("PAYMENT_CHECKOUT_VIEWED"));
  assert(isPaymentViewEvent("PAYMENT_BANK_SLIP_VIEWED"));
  assertEquals(isPaymentViewEvent("PAYMENT_RECEIVED"), false);
  assertEquals(isPaymentViewEvent(undefined), false);
});

Deno.test("alert text uses Brasília time and the requested format", () => {
  const at = asaasViewedAtIso("2026-11-21 14:05:09");
  assertEquals(at, "2026-11-21T17:05:09.000Z");
  assertEquals(schoolClock(at), { date: "2026-11-21", time: "14:05" });
  // Virada do dia em UTC continua no dia de Brasília.
  assertEquals(schoolClock("2026-11-22T01:30:00.000Z").date, "2026-11-21");
  assertEquals(
    paymentViewAlertText({
      payerName: "Ana *Souza*\n",
      value: 187,
      dueDate: "2026-12-10",
      viewedAtIso: at,
    }),
    "Ana Souza abriu a cobrança de R$ 187,00 (venc. 10/12) às 14:05",
  );
  const now = new Date("2026-11-21T10:00:00.000Z");
  assertEquals(asaasViewedAtIso(null, now), now.toISOString());
  assertEquals(asaasViewedAtIso("lixo", now), now.toISOString());
});

type Inserted = { table: string; row: Record<string, unknown> };

function fakeAdmin(options: {
  payments?: Record<string, unknown>[];
  fenceCode?: string;
  queueCode?: string;
  inserts: Inserted[];
}) {
  return {
    from: (table: string) => {
      const chain: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ["select", "update", "eq", "or", "limit"]) {
        chain[method] = () => chain;
      }
      chain.maybeSingle = () =>
        Promise.resolve({
          data: {
            full_name: "João",
            guardian_id: "guardian",
            guardian_cpf: null,
            guardian_name: "Maria",
          },
          error: null,
        });
      chain.insert = (row: unknown) => {
        options.inserts.push({ table, row: row as Record<string, unknown> });
        const code = table === "payment_view_alerts"
          ? options.fenceCode
          : options.queueCode;
        return Promise.resolve({ error: code ? { code } : null });
      };
      chain.then = (resolve: unknown) =>
        (resolve as (v: unknown) => unknown)(
          table === "student_payments"
            ? { data: options.payments ?? [], error: null }
            : { data: null, error: null },
        );
      return chain;
    },
  };
}

const openPayment = {
  id: "payment-1",
  tenant_id: "school-wise-wolf",
  student_id: "student-1",
  value: 187,
  due_date: "2026-12-10",
  status: "PENDING",
};
const input = {
  eventId: "evt_1",
  event: "PAYMENT_CHECKOUT_VIEWED" as const,
  providerPaymentId: "pay_1",
  viewedAtIso: "2026-11-21T17:05:00.000Z",
};
const group = () => Promise.resolve("120363000000000000@g.us");

Deno.test("view of an open invoice fences the day and queues one finance alert", async () => {
  const inserts: Inserted[] = [];
  assertEquals(
    await processPaymentViewEvent(
      fakeAdmin({ payments: [openPayment], inserts }),
      input,
      group,
    ),
    "QUEUED",
  );
  assertEquals(inserts.map((i) => i.table), [
    "payment_view_alerts",
    "notification_queue",
  ]);
  assertEquals(inserts[0].row.alert_date, "2026-11-21");
  const queued = inserts[1].row;
  assertEquals(queued.notification_kind, PAYMENT_VIEW_ALERT_KIND);
  assertEquals(queued.student_phone, "120363000000000000@g.us");
  assertEquals(queued.idempotency_key, "payment-view:payment-1:2026-11-21");
  assertEquals(
    queued.message_body,
    "Maria (responsável por João) abriu a cobrança de R$ 187,00 (venc. 10/12) às 14:05",
  );
});

Deno.test("second view the same day never queues a second alert", async () => {
  const inserts: Inserted[] = [];
  assertEquals(
    await processPaymentViewEvent(
      fakeAdmin({
        payments: [openPayment],
        fenceCode: "23505",
        queueCode: "23505",
        inserts,
      }),
      input,
      group,
    ),
    "ALREADY_ALERTED",
  );
});

Deno.test("paid invoice, unknown invoice or no channel do not alert", async () => {
  const inserts: Inserted[] = [];
  assertEquals(
    await processPaymentViewEvent(
      fakeAdmin({
        payments: [{ ...openPayment, status: "RECEIVED" }],
        inserts,
      }),
      input,
      group,
    ),
    "NOT_OPEN",
  );
  assertEquals(
    await processPaymentViewEvent(
      fakeAdmin({ payments: [], inserts }),
      input,
      group,
    ),
    "NOT_STUDENT_PAYMENT",
  );
  assertEquals(
    await processPaymentViewEvent(
      fakeAdmin({ payments: [openPayment], inserts }),
      input,
      () => Promise.resolve(null),
    ),
    "NO_DESTINATION",
  );
  assertEquals(inserts, []);
});
