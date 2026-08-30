/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizePaymentTarget } from "../_shared/payment-auth.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
import { guardAsaasMutationTarget } from "../_shared/asaas-mutation-guard.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  type AsaasCreationClaim,
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  bindStudentAsaasCreationLifecycle,
  claimAsaasCreation,
  findUniqueAsaasEntity,
  markStudentAsaasCreationSubmitting,
  recordAsaasCreationState,
  releaseStudentAsaasCreationLifecycle,
} from "../_shared/asaas-creation-guard.ts";
import {
  loadTenantCentralWhatsAppInstance,
  loadTenantWhatsAppInstance,
  safeCommunicationText,
} from "../_shared/tenant-communication.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
  type ResolvedEvolutionIntegration,
  resolveEvolutionIntegration,
  TenantIntegrationBrokerError,
} from "../_shared/tenant-integration-broker.ts";
import {
  claimOutboundMessage,
  claimStudentBillingPeriod,
  finishOutboundMessage,
  markOutboundMessageSubmitting,
  markStudentBillingPeriodSubmitting,
  recordStudentBillingPeriodState,
  type StudentBillingPeriodClaim,
} from "../_shared/student-billing-period-guard.ts";
import {
  canonicalEnrollmentSplitPolicy,
  providerSplitPayload,
  providerSplitPoliciesEqual,
} from "../_shared/student-provider-lifecycle.ts";
import {
  digits,
  formatManualPixMessage,
  hasOpenNonPixPayment,
  manualPixIssuanceIdFromReference,
  manualPixProviderReference,
  nextUpcomingDueDate,
  normalizeBrazilianPhone,
  paymentBelongsToStudent,
  paymentOccupiesDueDate,
  type ProviderPayment,
  providerPaymentMatchesManualIssuance,
  providerPaymentMatchesMonthlyCompetence,
  recurringPaymentSourceKey,
  selectExactMonthlyPixPayment,
  text,
} from "./core.ts";

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

