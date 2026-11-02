import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type DailyCharge = {
  id: string;
  student_id: string;
  tenant_id: string;
  asaas_payment_id: string | null;
  value: number;
  due_date: string;
  invoice_url: string | null;
};
export type DailyProviderPayment = {
  id: string;
  status: string;
  dueDate: string;
  value: number;
  invoiceUrl: string | null;
  customer: string | null;
  subscription: string | null;
  deleted?: boolean;
};
type Student = {
  id: string;
  role: string;
  full_name: string;
  email: string | null;
  asaas_customer_id: string | null;
  subscription_id: string | null;
  contract_accepted: boolean;
  status: string;
  lifecycle_status: string;
  is_test_account: boolean;
  guardian_id: string | null;
  guardian_cpf: string | null;
  guardian_email: string | null;
};
export type DailyDependencies = {
  readProvider: (charge: DailyCharge) => Promise<DailyProviderPayment>;
  stillStudies: (charge: DailyCharge) => Promise<boolean>;
  recipient: (charge: DailyCharge) => Promise<{
    ok: boolean;
    motivo: string;
    nome: string;
    brandName: string;
    phone: string;
    instance: string;
  }>;
  whatsapp: (charge: DailyCharge, input: {
    kind: string;
    phone: string;
    instance: string;
    text: string;
  }) => Promise<{ status: string; sentNow: boolean; reason: string }>;
};

