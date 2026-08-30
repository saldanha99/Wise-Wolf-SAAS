/// <reference lib="deno.ns" />

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  authorizeRequest,
  type RequestAuthContext,
} from "../_shared/request-auth.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";
import { guardAsaasMutationTarget } from "../_shared/asaas-mutation-guard.ts";
import { providerCustomerMatchesStudent } from "../_shared/student-provider-lifecycle.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type AsaasDeletionResult = {
  subscriptionDeleted: boolean;
  customerDeleted: boolean;
  error: string | null;
  failedStage: "subscription" | "customer" | null;
};

type DeletionClaim = {
  id: string;
  token: string;
  action: "PROCEED" | "RECONCILE_REQUIRED" | "FINALIZE_REQUIRED";
  tenantId: string;
  studentId: string;
  customerId: string;
  subscriptionId: string;
  billingCpf: string;
  subscriptionDeleted: boolean;
  customerDeleted: boolean;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function domainFailure(
  error: string,
  details: Record<string, unknown> = {},
) {
  // O caller atual lê data.error. Manter HTTP 200 aqui preserva a mensagem útil
  // na interface, sem jamais responder success:true em uma exclusão parcial.
  return json({ success: false, error, ...details });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value);
}

function isAuthNotFound(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: number; message?: string };
  return candidate.status === 404 ||
    /not found|does not exist/i.test(candidate.message || "");
}

async function asaasError(response: Response) {
  const payload = await response.json().catch(() => null) as
    | { errors?: Array<{ description?: string }>; error?: string }
    | null;
  const descriptions = payload?.errors
    ?.map((item) => item.description)
    .filter(Boolean)
    .join("; ");
  const message = descriptions || payload?.error ||
    `HTTP ${response.status}`;
  return message.slice(0, 500);
}

const normalizedText = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const normalizedDigits = (value: unknown) =>
  String(value || "").replace(/\D/g, "");

function billingCpfForProfile(profile: Record<string, unknown>): string {
  const dependent = Boolean(
    normalizedText(profile.guardian_id) ||
      normalizedDigits(profile.guardian_cpf),
  );
  return normalizedDigits(dependent ? profile.guardian_cpf : profile.cpf);
}

async function beginDeletionClaim(
  admin: RequestAuthContext["admin"],
  input: { tenantId: string; studentId: string; requestedBy: string },
): Promise<
  | { kind: "CLAIMED"; claim: DeletionClaim }
  | { kind: "IN_PROGRESS" }
  | { kind: "COMPLETED" }
  | { kind: "REVIEW_REQUIRED" }
> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await admin.rpc("begin_student_account_deletion", {
    p_tenant_id: input.tenantId,
    p_student_id: input.studentId,
    p_requested_by: input.requestedBy,
    p_claim_token: claimToken,
    p_lease_seconds: 300,
  });
  if (error || !data || typeof data !== "object") {
    throw new Error(
      `deletion_claim_failed:${error?.code || "invalid_response"}`,
    );
  }
  const result = data as Record<string, unknown>;
  const action = normalizedText(result.action);
  if (action === "IN_PROGRESS") return { kind: "IN_PROGRESS" };
  if (action === "ALREADY_COMPLETED") return { kind: "COMPLETED" };
  if (result.ok !== true || action === "REVIEW_REQUIRED") {
    return { kind: "REVIEW_REQUIRED" };
  }
  if (
    !["PROCEED", "RECONCILE_REQUIRED", "FINALIZE_REQUIRED"].includes(action)
  ) {
    throw new Error("deletion_claim_response_invalid");
  }
  const id = normalizedText(result.claim_id);
  const returnedToken = normalizedText(result.claim_token);
  if (!id || returnedToken !== claimToken) {
    throw new Error("deletion_claim_response_invalid");
  }
  return {
    kind: "CLAIMED",
    claim: {
      id,
      token: claimToken,
      action: action as DeletionClaim["action"],
      tenantId: normalizedText(result.tenant_id),
      studentId: normalizedText(result.student_id),
      customerId: normalizedText(result.customer_id),
      subscriptionId: normalizedText(result.subscription_id),
      billingCpf: normalizedDigits(result.billing_cpf),
      subscriptionDeleted: result.subscription_deleted === true,
      customerDeleted: result.customer_deleted === true,
    },
  };
}

