// Avisos de cobrança enfileirados pelo asaas-webhook no lugar das notificações
// pagas do Asaas (desligadas em 19/11/2026):
//   PAYMENT_CREATED         nova cobrança        → WhatsApp + e-mail
//   PAYMENT_UPDATED         vencimento alterado  → WhatsApp + e-mail
//   PAYMENT_RECEIVED_EMAIL  recibo               → somente e-mail
//
// A linha da fila é só o gatilho durável. O envio do WhatsApp passa pela cerca
// financeira `asaas_outbound_message_attempts` (PAYMENT_CREATED_WHATSAPP /
// PAYMENT_UPDATED_WHATSAPP_YYYYMMDD) e o e-mail pela intenção única em
// `payment_notification_email_attempts`. Por isso a linha da fila termina como
// `skipped` (com o resultado no motivo), `uncertain` ou `failed`: ela nunca
// cruza o provedor pelo caminho genérico da fila.

import {
  resolveAsaasIntegration,
  resolveEvolutionIntegration,
} from "../_shared/tenant-integration-broker.ts";
import {
  buildPaymentNoticeMessage,
  buildPaymentReceiptEmail,
  deliverPaymentNoticeWhatsApp,
  noticeProviderEligible,
  payerFirstName,
  type PaymentNoticeDelivery,
  paymentNoticeEmailKind,
  paymentNoticeWhatsAppKind,
  readAsaasNoticePayment,
  resolvePaymentNoticeRecipient,
  studentNotificationsEnabled,
  studentStillStudies,
  tenantBrandName,
} from "../_shared/payment-notice.ts";
import {
  deliverPaymentNoticeEmail,
  resolveVerifiedPaymentEmail,
} from "../_shared/payment-email.ts";

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export const PAYMENT_NOTICE_QUEUE_KINDS = [
  "PAYMENT_CREATED",
  "PAYMENT_UPDATED",
  "PAYMENT_RECEIVED_EMAIL",
] as const;

export function isPaymentNoticeQueueKind(kind: string): boolean {
  return (PAYMENT_NOTICE_QUEUE_KINDS as readonly string[]).includes(kind);
}

export type PaymentNoticeQueueOutcome = {
  queueStatus: "skipped" | "failed" | "uncertain" | "pending" | "deferred";
  reason: string;
  deferSeconds: number;
};

const outcome = (
  queueStatus: PaymentNoticeQueueOutcome["queueStatus"],
  reason: string,
  deferSeconds = 0,
): PaymentNoticeQueueOutcome => ({
  queueStatus,
  reason: reason.slice(0, 200),
  deferSeconds,
});

/**
 * Status final da linha da fila. O WhatsApp manda no estado (o e-mail tem a
 * própria intenção durável e aparece só no motivo). Sem WhatsApp, o e-mail
 * decide: incerto nunca vira nova tentativa.
 */
export function paymentNoticeQueueOutcome(
  whatsapp: PaymentNoticeDelivery | null,
  whatsappSkipReason: string,
  email: string,
): PaymentNoticeQueueOutcome {
  const detail = `payment_notice:wa=${
    whatsapp ? whatsapp.status.toLowerCase() : whatsappSkipReason
  };email=${email.toLowerCase()}`;
  if (whatsapp) {
    if (whatsapp.status === "SKIPPED" && whatsapp.retryAfterSeconds > 0) {
      return outcome(
        "deferred",
        `${whatsapp.reason};${detail}`,
        Math.max(
          60,
          whatsapp.retryAfterSeconds,
        ),
      );
    }
    if (whatsapp.status === "UNKNOWN") return outcome("uncertain", detail);
    if (whatsapp.status === "FAILED") return outcome("failed", detail);
    return outcome("skipped", detail);
  }
  if (email === "UNKNOWN" || email === "RESULT_NOT_PERSISTED") {
    return outcome("uncertain", detail);
  }
  if (email === "PROVIDER_UNAVAILABLE" || email === "REJECTED") {
    return outcome("failed", detail);
  }
  return outcome("skipped", detail);
}

type QueueNotice = {
  tenant_id: string | null;
  student_id: string | null;
  source_id: string | null;
  class_date: string | null;
  notification_kind: string | null;
};