export function schoolDate(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function dailyProviderEligible(
  charge: DailyCharge,
  student: Pick<Student, "asaas_customer_id" | "subscription_id">,
  provider: DailyProviderPayment,
  date: string,
): boolean {
  return !provider.deleted && provider.status === "OVERDUE" &&
    provider.id === charge.asaas_payment_id &&
    Boolean(student.asaas_customer_id && student.subscription_id) &&
    provider.customer === student.asaas_customer_id &&
    provider.subscription === student.subscription_id &&
    provider.dueDate < date && /^\d{4}-\d{2}-\d{2}$/.test(provider.dueDate) &&
    Number.isFinite(provider.value) && provider.value > 0;
}

export function validInvoiceUrl(raw: string | null): boolean {
  try {
    const u = new URL(raw || "");
    return u.protocol === "https:" && !u.username && !u.password &&
      ["asaas.com", "www.asaas.com"].includes(u.hostname);
  } catch {
    return false;
  }
}

export function dailyCollectionText(input: {
  studentName: string;
  brandName: string;
  value: number;
  dueDate: string;
  invoiceUrl: string;
  date: string;
  guardian: boolean;
}): string {
  const clean = (s: string) => s.replace(/[\r\n*]/g, " ").trim();
  const money = input.value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const br = (s: string) => s.split("-").reverse().join("/");
  const who = clean(input.studentName);
  return `Olá! Aqui é a ${clean(input.brandName)}.\n\n` +
    `${
      input.guardian ? "Ao responsável financeiro: a" : "A"
    } mensalidade de ${who}, no valor de R$ ${money}, ` +
    `vencida em ${br(input.dueDate)}, continua em aberto no Asaas em ${
      br(input.date)
    }.\n\n` +
    `Pedimos a regularização hoje ou contato com a escola para negociar. ` +
    `Enquanto a cobrança permanecer vencida, enviaremos um lembrete diário.\n\n` +
    `Link para pagamento: ${input.invoiceUrl}\n\n` +
    `Se já pagou, envie o comprovante para conferirmos a baixa. Se precisar negociar, responda esta mensagem.`;
}

export async function enabledDailyTenants(
  client: SupabaseClient,
): Promise<string[]> {
  const { data, error } = await client.from("daily_payment_collection_settings")
    .select("tenant_id").eq("enabled", true);
  if (error) throw new Error("daily_collection_settings_unavailable");
  return (data || []).map((r: { tenant_id: string }) => r.tenant_id);
}

async function verifiedEmail(
  client: SupabaseClient,
  student: Student,
  tenant: string,
) {
  const guardian = Boolean(student.guardian_id || student.guardian_cpf);
  let id = student.id;
  let email = student.email?.trim().toLowerCase() || "";
  if (guardian) {
    if (!student.guardian_id) return null;
    const { data: payer, error } = await client.from("profiles")
      .select("id,email,is_test_account")
      .eq("id", student.guardian_id).eq("tenant_id", tenant).maybeSingle();
    if (error || !payer || payer.is_test_account) return null;
    id = payer.id;
    email = payer.email?.trim().toLowerCase() || "";
    if (email !== student.guardian_email?.trim().toLowerCase()) return null;
  }
  const { data, error } = await client.auth.admin.getUserById(id);
  if (
    error || !data.user?.email_confirmed_at ||
    data.user.email?.toLowerCase() !== email ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.endsWith("@accounts.invalid")
  ) return null;
  return { email, guardian };
}

// A intenção é persistida antes do POST. Uma resposta incerta nunca é repetida
// no mesmo dia, mesmo quando o resultado não pôde ser gravado.
export async function deliverDailyEmail(
  client: SupabaseClient,
  charge: DailyCharge,
  date: string,
  email: string,
  body: string,
  brand: string,
  transport: typeof fetch = fetch,
  getEnv: (key: string) => string | undefined = (key) => Deno.env.get(key),
): Promise<string> {
  const key = `daily-payment-${charge.tenant_id}-${charge.id}-${date}`;
  const apiKey = getEnv("RESEND_API_KEY");
  const from = getEnv("RESEND_FROM_EMAIL");
  if (!apiKey || !from) return "PROVIDER_UNAVAILABLE";
  const { data: attempt, error } = await client.from(
    "daily_payment_email_attempts",
  )
    .insert({
      tenant_id: charge.tenant_id,
      payment_id: charge.id,
      student_id: charge.student_id,
      campaign_date: date,
      recipient_email: email,
      provider_idempotency_key: key,
      status: "SUBMITTING",
    }).select("id").single();
  if (error?.code === "23505") return "ALREADY_ATTEMPTED";
  if (error || !attempt?.id) return "CLAIM_FAILED";
  let status = "UNKNOWN";
  let messageId: string | null = null;
  let http: number | null = null;
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
        to: [email],
        subject: `Pagamento pendente — ${brand.replace(/[\r\n]/g, " ")}`,
        text: body,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    http = response.status;
    const result = await response.json().catch(() => null);
    messageId = typeof result?.id === "string" ? result.id : null;
    if (response.ok && messageId) status = "SENT";
    else if (response.status >= 400 && response.status < 500) {
      status = "REJECTED";
    }
  } catch { /* resultado incerto fica terminal neste dia */ }
  const { error: finishError } = await client.from(
    "daily_payment_email_attempts",
  )
    .update({
      status,
      provider_message_id: messageId,
      provider_http_status: http,
      updated_at: new Date().toISOString(),
    }).eq("id", attempt.id).eq("status", "SUBMITTING");
  return finishError ? "RESULT_NOT_PERSISTED" : status;
}