async function recordDeletionProviderState(
  admin: RequestAuthContext["admin"],
  claim: DeletionClaim,
  resource: "subscription" | "customer",
  outcome: "STARTED" | "DELETED" | "ABSENT" | "UNKNOWN" | "FAILED",
  error: string | null = null,
): Promise<boolean> {
  const { data, error: rpcError } = await admin.rpc(
    "record_student_account_deletion_provider_state",
    {
      p_claim_id: claim.id,
      p_claim_token: claim.token,
      p_resource: resource,
      p_outcome: outcome,
      p_error: error,
    },
  );
  return !rpcError && data?.ok === true;
}

async function bindDeletionIntegrations(
  admin: RequestAuthContext["admin"],
  claim: DeletionClaim,
  subscription: ResolvedAsaasIntegration | null,
  customer: ResolvedAsaasIntegration | null,
): Promise<boolean> {
  const { data, error } = await admin.rpc(
    "bind_student_account_deletion_integrations",
    {
      p_claim_id: claim.id,
      p_claim_token: claim.token,
      p_subscription_integration_id: subscription?.integrationId || null,
      p_subscription_version: subscription?.version || null,
      p_subscription_environment: subscription?.environment || null,
      p_subscription_mode: subscription?.mode || null,
      p_customer_integration_id: customer?.integrationId || null,
      p_customer_version: customer?.version || null,
      p_customer_environment: customer?.environment || null,
      p_customer_mode: customer?.mode || null,
    },
  );
  return !error && data?.ok === true;
}

type StudentMembershipScope =
  | { ok: true; tenantId: string }
  | { ok: false; unavailable: boolean };

