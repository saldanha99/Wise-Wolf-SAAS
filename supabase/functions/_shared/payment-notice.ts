// Efeitos (Asaas, WhatsApp, banco) dos avisos que substituem as notificações
// pagas do Asaas. Regras e textos puros ficam em `payment-notice-core.ts`.
//
// Toda mensagem passa pela cerca durável `asaas_outbound_message_attempts`
// (claim → permit → SUBMITTING → POST → finish). Timeout = UNKNOWN, nunca reenviado.

import {
  requestOutboundPermit,
  resolveWhatsAppDestination,
  sendWhatsTextToResolvedDestinationDetailed,
  settleOutboundPermit,
  THROTTLE_MAX_INLINE_WAIT_MS,
} from "./evolution-send.ts";
import {
  claimOutboundMessage,
  deferOutboundMessageClaim,
  finishOutboundMessage,
  markOutboundMessageSubmittingDecision,
} from "./student-billing-period-guard.ts";
import { loadTenantCentralWhatsAppContext } from "./tenant-communication.ts";
import {
  type AsaasNoticePayment,
  ISO_DATE,
  normalizeDigitableLine,
  normalizePixCopyPaste,
} from "./payment-notice-core.ts";
import type {
  ResolvedAsaasIntegration,
  ResolvedEvolutionIntegration,
} from "./tenant-integration-broker.ts";
import {
  paymentNotificationFinish,
  resolvePaymentRecipient,
} from "../notify-payment-due/core.ts";

// deno-lint-ignore no-explicit-any
type AdminClient = any;

export * from "./payment-notice-core.ts";