async function providerRequest(
  integration: ResolvedAsaasIntegration,
  path: string,
  method = "GET",
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${integration.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        access_token: integration.apiKey,
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

async function providerListAll<T extends Record<string, unknown>>(
  integration: ResolvedAsaasIntegration,
  path: string,
  query: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: T[] }> {
  const data: T[] = [];
  for (let offset = 0, pages = 0; pages < 100; pages += 1) {
    const params = new URLSearchParams(query);
    params.set("limit", "100");
    params.set("offset", String(offset));
    const result = await providerRequest(
      integration,
      `${path}?${params.toString()}`,
    );
    if (!result.ok || !Array.isArray(result.data.data)) {
      return { ok: false, status: result.status, data: [] };
    }
    const page = result.data.data as T[];
    data.push(...page);
    if (result.data.hasMore !== true) {
      return { ok: true, status: result.status, data };
    }
    if (page.length === 0) return { ok: false, status: 502, data: [] };
    offset += page.length;
  }
  return { ok: false, status: 508, data: [] };
}

function providerCustomerMatches(
  customer: Record<string, unknown>,
  input: { studentId: string; billingCpf: string },
): boolean {
  const externalReference = text(customer.externalReference);
  return customer.deleted !== true &&
    text(customer.id) !== "" &&
    digits(customer.cpfCnpj) === input.billingCpf &&
    externalReference === input.studentId;
}

function providerMessage(
  data: Record<string, unknown>,
  fallback: string,
): string {
  const errors = Array.isArray(data.errors) ? data.errors : [];
  const first = errors[0] && typeof errors[0] === "object"
    ? errors[0] as Record<string, unknown>
    : null;
  return text(first?.description || data.error) || fallback;
}

async function sendWhatsapp(
  integration: ResolvedEvolutionIntegration,
  instanceName: string,
  phone: string,
  message: string,
): Promise<{
  sent: boolean;
  providerStatus?: number;
  ambiguous?: boolean;
}> {
  if (!instanceName) {
    return { sent: false };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(
      `${integration.baseUrl}/message/sendText/${
        encodeURIComponent(instanceName)
      }`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: integration.apiKey,
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
    const ambiguous = [408, 409, 425, 429].includes(response.status) ||
      response.status >= 500;
    return {
      sent: response.ok,
      providerStatus: response.status,
      ambiguous: !response.ok && ambiguous,
    };
  } catch {
    return { sent: false, ambiguous: true };
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ success: false, error: "method_not_allowed" }, 405);
  }

  const preAuth = await authorizeRequest(req, {
    allowService: true,
    allowedRoles: [
      "STUDENT",
      "SCHOOL_ADMIN",
      "SUPER_ADMIN",
      "COORDINATOR",
    ],
    corsHeaders,
  });
  if (preAuth.ok === false) {
    return preAuth.response;
  }

  try {
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const studentId = text(body.student_id);
    const authResult = await authorizePaymentTarget(
      req,
      studentId,
      corsHeaders,
    );
    if (authResult.error || !authResult.authorization) return authResult.error!;

    const authorization = authResult.authorization;
    const callerRole = text(authorization.callerProfile?.role);
    if (
      !authorization.isService &&
      !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(callerRole)
    ) {
      return json({
        success: false,
        error: "Somente a direção pode gerar o Pix manual.",
      }, 403);
    }

    const profile = authorization.targetProfile;
    if (text(profile.role) !== "STUDENT") {
      return json({
        success: false,
        error: "O cadastro selecionado não é de aluno.",
      }, 409);
    }

    const tenantId = authorization.tenantId;
    const studentName = text(profile.full_name);
    const isDependent = Boolean(profile.guardian_id || profile.guardian_cpf);
    const billingName = isDependent ? text(profile.guardian_name) : studentName;
    const billingEmail = isDependent
      ? text(profile.guardian_email)
      : text(profile.email);
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
      return json({
        success: false,
        error: "A mensalidade do aluno não está configurada.",
      }, 409);
    }
    const [customerIntegration, paymentIntegration] = await Promise.all([
      resolveAsaasIntegration(
        authorization.admin,
        tenantId,
        "customer.create",
      ),
      resolveAsaasIntegration(
        authorization.admin,
        tenantId,
        "payment.create",
      ),
    ]);
    const { data: tenant, error: tenantError } = await authorization.admin
      .from("tenants")
      .select("name,asaas_wallet_id,asaas_split_percentage")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError || !tenant) {
      return json({
        success: false,
        error: "Não foi possível validar a configuração financeira da escola.",
      }, 503);
    }
    const splitPolicy = canonicalEnrollmentSplitPolicy(
      paymentIntegration.mode,
      tenant.asaas_wallet_id,
      tenant.asaas_split_percentage,
    );
    if (!splitPolicy) {
      return json({
        success: false,
        error: "A configuração de repasse da escola precisa de revisão.",
      }, 409);
    }
    const split = providerSplitPayload(splitPolicy);
    const schoolName = safeCommunicationText(tenant?.name, 120) ||
      "Escola de idiomas";

    const customerPayload: Record<string, unknown> = {
      name: billingName,
      cpfCnpj: billingCpf,
      mobilePhone: billingPhone,
      externalReference: studentId,
      ...(billingEmail ? { email: billingEmail } : {}),
      ...(text(profile.postal_code)
        ? { postalCode: text(profile.postal_code) }
        : {}),
      ...(text(profile.address) ? { address: text(profile.address) } : {}),
      ...(text(profile.address_number)
        ? { addressNumber: text(profile.address_number) }
        : {}),
    };
    const customerLogicalKey = `student-customer:${studentId}`;
    const { data: storedCustomerCreation, error: storedCustomerCreationError } =
      await authorization.admin.from("asaas_provider_creation_attempts")
        .select("external_reference,request_fingerprint")
        .eq("tenant_id", tenantId)
        .eq("operation", "CUSTOMER_CREATE")
        .eq("logical_key", customerLogicalKey)
        .maybeSingle();
    if (storedCustomerCreationError) {
      return json({
        success: false,
        error: "Não foi possível conferir o cadastro durável do titular.",
      }, 503);
    }
    if (
      storedCustomerCreation &&
      text(storedCustomerCreation.external_reference) !== studentId
    ) {
      return json({
        success: false,
        error: "A referência durável do titular precisa de revisão.",
      }, 409);
    }
    const customerFingerprint =
      text(storedCustomerCreation?.request_fingerprint) ||
      await asaasCreationFingerprint({
        tenantId,
        operation: "CUSTOMER_CREATE",
        logicalKey: customerLogicalKey,
        payload: customerPayload,
      });
    const customerClaim = await claimAsaasCreation(authorization.admin, {
      tenantId,
      operation: "CUSTOMER_CREATE",
      logicalKey: customerLogicalKey,
      externalReference: studentId,
      requestFingerprint: customerFingerprint,
    });
    if (customerClaim.action === "IN_PROGRESS") {
      return json({
        success: false,
        error: "O cadastro do titular já está sendo processado.",
        retry_after_seconds: customerClaim.retry_after_seconds || 15,
      }, 409);
    }
    if (customerClaim.action === "REVIEW_REQUIRED" || !customerClaim.ok) {
      return json({
        success: false,
        error: "O cadastro do titular no Asaas precisa de revisão.",
      }, 409);
    }
    const customerLifecycleInput = {
      tenantId,
      studentId,
      bindingKind: "CUSTOMER" as const,
      expectedCustomerId: null,
    };

    let asaasCustomerId = text(profile.asaas_customer_id);
    if (asaasCustomerId) {
      const linkedCustomer = await providerRequest(
        customerIntegration,
        `/customers/${encodeURIComponent(asaasCustomerId)}`,
      );
      if (
        !linkedCustomer.ok ||
        !providerCustomerMatches(linkedCustomer.data, {
          studentId,
          billingCpf,
        })
      ) {
        return json({
          success: false,
          error:
            "O vínculo do titular com o Asaas precisa de revisão antes de gerar a cobrança.",
        }, linkedCustomer.ok ? 409 : 503);
      }
      if (
        customerClaim.action === "ALREADY_SUCCEEDED" &&
        text(customerClaim.provider_entity_id) !== asaasCustomerId
      ) {
        return json({
          success: false,
          error:
            "O cadastro durável do titular diverge do vínculo local e precisa de revisão.",
        }, 409);
      }
      if (customerClaim.action !== "ALREADY_SUCCEEDED") {
        await recordAsaasCreationState(authorization.admin, customerClaim, {
          status: "SUCCEEDED",
          providerEntityId: asaasCustomerId,
          providerStatus: text(linkedCustomer.data.status),
        });
      }
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          customerClaim,
          customerLifecycleInput,
        ) ||
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          customerClaim,
          { tenantId, studentId, providerEntityId: asaasCustomerId },
        )
      ) {
        return json({
          success: false,
          error:
            "O vínculo local do titular não pôde ser confirmado com segurança.",
        }, 409);
      }
    } else {
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          customerClaim,
          customerLifecycleInput,
        )
      ) {
        return json({
          success: false,
          error:
            "O ciclo de vida do aluno mudou e o cadastro do titular precisa de revisão.",
        }, 409);
      }

      if (customerClaim.action === "ALREADY_SUCCEEDED") {
        asaasCustomerId = text(customerClaim.provider_entity_id);
        const linkedCustomer = asaasCustomerId
          ? await providerRequest(
            customerIntegration,
            `/customers/${encodeURIComponent(asaasCustomerId)}`,
          )
          : null;
        if (
          !linkedCustomer?.ok ||
          !providerCustomerMatches(linkedCustomer.data, {
            studentId,
            billingCpf,
          })
        ) {
          return json({
            success: false,
            error: "O cadastro recuperado do titular precisa de revisão.",
          }, 409);
        }
      } else {
        // CPF is the provider-side identity key. Read every page and reject a
        // divergent reference instead of silently creating a second customer
        // for the same holder.
        const customerLookup = await providerListAll<Record<string, unknown>>(
          customerIntegration,
          "/customers",
          { cpfCnpj: billingCpf },
        );
        if (!customerLookup.ok) {
          await recordAsaasCreationState(authorization.admin, customerClaim, {
            status: customerClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            httpStatus: customerLookup.status,
            error: "customer_recovery_lookup_unavailable",
          });
          return json({
            success: false,
            error: "Não foi possível conferir o cadastro no Asaas.",
          }, 503);
        }
        const activeCpfCustomers = customerLookup.data.filter((candidate) =>
          candidate.deleted !== true && digits(candidate.cpfCnpj) === billingCpf
        );
        const matchingCustomers = activeCpfCustomers.filter((candidate) =>
          providerCustomerMatches(candidate, {
            studentId,
            billingCpf,
          })
        );
        if (
          matchingCustomers.length > 1 ||
          activeCpfCustomers.length !== matchingCustomers.length
        ) {
          await recordAsaasCreationState(authorization.admin, customerClaim, {
            status: "BLOCKED",
            error: matchingCustomers.length > 1
              ? "duplicate_provider_customers"
              : "provider_customer_identity_conflict",
          });
          return json({
            success: false,
            error:
              "O CPF do titular já possui um vínculo diferente no Asaas e precisa de revisão.",
          }, 409);
        }
        if (matchingCustomers.length === 1) {
          const matchedCustomer = matchingCustomers[0];
          asaasCustomerId = text(matchedCustomer.id);
          if (!asaasCustomerId) {
            await recordAsaasCreationState(
              authorization.admin,
              customerClaim,
              { status: "BLOCKED", error: "provider_customer_id_missing" },
            );
            return json({
              success: false,
              error: "O cadastro recuperado do titular precisa de revisão.",
            }, 409);
          }
          await recordAsaasCreationState(authorization.admin, customerClaim, {
            status: "SUCCEEDED",
            providerEntityId: asaasCustomerId,
            providerStatus: text(matchedCustomer.status),
          });
        } else if (customerClaim.action === "RECONCILE_REQUIRED") {
          await recordAsaasCreationState(authorization.admin, customerClaim, {
            status: "UNKNOWN",
            error: "provider_customer_not_yet_observed",
          });
          return json({
            success: false,
            error: "O cadastro no Asaas ainda está sendo conciliado.",
          }, 409);
        } else {
          await markStudentAsaasCreationSubmitting(
            authorization.admin,
            customerClaim,
            customerLifecycleInput,
          );
          let submitCustomerIntegration: ResolvedAsaasIntegration;
          try {
            submitCustomerIntegration = await revalidateAsaasMutationCapability(
              authorization.admin,
              {
                tenantId,
                purpose: "customer.create",
                expected: customerIntegration,
              },
            );
          } catch (error) {
            const unavailable = error instanceof AsaasCapabilityFenceError &&
              error.failure === "UNAVAILABLE";
            await recordAsaasCreationState(
              authorization.admin,
              customerClaim,
              {
                status: "BLOCKED",
                error: unavailable
                  ? "customer_capability_unavailable_before_submit"
                  : "customer_capability_changed_before_submit",
              },
            );
            return json({
              success: false,
              error: unavailable
                ? "A capacidade de cadastro no Asaas está indisponível."
                : "A credencial de cadastro no Asaas mudou; reinicie a operação.",
            }, unavailable ? 503 : 409);
          }
          let createdCustomer: Awaited<ReturnType<typeof providerRequest>>;
          try {
            createdCustomer = await providerRequest(
              submitCustomerIntegration,
              "/customers",
              "POST",
              customerPayload,
            );
          } catch {
            await recordAsaasCreationState(
              authorization.admin,
              customerClaim,
              {
                status: "UNKNOWN",
                error: "provider_customer_post_outcome_unknown",
              },
            );
            return json({
              success: false,
              error: "O resultado do cadastro no Asaas precisa ser conciliado.",
            }, 502);
          }
          asaasCustomerId = text(createdCustomer.data.id);
          const outcome = asaasCreationHttpOutcome(
            createdCustomer.ok,
            createdCustomer.status,
            asaasCustomerId,
          );
          const exactCreatedCustomer = outcome !== "SUCCEEDED" ||
            providerCustomerMatches(createdCustomer.data, {
              studentId,
              billingCpf,
            });
          await recordAsaasCreationState(authorization.admin, customerClaim, {
            status: exactCreatedCustomer ? outcome : "BLOCKED",
            providerEntityId: asaasCustomerId,
            providerStatus: text(createdCustomer.data.status),
            httpStatus: createdCustomer.status,
            error: !exactCreatedCustomer
              ? "provider_customer_post_identity_mismatch"
              : outcome === "SUCCEEDED"
              ? null
              : outcome === "FAILED"
              ? "provider_customer_creation_rejected"
              : "provider_customer_post_outcome_unknown",
          });
          if (!exactCreatedCustomer) {
            return json({
              success: false,
              error:
                "O cadastro criado no Asaas divergiu da identidade esperada e precisa de revisão.",
            }, 409);
          }
          if (outcome !== "SUCCEEDED") {
            return json({
              success: false,
              error: outcome === "FAILED"
                ? providerMessage(
                  createdCustomer.data,
                  "Não foi possível cadastrar o titular no Asaas.",
                )
                : "O resultado do cadastro no Asaas precisa ser conciliado.",
            }, outcome === "FAILED" ? 422 : 502);
          }
        }
      }

      const { data: linkedProfile, error: customerSaveError } =
        await authorization.admin
          .from("profiles")
          .update({ asaas_customer_id: asaasCustomerId })
          .eq("id", studentId)
          .eq("tenant_id", tenantId)
          .is("asaas_customer_id", null)
          .select("asaas_customer_id")
          .maybeSingle();
      if (customerSaveError || !linkedProfile) {
        const currentProfile = await authorization.admin.from("profiles")
          .select("asaas_customer_id")
          .eq("id", studentId)
          .eq("tenant_id", tenantId)
          .maybeSingle();
        if (text(currentProfile.data?.asaas_customer_id) !== asaasCustomerId) {
          throw new Error("customer_link_failed");
        }
      }
      if (
        !await releaseStudentAsaasCreationLifecycle(
          authorization.admin,
          customerClaim,
          {
            tenantId,
            studentId,
            providerEntityId: asaasCustomerId,
          },
        )
      ) {
        return json({
          success: false,
          error:
            "O vínculo local do titular não pôde ser confirmado com segurança.",
        }, 409);
      }
    }

    const listResult = await providerListAll<ProviderPayment>(
      paymentIntegration,
      "/payments",
      { customer: asaasCustomerId },
    );
    if (!listResult.ok) {
      return json({
        success: false,
        error: "Não foi possível consultar as cobranças abertas.",
      }, 502);
    }
    const allCustomerPayments = listResult.data;
    const subscriptionId = text(profile.subscription_id);
    const targetDueDate = nextUpcomingDueDate(new Date(), dueDay);
    const expectedMonthlyPayment = {
      studentId,
      subscriptionId,
      customerId: asaasCustomerId,
      dueDate: targetDueDate,
      value,
      splitPolicy,
    };
    const providerPayments = allCustomerPayments.filter((payment) =>
      paymentBelongsToStudent(payment, studentId, subscriptionId)
    );
    let payment = selectExactMonthlyPixPayment(
      providerPayments,
      expectedMonthlyPayment,
    );
    if (!payment && hasOpenNonPixPayment(providerPayments)) {
      return json({
        success: false,
        error:
          "Existe uma cobrança aberta no cartão. Altere a forma de pagamento antes de emitir outro Pix.",
      }, 409);
    }
    if (
      !payment &&
      providerPayments.some((candidate) =>
        paymentOccupiesDueDate(candidate, targetDueDate)
      )
    ) {
      return json({
        success: false,
        error:
          "Já existe uma cobrança para este vencimento. A conciliação precisa terminar antes de outra emissão.",
      }, 409);
    }
    if (!payment && subscriptionId) {
      const subscription = await guardAsaasMutationTarget({
        admin: authorization.admin,
        baseUrl: paymentIntegration.baseUrl,
        apiKey: paymentIntegration.apiKey,
        operation: "manual_pix_inactive_subscription_gate",
        target: {
          tenantId,
          studentId,
          resource: "subscription",
          entityId: subscriptionId,
          customerId: asaasCustomerId,
          subscriptionId,
          subscriptionMatch: "entity_id",
        },
      });
      if (subscription.ok === false) {
        return json({
          success: false,
          error:
            "A assinatura vinculada precisa ser conferida antes de emitir um Pix avulso.",
        }, subscription.code === "LOOKUP_FAILED" ? 503 : 409);
      }
      const subscriptionStatus = text(subscription.entity.status).toUpperCase();
      if (!["INACTIVE", "EXPIRED"].includes(subscriptionStatus)) {
        return json({
          success: false,
          error:
            "A assinatura recorrente ainda pode gerar a cobrança desta competência ou está em estado desconhecido. Aguarde a conciliação ou altere a forma de pagamento.",
        }, 409);
      }
    }

    let reused = Boolean(payment);
    let paymentLifecycleClaim: AsaasCreationClaim | null = null;
    let paymentPeriodClaim: StudentBillingPeriodClaim | null = null;
    let manualIssuanceId = "";
    let manualPaymentExternalReference = "";
    let recurringBillingSourceKey = "";
    let periodBoundProviderId = "";
    const recordPaymentPeriod = async (
      status: "RETRY" | "UNKNOWN" | "BOUND" | "FAILED" | "BLOCKED",
      providerEntityId?: string | null,
      error?: string | null,
    ) => {
      if (!paymentPeriodClaim?.claim_token) return;
      await recordStudentBillingPeriodState(
        authorization.admin,
        paymentPeriodClaim,
        { status, providerEntityId, error },
      );
    };

    if (payment) {
      const observedPaymentId = text(payment.id);
      const observedExternalReference = text(payment.externalReference);
      const referencedIssuanceId = manualPixIssuanceIdFromReference(
        observedExternalReference,
        studentId,
      );
      let billingSource: "MANUAL_PIX" | "SUBSCRIPTION";
      let billingSourceKey: string;
      if (referencedIssuanceId) {
        const { data: issuance, error: issuanceError } = await authorization
          .admin.from("student_manual_pix_issuances")
          .select(
            "id,tenant_id,student_id,due_date,asaas_payment_id,status",
          )
          .eq("id", referencedIssuanceId)
          .eq("tenant_id", tenantId)
          .eq("student_id", studentId)
          .eq("due_date", targetDueDate)
          .maybeSingle();
        if (
          issuanceError || !issuance ||
          (text(issuance.asaas_payment_id) &&
            text(issuance.asaas_payment_id) !== observedPaymentId)
        ) {
          return json({
            success: false,
            error:
              "A emissão manual encontrada não possui prova local exata e precisa de revisão.",
          }, 409);
        }
        manualIssuanceId = referencedIssuanceId;
        manualPaymentExternalReference = observedExternalReference;
        billingSource = "MANUAL_PIX";
        billingSourceKey = `manual-pix:${referencedIssuanceId}`;
      } else {
        const { data: legacyIssuance, error: legacyIssuanceError } =
          text(payment.subscription) === "" &&
            observedExternalReference === studentId
            ? await authorization.admin.from("student_manual_pix_issuances")
              .select(
                "id,tenant_id,student_id,due_date,asaas_payment_id,status",
              )
              .eq("tenant_id", tenantId)
              .eq("student_id", studentId)
              .eq("due_date", targetDueDate)
              .eq("asaas_payment_id", observedPaymentId)
              .maybeSingle()
            : { data: null, error: null };
        if (legacyIssuanceError) {
          return json({
            success: false,
            error: "Não foi possível conferir a emissão legada da cobrança.",
          }, 503);
        }
        if (
          legacyIssuance &&
          ["PROCESSING", "READY"].includes(text(legacyIssuance.status))
        ) {
          manualIssuanceId = text(legacyIssuance.id);
          manualPaymentExternalReference = observedExternalReference;
          billingSource = "MANUAL_PIX";
          billingSourceKey = `manual-pix:${manualIssuanceId}`;
        } else {
          const recurringSourceKey = recurringPaymentSourceKey(
            payment,
            studentId,
            subscriptionId,
          );
          if (!recurringSourceKey) {
            return json({
              success: false,
              error:
                "A cobrança encontrada não possui referência recorrente exata e precisa de revisão.",
            }, 409);
          }
          billingSource = "SUBSCRIPTION";
          billingSourceKey = recurringSourceKey;
          recurringBillingSourceKey = recurringSourceKey;
        }
        if (!manualIssuanceId && !recurringBillingSourceKey) {
          return json({
            success: false,
            error: "A origem durável da cobrança não pôde ser comprovada.",
          }, 409);
        }
      }

      const { data: storedPeriod, error: storedPeriodError } =
        await authorization.admin.from("asaas_student_billing_period_claims")
          .select("source,source_key,request_fingerprint")
          .eq("tenant_id", tenantId)
          .eq("student_id", studentId)
          .eq("due_date", targetDueDate)
          .maybeSingle();
      if (storedPeriodError) {
        return json({
          success: false,
          error: "Não foi possível conferir a reserva desta competência.",
        }, 503);
      }
      if (
        storedPeriod &&
        (text(storedPeriod.source) !== billingSource ||
          text(storedPeriod.source_key) !== billingSourceKey)
      ) {
        return json({
          success: false,
          error:
            "A competência pertence a outra automação e precisa de conciliação.",
        }, 409);
      }
      const periodFingerprint = text(storedPeriod?.request_fingerprint) ||
        await asaasCreationFingerprint({
          tenantId,
          studentId,
          dueDate: targetDueDate,
          source: billingSource,
          sourceKey: billingSourceKey,
          providerPaymentId: observedPaymentId,
          customerId: asaasCustomerId,
          subscriptionId: text(payment.subscription) || null,
          externalReference: observedExternalReference,
          value,
          splitPolicy,
        });
      paymentPeriodClaim = await claimStudentBillingPeriod(
        authorization.admin,
        {
          tenantId,
          studentId,
          dueDate: targetDueDate,
          source: billingSource,
          sourceKey: billingSourceKey,
          requestFingerprint: periodFingerprint,
        },
      );
      if (
        paymentPeriodClaim.action === "CONFLICT" ||
        paymentPeriodClaim.action === "REVIEW_REQUIRED" ||
        !paymentPeriodClaim.ok
      ) {
        return json({
          success: false,
          error: "A competência da cobrança precisa de revisão.",
        }, 409);
      }
      if (paymentPeriodClaim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "Esta competência já está sendo conciliada.",
          retry_after_seconds: paymentPeriodClaim.retry_after_seconds || 15,
        }, 409);
      }
      periodBoundProviderId = paymentPeriodClaim.action === "ALREADY_BOUND"
        ? text(paymentPeriodClaim.provider_entity_id)
        : "";
      const allowedBoundIds = billingSource === "SUBSCRIPTION"
        ? new Set([observedPaymentId, subscriptionId])
        : new Set([observedPaymentId]);
      if (
        periodBoundProviderId && !allowedBoundIds.has(periodBoundProviderId)
      ) {
        return json({
          success: false,
          error: "A competência está vinculada a outra entidade no Asaas.",
        }, 409);
      }

      const paymentLogicalKey = billingSource === "MANUAL_PIX"
        ? billingSourceKey
        : `subscription-payment:${subscriptionId}:${targetDueDate}`;
      const { data: storedCreation, error: storedCreationError } =
        await authorization.admin.from("asaas_provider_creation_attempts")
          .select("external_reference,request_fingerprint")
          .eq("tenant_id", tenantId)
          .eq("operation", "PAYMENT_CREATE")
          .eq("logical_key", paymentLogicalKey)
          .maybeSingle();
      if (storedCreationError) {
        await recordPaymentPeriod(
          paymentPeriodClaim.action === "RECONCILE_REQUIRED"
            ? "UNKNOWN"
            : "RETRY",
          null,
          "manual_pix_creation_claim_lookup_unavailable",
        );
        return json({
          success: false,
          error: "Não foi possível conferir a adoção durável da cobrança.",
        }, 503);
      }
      if (
        storedCreation &&
        text(storedCreation.external_reference) !== observedExternalReference
      ) {
        await recordPaymentPeriod(
          "BLOCKED",
          observedPaymentId,
          "provider_creation_reference_conflict",
        );
        return json({
          success: false,
          error: "A referência durável da cobrança precisa de revisão.",
        }, 409);
      }
      const creationFingerprint = text(storedCreation?.request_fingerprint) ||
        await asaasCreationFingerprint({
          tenantId,
          operation: "PAYMENT_CREATE",
          logicalKey: paymentLogicalKey,
          adoption: {
            providerPaymentId: observedPaymentId,
            customer: asaasCustomerId,
            subscription: text(payment.subscription) || null,
            externalReference: observedExternalReference,
            billingType: text(payment.billingType).toUpperCase(),
            value,
            dueDate: targetDueDate,
            splitPolicy,
          },
        });
      const paymentClaim = await claimAsaasCreation(authorization.admin, {
        tenantId,
        operation: "PAYMENT_CREATE",
        logicalKey: paymentLogicalKey,
        externalReference: observedExternalReference,
        requestFingerprint: creationFingerprint,
      });
      paymentLifecycleClaim = paymentClaim;
      if (paymentClaim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "A cobrança já está sendo conciliada.",
          retry_after_seconds: paymentClaim.retry_after_seconds || 15,
        }, 409);
      }
      if (paymentClaim.action === "REVIEW_REQUIRED" || !paymentClaim.ok) {
        await recordPaymentPeriod(
          "BLOCKED",
          observedPaymentId,
          "provider_payment_adoption_requires_review",
        );
        return json({
          success: false,
          error: "A adoção durável da cobrança precisa de revisão.",
        }, 409);
      }
      if (
        paymentClaim.action === "ALREADY_SUCCEEDED" &&
        text(paymentClaim.provider_entity_id) !== observedPaymentId
      ) {
        await recordPaymentPeriod(
          "BLOCKED",
          observedPaymentId,
          "provider_payment_adoption_id_conflict",
        );
        return json({
          success: false,
          error: "A cobrança durável aponta para outra entidade no Asaas.",
        }, 409);
      }
      const paymentLifecycleInput = {
        tenantId,
        studentId,
        bindingKind: "STUDENT_PAYMENT" as const,
        expectedCustomerId: asaasCustomerId,
      };
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          paymentClaim,
          paymentLifecycleInput,
        )
      ) {
        await recordPaymentPeriod(
          "BLOCKED",
          observedPaymentId,
          "observed_payment_student_lifecycle_requires_review",
        );
        return json({
          success: false,
          error:
            "O ciclo de vida do aluno mudou e a cobrança precisa de revisão.",
        }, 409);
      }
      const exactObservedPayment = await providerRequest(
        paymentIntegration,
        `/payments/${encodeURIComponent(observedPaymentId)}`,
      );
      const exactObservedIdentity = exactObservedPayment.ok &&
        (billingSource === "MANUAL_PIX"
          ? providerPaymentMatchesManualIssuance(
            exactObservedPayment.data,
            {
              externalReference: observedExternalReference,
              customerId: asaasCustomerId,
              dueDate: targetDueDate,
              value,
              splitPolicy,
            },
          )
          : recurringPaymentSourceKey(
                exactObservedPayment.data,
                studentId,
                subscriptionId,
              ) === billingSourceKey &&
            providerPaymentMatchesMonthlyCompetence(
              exactObservedPayment.data,
              expectedMonthlyPayment,
            ));
      if (!exactObservedIdentity) {
        if (paymentClaim.action !== "ALREADY_SUCCEEDED") {
          await recordAsaasCreationState(authorization.admin, paymentClaim, {
            status: exactObservedPayment.ok
              ? "BLOCKED"
              : paymentClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            providerEntityId: observedPaymentId,
            httpStatus: exactObservedPayment.status,
            error: exactObservedPayment.ok
              ? "observed_payment_identity_mismatch"
              : "observed_payment_lookup_unavailable",
          });
        }
        await recordPaymentPeriod(
          exactObservedPayment.ok
            ? "BLOCKED"
            : paymentPeriodClaim.action === "RECONCILE_REQUIRED"
            ? "UNKNOWN"
            : "RETRY",
          observedPaymentId,
          exactObservedPayment.ok
            ? "observed_payment_identity_mismatch"
            : "observed_payment_lookup_unavailable",
        );
        return json({
          success: false,
          error: exactObservedPayment.ok
            ? "A cobrança encontrada divergiu da identidade esperada."
            : "Não foi possível confirmar a cobrança diretamente no Asaas.",
        }, exactObservedPayment.ok ? 409 : 503);
      }
      if (paymentClaim.action !== "ALREADY_SUCCEEDED") {
        await recordAsaasCreationState(authorization.admin, paymentClaim, {
          status: "SUCCEEDED",
          providerEntityId: observedPaymentId,
          providerStatus: text(exactObservedPayment.data.status),
          httpStatus: exactObservedPayment.status,
        });
      }
      payment = exactObservedPayment.data;
    }
    if (!payment) {
      const dueDate = targetDueDate;
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
            .select(
              "id,status,processing_started_at,updated_at,asaas_payment_id",
            )
            .eq("student_id", studentId)
            .eq("due_date", dueDate)
            .maybeSingle();
        if (claimLookupError || !existingClaim) {
          throw new Error("pix_claim_lookup_failed");
        }

        const startedAt = Date.parse(text(existingClaim.processing_started_at));
        const freshProcessing = text(existingClaim.status) === "PROCESSING" &&
          Number.isFinite(startedAt) && startedAt > Date.now() - 5 * 60_000;
        if (freshProcessing) {
          return json({
            success: false,
            error:
              "Este Pix já está sendo gerado em outra aba. Aguarde alguns segundos.",
          }, 409);
        }
        if (
          text(existingClaim.status) === "READY" &&
          !text(existingClaim.asaas_payment_id)
        ) {
          return json({
            success: false,
            error:
              "A emissão pronta não possui vínculo verificável e precisa de revisão.",
          }, 409);
        }

        const takeoverStartedAt = new Date().toISOString();
        const { data: claimed, error: takeoverError } = await authorization
          .admin.from("student_manual_pix_issuances")
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
            error:
              "Este Pix já está sendo gerado em outra aba. Aguarde alguns segundos.",
          }, 409);
        }
        issuanceId = text(claimed.id);
      } else {
        throw new Error(
          `pix_claim_failed:${claimInsertError?.code || "unknown"}`,
        );
      }
      manualIssuanceId = issuanceId;

      const externalReference = manualPixProviderReference(
        issuanceId,
        studentId,
      );
      manualPaymentExternalReference = externalReference;
      const paymentPayload: Record<string, unknown> = {
        customer: asaasCustomerId,
        billingType: "PIX",
        value,
        dueDate,
        description: `Mensalidade ${schoolName} - ${studentName}`.slice(
          0,
          500,
        ),
        externalReference,
        ...(split ? { split } : {}),
      };
      const paymentLogicalKey = `manual-pix:${issuanceId}`;
      const periodClaim: StudentBillingPeriodClaim =
        await claimStudentBillingPeriod(authorization.admin, {
          tenantId,
          studentId,
          dueDate,
          source: "MANUAL_PIX",
          sourceKey: paymentLogicalKey,
          requestFingerprint: await asaasCreationFingerprint({
            tenantId,
            studentId,
            dueDate,
            source: "MANUAL_PIX",
            customerId: asaasCustomerId,
            value,
          }),
        });
      paymentPeriodClaim = periodClaim;
      if (
        periodClaim.action === "CONFLICT" ||
        periodClaim.action === "REVIEW_REQUIRED" ||
        !periodClaim.ok
      ) {
        await authorization.admin.from("student_manual_pix_issuances").update({
          status: "FAILED",
          last_error: "billing_period_requires_review",
          updated_at: new Date().toISOString(),
        }).eq("id", issuanceId).eq("status", "PROCESSING");
        return json({
          success: false,
          error:
            "Outra automação já reservou este vencimento ou a competência precisa de revisão.",
        }, 409);
      }
      if (periodClaim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "Este vencimento já está sendo processado.",
          retry_after_seconds: periodClaim.retry_after_seconds || 15,
        }, 409);
      }
      const periodReconcileOnly = periodClaim.action === "RECONCILE_REQUIRED";
      const boundPeriodProviderId = periodClaim.action === "ALREADY_BOUND"
        ? text(periodClaim.provider_entity_id)
        : "";
      const recordPeriod = async (
        status: "RETRY" | "UNKNOWN" | "BOUND" | "FAILED" | "BLOCKED",
        providerEntityId?: string | null,
        error?: string | null,
      ) => {
        if (!periodClaim.claim_token) return;
        await recordStudentBillingPeriodState(
          authorization.admin,
          periodClaim,
          { status, providerEntityId, error },
        );
      };
      const paymentClaim = await claimAsaasCreation(authorization.admin, {
        tenantId,
        operation: "PAYMENT_CREATE",
        logicalKey: paymentLogicalKey,
        externalReference,
        requestFingerprint: await asaasCreationFingerprint({
          tenantId,
          operation: "PAYMENT_CREATE",
          logicalKey: paymentLogicalKey,
          payload: paymentPayload,
        }),
      });
      paymentLifecycleClaim = paymentClaim;
      if (paymentClaim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "Este Pix já está sendo processado em outra aba.",
          retry_after_seconds: paymentClaim.retry_after_seconds || 15,
        }, 409);
      }
      if (paymentClaim.action === "REVIEW_REQUIRED" || !paymentClaim.ok) {
        await authorization.admin.from("student_manual_pix_issuances").update({
          status: "FAILED",
          last_error: "provider_creation_requires_review",
          updated_at: new Date().toISOString(),
        }).eq("id", issuanceId).eq("status", "PROCESSING");
        return json({
          success: false,
          error: "Esta emissão precisa de revisão antes de tentar novamente.",
        }, 409);
      }
      const paymentLifecycleInput = {
        tenantId,
        studentId,
        bindingKind: "STUDENT_PAYMENT" as const,
        expectedCustomerId: asaasCustomerId,
      };
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          paymentClaim,
          paymentLifecycleInput,
        )
      ) {
        await recordPeriod(
          "BLOCKED",
          null,
          "manual_pix_student_lifecycle_requires_review",
        );
        return json({
          success: false,
          error:
            "O ciclo de vida do aluno mudou e esta cobrança precisa de revisão.",
        }, 409);
      }

      const expectedPayment = {
        externalReference,
        customerId: asaasCustomerId,
        dueDate,
        value,
        splitPolicy,
      };
      let submittedNow = false;
      if (paymentClaim.action === "ALREADY_SUCCEEDED") {
        const claimedPaymentId = text(paymentClaim.provider_entity_id);
        const claimedPayment = claimedPaymentId
          ? await providerRequest(
            paymentIntegration,
            `/payments/${encodeURIComponent(claimedPaymentId)}`,
          )
          : null;
        if (
          !claimedPayment?.ok ||
          !providerPaymentMatchesManualIssuance(
            claimedPayment.data,
            expectedPayment,
          )
        ) {
          await recordPeriod(
            "BLOCKED",
            claimedPaymentId,
            "claimed_provider_payment_identity_mismatch",
          );
          return json({
            success: false,
            error: "A cobrança recuperada do Asaas precisa de revisão.",
          }, 409);
        }
        if (
          boundPeriodProviderId && boundPeriodProviderId !== claimedPaymentId
        ) {
          return json({
            success: false,
            error: "A competência está vinculada a outra cobrança no Asaas.",
          }, 409);
        }
        payment = claimedPayment.data;
      } else {
        const lookup = await findUniqueAsaasEntity<ProviderPayment>({
          baseUrl: paymentIntegration.baseUrl,
          apiKey: paymentIntegration.apiKey,
          path: "payments",
          query: {
            externalReference,
          },
          matches: (candidate) =>
            providerPaymentMatchesManualIssuance(candidate, expectedPayment),
          conflicts: (candidate) =>
            candidate.deleted !== true &&
            text(candidate.externalReference) === externalReference,
        });
        if (lookup.kind === "DUPLICATE" || lookup.kind === "CONFLICT") {
          await recordAsaasCreationState(authorization.admin, paymentClaim, {
            status: "BLOCKED",
            error: lookup.kind === "DUPLICATE"
              ? "duplicate_manual_pix_payments"
              : "manual_pix_provider_identity_conflict",
          });
          await recordPeriod(
            "BLOCKED",
            null,
            lookup.kind === "DUPLICATE"
              ? "duplicate_manual_pix_payments"
              : "manual_pix_provider_identity_conflict",
          );
          await authorization.admin.from("student_manual_pix_issuances").update(
            {
              status: "FAILED",
              last_error: lookup.kind === "DUPLICATE"
                ? "duplicate_provider_payments"
                : "provider_payment_identity_conflict",
              updated_at: new Date().toISOString(),
            },
          ).eq("id", issuanceId).eq("status", "PROCESSING");
          return json({
            success: false,
            error: lookup.kind === "DUPLICATE"
              ? "Foram encontradas cobranças duplicadas no Asaas."
              : "A referência desta emissão já pertence a outra cobrança no Asaas.",
          }, 409);
        }
        if (lookup.kind === "UNAVAILABLE") {
          await recordAsaasCreationState(authorization.admin, paymentClaim, {
            status: paymentClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            httpStatus: lookup.httpStatus,
            error: "manual_pix_recovery_lookup_unavailable",
          });
          if (periodClaim.action === "SUBMIT_ONCE") {
            await recordPeriod(
              "RETRY",
              null,
              "manual_pix_recovery_lookup_unavailable",
            );
          }
          await authorization.admin.from("student_manual_pix_issuances").update(
            {
              last_error: "provider_reconciliation_unavailable",
              updated_at: new Date().toISOString(),
            },
          ).eq("id", issuanceId).eq("status", "PROCESSING");
          return json({
            success: false,
            error: "Não foi possível conferir a cobrança no Asaas.",
          }, 503);
        }
        if (lookup.kind === "FOUND") {
          const recoveredPaymentId = text(lookup.entity.id);
          if (!recoveredPaymentId) {
            await recordAsaasCreationState(
              authorization.admin,
              paymentClaim,
              { status: "BLOCKED", error: "provider_payment_id_missing" },
            );
            return json({
              success: false,
              error: "A cobrança recuperada do Asaas precisa de revisão.",
            }, 409);
          }
          if (
            boundPeriodProviderId &&
            boundPeriodProviderId !== recoveredPaymentId
          ) {
            await recordAsaasCreationState(
              authorization.admin,
              paymentClaim,
              {
                status: "BLOCKED",
                providerEntityId: recoveredPaymentId,
                error: "billing_period_provider_id_mismatch",
              },
            );
            return json({
              success: false,
              error: "A competência está vinculada a outra cobrança no Asaas.",
            }, 409);
          }
          await recordAsaasCreationState(authorization.admin, paymentClaim, {
            status: "SUCCEEDED",
            providerEntityId: recoveredPaymentId,
            providerStatus: text(lookup.entity.status),
          });
          payment = lookup.entity;
        } else if (
          paymentClaim.action === "RECONCILE_REQUIRED" ||
          periodReconcileOnly || boundPeriodProviderId
        ) {
          await recordAsaasCreationState(authorization.admin, paymentClaim, {
            status: paymentClaim.action === "RECONCILE_REQUIRED"
              ? "UNKNOWN"
              : "RETRY",
            error: "manual_pix_payment_not_yet_observed",
          });
          return json({
            success: false,
            error: "A emissão ainda está sendo conciliada com o Asaas.",
          }, 409);
        } else {
          // The broad customer read happened before the durable claim. Repeat
          // it immediately before submission so a recurring automation or
          // another billing flow cannot silently occupy the same competence in
          // that interval.
          const latestPayments = await providerListAll<ProviderPayment>(
            paymentIntegration,
            "/payments",
            { customer: asaasCustomerId },
          );
          if (!latestPayments.ok) {
            await recordAsaasCreationState(authorization.admin, paymentClaim, {
              status: "RETRY",
              httpStatus: latestPayments.status,
              error: "manual_pix_pre_submit_revalidation_unavailable",
            });
            await recordPeriod(
              "RETRY",
              null,
              "manual_pix_pre_submit_revalidation_unavailable",
            );
            return json({
              success: false,
              error:
                "Não foi possível confirmar novamente a competência antes da emissão.",
            }, 503);
          }
          const competingPayment = latestPayments.data
            .filter((candidate) =>
              paymentBelongsToStudent(candidate, studentId, subscriptionId)
            )
            .find((candidate) =>
              text(candidate.externalReference) !== externalReference &&
              paymentOccupiesDueDate(candidate, dueDate)
            );
          if (competingPayment) {
            await recordAsaasCreationState(authorization.admin, paymentClaim, {
              status: "BLOCKED",
              providerEntityId: text(competingPayment.id),
              providerStatus: text(competingPayment.status),
              error: "billing_competence_occupied_before_submit",
            });
            await recordPeriod(
              "BLOCKED",
              text(competingPayment.id),
              "billing_competence_occupied_before_submit",
            );
            await authorization.admin.from("student_manual_pix_issuances")
              .update({
                status: "FAILED",
                last_error: "billing_competence_occupied",
                updated_at: new Date().toISOString(),
              }).eq("id", issuanceId).eq("status", "PROCESSING");
            return json({
              success: false,
              error:
                "Outra cobrança passou a ocupar este vencimento; nenhum novo Pix foi criado.",
            }, 409);
          }
          const { data: latestTenant, error: latestTenantError } =
            await authorization.admin.from("tenants")
              .select("asaas_wallet_id,asaas_split_percentage")
              .eq("id", tenantId)
              .maybeSingle();
          if (latestTenantError || !latestTenant) {
            await recordAsaasCreationState(authorization.admin, paymentClaim, {
              status: "RETRY",
              error: "manual_pix_split_revalidation_unavailable",
            });
            await recordPeriod(
              "RETRY",
              null,
              "manual_pix_split_revalidation_unavailable",
            );
            return json({
              success: false,
              error:
                "Não foi possível confirmar a configuração de repasse antes da emissão.",
            }, 503);
          }
          const latestSplitPolicy = canonicalEnrollmentSplitPolicy(
            paymentIntegration.mode,
            latestTenant.asaas_wallet_id,
            latestTenant.asaas_split_percentage,
          );
          if (
            !latestSplitPolicy ||
            !providerSplitPoliciesEqual(latestSplitPolicy, splitPolicy)
          ) {
            await recordAsaasCreationState(authorization.admin, paymentClaim, {
              status: "BLOCKED",
              error: latestSplitPolicy
                ? "manual_pix_split_configuration_changed"
                : "manual_pix_split_configuration_invalid",
            });
            await recordPeriod(
              "BLOCKED",
              null,
              latestSplitPolicy
                ? "manual_pix_split_configuration_changed"
                : "manual_pix_split_configuration_invalid",
            );
            return json({
              success: false,
              error:
                "A configuração de repasse mudou e esta emissão precisa ser reiniciada.",
            }, 409);
          }
          await markStudentBillingPeriodSubmitting(
            authorization.admin,
            periodClaim,
          );
          await markStudentAsaasCreationSubmitting(
            authorization.admin,
            paymentClaim,
            paymentLifecycleInput,
          );
          let submitPaymentIntegration: ResolvedAsaasIntegration;
          try {
            submitPaymentIntegration = await revalidateAsaasMutationCapability(
              authorization.admin,
              {
                tenantId,
                purpose: "payment.create",
                expected: paymentIntegration,
              },
            );
          } catch (error) {
            const unavailable = error instanceof AsaasCapabilityFenceError &&
              error.failure === "UNAVAILABLE";
            const state = "BLOCKED" as const;
            const stateError = unavailable
              ? "payment_capability_unavailable_before_submit"
              : "payment_capability_changed_before_submit";
            await recordAsaasCreationState(
              authorization.admin,
              paymentClaim,
              { status: state, error: stateError },
            );
            await recordPeriod(state, null, stateError);
            return json({
              success: false,
              error: unavailable
                ? "A capacidade de cobrança no Asaas está indisponível."
                : "A credencial de cobrança no Asaas mudou; reinicie a emissão.",
            }, unavailable ? 503 : 409);
          }
          let createdPayment: Awaited<ReturnType<typeof providerRequest>>;
          try {
            createdPayment = await providerRequest(
              submitPaymentIntegration,
              "/payments",
              "POST",
              paymentPayload,
            );
          } catch {
            await recordAsaasCreationState(
              authorization.admin,
              paymentClaim,
              {
                status: "UNKNOWN",
                error: "manual_pix_payment_post_outcome_unknown",
              },
            );
            await recordPeriod(
              "UNKNOWN",
              null,
              "manual_pix_payment_post_outcome_unknown",
            );
            return json({
              success: false,
              error: "O resultado da emissão no Asaas precisa ser conciliado.",
            }, 502);
          }
          const providerPaymentId = text(createdPayment.data.id);
          const outcome = asaasCreationHttpOutcome(
            createdPayment.ok,
            createdPayment.status,
            providerPaymentId,
          );
          const exactCreatedPayment = outcome !== "SUCCEEDED" ||
            providerPaymentMatchesManualIssuance(
              createdPayment.data,
              expectedPayment,
            );
          await recordAsaasCreationState(authorization.admin, paymentClaim, {
            status: exactCreatedPayment ? outcome : "BLOCKED",
            providerEntityId: providerPaymentId,
            providerStatus: text(createdPayment.data.status),
            httpStatus: createdPayment.status,
            error: !exactCreatedPayment
              ? "manual_pix_post_identity_mismatch"
              : outcome === "SUCCEEDED"
              ? null
              : outcome === "FAILED"
              ? "manual_pix_payment_creation_rejected"
              : "manual_pix_payment_post_outcome_unknown",
          });
          if (!exactCreatedPayment || outcome !== "SUCCEEDED") {
            await recordPeriod(
              !exactCreatedPayment
                ? "BLOCKED"
                : outcome === "FAILED"
                ? "FAILED"
                : "UNKNOWN",
              providerPaymentId,
              !exactCreatedPayment
                ? "manual_pix_post_identity_mismatch"
                : outcome === "FAILED"
                ? "manual_pix_payment_creation_rejected"
                : "manual_pix_payment_post_outcome_unknown",
            );
          }
          if (!exactCreatedPayment) {
            await authorization.admin.from("student_manual_pix_issuances")
              .update({
                status: "FAILED",
                last_error: "provider_post_identity_mismatch",
                updated_at: new Date().toISOString(),
              }).eq("id", issuanceId).eq("status", "PROCESSING");
            return json({
              success: false,
              error:
                "A cobrança criada divergiu da emissão esperada e precisa de revisão.",
            }, 409);
          }
          if (outcome !== "SUCCEEDED") {
            if (outcome === "FAILED") {
              await authorization.admin.from("student_manual_pix_issuances")
                .update({
                  status: "FAILED",
                  last_error: `asaas_status_${createdPayment.status}`,
                  updated_at: new Date().toISOString(),
                }).eq("id", issuanceId).eq("status", "PROCESSING");
            }
            return json({
              success: false,
              error: outcome === "FAILED"
                ? providerMessage(
                  createdPayment.data,
                  "Não foi possível criar a cobrança Pix.",
                )
                : "O resultado da emissão no Asaas precisa ser conciliado.",
            }, outcome === "FAILED" ? 422 : 502);
          }
          payment = createdPayment.data;
          submittedNow = true;
        }
      }

      if (!payment || !text(payment.id)) {
        throw new Error("manual_pix_creation_state_invalid");
      }
      reused = !submittedNow;
    }

    const paymentIdentity = await providerRequest(
      paymentIntegration,
      `/payments/${encodeURIComponent(text(payment?.id))}`,
    );
    const exactPaymentIdentity = paymentIdentity.ok &&
      (manualIssuanceId
        ? providerPaymentMatchesManualIssuance(paymentIdentity.data, {
          externalReference: manualPaymentExternalReference,
          customerId: asaasCustomerId,
          dueDate: targetDueDate,
          value,
          splitPolicy,
        })
        : recurringPaymentSourceKey(
              paymentIdentity.data,
              studentId,
              subscriptionId,
            ) === recurringBillingSourceKey &&
          providerPaymentMatchesMonthlyCompetence(
            paymentIdentity.data,
            expectedMonthlyPayment,
          ));
    if (
      !exactPaymentIdentity
    ) {
      return json({
        success: false,
        error:
          "A cobrança mudou ou deixou de estar aberta antes da emissão do código Pix.",
      }, paymentIdentity.ok ? 409 : 503);
    }
    payment = paymentIdentity.data;

    const paymentId = text(payment.id);
    const paymentValue = Number(payment.value) || value;
    const paymentStatus = text(payment.status) || "PENDING";
    const localPendingStatus = ["PENDING", "OVERDUE"].includes(
        paymentStatus.toUpperCase(),
      )
      ? paymentStatus.toUpperCase()
      : "PENDING";
    const dueDate = text(payment.dueDate) ||
      nextUpcomingDueDate(new Date(), dueDay);
    const description = text(payment.description) ||
      `Mensalidade ${schoolName} - ${studentName}`;
    const invoiceUrl = text(payment.bankSlipUrl || payment.invoiceUrl) || null;

    // The local provider ID is immutable ownership, not an upsert target that
    // may be reassigned. A GET here can establish only a pending snapshot;
    // cash settlement remains exclusive to the signed webhook.
    const pendingSnapshot = {
      asaas_payment_id: paymentId,
      provider_customer_id: asaasCustomerId,
      student_id: studentId,
      tenant_id: tenantId,
      value: paymentValue,
      amount_cents: Math.round(paymentValue * 100),
      status: localPendingStatus,
      provider_status: paymentStatus,
      due_date: dueDate,
      billing_type: "PIX",
      payment_method: "PIX",
      invoice_url: invoiceUrl,
      description,
      payment_type: "SUBSCRIPTION",
      updated_at: new Date().toISOString(),
    };
    const loadLocalPayment = () =>
      authorization.admin.from("student_payments")
        .select(
          "id,student_id,tenant_id,provider_customer_id,value,status,due_date",
        )
        .eq("asaas_payment_id", paymentId)
        .maybeSingle();
    let { data: localPayment, error: localPaymentError } =
      await loadLocalPayment();
    if (localPaymentError) throw localPaymentError;

    if (!localPayment) {
      const inserted = await authorization.admin.from("student_payments")
        .insert(pendingSnapshot)
        .select(
          "id,student_id,tenant_id,provider_customer_id,value,status,due_date",
        )
        .maybeSingle();
      localPayment = inserted.data;
      localPaymentError = inserted.error;
      if (localPaymentError?.code === "23505") {
        const raced = await loadLocalPayment();
        localPayment = raced.data;
        localPaymentError = raced.error;
      }
      if (localPaymentError) {
        throw new Error(`payment_link_failed:${localPaymentError.code}`);
      }
    }
    if (
      !localPayment || localPayment.student_id !== studentId ||
      localPayment.tenant_id !== tenantId ||
      text(localPayment.provider_customer_id) !== asaasCustomerId ||
      Math.round(Number(localPayment.value) * 100) !==
        Math.round(paymentValue * 100) ||
      text(localPayment.due_date) !== dueDate
    ) {
      await authorization.admin.from("asaas_reconciliation_issues").insert({
        run_id: null,
        tenant_id: tenantId,
        source: "PAYMENT",
        kind: "MANUAL_PIX_LOCAL_BINDING_CONFLICT",
        severity: "CRITICAL",
        provider_entity_id: paymentId,
        local_entity_id: localPayment?.id || null,
        fingerprint: `manual-pix-local-binding:${paymentId}`,
        details: {
          requestedStudentId: studentId,
          existingStudentId: localPayment?.student_id || null,
          existingTenantId: localPayment?.tenant_id || null,
          existingValue: localPayment?.value ?? null,
          existingDueDate: localPayment?.due_date ?? null,
          providerValue: paymentValue,
        },
      });
      return json({
        success: false,
        error: "A cobrança já possui outro vínculo local e precisa de revisão.",
      }, 409);
    }
    const { data: updatedLocalPayment, error: paymentSaveError } =
      await authorization.admin.from("student_payments")
        .update({
          status: text(localPayment.status) || localPendingStatus,
          billing_type: "PIX",
          payment_method: "PIX",
          invoice_url: invoiceUrl,
          description,
          updated_at: new Date().toISOString(),
        })
        .eq("id", localPayment.id)
        .eq("student_id", studentId)
        .eq("tenant_id", tenantId)
        .eq("provider_customer_id", asaasCustomerId)
        .eq("asaas_payment_id", paymentId)
        .select("id")
        .maybeSingle();
    if (paymentSaveError || !updatedLocalPayment) {
      throw new Error(
        `payment_link_failed:${paymentSaveError?.code || "binding_lost"}`,
      );
    }
    if (
      paymentLifecycleClaim &&
      !await releaseStudentAsaasCreationLifecycle(
        authorization.admin,
        paymentLifecycleClaim,
        {
          tenantId,
          studentId,
          providerEntityId: paymentId,
        },
      )
    ) {
      return json({
        success: false,
        error:
          "O vínculo local da cobrança não pôde ser confirmado com segurança.",
      }, 409);
    }
    await recordPaymentPeriod("BOUND", paymentId);

    if (manualIssuanceId) {
      const { data: issuance, error: issuanceLookupError } = await authorization
        .admin.from("student_manual_pix_issuances")
        .select("id,tenant_id,student_id,due_date,asaas_payment_id,status")
        .eq("id", manualIssuanceId)
        .eq("tenant_id", tenantId)
        .eq("student_id", studentId)
        .eq("due_date", dueDate)
        .maybeSingle();
      if (
        issuanceLookupError || !issuance ||
        !["PROCESSING", "READY"].includes(text(issuance.status)) ||
        (text(issuance.asaas_payment_id) &&
          text(issuance.asaas_payment_id) !== paymentId)
      ) {
        throw new Error("manual_pix_ready_link_failed");
      }
      let readyUpdate = authorization.admin
        .from("student_manual_pix_issuances")
        .update({
          status: "READY",
          asaas_payment_id: paymentId,
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", manualIssuanceId)
        .eq("tenant_id", tenantId)
        .eq("student_id", studentId)
        .eq("due_date", dueDate)
        .eq("status", text(issuance.status));
      readyUpdate = text(issuance.asaas_payment_id)
        ? readyUpdate.eq("asaas_payment_id", paymentId)
        : readyUpdate.is("asaas_payment_id", null);
      const { data: readyIssuance, error: readyError } = await readyUpdate
        .select("asaas_payment_id,status")
        .maybeSingle();
      if (
        readyError || text(readyIssuance?.asaas_payment_id) !== paymentId ||
        text(readyIssuance?.status) !== "READY"
      ) {
        const currentIssuance = await authorization.admin
          .from("student_manual_pix_issuances")
          .select("asaas_payment_id,status")
          .eq("id", manualIssuanceId)
          .maybeSingle();
        if (
          currentIssuance.error ||
          text(currentIssuance.data?.asaas_payment_id) !== paymentId ||
          text(currentIssuance.data?.status) !== "READY"
        ) {
          throw new Error("manual_pix_ready_link_failed");
        }
      }
    }

    const pixResult = await providerRequest(
      paymentIntegration,
      `/payments/${encodeURIComponent(paymentId)}/pixQrCode`,
    );
    const pixPayload = text(pixResult.data.payload);
    if (!pixResult.ok || !pixPayload) {
      return json({
        success: false,
        error:
          "A cobrança foi vinculada, mas o Asaas não entregou o código Pix.",
      }, 502);
    }

    let directorInstance = "";
    if (!authorization.isService && authorization.callerId) {
      directorInstance = await loadTenantWhatsAppInstance(
        authorization.admin,
        tenantId,
        authorization.callerId,
        "student",
      ) || "";
    }
    if (!directorInstance) {
      directorInstance = await loadTenantCentralWhatsAppInstance(
        authorization.admin,
        tenantId,
        "student",
      ) || "";
    }

    const message = formatManualPixMessage({
      studentName,
      value: paymentValue,
      dueDate,
      pixPayload,
      brandName: schoolName,
    });
    const isTest = profile.is_test_account === true;
    let whatsapp: {
      sent: boolean;
      suppressed?: boolean;
      providerStatus?: number;
    } = { sent: false };
    const messageClaim = await claimOutboundMessage(authorization.admin, {
      tenantId,
      studentId,
      providerEntityId: paymentId,
      notificationKind: "MANUAL_PIX_CREATED",
    });
    if (messageClaim.action === "SUBMIT_ONCE") {
      if (isTest || !directorInstance) {
        await finishOutboundMessage(authorization.admin, messageClaim, {
          status: "SUPPRESSED",
          error: isTest ? "test_account" : "whatsapp_route_missing",
        });
        whatsapp = { sent: false, suppressed: true };
      } else {
        try {
          // Resolve routing before fencing the irreversible POST. Once
          // SUBMITTING is persisted, an ambiguous timeout is terminal and a
          // later invocation may never send the message again.
          const evolutionIntegration = await resolveEvolutionIntegration(
            authorization.admin,
            tenantId,
            "message.send_text",
          );
          await markOutboundMessageSubmitting(
            authorization.admin,
            messageClaim,
          );
          const delivery = await sendWhatsapp(
            evolutionIntegration,
            directorInstance,
            billingPhone,
            message,
          );
          await finishOutboundMessage(authorization.admin, messageClaim, {
            status: delivery.sent
              ? "SENT"
              : delivery.ambiguous
              ? "UNKNOWN"
              : "FAILED",
            providerHttpStatus: delivery.providerStatus,
            error: delivery.sent
              ? null
              : delivery.ambiguous
              ? "provider_delivery_outcome_unknown"
              : "provider_delivery_rejected",
          });
          whatsapp = delivery;
        } catch {
          // A cobrança já existe; a falha de configuração/mensageria não pode
          // provocar retry da criação financeira nem fallback entre tenants.
          whatsapp = { sent: false };
        }
      }
    } else if (messageClaim.action === "ALREADY_FINAL") {
      whatsapp = {
        sent: text(messageClaim.status).toUpperCase() === "SENT",
        suppressed: text(messageClaim.status).toUpperCase() === "SUPPRESSED",
      };
    }

    await authorization.admin.from("audit_logs").insert({
      tenant_id: tenantId,
      user_id: authorization.callerId,
      user_role: callerRole ||
        (authorization.isService ? "SERVICE" : "SCHOOL_ADMIN"),
      action: "student_manual_pix_generated",
      resource_type: "student_payment",
      resource_id: paymentId,
      new_values: {
        student_id: studentId,
        value: paymentValue,
        due_date: dueDate,
        reused,
        whatsapp_sent: whatsapp.sent,
        test_suppressed: "suppressed" in whatsapp &&
          whatsapp.suppressed === true,
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
      whatsappSuppressed: "suppressed" in whatsapp &&
        whatsapp.suppressed === true,
      whatsappUnavailable: !directorInstance,
    });
  } catch (cause) {
    const integrationUnavailable = cause instanceof
      TenantIntegrationBrokerError;
    console.error("[generate-student-manual-pix] unexpected", {
      type: cause instanceof Error ? cause.name : "UnknownError",
      code: cause instanceof Error ? cause.message.split(":")[0] : "unknown",
    });
    return json({
      success: false,
      error: integrationUnavailable
        ? "Asaas indisponível para esta escola."
        : "Não foi possível gerar o Pix manual.",
    }, integrationUnavailable ? 503 : 500);
  }
});
