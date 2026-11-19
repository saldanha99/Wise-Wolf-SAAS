// E-mail transacional de cobrança (Resend) com intenção durável.
//
// Extraído de `notify-payment-due/daily.ts` (deliverDailyEmail/verifiedEmail)
// para os avisos que substituem as notificações pagas do Asaas: nova cobrança,
// cobrança alterada, lembretes D-10/D0 e recibo. O fluxo diário continua com a
// própria cópia para não arriscar regressão.
//
// Regras: a intenção é gravada (SUBMITTING) antes do POST; a chave única
// (escola, fatura, tipo, data de referência) impede um segundo envio; resultado
// incerto fica UNKNOWN e nunca é repetido automaticamente.

// Cliente mínimo usado aqui: o tipo completo do supabase-js não é necessário e
// deixaria o módulo preso a uma versão específica do SDK.
// deno-lint-ignore no-explicit-any
type EmailAdminClient = any;

export const PAYMENT_NOTICE_EMAIL_KINDS = [
  "PAYMENT_CREATED_EMAIL",
  "PAYMENT_UPDATED_EMAIL",
  "PAYMENT_DUE_REMINDER_D10_EMAIL",
  "PAYMENT_DUE_REMINDER_D0_EMAIL",
  "PAYMENT_RECEIVED_EMAIL",
] as const;
export type PaymentNoticeEmailKind = typeof PAYMENT_NOTICE_EMAIL_KINDS[number];

export type PaymentEmailResult =
  | "SENT"
  | "REJECTED"
  | "UNKNOWN"
  | "ALREADY_ATTEMPTED"
  | "PROVIDER_UNAVAILABLE"
  | "CLAIM_FAILED"
  | "RESULT_NOT_PERSISTED";

export function paymentEmailIdempotencyKey(input: {
  kind: string;
  tenantId: string;
  paymentId: string;
  refDate: string;
}): string {
  return `payment-notice-${input.kind.toLowerCase()}-${input.tenantId}-${input.paymentId}-${input.refDate}`;
}

/**
 * Destinatário de e-mail financeiro: o titular autenticado ou, para dependente,
 * o responsável financeiro vinculado com o mesmo endereço do contato
 * financeiro. Mesma regra do fluxo diário (`verifiedEmail`).
 */
export async function resolveVerifiedPaymentEmail(
  client: EmailAdminClient,
  studentId: string,
  tenantId: string,
): Promise<{ email: string; guardian: boolean } | null> {
  const { data: student, error: studentError } = await client.from("profiles")
    .select(
      "id,role,email,is_test_account,guardian_id,guardian_cpf,guardian_email",
    )
    .eq("id", studentId).eq("tenant_id", tenantId).maybeSingle();
  if (
    studentError || !student || student.role !== "STUDENT" ||
    student.is_test_account === true
  ) return null;
  const guardian = Boolean(student.guardian_id || student.guardian_cpf);
  let id = String(student.id);
  let email = String(student.email || "").trim().toLowerCase();
  if (guardian) {
    if (!student.guardian_id) return null;
    const { data: payer, error } = await client.from("profiles")
      .select("id,email,is_test_account")
      .eq("id", student.guardian_id).eq("tenant_id", tenantId).maybeSingle();
    if (error || !payer || payer.is_test_account) return null;
    id = String(payer.id);
    email = String(payer.email || "").trim().toLowerCase();
    if (email !== String(student.guardian_email || "").trim().toLowerCase()) {
      return null;
    }
  }
  const { data, error } = await client.auth.admin.getUserById(id);
  if (
    error || !data?.user?.email_confirmed_at ||
    String(data.user.email || "").toLowerCase() !== email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.endsWith("@accounts.invalid")
  ) return null;
  return { email, guardian };
}

export async function deliverPaymentNoticeEmail(
  client: EmailAdminClient,
  input: {
    kind: PaymentNoticeEmailKind;
    tenantId: string;
    paymentId: string;
    studentId: string;
    refDate: string;
    email: string;
    subject: string;
    text: string;
  },
  transport: typeof fetch = fetch,
  getEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): Promise<PaymentEmailResult> {
  if (
    !PAYMENT_NOTICE_EMAIL_KINDS.includes(input.kind) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.refDate)
  ) return "CLAIM_FAILED";
  const apiKey = getEnv("RESEND_API_KEY")?.trim();
  const from = getEnv("RESEND_FROM_EMAIL")?.trim();
  if (!apiKey || !from) return "PROVIDER_UNAVAILABLE";
  const key = paymentEmailIdempotencyKey(input);
  const { data: attempt, error } = await client.from(
    "payment_notification_email_attempts",
  )
    .insert({
      tenant_id: input.tenantId,
      payment_id: input.paymentId,
      student_id: input.studentId,
      kind: input.kind,
      ref_date: input.refDate,
      recipient_email: input.email,
      provider_idempotency_key: key,
      status: "SUBMITTING",
    }).select("id").single();
  if (error?.code === "23505") return "ALREADY_ATTEMPTED";
  if (error || !attempt?.id) return "CLAIM_FAILED";

  let status: "SENT" | "REJECTED" | "UNKNOWN" = "UNKNOWN";
  let messageId: string | null = null;
  let http: number | null = null;
  let lastError: string | null = null;
  try {
    const response = await transport("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({
        from,
        to: [input.email],
        subject: input.subject.replace(/[\r\n]/g, " ").slice(0, 200),
        text: input.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    http = response.status;
    const result = await response.json().catch(() => null);
    messageId = typeof result?.id === "string" ? result.id : null;
    if (response.ok && messageId) status = "SENT";
    else if (response.status >= 400 && response.status < 500) {
      status = "REJECTED";
      lastError = "provider_rejected";
    } else lastError = "provider_outcome_unknown";
  } catch {
    // Resultado incerto fica terminal: nunca repetir o POST no escuro.
    lastError = "provider_outcome_unknown";
  }
  const { error: finishError } = await client.from(
    "payment_notification_email_attempts",
  )
    .update({
      status,
      provider_message_id: messageId,
      provider_http_status: http,
      last_error: lastError,
      updated_at: new Date().toISOString(),
    }).eq("id", attempt.id).eq("status", "SUBMITTING");
  return finishError ? "RESULT_NOT_PERSISTED" : status;
}