export async function processPaymentNoticeQueueItem(
  supabase: AdminClient,
  item: QueueNotice,
): Promise<PaymentNoticeQueueOutcome> {
  const tenantId = String(item.tenant_id || "");
  const studentId = String(item.student_id || "");
  const paymentId = String(item.source_id || "");
  const dueDate = String(item.class_date || "").slice(0, 10);
  const kind = String(item.notification_kind || "").toUpperCase();
  if (
    !tenantId || !studentId || !paymentId ||
    !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !isPaymentNoticeQueueKind(kind)
  ) return outcome("failed", "payment_notice_binding_missing");
  try {
    if (kind === "PAYMENT_RECEIVED_EMAIL") {
      return await processReceiptEmail(supabase, {
        tenantId,
        studentId,
        paymentId,
        dueDate,
      });
    }
    return await processChargeNotice(supabase, {
      stage: kind === "PAYMENT_CREATED" ? "CREATED" : "UPDATED",
      tenantId,
      studentId,
      paymentId,
      dueDate,
    });
  } catch (error) {
    // Nada cruzou o provedor sem antes ficar durável na cerca: tentar de novo
    // é seguro (a cerca devolve ALREADY_FINAL se o POST já aconteceu).
    return outcome(
      "pending",
      `payment_notice_unavailable:${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }
}

type LocalPayment = {
  id: string;
  tenant_id: string;
  student_id: string;
  status: string | null;
  due_date: string;
  value: number;
  asaas_payment_id: string | null;
  exclusion_reason: string | null;
  refunded_amount: number | null;
};

async function loadLocalPayment(
  supabase: AdminClient,
  input: { tenantId: string; studentId: string; paymentId: string },
): Promise<LocalPayment | null> {
  const { data, error } = await supabase.from("student_payments")
    .select(
      "id,tenant_id,student_id,status,due_date,value,asaas_payment_id,exclusion_reason,refunded_amount",
    )
    .eq("id", input.paymentId)
    .eq("tenant_id", input.tenantId)
    .eq("student_id", input.studentId)
    .maybeSingle();
  if (error) throw new Error("payment_notice_source_unavailable");
  return data as LocalPayment | null;
}

async function processChargeNotice(
  supabase: AdminClient,
  input: {
    stage: "CREATED" | "UPDATED";
    tenantId: string;
    studentId: string;
    paymentId: string;
    dueDate: string;
  },
): Promise<PaymentNoticeQueueOutcome> {
  const local = await loadLocalPayment(supabase, input);
  if (
    !local || String(local.status || "").toUpperCase() !== "PENDING" ||
    local.due_date !== input.dueDate || local.exclusion_reason ||
    Number(local.refunded_amount || 0) > 0 || !local.asaas_payment_id
  ) return outcome("skipped", "payment_notice_source_changed");
  if (!(await studentStillStudies(supabase, input.tenantId, input.studentId))) {
    return outcome("skipped", "payment_notice_student_not_current");
  }
  const asaas = await resolveAsaasIntegration(
    supabase,
    input.tenantId,
    "payment.read",
  );
  if (asaas.baseUrl.includes("sandbox")) {
    return outcome("skipped", "payment_notice_asaas_sandbox");
  }
  const provider = await readAsaasNoticePayment(asaas, local.asaas_payment_id);
  const eligible = noticeProviderEligible(local, provider);
  if (!eligible.ok) {
    return outcome("skipped", `payment_notice_${eligible.reason}`);
  }

  const recipient = await resolvePaymentNoticeRecipient(
    supabase,
    input.tenantId,
    input.studentId,
  );
  const brandName = recipient.ok
    ? recipient.brandName
    : await tenantBrandName(supabase, input.tenantId);
  const name = recipient.ok
    ? recipient.nome
    : await payerFirstName(supabase, input.tenantId, input.studentId);
  const message = buildPaymentNoticeMessage({
    stage: input.stage,
    name,
    brandName,
    value: provider.value,
    dueDate: provider.dueDate,
    invoiceUrl: eligible.invoiceUrl,
  });

  // Canais independentes: falha de WhatsApp não impede o e-mail.
  let whatsapp: PaymentNoticeDelivery | null = null;
  if (recipient.ok) {
    const integration = await resolveEvolutionIntegration(
      supabase,
      input.tenantId,
      "message.send_text",
    );
    whatsapp = await deliverPaymentNoticeWhatsApp(supabase, {
      tenantId: input.tenantId,
      studentId: input.studentId,
      paymentId: input.paymentId,
      notificationKind: paymentNoticeWhatsAppKind(input.stage, input.dueDate),
      integration,
      instance: recipient.instance,
      phone: recipient.phone,
      text: message.whatsapp,
    });
  }

  let email = "NOTIFICATIONS_DISABLED";
  if (await studentNotificationsEnabled(supabase, input.tenantId)) {
    const to = await resolveVerifiedPaymentEmail(
      supabase,
      input.studentId,
      input.tenantId,
    );
    if (!to) email = "RECIPIENT_UNVERIFIED";
    else {
      // Releitura depois da espera do WhatsApp, antes da intenção de e-mail.
      const current = whatsapp
        ? await readAsaasNoticePayment(asaas, local.asaas_payment_id)
        : provider;
      const still = noticeProviderEligible(local, current);
      if (
        !still.ok || current.value !== provider.value ||
        still.invoiceUrl !== eligible.invoiceUrl
      ) email = "PROVIDER_CHANGED";
      else {
        email = await deliverPaymentNoticeEmail(supabase, {
          kind: paymentNoticeEmailKind(input.stage),
          tenantId: input.tenantId,
          paymentId: input.paymentId,
          studentId: input.studentId,
          refDate: input.dueDate,
          email: to.email,
          subject: message.subject,
          text: message.email,
          brandName,
        });
      }
    }
  }
  return paymentNoticeQueueOutcome(whatsapp, recipient.motivo, email);
}

async function processReceiptEmail(
  supabase: AdminClient,
  input: {
    tenantId: string;
    studentId: string;
    paymentId: string;
    dueDate: string;
  },
): Promise<PaymentNoticeQueueOutcome> {
  const local = await loadLocalPayment(supabase, input);
  if (
    !local || local.due_date !== input.dueDate || !local.asaas_payment_id ||
    !["RECEIVED", "RECEIVED_IN_CASH", "PAGO"].includes(
      String(local.status || "").toUpperCase(),
    )
  ) return outcome("skipped", "payment_receipt_source_unsettled");
  if (!(await studentNotificationsEnabled(supabase, input.tenantId))) {
    return outcome("skipped", "payment_receipt_notifications_disabled");
  }
  const to = await resolveVerifiedPaymentEmail(
    supabase,
    input.studentId,
    input.tenantId,
  );
  if (!to) return outcome("skipped", "payment_receipt_recipient_unverified");
  const asaas = await resolveAsaasIntegration(
    supabase,
    input.tenantId,
    "payment.read",
  );
  if (asaas.baseUrl.includes("sandbox")) {
    return outcome("skipped", "payment_receipt_asaas_sandbox");
  }
  const provider = await readAsaasNoticePayment(asaas, local.asaas_payment_id);
  if (
    provider.deleted ||
    !["RECEIVED", "RECEIVED_IN_CASH"].includes(provider.status)
  ) return outcome("skipped", "payment_receipt_provider_unsettled");
  const brandName = await tenantBrandName(supabase, input.tenantId);
  const receipt = buildPaymentReceiptEmail({
    name: await payerFirstName(supabase, input.tenantId, input.studentId),
    brandName,
    value: provider.value,
    dueDate: local.due_date,
    receiptUrl: provider.transactionReceiptUrl,
  });
  const email = await deliverPaymentNoticeEmail(supabase, {
    kind: "PAYMENT_RECEIVED_EMAIL",
    tenantId: input.tenantId,
    paymentId: input.paymentId,
    studentId: input.studentId,
    refDate: local.due_date,
    email: to.email,
    subject: receipt.subject,
    text: receipt.text,
    brandName,
  });
  return paymentNoticeQueueOutcome(null, "email_only", email);
}
