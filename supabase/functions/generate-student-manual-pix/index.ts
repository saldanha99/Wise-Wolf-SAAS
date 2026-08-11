/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizePaymentTarget } from "../_shared/payment-auth.ts";
import {
  digits,
  formatManualPixMessage,
  hasOpenNonPixPayment,
  nextUpcomingDueDate,
  normalizeBrazilianPhone,
  paymentBelongsToStudent,
  selectOpenPixPayment,
  text,
  type ProviderPayment,
} from "./core.ts";

let ASAAS_URL = Deno.env.get("ASAAS_API_URL") || "https://api-sandbox.asaas.com";
ASAAS_URL = ASAAS_URL.replace(/\/+$/, "")
  .replace(/\/v3$/, "")
  .replace(/\/api\/v3$/, "")
  .replace(/\/api$/, "");

const ASAAS_API_KEY = (
  Deno.env.get("ASAAS_API_KEY") || Deno.env.get("ASAAS_ACCESS_TOKEN") || ""
).trim();
const EVOLUTION_API_URL = (Deno.env.get("EVOLUTION_API_URL") || "")
  .trim().replace(/\/+$/, "");
const EVOLUTION_API_KEY = (Deno.env.get("EVOLUTION_API_KEY") || "").trim();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function asaasPathPrefix() {
  return ASAAS_URL.includes("api-sandbox") || ASAAS_URL.includes("api.asaas.com")
    ? "/v3"
    : "/api/v3";
}

