// Aviso à escola quando o aluno/responsável abre a cobrança (21/11/2026).
//
// Fonte: eventos do Asaas PAYMENT_CHECKOUT_VIEWED (fatura) e
// PAYMENT_BANK_SLIP_VIEWED (boleto), já autenticados pelo `asaas-access-token`
// e persistidos na inbox durável do asaas-webhook. O evento nunca mexe em
// status de pagamento: só grava `provider_viewed_at` e, uma vez por fatura por
// dia de Brasília (`payment_view_alerts`), enfileira um aviso no canal
// `financeiro` da escola (que cai no grupo da direção quando não configurado).

// Cliente mínimo: o tipo completo do supabase-js prenderia o módulo a uma
// versão do SDK (mesmo padrão de `_shared/payment-email.ts`).
// deno-lint-ignore no-explicit-any
type AdminClient = any;

export const PAYMENT_VIEW_EVENTS = [
  "PAYMENT_CHECKOUT_VIEWED",
  "PAYMENT_BANK_SLIP_VIEWED",
] as const;
export type PaymentViewEvent = typeof PAYMENT_VIEW_EVENTS[number];
export const PAYMENT_VIEW_ALERT_KIND = "INVOICE_VIEWED_MANAGEMENT";

export type PaymentViewOutcome =
  | "NOT_STUDENT_PAYMENT"
  | "NOT_OPEN"
  | "NO_DESTINATION"
  | "ALREADY_ALERTED"
  | "QUEUED";

export function isPaymentViewEvent(event: unknown): event is PaymentViewEvent {
  return typeof event === "string" &&
    (PAYMENT_VIEW_EVENTS as readonly string[]).includes(event);
}

/**
 * Horário do evento. O `dateCreated` do Asaas vem sem fuso
 * ("AAAA-MM-DD HH:mm:ss"); a conta Asaas da escola opera no horário de
 * Brasília (sem horário de verão desde 2019), então é lido como -03:00.
 * Sem data válida, vale o instante do processamento.
 */
export function asaasViewedAtIso(
  dateCreated: unknown,
  now = new Date(),
): string {
  const raw = typeof dateCreated === "string" ? dateCreated.trim() : "";
  const local = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(" ", "T")}-03:00`
    : raw;
  const parsed = local ? new Date(local) : now;
  return Number.isNaN(parsed.getTime())
    ? now.toISOString()
    : parsed.toISOString();
}

/** Data (AAAA-MM-DD) e hora (HH:MM) no relógio da escola. */
export function schoolClock(iso: string): { date: string; time: string } {
  const at = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

const plain = (value: unknown, max = 80) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f*_~`<>]/g, " ").replace(/\s+/g, " ")
      .trim().slice(0, max)
    : "";

/** "Fulano abriu a cobrança de R$ X (venc. dd/mm) às hh:mm". */
export function paymentViewAlertText(input: {
  payerName: string;
  value: number;
  dueDate: string;
  viewedAtIso: string;
}): string {
  const money = Number(input.value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const [, month, day] = input.dueDate.split("-");
  const { time } = schoolClock(input.viewedAtIso);
  return `${
    plain(input.payerName) || "Aluno"
  } abriu a cobrança de R$ ${money} ` +
    `(venc. ${day}/${month}) às ${time}`;
}

function payerName(profile: Record<string, unknown> | null): string {
  if (!profile) return "";
  const student = plain(profile.full_name);
  const guardian = Boolean(profile.guardian_id || profile.guardian_cpf);
  const guardianName = plain(profile.guardian_name);
  return guardian && guardianName
    ? `${guardianName} (responsável por ${student || "aluno"})`
    : student;
}

export async function processPaymentViewEvent(
  admin: AdminClient,
  input: {
    eventId: string;
    event: PaymentViewEvent;
    providerPaymentId: string;
    viewedAtIso: string;
  },
  noticeDestination: (tenantId: string) => Promise<string | null>,
): Promise<PaymentViewOutcome> {
  const { data: rows, error } = await admin.from("student_payments")
    .select("id,tenant_id,student_id,value,due_date,status")
    .eq("asaas_payment_id", input.providerPaymentId)
    .limit(2);
  if (error) throw new Error("payment_view_lookup_failed");
  if (!Array.isArray(rows) || rows.length !== 1) return "NOT_STUDENT_PAYMENT";
  const payment = rows[0] as {
    id: string;
    tenant_id: string;
    student_id: string | null;
    value: number;
    due_date: string;
    status: string | null;
  };

  const { error: markError } = await admin.from("student_payments")
    .update({ provider_viewed_at: input.viewedAtIso })
    .eq("id", payment.id)
    .or(
      `provider_viewed_at.is.null,provider_viewed_at.lt.${input.viewedAtIso}`,
    );
  if (markError) throw new Error("payment_view_mark_failed");

  // Só cobrança em aberto vira aviso: fatura paga ou cancelada vista de novo
  // não é informação útil para a direção.
  const status = String(payment.status || "").toUpperCase();
  if (!["PENDING", "OVERDUE"].includes(status) || !payment.tenant_id) {
    return "NOT_OPEN";
  }

  const destination = await noticeDestination(payment.tenant_id);
  if (!destination) return "NO_DESTINATION";

  const { data: profile, error: profileError } = payment.student_id
    ? await admin.from("profiles")
      .select("full_name,guardian_id,guardian_cpf,guardian_name")
      .eq("id", payment.student_id).eq("tenant_id", payment.tenant_id)
      .maybeSingle()
    : { data: null, error: null };
  if (profileError) throw new Error("payment_view_payer_lookup_failed");

  const { date } = schoolClock(input.viewedAtIso);
  const { error: fenceError } = await admin.from("payment_view_alerts")
    .insert({
      tenant_id: payment.tenant_id,
      payment_id: payment.id,
      alert_date: date,
      source: input.event,
      provider_event_id: input.eventId,
      viewed_at: input.viewedAtIso,
    });
  // Fence repetida não encerra aqui: se a tentativa anterior gravou a cerca e
  // caiu antes de enfileirar, a chave única da fila decide (nunca duplica).
  if (fenceError && fenceError.code !== "23505") {
    throw new Error("payment_view_fence_failed");
  }

  const now = new Date().toISOString();
  const { error: queueError } = await admin.from("notification_queue").insert({
    tenant_id: payment.tenant_id,
    student_id: null,
    student_name: "Financeiro",
    student_phone: destination,
    message_body: paymentViewAlertText({
      payerName: payerName(profile),
      value: Number(payment.value),
      dueDate: payment.due_date,
      viewedAtIso: input.viewedAtIso,
    }),
    scheduled_for: now,
    next_attempt_at: now,
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    delivery_status: "queued",
    notification_kind: PAYMENT_VIEW_ALERT_KIND,
    source_id: payment.id,
    source_type: "PAYMENT_VIEW_ALERT",
    class_date: date,
    idempotency_key: `payment-view:${payment.id}:${date}`,
  });
  if (queueError?.code === "23505") return "ALREADY_ALERTED";
  if (queueError) throw new Error("payment_view_alert_enqueue_failed");
  return "QUEUED";
}