export async function runDailyCollections(
  client: SupabaseClient,
  date: string,
  deps: DailyDependencies,
  scope?: { tenant_id: string; student_ids: string[] },
) {
  const enabled = await enabledDailyTenants(client);
  const tenants = scope
    ? enabled.filter((id) => id === scope.tenant_id)
    : enabled;
  const result = {
    campaign_date: date,
    considered: 0,
    whatsapp_sent: 0,
    email_sent: 0,
    skipped: 0,
    failures: 0,
    reasons: [] as string[],
  };
  if (!tenants.length) return result;
  let query = client.from("student_payments")
    .select(
      "id,student_id,tenant_id,asaas_payment_id,value,due_date,invoice_url",
    )
    .in("tenant_id", tenants).in("status", ["PENDING", "OVERDUE"])
    .lt("due_date", date).order("due_date").order("id");
  if (scope) query = query.in("student_id", scope.student_ids);
  const charges: DailyCharge[] = [];
  for (let offset = 0;; offset += 200) {
    const { data, error } = await query.range(offset, offset + 199);
    if (error) throw new Error("daily_collection_candidates_unavailable");
    charges.push(...(data || []) as DailyCharge[]);
    if (!data || data.length < 200) break;
  }
  for (const charge of charges) {
    result.considered++;
    try {
      const { data: profile, error: pe } = await client.from("profiles")
        .select(
          "id,role,full_name,email,asaas_customer_id,subscription_id,contract_accepted,status,lifecycle_status,is_test_account,guardian_id,guardian_cpf,guardian_email",
        )
        .eq("id", charge.student_id).eq("tenant_id", charge.tenant_id)
        .maybeSingle();
      const student = profile as Student | null;
      if (
        pe || !student || student.role !== "STUDENT" ||
        student.status !== "Ativo" ||
        student.lifecycle_status !== "active" || student.is_test_account ||
        !student.contract_accepted || !(await deps.stillStudies(charge))
      ) {
        result.skipped++;
        continue;
      }
      const provider = await deps.readProvider(charge);
      if (
        !dailyProviderEligible(charge, student, provider, date) ||
        !validInvoiceUrl(provider.invoiceUrl)
      ) {
        result.skipped++;
        continue;
      }
      const recipient = await deps.recipient(charge);
      let brandName = recipient.brandName;
      if (!brandName) {
        const { data: tenant, error: te } = await client.from("tenants").select(
          "name",
        )
          .eq("id", charge.tenant_id).maybeSingle();
        if (te || !tenant?.name) throw new Error("school_identity_unavailable");
        brandName = tenant.name;
      }
      const text = dailyCollectionText({
        studentName: student.full_name,
        brandName,
        value: provider.value,
        dueDate: provider.dueDate,
        invoiceUrl: provider.invoiceUrl!,
        date,
        guardian: Boolean(student.guardian_id || student.guardian_cpf),
      });
      // Canais independentes: falha de WhatsApp não impede o e-mail.
      try {
        if (!recipient.ok) throw new Error("financial_whatsapp_unavailable");
        const { count, error: recentError } = await client.from(
          "asaas_outbound_message_attempts",
        )
          .select("id", { count: "exact", head: true }).eq(
            "tenant_id",
            charge.tenant_id,
          )
          .eq("provider_entity_id", charge.id).like(
            "notification_kind",
            "PAYMENT_%",
          )
          .in("status", ["SENT", "SUBMITTING", "UNKNOWN"])
          .gte("updated_at", `${date}T00:00:00-03:00`);
        if (recentError) throw new Error("daily_whatsapp_history_unavailable");
        if (!count) {
          const delivery = await deps.whatsapp(charge, {
            kind: `PAYMENT_OVERDUE_DAILY_${date.replaceAll("-", "")}`,
            phone: recipient.phone,
            instance: recipient.instance,
            text,
          });
          if (delivery.status === "SENT" && delivery.sentNow) {
            result.whatsapp_sent++;
          } else if (
            delivery.status === "SENT" || delivery.status === "SKIPPED"
          ) result.skipped++;
          else {
            result.failures++;
            result.reasons.push(`${charge.id}: WhatsApp ${delivery.reason}`);
          }
        } else result.skipped++;
      } catch {
        result.failures++;
        result.reasons.push(`${charge.id}: WhatsApp unavailable`);
      }
      const email = await verifiedEmail(client, student, charge.tenant_id);
      if (!email) {
        result.failures++;
        result.reasons.push(`${charge.id}: financial_email_unverified`);
        continue;
      }
      // Releitura do Asaas após a espera do WhatsApp, antes da intenção de e-mail.
      const current = await deps.readProvider(charge);
      if (
        !dailyProviderEligible(charge, student, current, date) ||
        current.value !== provider.value ||
        current.dueDate !== provider.dueDate ||
        current.invoiceUrl !== provider.invoiceUrl
      ) {
        result.skipped++;
        continue;
      }
      const emailStatus = await deliverDailyEmail(
        client,
        charge,
        date,
        email.email,
        text,
        brandName,
      );
      if (emailStatus === "SENT") result.email_sent++;
      else if (emailStatus === "ALREADY_ATTEMPTED") result.skipped++;
      else {
        result.failures++;
        result.reasons.push(`${charge.id}: email ${emailStatus}`);
      }
    } catch {
      result.failures++;
      result.reasons.push(`${charge.id}: daily_collection_unavailable`);
    }
  }
  return result;
}