async function providerRequest(
  path: string,
  method = "GET",
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${ASAAS_URL}${asaasPathPrefix()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        access_token: ASAAS_API_KEY,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      data: await response.json().catch(() => ({})),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function providerMessage(data: Record<string, unknown>, fallback: string): string {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const first = errors[0] && typeof errors[0] === "object"
    ? errors[0] as Record<string, unknown>
    : null;
  return text(first?.description || data.error) || fallback;
}

async function sendWhatsapp(
  instanceName: string,
  phone: string,
  message: string,
): Promise<{ sent: boolean; providerStatus?: number }> {
  if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !instanceName) {
    return { sent: false };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(
      `${EVOLUTION_API_URL}/message/sendText/${encodeURIComponent(instanceName)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: EVOLUTION_API_KEY,
        },
        body: JSON.stringify({
          number: phone,
          text: message,
          delay: 1200,
          linkPreview: false,
        }),
        signal: controller.signal,
      },
    );
    return { sent: response.ok, providerStatus: response.status };
  } catch {
    return { sent: false };
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
  if (!ASAAS_API_KEY) return json({ success: false, error: "Asaas indisponível." }, 503);

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const studentId = text(body.student_id);
    const authResult = await authorizePaymentTarget(req, studentId, corsHeaders);
    if (authResult.error || !authResult.authorization) return authResult.error!;

    const authorization = authResult.authorization;
    const callerRole = text(authorization.callerProfile?.role);
    if (!authorization.isService && !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(callerRole)) {
      return json({ success: false, error: "Somente a direção pode gerar o Pix manual." }, 403);
    }

    const profile = authorization.targetProfile;
    if (text(profile.role) !== "STUDENT") {
      return json({ success: false, error: "O cadastro selecionado não é de aluno." }, 409);
    }

    const tenantId = text(profile.tenant_id);
    const studentName = text(profile.full_name);
    const isDependent = Boolean(profile.guardian_id || profile.guardian_cpf);
    const billingName = isDependent ? text(profile.guardian_name) : studentName;
    const billingEmail = isDependent ? text(profile.guardian_email) : text(profile.email);
    const billingCpf = digits(isDependent ? profile.guardian_cpf : profile.cpf);
    const billingPhone = normalizeBrazilianPhone(
      isDependent ? profile.guardian_phone : profile.phone,
    );
    const value = Number(profile.monthly_fee);
    const dueDay = Number(profile.due_day) || 10;

    if (!tenantId || !studentName || !billingName || billingCpf.length !== 11) {
      return json({
        success: false,
        error: "Complete nome e CPF do titular antes de gerar o Pix manual.",
      }, 409);
    }
    if (!billingPhone) {
      return json({
        success: false,
        error: "Cadastre um WhatsApp válido do aluno ou responsável.",
      }, 409);
    }
    if (!Number.isFinite(value) || value <= 0) {
      return json({ success: false, error: "A mensalidade do aluno não está configurada." }, 409);
    }

    let asaasCustomerId = text(profile.asaas_customer_id);
    if (!asaasCustomerId) {
      const lookup = await providerRequest(
        `/customers?cpfCnpj=${encodeURIComponent(billingCpf)}&limit=100`,
      );
      const candidates = Array.isArray(lookup.data.data)
        ? lookup.data.data as Record<string, unknown>[]
        : [];
      const exact = candidates.find((candidate) =>
        candidate.deleted !== true && text(candidate.externalReference) === studentId
      );
      asaasCustomerId = text(exact?.id);
    }

    if (!asaasCustomerId) {
      const customerPayload: Record<string, unknown> = {
        name: billingName,
        cpfCnpj: billingCpf,
        mobilePhone: billingPhone,
        externalReference: studentId,
        ...(billingEmail ? { email: billingEmail } : {}),
        ...(text(profile.postal_code) ? { postalCode: text(profile.postal_code) } : {}),
        ...(text(profile.address) ? { address: text(profile.address) } : {}),
        ...(text(profile.address_number)
          ? { addressNumber: text(profile.address_number) }
          : {}),
      };
      const createdCustomer = await providerRequest("/customers", "POST", customerPayload);
      asaasCustomerId = text(createdCustomer.data.id);
      if (!createdCustomer.ok || !asaasCustomerId) {
        return json({
          success: false,
          error: providerMessage(createdCustomer.data, "Não foi possível cadastrar o titular no Asaas."),
        }, 422);
      }
      const { error: customerSaveError } = await authorization.admin
        .from("profiles")
        .update({ asaas_customer_id: asaasCustomerId })
        .eq("id", studentId)
        .eq("tenant_id", tenantId);
      if (customerSaveError) throw new Error("customer_link_failed");
    }

    const listResult = await providerRequest(
      `/payments?customer=${encodeURIComponent(asaasCustomerId)}&limit=100`,
    );
    if (!listResult.ok) {
      return json({ success: false, error: "Não foi possível consultar as cobranças abertas." }, 502);
    }
    const allCustomerPayments = Array.isArray(listResult.data.data)
      ? listResult.data.data as ProviderPayment[]
      : [];
    const subscriptionId = text(profile.subscription_id);
    const providerPayments = allCustomerPayments.filter((payment) =>
      paymentBelongsToStudent(payment, studentId, subscriptionId)
    );
    let payment = selectOpenPixPayment(providerPayments);
    if (!payment && hasOpenNonPixPayment(providerPayments)) {
      return json({
        success: false,
        error: "Existe uma cobrança aberta no cartão. Altere a forma de pagamento antes de emitir outro Pix.",
      }, 409);
    }

    let reused = Boolean(payment);
    if (!payment) {
      const dueDate = nextUpcomingDueDate(new Date(), dueDay);
      const claimPayload = {
        tenant_id: tenantId,
        student_id: studentId,
        due_date: dueDate,
        status: "PROCESSING",
        requested_by: authorization.callerId,
        processing_started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      let issuanceId = "";
      const { data: insertedClaim, error: claimInsertError } =
        await authorization.admin.from("student_manual_pix_issuances")
          .insert(claimPayload)
          .select("id")
          .maybeSingle();

      if (!claimInsertError && insertedClaim?.id) {
        issuanceId = text(insertedClaim.id);
      } else if (claimInsertError?.code === "23505") {
        const { data: existingClaim, error: claimLookupError } =
          await authorization.admin.from("student_manual_pix_issuances")
            .select("id, status, processing_started_at, updated_at")
            .eq("student_id", studentId)
            .eq("due_date", dueDate)
            .maybeSingle();
        if (claimLookupError || !existingClaim) throw new Error("pix_claim_lookup_failed");

        const startedAt = Date.parse(text(existingClaim.processing_started_at));
        const freshProcessing = text(existingClaim.status) === "PROCESSING" &&
          Number.isFinite(startedAt) && startedAt > Date.now() - 5 * 60_000;
        if (freshProcessing) {
          return json({
            success: false,
            error: "Este Pix já está sendo gerado em outra aba. Aguarde alguns segundos.",
          }, 409);
        }
        if (text(existingClaim.status) === "READY") {
          return json({
            success: false,
            error: "A cobrança deste vencimento já foi emitida. Atualize o perfil para consultá-la.",
          }, 409);
        }

        const takeoverStartedAt = new Date().toISOString();
        const { data: claimed, error: takeoverError } =
          await authorization.admin.from("student_manual_pix_issuances")
            .update({
              status: "PROCESSING",
              requested_by: authorization.callerId,
              processing_started_at: takeoverStartedAt,
              updated_at: takeoverStartedAt,
              last_error: null,
            })
            .eq("id", existingClaim.id)
            .eq("updated_at", existingClaim.updated_at)
            .select("id")
            .maybeSingle();
        if (takeoverError || !claimed?.id) {
          return json({
            success: false,
            error: "Este Pix já está sendo gerado em outra aba. Aguarde alguns segundos.",
          }, 409);
        }
        issuanceId = text(claimed.id);
      } else {
        throw new Error(`pix_claim_failed:${claimInsertError?.code || "unknown"}`);
      }

      const { data: tenant } = await authorization.admin
        .from("tenants")
        .select("asaas_wallet_id, asaas_split_percentage")
        .eq("id", tenantId)
        .maybeSingle();
      const split = tenant?.asaas_wallet_id
        ? [{
          walletId: tenant.asaas_wallet_id,
          percentualValue: tenant.asaas_split_percentage ?? 90,
        }]
        : undefined;
      const createdPayment = await providerRequest("/payments", "POST", {
        customer: asaasCustomerId,
        billingType: "PIX",
        value,
        dueDate,
        description: `Mensalidade Wise Wolf - ${studentName}`.slice(0, 500),
        externalReference: studentId,
        ...(split ? { split } : {}),
      });
      if (!createdPayment.ok || !text(createdPayment.data.id)) {
        await authorization.admin.from("student_manual_pix_issuances").update({
          status: "FAILED",
          last_error: `asaas_status_${createdPayment.status}`,
          updated_at: new Date().toISOString(),
        }).eq("id", issuanceId).eq("status", "PROCESSING");
        return json({
          success: false,
          error: providerMessage(createdPayment.data, "Não foi possível criar a cobrança Pix."),
        }, 422);
      }
      payment = createdPayment.data;
      const { error: claimReadyError } = await authorization.admin
        .from("student_manual_pix_issuances")
        .update({
          status: "READY",
          asaas_payment_id: text(createdPayment.data.id),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", issuanceId)
        .eq("status", "PROCESSING");
      if (claimReadyError) {
        console.warn("[generate-student-manual-pix] claim_ready_failed", {
          code: claimReadyError.code,
        });
      }
      reused = false;
    }

    const paymentId = text(payment.id);
    const paymentValue = Number(payment.value) || value;
    const paymentStatus = text(payment.status) || "PENDING";
    const dueDate = text(payment.dueDate) || nextUpcomingDueDate(new Date(), dueDay);
    const description = text(payment.description) || `Mensalidade Wise Wolf - ${studentName}`;
    const invoiceUrl = text(payment.bankSlipUrl || payment.invoiceUrl) || null;

    // O vínculo nasce antes do recebimento. O webhook fará upsert pelo mesmo ID
    // e o trigger contábil/rateio verá aluno, tenant e agenda desde o primeiro evento.
    const { error: paymentSaveError } = await authorization.admin
      .from("student_payments")
      .upsert({
        asaas_payment_id: paymentId,
        student_id: studentId,
        tenant_id: tenantId,
        value: paymentValue,
        amount_cents: Math.round(paymentValue * 100),
        status: paymentStatus,
        due_date: dueDate,
        billing_type: "PIX",
        payment_method: "PIX",
        invoice_url: invoiceUrl,
        description,
        payment_type: "SUBSCRIPTION",
        updated_at: new Date().toISOString(),
      }, { onConflict: "asaas_payment_id" });
    if (paymentSaveError) throw new Error(`payment_link_failed:${paymentSaveError.code}`);

    const pixResult = await providerRequest(
      `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
    );
    const pixPayload = text(pixResult.data.payload);
    if (!pixResult.ok || !pixPayload) {
      return json({ success: false, error: "A cobrança foi vinculada, mas o Asaas não entregou o código Pix." }, 502);
    }

    let directorInstance = "";
    if (!authorization.isService && authorization.callerId) {
      const { data: caller } = await authorization.admin.from("profiles")
        .select("whatsapp_instance")
        .eq("id", authorization.callerId)
        .maybeSingle();
      directorInstance = text(caller?.whatsapp_instance);
    }
    if (!directorInstance) {
      const { data: director } = await authorization.admin.from("profiles")
        .select("whatsapp_instance")
        .eq("tenant_id", tenantId)
        .in("role", ["SCHOOL_ADMIN", "SUPER_ADMIN"])
        .not("whatsapp_instance", "is", null)
        .neq("whatsapp_instance", "")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      directorInstance = text(director?.whatsapp_instance);
    }

    const message = formatManualPixMessage({
      studentName,
      value: paymentValue,
      dueDate,
      pixPayload,
    });
    const isTest = profile.is_test_account === true;
    const whatsapp = isTest
      ? { sent: false, suppressed: true }
      : await sendWhatsapp(directorInstance, billingPhone, message);

    await authorization.admin.from("audit_logs").insert({
      tenant_id: tenantId,
      user_id: authorization.callerId,
      user_role: callerRole || (authorization.isService ? "SERVICE" : "SCHOOL_ADMIN"),
      action: "student_manual_pix_generated",
      resource_type: "student_payment",
      resource_id: paymentId,
      new_values: {
        student_id: studentId,
        value: paymentValue,
        due_date: dueDate,
        reused,
        whatsapp_sent: whatsapp.sent,
        test_suppressed: "suppressed" in whatsapp && whatsapp.suppressed === true,
        destination_last4: billingPhone.slice(-4),
      },
    });

    return json({
      success: true,
      paymentId,
      value: paymentValue,
      dueDate,
      pixPayload,
      encodedImage: text(pixResult.data.encodedImage) || null,
      expiresAt: text(pixResult.data.expirationDate) || null,
      reused,
      whatsappSent: whatsapp.sent,
      whatsappSuppressed: "suppressed" in whatsapp && whatsapp.suppressed === true,
      whatsappUnavailable: !directorInstance,
    });
  } catch (cause) {
    console.error("[generate-student-manual-pix] unexpected", {
      type: cause instanceof Error ? cause.name : "UnknownError",
      code: cause instanceof Error ? cause.message.split(":")[0] : "unknown",
    });
    return json({ success: false, error: "Não foi possível gerar o Pix manual." }, 500);
  }
});