async function loadExclusiveActiveStudentScope(
  admin: RequestAuthContext["admin"],
  studentId: string,
  profileTenantId: unknown,
): Promise<StudentMembershipScope> {
  const { data, error } = await admin.from("tenant_memberships")
    .select("tenant_id,role,status")
    .eq("user_id", studentId)
    .limit(2);
  if (error) {
    console.error(
      "[delete-student-account] Falha ao consultar vinculo do alvo",
      { code: error.code },
    );
    return { ok: false, unavailable: true };
  }

  const tenantId = typeof profileTenantId === "string"
    ? profileTenantId.trim()
    : "";
  if (data?.length !== 1) return { ok: false, unavailable: false };
  const membership = data[0];
  if (
    !tenantId || membership.tenant_id !== tenantId ||
    membership.role !== "STUDENT" || membership.status !== "ACTIVE"
  ) {
    return { ok: false, unavailable: false };
  }
  return { ok: true, tenantId };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Método não permitido." }, 405);
  }

  try {
    const auth = await authorizeRequest(req, {
      allowInactiveTenant: true,
      allowService: false,
      allowedRoles: ["SCHOOL_ADMIN", "SUPER_ADMIN"],
      corsHeaders,
    });
    if (auth.ok === false) return auth.response;
    const supabase = auth.context.admin;
    const callerId = auth.context.userId;
    const adminProfile = auth.context.profile;
    if (!callerId || !adminProfile) {
      return json({ error: "Não foi possível validar sua permissão." }, 403);
    }

    const body = await req.json().catch(() => null) as
      | {
        studentId?: unknown;
        applyPenalty?: unknown;
        penaltyValue?: unknown;
      }
      | null;
    if (!body || !isUuid(body.studentId)) {
      return json({ error: "Aluno inválido." }, 400);
    }
    const studentId = body.studentId;
    if (studentId === callerId) {
      return json({
        error:
          "Você não pode excluir sua própria conta enquanto estiver logado.",
      }, 400);
    }

    const applyPenaltyRequested = body.applyPenalty === true;

    const { data: studentProfile, error: profileError } = await supabase
      .from("profiles")
      .select(
        "id, role, tenant_id, lifecycle_status, asaas_customer_id, subscription_id, is_test_account, cpf, guardian_id, guardian_cpf",
      )
      .eq("id", studentId)
      .maybeSingle();
    if (profileError) {
      console.error(
        "[delete-student-account] Falha ao consultar alvo",
        profileError.message,
      );
      return json({ error: "Não foi possível validar o aluno." }, 503);
    }
    if (!studentProfile) {
      // Crash recovery after Auth/profile deletion: the durable claim survives
      // without an FK and is the only authority allowed to finish this path.
      const { data: existingClaim, error: claimLookupError } = await supabase
        .from("student_account_deletion_claims")
        .select("tenant_id,status")
        .eq("student_id", studentId)
        .maybeSingle();
      if (claimLookupError || !existingClaim) {
        return json({ error: "Aluno não encontrado." }, 404);
      }
      if (
        adminProfile.role !== "SUPER_ADMIN" &&
        existingClaim.tenant_id !== adminProfile.tenant_id
      ) {
        return json({ error: "Aluno pertence a outra escola." }, 403);
      }
      if (
        !["PROVIDER_COMPLETE", "COMPLETED"].includes(existingClaim.status)
      ) {
        return domainFailure(
          "O perfil está ausente antes da conclusão financeira e precisa de revisão técnica.",
          { retryable: false },
        );
      }
      const recovered = await beginDeletionClaim(supabase, {
        tenantId: existingClaim.tenant_id,
        studentId,
        requestedBy: callerId,
      });
      if (recovered.kind === "COMPLETED") {
        return json({
          success: true,
          message: "Aluno já removido do acesso, do perfil e do financeiro.",
          penaltyIgnoredForTest: applyPenaltyRequested,
          idempotent: true,
        });
      }
      if (
        recovered.kind !== "CLAIMED" ||
        recovered.claim.action !== "FINALIZE_REQUIRED"
      ) {
        return domainFailure(
          "A confirmação durável da exclusão precisa de revisão técnica.",
          { retryable: false },
        );
      }
      const authLookup = await supabase.auth.admin.getUserById(studentId);
      if (authLookup.error && !isAuthNotFound(authLookup.error)) {
        return domainFailure(
          "Não foi possível confirmar a remoção do acesso do aluno.",
          { retryable: true },
        );
      }
      if (authLookup.data.user) {
        const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(
          studentId,
        );
        if (deleteAuthError && !isAuthNotFound(deleteAuthError)) {
          return domainFailure(
            "Não foi possível concluir a remoção do acesso do aluno.",
            { retryable: true },
          );
        }
      }
      const authCheck = await supabase.auth.admin.getUserById(studentId);
      if (
        authCheck.data.user ||
        (authCheck.error && !isAuthNotFound(authCheck.error))
      ) {
        return domainFailure(
          "A remoção do acesso ainda não foi confirmada.",
          { retryable: true },
        );
      }
      const { data: finalized, error: finalizeError } = await supabase.rpc(
        "finalize_student_account_deletion",
        {
          p_claim_id: recovered.claim.id,
          p_claim_token: recovered.claim.token,
          p_profile_absent: true,
          p_auth_absent: true,
        },
      );
      if (finalizeError || finalized?.ok !== true) {
        return domainFailure(
          "A exclusão local terminou, mas a confirmação durável precisa de revisão técnica.",
          { retryable: false, partial: true },
        );
      }
      return json({
        success: true,
        message: "Aluno removido do acesso, do perfil e do financeiro.",
        penaltyIgnoredForTest: applyPenaltyRequested,
        recovered: true,
      });
    }
    if (studentProfile.role !== "STUDENT") {
      return json({
        error: "Esta função só pode excluir contas com papel de aluno.",
      }, 409);
    }
    if (
      String(studentProfile.lifecycle_status || "").trim().toLowerCase() !==
        "active"
    ) {
      return json({
        error: "A conta do aluno não está ativa. A exclusão foi bloqueada.",
      }, 409);
    }
    const targetScope = await loadExclusiveActiveStudentScope(
      supabase,
      studentId,
      studentProfile.tenant_id,
    );
    if (targetScope.ok === false) {
      return json({
        error: targetScope.unavailable
          ? "Não foi possível validar o vínculo ativo do aluno."
          : "O aluno não possui um único vínculo escolar ativo e coerente.",
      }, targetScope.unavailable ? 503 : 409);
    }
    const targetTenantId = targetScope.tenantId;
    if (
      adminProfile.role !== "SUPER_ADMIN" &&
      targetTenantId !== adminProfile.tenant_id
    ) {
      return json({ error: "Aluno pertence a outra escola." }, 403);
    }
    if (!studentProfile.is_test_account) {
      return domainFailure(
        "A exclusão permanente é reservada a contas de teste. Para um aluno real, use a opção “Desligar”, que cancela as cobranças futuras e preserva o histórico.",
      );
    }

    const claimed = await beginDeletionClaim(supabase, {
      tenantId: targetTenantId,
      studentId,
      requestedBy: callerId,
    });
    if (claimed.kind === "IN_PROGRESS") {
      return domainFailure(
        "A exclusão já está sendo processada por outra solicitação.",
        { retryable: true },
      );
    }
    if (claimed.kind === "COMPLETED") {
      return json({
        success: true,
        message: "Aluno já removido do acesso, do perfil e do financeiro.",
        penaltyIgnoredForTest: applyPenaltyRequested,
        idempotent: true,
      });
    }
    if (claimed.kind === "REVIEW_REQUIRED") {
      return domainFailure(
        "A exclusão possui um estado anterior divergente e precisa de revisão técnica.",
        { retryable: false },
      );
    }
    const claim = claimed.claim;
    if (
      claim.tenantId !== targetTenantId || claim.studentId !== studentId ||
      claim.billingCpf.length !== 11
    ) {
      return domainFailure(
        "A trava de exclusão retornou um vínculo inválido.",
        { retryable: false },
      );
    }

    const customerId = claim.customerId;
    const subscriptionId = claim.subscriptionId;
    // Fixtures jamais geram multa rescisória, mesmo que um caller antigo envie
    // a opção que existia na tela de exclusão de alunos reais.
    const needsAsaas = Boolean(customerId || subscriptionId);
    const asaas: AsaasDeletionResult = {
      subscriptionDeleted: claim.subscriptionDeleted,
      customerDeleted: claim.customerDeleted,
      error: null,
      failedStage: null,
    };
    let asaasFailureRetryable = true;

    const { data: providerTarget, error: providerTargetError } = await supabase
      .from("profiles")
      .select(
        "id,role,tenant_id,lifecycle_status,is_test_account,asaas_customer_id,subscription_id,cpf,guardian_id,guardian_cpf",
      )
      .eq("id", studentId)
      .maybeSingle();
    if (
      providerTargetError || !providerTarget ||
      providerTarget.role !== "STUDENT" ||
      providerTarget.tenant_id !== targetTenantId ||
      normalizedText(providerTarget.lifecycle_status).toLowerCase() !==
        "active" ||
      providerTarget.is_test_account !== true ||
      normalizedText(providerTarget.asaas_customer_id) !== customerId ||
      normalizedText(providerTarget.subscription_id) !== subscriptionId ||
      billingCpfForProfile(providerTarget) !== claim.billingCpf
    ) {
      return domainFailure(
        "O vínculo financeiro do aluno mudou depois da aquisição da trava. Nenhuma chamada destrutiva foi iniciada.",
        { retryable: false },
      );
    }
    const providerScope = await loadExclusiveActiveStudentScope(
      supabase,
      studentId,
      providerTarget.tenant_id,
    );
    if (providerScope.ok === false) {
      return domainFailure(
        "O vínculo escolar mudou antes da limpeza financeira.",
        { retryable: providerScope.unavailable },
      );
    }

    let subscriptionIntegration: ResolvedAsaasIntegration | null = null;
    let customerIntegration: ResolvedAsaasIntegration | null = null;
    if (needsAsaas && claim.action !== "FINALIZE_REQUIRED") {
      try {
        [subscriptionIntegration, customerIntegration] = await Promise.all([
          subscriptionId
            ? resolveAsaasIntegration(
              supabase,
              targetTenantId,
              "subscription.delete",
            )
            : Promise.resolve(null),
          customerId
            ? resolveAsaasIntegration(
              supabase,
              targetTenantId,
              "customer.delete",
            )
            : Promise.resolve(null),
        ]);
      } catch {
        return domainFailure(
          "A exclusão foi interrompida porque a integração financeira desta escola não está disponível. Nenhum dado local foi removido.",
          { asaas: { ...asaas, error: "Integração Asaas indisponível" } },
        );
      }
    }

    if (
      claim.action !== "FINALIZE_REQUIRED" &&
      !await bindDeletionIntegrations(
        supabase,
        claim,
        subscriptionIntegration,
        customerIntegration,
      )
    ) {
      return domainFailure(
        "A conta ou a versão da integração Asaas mudou durante a exclusão. A operação foi bloqueada para revisão.",
        { retryable: false },
      );
    }

    if (claim.action !== "FINALIZE_REQUIRED") {
      try {
        if (!asaas.subscriptionDeleted) {
          if (!subscriptionId) {
            asaas.subscriptionDeleted = await recordDeletionProviderState(
              supabase,
              claim,
              "subscription",
              "ABSENT",
            );
          } else if (subscriptionIntegration) {
            const guard = await guardAsaasMutationTarget({
              admin: supabase,
              baseUrl: subscriptionIntegration.baseUrl,
              apiKey: subscriptionIntegration.apiKey,
              operation: "student_account_deletion_subscription_read",
              target: {
                tenantId: targetTenantId,
                studentId,
                resource: "subscription",
                entityId: subscriptionId,
                customerId,
                subscriptionId,
                subscriptionMatch: "entity_id",
              },
            });
            if (guard.ok === false && guard.code === "NOT_FOUND") {
              asaas.subscriptionDeleted = await recordDeletionProviderState(
                supabase,
                claim,
                "subscription",
                "ABSENT",
              );
            } else if (guard.ok === false) {
              asaas.failedStage = "subscription";
              asaas.error = "Identidade da assinatura não confirmada";
              asaasFailureRetryable = false;
              await recordDeletionProviderState(
                supabase,
                claim,
                "subscription",
                "FAILED",
                "subscription_identity_unverified",
              );
            } else {
              asaas.failedStage = "subscription";
              if (
                !await recordDeletionProviderState(
                  supabase,
                  claim,
                  "subscription",
                  "STARTED",
                )
              ) {
                throw new Error("deletion_claim_lost_before_subscription");
              }
              const submitSubscriptionIntegration =
                await revalidateAsaasMutationCapability(supabase, {
                  tenantId: targetTenantId,
                  purpose: "subscription.delete",
                  expected: subscriptionIntegration,
                });
              const response = await fetch(
                `${submitSubscriptionIntegration.baseUrl}/subscriptions/${
                  encodeURIComponent(subscriptionId)
                }`,
                {
                  method: "DELETE",
                  headers: {
                    access_token: submitSubscriptionIntegration.apiKey,
                  },
                  signal: AbortSignal.timeout(15_000),
                },
              );
              if (response.ok || response.status === 404) {
                asaas.subscriptionDeleted = await recordDeletionProviderState(
                  supabase,
                  claim,
                  "subscription",
                  response.status === 404 ? "ABSENT" : "DELETED",
                );
                asaas.failedStage = null;
              } else {
                asaas.failedStage = "subscription";
                asaas.error = await asaasError(response);
                await recordDeletionProviderState(
                  supabase,
                  claim,
                  "subscription",
                  "UNKNOWN",
                  asaas.error,
                );
              }
            }
          }
        }

        if (!asaas.error && !asaas.customerDeleted) {
          if (!customerId) {
            asaas.customerDeleted = await recordDeletionProviderState(
              supabase,
              claim,
              "customer",
              "ABSENT",
            );
          } else if (customerIntegration) {
            const readResponse = await fetch(
              `${customerIntegration.baseUrl}/customers/${
                encodeURIComponent(customerId)
              }`,
              {
                method: "GET",
                headers: { access_token: customerIntegration.apiKey },
                signal: AbortSignal.timeout(12_000),
              },
            );
            if (readResponse.status === 404) {
              asaas.customerDeleted = await recordDeletionProviderState(
                supabase,
                claim,
                "customer",
                "ABSENT",
              );
            } else if (!readResponse.ok) {
              asaas.failedStage = "customer";
              asaas.error = await asaasError(readResponse);
              await recordDeletionProviderState(
                supabase,
                claim,
                "customer",
                "UNKNOWN",
                asaas.error,
              );
            } else {
              const providerCustomer = await readResponse.json().catch(() =>
                null
              );
              if (
                !providerCustomerMatchesStudent(providerCustomer, {
                  id: customerId,
                  externalReference: studentId,
                  cpfCnpj: claim.billingCpf,
                })
              ) {
                asaas.failedStage = "customer";
                asaas.error = "Identidade do cliente não confirmada";
                asaasFailureRetryable = false;
                await recordDeletionProviderState(
                  supabase,
                  claim,
                  "customer",
                  "FAILED",
                  "customer_identity_unverified",
                );
              } else {
                asaas.failedStage = "customer";
                if (
                  !await recordDeletionProviderState(
                    supabase,
                    claim,
                    "customer",
                    "STARTED",
                  )
                ) {
                  throw new Error("deletion_claim_lost_before_customer");
                }
                const submitCustomerIntegration =
                  await revalidateAsaasMutationCapability(supabase, {
                    tenantId: targetTenantId,
                    purpose: "customer.delete",
                    expected: customerIntegration,
                  });
                const response = await fetch(
                  `${submitCustomerIntegration.baseUrl}/customers/${
                    encodeURIComponent(customerId)
                  }`,
                  {
                    method: "DELETE",
                    headers: {
                      access_token: submitCustomerIntegration.apiKey,
                    },
                    signal: AbortSignal.timeout(15_000),
                  },
                );
                if (response.ok || response.status === 404) {
                  asaas.customerDeleted = await recordDeletionProviderState(
                    supabase,
                    claim,
                    "customer",
                    response.status === 404 ? "ABSENT" : "DELETED",
                  );
                  asaas.failedStage = null;
                } else {
                  asaas.failedStage = "customer";
                  asaas.error = await asaasError(response);
                  await recordDeletionProviderState(
                    supabase,
                    claim,
                    "customer",
                    "UNKNOWN",
                    asaas.error,
                  );
                }
              }
            }
          }
        }
      } catch (error) {
        const capabilityFailure = error instanceof AsaasCapabilityFenceError;
        if (capabilityFailure) asaasFailureRetryable = false;
        asaas.error = error instanceof Error
          ? error.message.slice(0, 500)
          : "Falha de comunicação com o Asaas";
        if (asaas.failedStage) {
          await recordDeletionProviderState(
            supabase,
            claim,
            asaas.failedStage,
            capabilityFailure ? "FAILED" : "UNKNOWN",
            capabilityFailure
              ? error.failure === "UNAVAILABLE"
                ? "provider_capability_unavailable_before_delete"
                : "provider_capability_changed_before_delete"
              : "provider_request_outcome_unknown",
          ).catch(() => false);
        }
      }
    }

    if (
      !asaas.error && (!asaas.subscriptionDeleted || !asaas.customerDeleted)
    ) {
      asaas.error = "A conclusão do provedor não foi persistida";
    }

    if (asaas.error) {
      console.error(
        `[delete-student-account] Limpeza Asaas interrompida em ${
          asaas.failedStage || "network"
        }: ${asaas.error}`,
      );
      return domainFailure(
        "A exclusão foi interrompida por uma falha no Asaas. Os dados locais foram preservados; verifique a cobrança antes de tentar novamente.",
        { asaas, retryable: asaasFailureRetryable },
      );
    }

    const { data: deletionTarget, error: deletionTargetError } = await supabase
      .from("profiles")
      .select(
        "id,role,tenant_id,lifecycle_status,is_test_account,asaas_customer_id,subscription_id,cpf,guardian_id,guardian_cpf",
      )
      .eq("id", studentId)
      .eq("role", "STUDENT")
      .eq("is_test_account", true)
      .maybeSingle();
    if (deletionTargetError) {
      return domainFailure(
        "Não foi possível revalidar a conta antes da exclusão local. Nenhum dado local foi removido.",
        { retryable: true, asaas },
      );
    }
    if (
      !deletionTarget || deletionTarget.tenant_id !== targetTenantId ||
      String(deletionTarget.lifecycle_status || "").trim().toLowerCase() !==
        "active" ||
      normalizedText(deletionTarget.asaas_customer_id) !== customerId ||
      normalizedText(deletionTarget.subscription_id) !== subscriptionId ||
      billingCpfForProfile(deletionTarget) !== claim.billingCpf
    ) {
      return domainFailure(
        "A conta deixou de estar ativa, vinculada à escola ou marcada como teste durante a operação. A exclusão local foi cancelada.",
        { retryable: false, asaas },
      );
    }
    const deletionScope = await loadExclusiveActiveStudentScope(
      supabase,
      studentId,
      deletionTarget.tenant_id,
    );
    if (deletionScope.ok === false) {
      return domainFailure(
        deletionScope.unavailable
          ? "Não foi possível revalidar o vínculo do aluno. A exclusão local não foi iniciada."
          : "O vínculo escolar do aluno mudou durante a operação. A exclusão local foi cancelada.",
        { retryable: deletionScope.unavailable, asaas },
      );
    }

    // A ausência no Auth é aceitável apenas para reparar um perfil órfão já
    // autorizado acima por papel e tenant. Outros erros abortam antes de
    // qualquer exclusão local.
    const authLookup = await supabase.auth.admin.getUserById(studentId);
    if (authLookup.error && !isAuthNotFound(authLookup.error)) {
      console.error(
        "[delete-student-account] Falha ao verificar Auth",
        authLookup.error.message,
      );
      return domainFailure(
        "Não foi possível confirmar a conta de acesso. A exclusão local não foi iniciada.",
        { retryable: true },
      );
    }

    // A instalação atual não pode depender de cascade Auth -> profiles.
    // Delete o perfil primeiro: se algum histórico RESTRICT ainda existir, o
    // acesso Auth permanece intacto e a operação pode ser revisada sem deixar
    // um aluno sem login e com perfil financeiro vivo. Se o Auth falhar depois,
    // o caminho de recuperação por claim PROVIDER_COMPLETE conclui o restante.
    // A condição role=STUDENT evita ampliar o alvo caso ele tenha mudado.
    let profileDeleteQuery = supabase.from("profiles").delete()
      .eq("id", studentId)
      .eq("role", "STUDENT")
      .eq("tenant_id", targetTenantId)
      .eq("lifecycle_status", deletionTarget.lifecycle_status)
      .eq("is_test_account", true);
    profileDeleteQuery = customerId
      ? profileDeleteQuery.eq("asaas_customer_id", customerId)
      : profileDeleteQuery.is("asaas_customer_id", null);
    profileDeleteQuery = subscriptionId
      ? profileDeleteQuery.eq("subscription_id", subscriptionId)
      : profileDeleteQuery.is("subscription_id", null);
    const { error: deleteProfileError } = await profileDeleteQuery;
    const { data: remainingProfile, error: profileCheckError } = await supabase
      .from("profiles").select("id").eq("id", studentId).maybeSingle();
    if (deleteProfileError || profileCheckError || remainingProfile) {
      console.error("[delete-student-account] Perfil não removido", {
        studentId,
        profileStillExists: Boolean(remainingProfile),
        profileDeleteError: deleteProfileError?.message,
        profileCheckError: profileCheckError?.message,
      });
      return domainFailure(
        "O perfil possui um vínculo local que impede a limpeza segura. O acesso foi preservado para revisão técnica.",
        {
          partial: false,
          authDeleted: false,
          profileDeleted: false,
          asaas,
        },
      );
    }

    let authDeleted = !authLookup.data.user;
    if (authLookup.data.user) {
      const { error: deleteAuthError } = await supabase.auth.admin.deleteUser(
        studentId,
      );
      if (deleteAuthError && !isAuthNotFound(deleteAuthError)) {
        console.error(
          "[delete-student-account] Falha ao excluir Auth após o perfil",
          deleteAuthError.message,
        );
        return domainFailure(
          "O perfil foi removido, mas o acesso ainda precisa ser concluído. Tente novamente para finalizar com a prova durável existente.",
          {
            partial: true,
            authDeleted: false,
            profileDeleted: true,
            asaas,
            retryable: true,
          },
        );
      }
      authDeleted = true;
    }

    const authCheck = await supabase.auth.admin.getUserById(studentId);
    const authStillExists = Boolean(authCheck.data.user);
    const authCheckFailed = Boolean(
      authCheck.error && !isAuthNotFound(authCheck.error),
    );

    if (
      authStillExists || authCheckFailed || !authDeleted
    ) {
      console.error("[delete-student-account] Pós-condição não satisfeita", {
        studentId,
        authStillExists,
        profileStillExists: Boolean(remainingProfile),
        authCheckFailed,
      });
      return domainFailure(
        "A exclusão ficou incompleta e não foi confirmada. O administrador técnico deve concluir a limpeza antes de uma nova tentativa.",
        {
          partial: true,
          authDeleted: !authStillExists && !authCheckFailed,
          profileDeleted: !remainingProfile && !profileCheckError,
          asaas,
        },
      );
    }

    const { data: finalized, error: finalizeError } = await supabase.rpc(
      "finalize_student_account_deletion",
      {
        p_claim_id: claim.id,
        p_claim_token: claim.token,
        p_profile_absent: true,
        p_auth_absent: true,
      },
    );
    if (finalizeError || finalized?.ok !== true) {
      return domainFailure(
        "A exclusão foi concluída, mas a confirmação durável precisa de revisão técnica.",
        {
          partial: true,
          authDeleted: true,
          profileDeleted: true,
          asaas,
        },
      );
    }

    return json({
      success: true,
      message: "Aluno removido do acesso, do perfil e do financeiro.",
      penaltyIgnoredForTest: applyPenaltyRequested,
      asaas,
    });
  } catch (error) {
    console.error(
      "[delete-student-account] Erro inesperado",
      error instanceof Error ? error.message : error,
    );
    return json({ error: "Erro inesperado ao excluir o aluno." }, 500);
  }
});
