// Abertura/clique de e-mail de cobrança (Resend `email.opened` /
// `email.clicked`), gravados na linha da intenção de e-mail (o registro
// durável do envio) e resumidos na fatura para o painel financeiro.
//
// Abertura é "provável": a Proteção de Privacidade do Apple Mail e scanners
// baixam as imagens sem a pessoa ler. Por isso nada aqui avisa a escola; o
// aviso confiável vem do Asaas (fatura/boleto visualizado).

// deno-lint-ignore no-explicit-any
type AdminClient = any;

/** Tabelas de intenção de e-mail de cobrança, com `provider_message_id`. */
export const PAYMENT_EMAIL_ATTEMPT_TABLES = [
  "payment_notification_email_attempts",
  "daily_payment_email_attempts",
  "payment_overdue_email_attempts",
] as const;

export type EngagementOutcome = "IGNORED" | "UNKNOWN_EMAIL" | "RECORDED";

type ResendEvent = {
  type?: unknown;
  created_at?: unknown;
  data?: { email_id?: unknown; created_at?: unknown } | null;
};

function eventInstant(event: ResendEvent, now: Date): string {
  const raw = typeof event.created_at === "string" ? event.created_at : "";
  const parsed = new Date(raw);
  return raw && !Number.isNaN(parsed.getTime())
    ? parsed.toISOString()
    : now.toISOString();
}

export async function recordEmailEngagement(
  admin: AdminClient,
  event: ResendEvent,
  now = new Date(),
): Promise<EngagementOutcome> {
  const kind = event.type === "email.opened"
    ? "opened"
    : event.type === "email.clicked"
    ? "clicked"
    : null;
  const emailId = typeof event.data?.email_id === "string"
    ? event.data.email_id.trim()
    : "";
  if (!kind || !emailId || emailId.length > 200) return "IGNORED";
  const at = eventInstant(event, now);
  const attemptColumn = `${kind}_at`;
  const paymentColumn = `email_${kind}_at`;

  for (const table of PAYMENT_EMAIL_ATTEMPT_TABLES) {
    const { data: attempt, error } = await admin.from(table)
      .select("id,payment_id")
      .eq("provider_message_id", emailId)
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("email_engagement_lookup_failed");
    if (!attempt?.id) continue;

    // Primeira abertura/clique fica registrada na intenção; repetir é inócuo.
    const { error: attemptError } = await admin.from(table)
      .update({ [attemptColumn]: at })
      .eq("id", attempt.id)
      .is(attemptColumn, null);
    if (attemptError) throw new Error("email_engagement_mark_failed");

    // Na fatura vale o mais recente, para o painel.
    const { error: paymentError } = await admin.from("student_payments")
      .update({ [paymentColumn]: at })
      .eq("id", attempt.payment_id)
      .or(`${paymentColumn}.is.null,${paymentColumn}.lt.${at}`);
    if (paymentError) throw new Error("email_engagement_payment_failed");
    return "RECORDED";
  }
  return "UNKNOWN_EMAIL";
}
