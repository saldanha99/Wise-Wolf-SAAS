import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  authorizePaymentTarget,
  loadClaimedEnrollmentOffer,
} from "../_shared/payment-auth.ts";
import type { PaymentAdminClient } from "../_shared/payment-auth.ts";
import { authorizeRequest } from "../_shared/request-auth.ts";
import {
  markEnrollmentFailure,
  markEnrollmentStage,
} from "../_shared/enrollment-progress.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
  TenantIntegrationBrokerError,
} from "../_shared/tenant-integration-broker.ts";
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
  revalidateActiveStudentCreationScope,
} from "../_shared/asaas-creation-guard.ts";
import { providerCustomerMatchesStudent } from "../_shared/student-provider-lifecycle.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(
    JSON.stringify(body),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );

const digits = (value: unknown) => String(value || "").replace(/\D/g, "");
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function providerCustomerMatches(
  candidate: Record<string, unknown>,
  externalReference: string,
  cpfCnpj: string,
): boolean {
  return candidate.deleted !== true &&
    text(candidate.externalReference) === externalReference &&
    digits(candidate.cpfCnpj) === cpfCnpj;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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

  let progressAdmin: PaymentAdminClient | null = null;
  let progressOfferId = "";
  let progressUserId = "";

  try {
    const body = await req.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    const userId = text(body?.user_id);
    progressUserId = userId;
    if (!body || !userId) {
      return json({ success: false, error: "user_id_required" }, 400);
    }

    const authResult = await authorizePaymentTarget(req, userId, corsHeaders);
    if (authResult.error) return authResult.error;
    const authorization = authResult.authorization!;
    progressAdmin = authorization.admin;

    const profile = authorization.targetProfile;
    const isSelfStudent = !authorization.isService &&
      authorization.callerId === userId &&
      authorization.callerProfile?.role === "STUDENT";
    const offer = isSelfStudent
      ? await loadClaimedEnrollmentOffer(
        authorization.admin,
        userId,
        authorization.tenantId,
      )
      : null;
    progressOfferId = offer?.id || "";

    if (isSelfStudent && !offer) {
      return json({ success: false, error: "enrollment_offer_required" }, 403);
    }
    const offerPayload = offer?.payload || {};
    const isDependent = offer ? Boolean(offerPayload.isDependent) : Boolean(
      body.is_dependent || profile.guardian_id || profile.guardian_cpf,
    );

    const tenantId = authorization.tenantId;
    const studentName = text(profile.full_name) || text(body.name);
    const studentEmail = text(profile.email) || text(body.email);
    const studentPhone = digits(
      profile.phone || body.phone || body.mobilePhone,
    );

    const guardianName = offer
      ? text(offerPayload.guardianName)
      : text(profile.guardian_name || body.guardian_name);
    const guardianEmail = offer
      ? text(offerPayload.guardianEmail)
      : text(profile.guardian_email || body.guardian_email);
    const guardianPhone = offer
      ? digits(offerPayload.guardianPhone)
      : digits(profile.guardian_phone || body.guardian_phone);
    const guardianCpf = offer
      ? digits(offerPayload.guardianCpf)
      : digits(profile.guardian_cpf || body.guardian_cpf);

    const billingName = isDependent ? guardianName : studentName;
    const billingEmail = isDependent ? guardianEmail : studentEmail;
    const billingPhone = isDependent ? guardianPhone : studentPhone;
    const billingCpf = isDependent
      ? guardianCpf
      : digits(profile.cpf || body.cpf);

    if (
      !billingName || !billingEmail || billingPhone.length < 10 ||
      billingCpf.length !== 11
    ) {
      throw new Error(
        "Nome, e-mail, telefone e CPF validos sao obrigatorios para a cobranca.",
      );
    }

    // A agenda reservada e revalidada/materializada sob locks no banco antes
    // de qualquer leitura ou escrita no Asaas. Assim, uma indisponibilidade
    // concorrente do professor nunca deixa um customer financeiro órfão.
    if (offer) {
      const { data: materialization, error: materializationError } =
        await authorization.admin.rpc(
          "materialize_enrollment_offer_schedule",
          { p_offer_id: offer.id, p_user_id: userId },
        );
      if (materializationError) {
        throw new Error(
          `schedule_materialization_failed: ${materializationError.message}`,
        );
      }
      if (
        !materialization ||
        typeof materialization !== "object" ||
        (materialization as Record<string, unknown>).success !== true
      ) {
        const materializationReason = materialization &&
            typeof materialization === "object"
          ? text((materialization as Record<string, unknown>).error)
          : "";
        throw new Error(
          `schedule_materialization_failed: ${
            materializationReason || "invalid_result"
          }`,
        );
      }
    }

    const profileCustomerIdAtAuthorization = text(profile.asaas_customer_id);
    const offerCustomerIdAtAuthorization = offer
      ? text(offer.metadata?.asaas_customer_id)
      : "";
    if (
      profileCustomerIdAtAuthorization && offerCustomerIdAtAuthorization &&
      profileCustomerIdAtAuthorization !== offerCustomerIdAtAuthorization
    ) {
      return json({
        success: false,
        error: "provider_customer_local_binding_conflict",
      }, 409);
    }
    const customerIdAtAuthorization = offerCustomerIdAtAuthorization ||
      profileCustomerIdAtAuthorization;
    const integration = await resolveAsaasIntegration(
      authorization.admin,
      authorization.tenantId,
      customerIdAtAuthorization ? "customer.read" : "customer.create",
    );
    let asaasCustomerId = customerIdAtAuthorization || null;
    let creationLifecycleClaim: AsaasCreationClaim | null = null;
    const externalReference = offer
      ? `tenant:${tenantId}:enrollment:${offer.id}:payer`
      : userId;
    const customerLogicalKey = offer
      ? `enrollment-payer:${offer.id}`
      : `student:${userId}`;
    const customerPayload = {
      name: billingName,
      cpfCnpj: billingCpf,
      email: billingEmail,
      mobilePhone: billingPhone,
      externalReference,
      // Fixtures E2E autorizadas nunca disparam comunicações do Asaas.
      notificationDisabled: offerPayload.testMode === true,
      postalCode: text(profile.postal_code || body.postalCode),
      address: text(profile.address || body.address),
      addressNumber: text(
        profile.address_number || body.addressNumber,
      ),
    };
    const claimCustomerLifecycle = async () =>
      claimAsaasCreation(authorization.admin, {
        tenantId,
        operation: "CUSTOMER_CREATE",
        logicalKey: customerLogicalKey,
        externalReference,
        requestFingerprint: await asaasCreationFingerprint({
          tenantId,
          operation: "CUSTOMER_CREATE",
          logicalKey: customerLogicalKey,
          externalReference,
          customer: customerPayload,
        }),
      });

    if (asaasCustomerId) {
      let existingResponse: Response;
      try {
        existingResponse = await fetch(
          `${integration.baseUrl}/customers/${
            encodeURIComponent(asaasCustomerId)
          }`,
          {
            method: "GET",
            headers: { access_token: integration.apiKey },
            signal: AbortSignal.timeout(12_000),
          },
        );
      } catch {
        return json({
          success: false,
          error: "provider_customer_binding_lookup_unavailable",
        }, 503);
      }
      if (!existingResponse.ok) {
        return json({
          success: false,
          error: existingResponse.status === 404
            ? "provider_customer_binding_not_found"
            : "provider_customer_binding_lookup_unavailable",
        }, existingResponse.status === 404 ? 409 : 503);
      }
      const existingCustomer = await existingResponse.json().catch(() => null);
      if (
        !providerCustomerMatchesStudent(existingCustomer, {
          id: asaasCustomerId,
          externalReference,
          cpfCnpj: billingCpf,
        })
      ) {
        return json({
          success: false,
          error: "provider_customer_local_binding_conflict",
        }, 409);
      }
      const linkedClaim = await claimCustomerLifecycle();
      if (linkedClaim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "customer_creation_in_progress",
          retry_after_seconds: linkedClaim.retry_after_seconds || 15,
        }, 409);
      }
      if (linkedClaim.action === "REVIEW_REQUIRED" || !linkedClaim.ok) {
        return json({
          success: false,
          error: "customer_creation_requires_review",
        }, 409);
      }
      if (linkedClaim.action !== "ALREADY_SUCCEEDED") {
        await recordAsaasCreationState(authorization.admin, linkedClaim, {
          status: "SUCCEEDED",
          providerEntityId: asaasCustomerId,
          providerStatus: text(
            (existingCustomer as Record<string, unknown>)?.status,
          ),
        });
      }
      if (
        !await bindStudentAsaasCreationLifecycle(
          authorization.admin,
          linkedClaim,
          {
            tenantId,
            studentId: userId,
            bindingKind: "CUSTOMER",
            expectedCustomerId: null,
          },
        )
      ) {
        return json({
          success: false,
          error: "customer_creation_lifecycle_requires_review",
        }, 409);
      }
      creationLifecycleClaim = linkedClaim;
    }

    if (!asaasCustomerId) {
      const claim = await claimCustomerLifecycle();
      creationLifecycleClaim = claim;
      const lifecycleInput = {
        tenantId,
        studentId: userId,
        bindingKind: "CUSTOMER" as const,
        expectedCustomerId: null,
      };

      if (claim.action === "ALREADY_SUCCEEDED") {
        if (
          !await bindStudentAsaasCreationLifecycle(
            authorization.admin,
            claim,
            lifecycleInput,
          )
        ) {
          return json({
            success: false,
            error: "customer_creation_lifecycle_requires_review",
          }, 409);
        }
        asaasCustomerId = text(claim.provider_entity_id) || null;
        if (!asaasCustomerId) {
          return json({
            success: false,
            error: "provider_customer_claim_id_missing",
          }, 409);
        }
        const claimedResponse = await fetch(
          `${integration.baseUrl}/customers/${
            encodeURIComponent(asaasCustomerId)
          }`,
          {
            headers: { access_token: integration.apiKey },
            signal: AbortSignal.timeout(12_000),
          },
        ).catch(() => null);
        if (!claimedResponse?.ok) {
          return json({
            success: false,
            error: "provider_customer_claim_reconciliation_pending",
          }, 503);
        }
        const claimedCustomer = await claimedResponse.json().catch(() => null);
        if (
          !claimedCustomer ||
          !providerCustomerMatches(
            claimedCustomer as Record<string, unknown>,
            externalReference,
            billingCpf,
          )
        ) {
          return json({
            success: false,
            error: "provider_customer_claim_identity_conflict",
          }, 409);
        }
      } else if (claim.action === "IN_PROGRESS") {
        return json({
          success: false,
          error: "customer_creation_in_progress",
          retry_after_seconds: claim.retry_after_seconds || 15,
        }, 409);
      } else if (claim.action === "REVIEW_REQUIRED" || !claim.ok) {
        return json({
          success: false,
          error: "customer_creation_requires_review",
        }, 409);
      } else {
        // A provider lookup is recovery/uniqueness evidence only. It is never
        // treated as the concurrency lock; the durable claim above owns that.
        const lookup = await findUniqueAsaasEntity<Record<string, unknown>>({
          baseUrl: integration.baseUrl,
          apiKey: integration.apiKey,
          path: "customers",
          query: { externalReference },
          matches: (candidate) =>
            providerCustomerMatches(candidate, externalReference, billingCpf),
          conflicts: (candidate) =>
            candidate.deleted !== true &&
            text(candidate.externalReference) === externalReference,
        });
        if (lookup.kind === "DUPLICATE" || lookup.kind === "CONFLICT") {
          await recordAsaasCreationState(authorization.admin, claim, {
            status: "BLOCKED",
            error: lookup.kind === "DUPLICATE"
              ? "duplicate_provider_customers"
              : "provider_customer_identity_conflict",
          });
          return json({
            success: false,
            error: lookup.kind === "DUPLICATE"
              ? "duplicate_provider_customers"
              : "provider_customer_identity_conflict",
          }, 409);
        }
        if (lookup.kind === "UNAVAILABLE") {
          await recordAsaasCreationState(authorization.admin, claim, {
            status: claim.action === "RECONCILE_REQUIRED" ? "UNKNOWN" : "RETRY",
            httpStatus: lookup.httpStatus,
            error: "customer_recovery_lookup_unavailable",
          });
          return json({
            success: false,
            error: "customer_recovery_lookup_unavailable",
          }, 503);
        }
        if (lookup.kind === "FOUND") {
          if (
            !await bindStudentAsaasCreationLifecycle(
              authorization.admin,
              claim,
              lifecycleInput,
            )
          ) {
            return json({
              success: false,
              error: "customer_creation_lifecycle_requires_review",
            }, 409);
          }
          asaasCustomerId = text(lookup.entity.id) || null;
          if (!asaasCustomerId) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "BLOCKED",
              error: "provider_customer_id_missing",
            });
            return json({
              success: false,
              error: "provider_customer_id_missing",
            }, 502);
          }
          await recordAsaasCreationState(authorization.admin, claim, {
            status: "SUCCEEDED",
            providerEntityId: asaasCustomerId,
            providerStatus: text(lookup.entity.status),
          });
        } else if (claim.action === "RECONCILE_REQUIRED") {
          await recordAsaasCreationState(authorization.admin, claim, {
            status: "UNKNOWN",
            error: "provider_customer_not_yet_observed",
          });
          return json({
            success: false,
            error: "customer_creation_reconciliation_pending",
          }, 409);
        } else {
          if (
            !await revalidateActiveStudentCreationScope(
              authorization.admin,
              lifecycleInput,
            )
          ) {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "BLOCKED",
              error: "student_lifecycle_changed_before_submit",
            });
            return json({
              success: false,
              error: "customer_creation_lifecycle_requires_review",
            }, 409);
          }
          await markStudentAsaasCreationSubmitting(
            authorization.admin,
            claim,
            lifecycleInput,
          );

          let submitIntegration: ResolvedAsaasIntegration;
          try {
            submitIntegration = await revalidateAsaasMutationCapability(
              authorization.admin,
              {
                tenantId,
                purpose: "customer.create",
                expected: integration,
              },
            );
          } catch (error) {
            const unavailable = error instanceof AsaasCapabilityFenceError &&
              error.failure === "UNAVAILABLE";
            await recordAsaasCreationState(authorization.admin, claim, {
              // The durable submit mark has already consumed the only POST.
              // RETRY is intentionally invalid from SUBMITTING.
              status: "BLOCKED",
              error: unavailable
                ? "customer_capability_unavailable_before_submit"
                : "customer_capability_changed_before_submit",
            });
            return json({
              success: false,
              error: unavailable
                ? "provider_customer_capability_unavailable"
                : "provider_customer_capability_changed",
            }, unavailable ? 503 : 409);
          }

          let createRes: Response;
          try {
            createRes = await fetch(`${submitIntegration.baseUrl}/customers`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                access_token: submitIntegration.apiKey,
              },
              body: JSON.stringify(customerPayload),
              signal: AbortSignal.timeout(25_000),
            });
          } catch {
            await recordAsaasCreationState(authorization.admin, claim, {
              status: "UNKNOWN",
              error: "provider_customer_post_outcome_unknown",
            });
            throw new Error("customer_creation_outcome_unknown");
          }

          const responseText = await createRes.text();
          let createData: Record<string, unknown> = {};
          try {
            createData = JSON.parse(responseText);
          } catch {
            // The HTTP class still decides whether this is a definitive 4xx or
            // an ambiguous response that must be reconciled by GET.
          }

          const submittedCustomerMatches = providerCustomerMatches(
            createData,
            externalReference,
            billingCpf,
          );
          const providerCustomerId = submittedCustomerMatches
            ? text(createData.id)
            : "";
          const outcome = asaasCreationHttpOutcome(
            createRes.ok,
            createRes.status,
            providerCustomerId,
          );
          await recordAsaasCreationState(authorization.admin, claim, {
            status: outcome,
            providerEntityId: providerCustomerId,
            providerStatus: text(createData.status),
            httpStatus: createRes.status,
            error: outcome === "SUCCEEDED"
              ? null
              : outcome === "FAILED"
              ? "provider_customer_creation_rejected"
              : "provider_customer_post_outcome_unknown",
          });

          if (outcome === "UNKNOWN") {
            throw new Error("customer_creation_outcome_unknown");
          }
          if (outcome === "FAILED") {
            const errors = Array.isArray(createData.errors)
              ? createData.errors
              : [];
            const firstError = errors[0] as
              | { description?: string }
              | undefined;
            throw new Error(
              firstError?.description ||
                "Nao foi possivel cadastrar o cliente no Asaas.",
            );
          }
          asaasCustomerId = providerCustomerId;
        }
      }
    }

    if (!asaasCustomerId) {
      throw new Error("customer_creation_state_invalid");
    }

    // Recovery/POST evidence is not a local binding authorization. Re-read
    // the exact provider object by id and prove both canonical reference and
    // billing CPF immediately before the tenant/customer CAS below.
    let finalCustomerResponse: Response;
    try {
      finalCustomerResponse = await fetch(
        `${integration.baseUrl}/customers/${
          encodeURIComponent(asaasCustomerId)
        }`,
        {
          method: "GET",
          headers: { access_token: integration.apiKey },
          signal: AbortSignal.timeout(12_000),
        },
      );
    } catch {
      return json({
        success: false,
        error: "provider_customer_binding_lookup_unavailable",
      }, 503);
    }
    if (!finalCustomerResponse.ok) {
      return json({
        success: false,
        error: finalCustomerResponse.status === 404
          ? "provider_customer_binding_not_found"
          : "provider_customer_binding_lookup_unavailable",
      }, finalCustomerResponse.status === 404 ? 409 : 503);
    }
    const finalCustomer = await finalCustomerResponse.json().catch(() => null);
    if (
      !providerCustomerMatchesStudent(finalCustomer, {
        id: asaasCustomerId,
        externalReference,
        cpfCnpj: billingCpf,
      })
    ) {
      return json({
        success: false,
        error: "provider_customer_local_binding_conflict",
      }, 409);
    }

    const profileUpdate: Record<string, unknown> = {
      asaas_customer_id: asaasCustomerId,
    };
    if (offer) {
      // begin_enrollment_offer is the authoritative writer for role/tenant_id.
      // Repeating those unchanged columns here needlessly fires membership and
      // commercial triggers during the financial sync.
      profileUpdate.monthly_fee = numberValue(offerPayload.value);
      profileUpdate.due_day = numberValue(offerPayload.dueDay);
      profileUpdate.class_frequency = `${
        numberValue(offerPayload.classesPerWeek) || 1
      }x`;
      profileUpdate.professor_id = text(offerPayload.professorId) || null;
      profileUpdate.professor_id2 = text(offerPayload.professorId2) || null;
      profileUpdate.enrollment_fee = Number(offer.enrollment_fee || 0);
      profileUpdate.guardian_id = isDependent
        ? text(offerPayload.guardianId) || null
        : null;
      profileUpdate.guardian_name = isDependent ? guardianName || null : null;
      profileUpdate.guardian_cpf = isDependent ? guardianCpf || null : null;
      profileUpdate.guardian_email = isDependent ? guardianEmail || null : null;
      profileUpdate.guardian_phone = isDependent ? guardianPhone || null : null;
      profileUpdate.attendance_phone = isDependent
        ? digits(offerPayload.studentPhone) || studentPhone || null
        : null;
      profileUpdate.start_date = text(offerPayload.startDate) || null;
    }

    let updateQuery = authorization.admin
      .from("profiles")
      .update(profileUpdate)
      .eq("id", userId)
      .eq("tenant_id", tenantId)
      .eq("role", "STUDENT")
      .eq("lifecycle_status", "active");
    updateQuery = profileCustomerIdAtAuthorization
      ? updateQuery.eq(
        "asaas_customer_id",
        profileCustomerIdAtAuthorization,
      )
      : updateQuery.is("asaas_customer_id", null);
    const { data: updatedProfile, error: updateError } = await updateQuery
      .select("id")
      .maybeSingle();
    if (updateError) {
      throw new Error(`profile_update_failed: ${updateError.message}`);
    }
    if (!updatedProfile) {
      // A concurrent writer may only win with the exact same provider
      // customer. Never overwrite a divergent canonical binding.
      const { data: latestProfile, error: latestProfileError } =
        await authorization.admin
          .from("profiles")
          .select("asaas_customer_id")
          .eq("id", userId)
          .eq("tenant_id", tenantId)
          .eq("role", "STUDENT")
          .maybeSingle();
      if (
        latestProfileError ||
        text(latestProfile?.asaas_customer_id) !== asaasCustomerId
      ) {
        throw new Error("provider_customer_local_binding_conflict");
      }
      const supplementalUpdate = { ...profileUpdate };
      delete supplementalUpdate.asaas_customer_id;
      if (Object.keys(supplementalUpdate).length > 0) {
        const { data: supplementedProfile, error: supplementalError } =
          await authorization.admin
            .from("profiles")
            .update(supplementalUpdate)
            .eq("id", userId)
            .eq("tenant_id", tenantId)
            .eq("role", "STUDENT")
            .eq("lifecycle_status", "active")
            .eq("asaas_customer_id", asaasCustomerId)
            .select("id")
            .maybeSingle();
        if (supplementalError || !supplementedProfile) {
          throw new Error(
            `profile_update_failed: ${
              supplementalError?.message || "profile_snapshot_changed"
            }`,
          );
        }
      }
    }

    if (
      creationLifecycleClaim &&
      !await releaseStudentAsaasCreationLifecycle(
        authorization.admin,
        creationLifecycleClaim,
        {
          tenantId,
          studentId: userId,
          providerEntityId: asaasCustomerId,
        },
      )
    ) {
      throw new Error("customer_creation_lifecycle_release_failed");
    }

    // Compatibilidade do fluxo administrativo legado sem oferta. Matrículas
    // por oferta já foram materializadas de forma autoritativa antes do Asaas.
    const schedule = Array.isArray(body.classSchedule)
      ? body.classSchedule
      : [];
    const professorId = text(profile.professor_id || body.professor_id);

    if (!offer && schedule.length > 0 && professorId) {
      // ⚠️ ACENTO IMPORTA: "Terça" e "Sábado" eram gravados aqui SEM acento e a
      // agenda ficava invisível para o professor. As telas de lançamento comparam
      // `day_of_week` com o nome que o navegador gera (`Terça`), então a aula
      // nunca aparecia para lançar — e o professor não recebia por ela. Pior:
      // `dow_name_to_int` normaliza acento, então a projeção do mês CONTAVA a
      // aula que a tela não deixava lançar, e o índice `uq_bookings_no_dup_active`
      // não via as duas grafias como duplicata (Gabriel e Milena ficaram com dois
      // agendamentos na mesma terça, achado em 13/08/2026).
      const dayMap: Record<string, string> = {
        monday: "Segunda",
        tuesday: "Terça",
        wednesday: "Quarta",
        thursday: "Quinta",
        friday: "Sexta",
        saturday: "Sábado",
        sunday: "Domingo",
      };
      // A comparação com o que já existe ignora acento e caixa: sem isso, um
      // agendamento legado em "Terca" não casaria com o "Terça" novo e a função
      // criaria a duplicata que este bloco existe para evitar.
      const dayKey = (value: string) =>
        value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const { data: existingBookings, error: bookingsError } =
        await authorization.admin
          .from("bookings")
          .select("teacher_id, day_of_week, time_slot")
          .eq("student_id", userId);
      if (bookingsError) {
        throw new Error(`booking_lookup_failed: ${bookingsError.message}`);
      }

      const existing = new Set(
        (existingBookings || []).map((booking: Record<string, unknown>) =>
          `${booking.teacher_id}|${
            dayKey(String(booking.day_of_week || ""))
          }|${booking.time_slot}`
        ),
      );
      const rows = schedule.flatMap((rawSlot) => {
        const slot = rawSlot as Record<string, unknown>;
        const rawDay = text(slot.weekday || slot.day);
        const day = dayMap[rawDay.toLowerCase()] || rawDay;
        const time = text(slot.time);
        const key = `${professorId}|${dayKey(day)}|${time}`;
        if (!day || !time || existing.has(key)) return [];
        existing.add(key);
        return [{
          tenant_id: tenantId,
          teacher_id: professorId,
          student_id: userId,
          day_of_week: day,
          time_slot: time,
          start_date: text(body.startDate) ||
            new Date().toISOString().slice(0, 10),
        }];
      });

      if (rows.length > 0) {
        const { error: insertError } = await authorization.admin.from(
          "bookings",
        ).insert(rows);
        if (insertError) {
          throw new Error(`booking_insert_failed: ${insertError.message}`);
        }
      }
    }

    if (offer) {
      await markEnrollmentStage(
        authorization.admin,
        offer.id,
        userId,
        "CUSTOMER_READY",
        { metadata: { asaas_customer_id: asaasCustomerId } },
      );
    }

    return json({
      success: true,
      asaas_customer_id: asaasCustomerId,
      processing_state: offer ? "CUSTOMER_READY" : null,
      correlation_id: offer?.processing_correlation_id || null,
    });
  } catch (error) {
    const integrationUnavailable = error instanceof
      TenantIntegrationBrokerError;
    console.error("[sync-student-asaas]", {
      type: error instanceof Error ? error.name : "UnknownError",
    });
    if (progressAdmin && progressOfferId && progressUserId) {
      await markEnrollmentFailure(
        progressAdmin,
        progressOfferId,
        progressUserId,
        integrationUnavailable
          ? "asaas_not_configured"
          : error instanceof Error && error.message.startsWith("booking_")
          ? "booking_update_failed"
          : error instanceof Error && error.message.startsWith("profile_")
          ? "profile_update_failed"
          : "customer_sync_failed",
        error,
      );
    }
    return json({
      success: false,
      error: integrationUnavailable
        ? "asaas_not_configured"
        : error instanceof Error
        ? error.message
        : "Erro interno ao sincronizar aluno.",
    }, integrationUnavailable ? 503 : 500);
  }
});
