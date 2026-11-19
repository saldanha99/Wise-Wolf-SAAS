// Núcleo puro dos avisos de cobrança que substituem as notificações pagas do Asaas.
//
// 19/11/2026: a escola desligou TODAS as notificações do Asaas ao cliente
// (cada e-mail/SMS custava dinheiro) e os clientes novos passam a ser criados com
// `notificationDisabled: true`. O próprio sistema cobre agora, por WhatsApp
// (instância central) e e-mail (Resend):
//   - PAYMENT_CREATED  → nova cobrança com link (webhook → fila);
//   - PAYMENT_UPDATED  → vencimento alterado (webhook → fila, chave por data);
//   - D-10 e D0        → lembretes no cron das 09h (notify-payment-due);
//   - PAYMENT_RECEIVED → comprovante do Asaas na confirmação + recibo por e-mail.
// Vencidas continuam na régua/cobrança diária existente (não mudou).
//
// Toda mensagem passa pela cerca durável `asaas_outbound_message_attempts`
// (claim → permit → SUBMITTING → POST → finish). Timeout = UNKNOWN, nunca
// reenviado. Este arquivo é puro (sem rede/banco) para ser testável e usado
// também pelo webhook sem carregar o envio.

export type PaymentNoticeStage = "CREATED" | "UPDATED" | "D10" | "D0";

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dias corridos entre a data da escola (hoje) e o vencimento. */
export function daysUntilDue(today: string, dueDate: string): number | null {
  if (!ISO_DATE.test(today) || !ISO_DATE.test(dueDate)) return null;
  const a = Date.parse(`${today}T12:00:00Z`);
  const b = Date.parse(`${dueDate}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400_000);
}

/**
 * Estágio dos lembretes novos. Mesmo calendário do Asaas: exatamente 10 dias
 * antes e no dia do vencimento. O D-3 (1 a 3 dias, `PAYMENT_DUE_REMINDER`)
 * continua no fluxo antigo e não é decidido aqui.
 */
export function dueReminderStage(
  today: string,
  dueDate: string,
): "D10" | "D0" | null {
  const days = daysUntilDue(today, dueDate);
  if (days === 10) return "D10";
  if (days === 0) return "D0";
  return null;
}

/**
 * Nome do envio na cerca durável. A chave do claim é (fatura, tipo): tipos com
 * data embutida deixam um vencimento novo gerar um aviso novo, e o mesmo
 * vencimento nunca gera dois.
 */
export function paymentNoticeWhatsAppKind(
  stage: PaymentNoticeStage,
  dueDate: string,
): string {
  if (!ISO_DATE.test(dueDate)) {
    throw new Error("payment_notice_due_date_invalid");
  }
  const ymd = dueDate.replaceAll("-", "");
  if (stage === "CREATED") return "PAYMENT_CREATED_WHATSAPP";
  if (stage === "UPDATED") return `PAYMENT_UPDATED_WHATSAPP_${ymd}`;
  if (stage === "D10") return `PAYMENT_DUE_REMINDER_D10_${ymd}`;
  return `PAYMENT_DUE_REMINDER_D0_${ymd}`;
}

export function paymentNoticeEmailKind(
  stage: PaymentNoticeStage,
):
  | "PAYMENT_CREATED_EMAIL"
  | "PAYMENT_UPDATED_EMAIL"
  | "PAYMENT_DUE_REMINDER_D10_EMAIL"
  | "PAYMENT_DUE_REMINDER_D0_EMAIL" {
  if (stage === "CREATED") return "PAYMENT_CREATED_EMAIL";
  if (stage === "UPDATED") return "PAYMENT_UPDATED_EMAIL";
  if (stage === "D10") return "PAYMENT_DUE_REMINDER_D10_EMAIL";
  return "PAYMENT_DUE_REMINDER_D0_EMAIL";
}

/** Link só do próprio Asaas (produção), https, sem credenciais na URL. */
export function validAsaasUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (
      u.protocol !== "https:" || u.username || u.password ||
      !["asaas.com", "www.asaas.com"].includes(u.hostname)
    ) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Comprovante (`transactionReceiptUrl`): mesma regra de host do Asaas. */
export function validReceiptUrl(raw: unknown): string | null {
  return validAsaasUrl(raw);
}

/** Cartão é debitado automaticamente: "pague pelo link" confundiria o aluno. */
export function isAutomaticCardCharge(billingType: unknown): boolean {
  return String(billingType || "").trim().toUpperCase() === "CREDIT_CARD";
}

export function normalizeDigitableLine(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const line = raw.trim().replace(/\s+/g, " ");
  const digits = line.replace(/\D/g, "");
  if (digits.length < 44 || digits.length > 48) return null;
  if (!/^[0-9 .]+$/.test(line)) return null;
  return line;
}

export function normalizePixCopyPaste(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const payload = raw.trim();
  if (
    payload.length < 30 || payload.length > 600 ||
    /[\u0000-\u001f\u007f]/.test(payload) || !payload.startsWith("000201")
  ) return null;
  return payload;
}

const brl = (value: number) =>
  `R$ ${
    value.toLocaleString("pt-BR", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  }`;
const dataBR = (iso: string) => iso.split("-").reverse().join("/");
const clean = (s: string) => s.replace(/[\r\n*_~`]/g, " ").trim();

export type PaymentNoticeMessage = {
  whatsapp: string;
  email: string;
  subject: string;
};

/**
 * Texto do aviso. WhatsApp usa *negrito*; e-mail é texto puro. A linha
 * digitável e o Pix copia e cola só aparecem no D0 e são opcionais: sem eles
 * a mensagem sai apenas com o link da fatura.
 */
export function buildPaymentNoticeMessage(input: {
  stage: PaymentNoticeStage;
  name: string;
  brandName: string;
  value: number;
  dueDate: string;
  invoiceUrl: string;
  digitableLine?: string | null;
  pixCopyPaste?: string | null;
}): PaymentNoticeMessage {
  const name = clean(input.name) || "tudo bem";
  const brand = clean(input.brandName) || "escola";
  const build = (bold: (s: string) => string) => {
    const valor = bold(brl(input.value));
    const venc = bold(dataBR(input.dueDate));
    let body = "";
    if (input.stage === "CREATED") {
      body = `Sua nova mensalidade de ${valor} já está disponível, ` +
        `com vencimento em ${venc}.`;
    } else if (input.stage === "UPDATED") {
      body = `Sua mensalidade foi atualizada: valor de ${valor}, ` +
        `com novo vencimento em ${venc}.`;
    } else if (input.stage === "D10") {
      body = `Lembrete: sua mensalidade de ${valor} vence em ${venc} ` +
        `(daqui a 10 dias).`;
    } else {
      body = `Sua mensalidade de ${valor} vence ${bold("hoje")} (${
        dataBR(input.dueDate)
      }).`;
    }
    let text = `Oi ${name}! Aqui é a ${brand}.\n\n${body}\n\n` +
      `Pague pelo link: ${input.invoiceUrl}`;
    if (input.stage === "D0") {
      const line = normalizeDigitableLine(input.digitableLine);
      const pix = normalizePixCopyPaste(input.pixCopyPaste);
      if (line) text += `\n\nLinha digitável do boleto:\n${line}`;
      if (pix) text += `\n\nPix copia e cola:\n${pix}`;
    }
    text +=
      `\n\nSe já pagou, desconsidere esta mensagem. Qualquer dúvida, é só responder.`;
    return text;
  };
  const subjects: Record<PaymentNoticeStage, string> = {
    CREATED: "Nova mensalidade disponível",
    UPDATED: "Mensalidade atualizada",
    D10: "Lembrete: mensalidade vence em 10 dias",
    D0: "Sua mensalidade vence hoje",
  };
  return {
    whatsapp: build((s) => `*${s}*`),
    email: build((s) => s),
    subject: `${subjects[input.stage]} - ${brand}`,
  };
}

/** Recibo por e-mail (PAYMENT_RECEIVED). Comprovante só se for do Asaas. */
export function buildPaymentReceiptEmail(input: {
  name: string;
  brandName: string;
  value: number;
  dueDate: string;
  receiptUrl: string | null;
}): { subject: string; text: string } {
  const name = clean(input.name) || "tudo bem";
  const brand = clean(input.brandName) || "escola";
  let text = `Olá, ${name}.\n\n` +
    `Recebemos o pagamento de ${brl(input.value)} referente à mensalidade ` +
    `com vencimento em ${dataBR(input.dueDate)}. Obrigado!`;
  const receipt = validReceiptUrl(input.receiptUrl);
  if (receipt) text += `\n\nComprovante: ${receipt}`;
  text += `\n\nQualquer dúvida, é só responder a escola.`;
  return { subject: `Pagamento confirmado - ${brand}`, text };
}

/** Sufixo do comprovante na confirmação de WhatsApp já existente. */
export function receiptSuffix(rawReceiptUrl: unknown): string {
  const url = validReceiptUrl(rawReceiptUrl);
  return url ? `\n\nComprovante: ${url}` : "";
}

/**
 * Decide se um evento PAYMENT_CREATED/PAYMENT_UPDATED já aplicado vira aviso.
 * Forma plana (sem união discriminada): o `deno check` do projeto não estreita.
 */
export type PaymentNoticeEnqueueDecision = {
  enqueue: boolean;
  kind: "PAYMENT_CREATED" | "PAYMENT_UPDATED" | "";
  idempotencyKey: string;
  dueDateChanged: boolean;
  reason: string;
};

export function paymentNoticeEnqueueDecision(input: {
  event: string;
  paymentId: string;
  providerStatus: string;
  localStatus: string | null;
  paymentType: string;
  billingType: string | null;
  dueDate: string;
  previousDueDate: string | null;
  today: string;
  value: number;
  deleted: boolean;
  isTestAccount: boolean;
}): PaymentNoticeEnqueueDecision {
  const no = (reason: string): PaymentNoticeEnqueueDecision => ({
    enqueue: false,
    kind: "",
    idempotencyKey: "",
    dueDateChanged: false,
    reason,
  });
  const event = input.event.trim().toUpperCase();
  if (event !== "PAYMENT_CREATED" && event !== "PAYMENT_UPDATED") {
    return no("event_not_notified");
  }
  if (!input.paymentId) return no("payment_missing");
  if (input.isTestAccount) return no("test_account");
  if (input.deleted) return no("payment_deleted");
  if (input.providerStatus.trim().toUpperCase() !== "PENDING") {
    return no("provider_not_pending");
  }
  if (String(input.localStatus || "").trim().toUpperCase() !== "PENDING") {
    return no("local_not_pending");
  }
  if (!["SUBSCRIPTION", "PRO_RATA"].includes(input.paymentType)) {
    return no("payment_type_not_notified");
  }
  if (isAutomaticCardCharge(input.billingType)) return no("card_automatic");
  if (!Number.isFinite(input.value) || input.value <= 0) {
    return no("value_invalid");
  }
  const days = daysUntilDue(input.today, input.dueDate);
  if (days === null) return no("due_date_invalid");
  if (days < 0) return no("already_overdue");
  if (event === "PAYMENT_CREATED") {
    return {
      enqueue: true,
      kind: "PAYMENT_CREATED",
      idempotencyKey: `payment-notice:created:${input.paymentId}`,
      dueDateChanged: false,
      reason: "",
    };
  }
  if (!input.previousDueDate || input.previousDueDate === input.dueDate) {
    return no("updated_without_due_date_change");
  }
  return {
    enqueue: true,
    kind: "PAYMENT_UPDATED",
    idempotencyKey:
      `payment-notice:updated:${input.paymentId}:${input.dueDate}`,
    dueDateChanged: true,
    reason: "",
  };
}

export type AsaasNoticePayment = {
  id: string;
  status: string;
  dueDate: string;
  value: number;
  billingType: string;
  invoiceUrl: string | null;
  transactionReceiptUrl: string | null;
  customer: string | null;
  subscription: string | null;
  deleted: boolean;
};

/** D0: boleto (ou indefinido) tenta a linha; qualquer forma não-cartão tenta Pix. */
export function d0ExtrasToRead(billingType: string): {
  boleto: boolean;
  pix: boolean;
} {
  const type = billingType.trim().toUpperCase();
  return {
    boleto: type === "BOLETO" || type === "UNDEFINED" || type === "",
    pix: type !== "CREDIT_CARD" && type !== "DEBIT_CARD",
  };
}

/**
 * Fatura ainda pendente no Asaas, igual à local, com link válido e não cartão.
 */
export function noticeProviderEligible(
  local: { asaas_payment_id: string | null; due_date: string; value: number },
  provider: AsaasNoticePayment,
): { ok: boolean; reason: string; invoiceUrl: string } {
  const fail = (reason: string) => ({ ok: false, reason, invoiceUrl: "" });
  if (provider.deleted || provider.status !== "PENDING") {
    return fail("provider_not_pending");
  }
  if (provider.id !== local.asaas_payment_id) return fail("provider_mismatch");
  if (provider.dueDate !== local.due_date) return fail("provider_due_changed");
  if (Math.abs(provider.value - Number(local.value)) > 0.009) {
    return fail("provider_value_changed");
  }
  if (isAutomaticCardCharge(provider.billingType)) {
    return fail("card_automatic");
  }
  const invoiceUrl = validAsaasUrl(provider.invoiceUrl);
  if (!invoiceUrl) return fail("invoice_link_unavailable");
  return { ok: true, reason: "", invoiceUrl };
}