export async function readAsaasNoticePayment(
  integration: Pick<ResolvedAsaasIntegration, "baseUrl" | "apiKey">,
  asaasPaymentId: string,
  transport: typeof fetch = fetch,
): Promise<AsaasNoticePayment> {
  const response = await transport(
    `${integration.baseUrl}/payments/${encodeURIComponent(asaasPaymentId)}`,
    {
      headers: { access_token: integration.apiKey },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new Error("provider_payment_read_failed");
  const raw = await response.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("provider_payment_invalid");
  }
  const p = raw as Record<string, unknown>;
  const id = typeof p.id === "string" ? p.id : "";
  const dueDate = typeof p.dueDate === "string" ? p.dueDate : "";
  const value = Number(p.value);
  if (
    id !== asaasPaymentId || !ISO_DATE.test(dueDate) ||
    !Number.isFinite(value) || value <= 0
  ) throw new Error("provider_payment_invalid");
  const deleted = p.deleted === true;
  return {
    id,
    status: deleted ? "DELETED" : String(p.status || "").toUpperCase(),
    dueDate,
    value,
    billingType: String(p.billingType || "").toUpperCase(),
    invoiceUrl: typeof p.invoiceUrl === "string" ? p.invoiceUrl : null,
    transactionReceiptUrl: typeof p.transactionReceiptUrl === "string"
      ? p.transactionReceiptUrl
      : null,
    customer: typeof p.customer === "string" ? p.customer : null,
    subscription: typeof p.subscription === "string" ? p.subscription : null,
    deleted,
  };
}

/** Linha digitável do boleto. Qualquer falha = null (a mensagem sai só com link). */
export async function readBoletoDigitableLine(
  integration: Pick<ResolvedAsaasIntegration, "baseUrl" | "apiKey">,
  asaasPaymentId: string,
  transport: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await transport(
      `${integration.baseUrl}/payments/${
        encodeURIComponent(asaasPaymentId)
      }/identificationField`,
      {
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return normalizeDigitableLine(body?.identificationField);
  } catch {
    return null;
  }
}

/** Pix copia e cola. Qualquer falha = null (a mensagem sai só com link). */
export async function readPixCopyPaste(
  integration: Pick<ResolvedAsaasIntegration, "baseUrl" | "apiKey">,
  asaasPaymentId: string,
  transport: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const response = await transport(
      `${integration.baseUrl}/payments/${
        encodeURIComponent(asaasPaymentId)
      }/pixQrCode`,
      {
        headers: { access_token: integration.apiKey },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return normalizePixCopyPaste(body?.payload);
  } catch {
    return null;
  }
}

/**
 * Mesma trava do aviso de vencimento: agenda ativa OU aula nos últimos 30 dias.
 * (Cópia de `aindaEstuda` em notify-payment-due/index.ts.)
 */
export async function studentStillStudies(
  supabase: AdminClient,
  tenantId: string,
  studentId: string,
  today = new Date(),
): Promise<boolean> {
  const { count: agenda, error: agendaError } = await supabase.from(
    "bookings",
  )
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("student_id", studentId).eq("status", "SCHEDULED");
  if (agendaError) throw new Error("student_activity_unavailable");
  if ((agenda ?? 0) > 0) return true;
  const limite = new Date(today.getTime() - 30 * 86400_000).toISOString()
    .split("T")[0];
  const { count: aulas, error: aulasError } = await supabase.from("class_logs")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("student_id", studentId).gte("class_date", limite);
  if (aulasError) throw new Error("student_activity_unavailable");
  return (aulas ?? 0) > 0;
}

export async function studentNotificationsEnabled(
  supabase: AdminClient,
  tenantId: string,
): Promise<boolean> {
  const { data, error } = await supabase.from("tenant_admin_settings")
    .select("student_notifications_enabled")
    .eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new Error("student_notification_settings_unavailable");
  return data?.student_notifications_enabled === true;
}

export type PaymentNoticeRecipient = {
  ok: boolean;
  phone: string;
  instance: string;
  nome: string;
  brandName: string;
  motivo: string;
};

/**
 * Destinatário de WhatsApp. Mesma regra de `resolveRecipient` do
 * notify-payment-due: conta de teste e aluno não notificável ficam de fora;
 * dependente vai ao responsável financeiro, nunca ao telefone do filho.
 */
export async function resolvePaymentNoticeRecipient(
  supabase: AdminClient,
  tenantId: string,
  studentId: string,
): Promise<PaymentNoticeRecipient> {
  const no = (motivo: string): PaymentNoticeRecipient => ({
    ok: false,
    phone: "",
    instance: "",
    nome: "",
    brandName: "",
    motivo,
  });
  const { data: student, error } = await supabase.from("profiles")
    .select(
      "full_name, phone, guardian_id, guardian_cpf, guardian_name, guardian_phone, is_test_account",
    )
    .eq("id", studentId)
    .eq("tenant_id", tenantId)
    .eq("role", "STUDENT")
    .maybeSingle();
  if (error) throw new Error("student_recipient_lookup_failed");
  if (!student) return no("aluno fora da escola");
  if (student.is_test_account === true) return no("conta de teste");
  const eligibility = await supabase.rpc("is_student_notifiable", {
    p_id: studentId,
  });
  if (eligibility.error) {
    throw new Error("student_notification_revalidation_failed");
  }
  if (eligibility.data !== true) return no("aluno inativo (sem notificar)");
  const recipient = resolvePaymentRecipient(student);
  if (!recipient.ok) return no(recipient.reason);
  const context = await loadTenantCentralWhatsAppContext(
    supabase,
    tenantId,
    "student",
  );
  if (!context) return no("escola sem WhatsApp central");
  return {
    ok: true,
    phone: recipient.phone,
    instance: context.instanceName,
    nome: recipient.firstName,
    brandName: context.identity.brandName,
    motivo: "",
  };
}

/** Nome para o e-mail (responsável financeiro quando dependente). */
export async function payerFirstName(
  supabase: AdminClient,
  tenantId: string,
  studentId: string,
): Promise<string> {
  const { data } = await supabase.from("profiles")
    .select("full_name, guardian_id, guardian_cpf, guardian_name")
    .eq("id", studentId).eq("tenant_id", tenantId).maybeSingle();
  const guardian = Boolean(data?.guardian_id || data?.guardian_cpf);
  const full = String((guardian ? data?.guardian_name : data?.full_name) || "")
    .trim();
  return full.split(/\s+/)[0] || (guardian ? "Responsável" : "Aluno");
}

export async function tenantBrandName(
  supabase: AdminClient,
  tenantId: string,
): Promise<string> {
  const context = await loadTenantCentralWhatsAppContext(
    supabase,
    tenantId,
    "student",
  ).catch(() => null);
  if (context?.identity?.brandName) return context.identity.brandName;
  const { data, error } = await supabase.from("tenants").select("name")
    .eq("id", tenantId).maybeSingle();
  if (error || !data?.name) throw new Error("school_identity_unavailable");
  return String(data.name);
}

/**
 * WhatsApp já aceito/incerto hoje para esta fatura? Evita dois avisos de
 * cobrança no mesmo dia (ex.: D-3 e D0 na mesma rodada, ou nova cobrança
 * criada exatamente 10 dias antes do vencimento).
 */
export async function paymentMessagedToday(
  supabase: AdminClient,
  tenantId: string,
  paymentId: string,
  today: string,
): Promise<boolean> {
  const { count, error } = await supabase.from(
    "asaas_outbound_message_attempts",
  )
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("provider_entity_id", paymentId)
    .like("notification_kind", "PAYMENT_%")
    .in("status", ["SENT", "SUBMITTING", "UNKNOWN"])
    .gte("updated_at", `${today}T00:00:00-03:00`);
  if (error) throw new Error("payment_message_history_unavailable");
  return (count ?? 0) > 0;
}

export type PaymentNoticeDelivery = {
  status: "SENT" | "FAILED" | "UNKNOWN" | "SUPPRESSED" | "SKIPPED";
  sentNow: boolean;
  reason: string;
  retryAfterSeconds: number;
};

/**
 * Envio único e durável (mesma ordem de `deliverPaymentNotification` do
 * notify-payment-due): claim → permit → SUBMITTING → POST → finish.
 */
export async function deliverPaymentNoticeWhatsApp(
  supabase: AdminClient,
  input: {
    tenantId: string;
    studentId: string;
    paymentId: string;
    notificationKind: string;
    integration: ResolvedEvolutionIntegration;
    instance: string;
    phone: string;
    text: string;
  },
): Promise<PaymentNoticeDelivery> {
  const claim = await claimOutboundMessage(supabase, {
    tenantId: input.tenantId,
    studentId: input.studentId,
    providerEntityId: input.paymentId,
    notificationKind: input.notificationKind,
  });
  if (claim.action === "ALREADY_FINAL") {
    const status = String(claim.status || "UNKNOWN").toUpperCase();
    return {
      status: status === "SENT"
        ? "SENT"
        : status === "FAILED"
        ? "FAILED"
        : status === "SUPPRESSED"
        ? "SUPPRESSED"
        : "UNKNOWN",
      sentNow: false,
      reason: `durable_${status.toLowerCase()}`,
      retryAfterSeconds: 0,
    };
  }
  if (claim.action !== "SUBMIT_ONCE") {
    return {
      status: "SKIPPED",
      sentNow: false,
      reason: claim.reason || claim.action.toLowerCase(),
      retryAfterSeconds: claim.action === "IN_PROGRESS" ? 300 : 0,
    };
  }

  const resolvedDestination = await resolveWhatsAppDestination({
    base: input.integration.baseUrl,
    keys: [input.integration.apiKey],
    instance: input.instance,
    to: input.phone,
  });
  const permit = await requestOutboundPermit(
    input.instance,
    resolvedDestination,
  );
  if (permit?.allowed === false) {
    const retryAfterSeconds = Math.max(
      60,
      Math.ceil(Number(permit.wait_ms || 60_000) / 1000),
    );
    await deferOutboundMessageClaim(supabase, claim, {
      retryAfterSeconds,
      reason: `throttled_${permit.kind || "outbound"}`,
    });
    return {
      status: "SKIPPED",
      sentNow: false,
      reason: `throttled_${permit.kind || "outbound"}`,
      retryAfterSeconds,
    };
  }
  if (permit?.allowed) {
    const waitMs = Math.min(
      Math.max(0, Number(permit.wait_ms || 0)),
      THROTTLE_MAX_INLINE_WAIT_MS,
    );
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const mark = await markOutboundMessageSubmittingDecision(supabase, claim);
  if (mark.ok !== true || mark.status !== "SUBMITTING") {
    await settleOutboundPermit(permit?.ledger_id, false);
    return {
      status: mark.status === "SUPPRESSED" ? "SUPPRESSED" : "SKIPPED",
      sentNow: false,
      reason: mark.reason || "outbound_message_suppressed_before_send",
      retryAfterSeconds: 0,
    };
  }

  const providerResult = await sendWhatsTextToResolvedDestinationDetailed({
    base: input.integration.baseUrl,
    keys: [input.integration.apiKey],
    instance: input.instance,
    to: resolvedDestination,
    text: input.text,
    delayMs: 800,
    throttle: "skip",
  });
  await settleOutboundPermit(
    permit?.ledger_id,
    providerResult.outcome === "accepted",
  );
  const finish = paymentNotificationFinish(providerResult);
  try {
    await finishOutboundMessage(supabase, claim, finish);
  } catch {
    // SUBMITTING já é durável: nunca repetir o POST só porque gravar o
    // resultado falhou.
    return {
      status: "UNKNOWN",
      sentNow: false,
      reason: "outbound_message_finish_failed",
      retryAfterSeconds: 0,
    };
  }
  return {
    status: finish.status,
    sentNow: finish.status === "SENT",
    reason: finish.error || "sent",
    retryAfterSeconds: 0,
  };
}
