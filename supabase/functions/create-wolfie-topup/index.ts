/// <reference lib="deno.ns" />

// Cobrança PIX de minutos adicionais do Wolfie ao vivo.
//
// Segurança do dinheiro: o VALOR e a QUANTIDADE de minutos vêm SEMPRE da
// tabela `wolfie_topup_packages`, nunca do corpo da requisição. O cliente só
// escolhe qual pacote — se ele mandasse o preço, poderia comprar 180 minutos
// por R$ 0,01.
//
// Os minutos só são creditados pelo webhook, quando o Asaas confirmar o
// pagamento. Esta função apenas gera a cobrança.

// deno-lint-ignore no-import-prefix
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  AsaasCapabilityFenceError,
  revalidateAsaasMutationCapability,
} from "../_shared/asaas-capability-fence.ts";
import {
  asaasCreationFingerprint,
  asaasCreationHttpOutcome,
  bindStudentAsaasCreationLifecycle,
  claimAsaasCreation,
  findUniqueAsaasEntity,
  markStudentAsaasCreationSubmitting,
  recordAsaasCreationState,
  releaseStudentAsaasCreationLifecycle,
} from "../_shared/asaas-creation-guard.ts";
import { authorizeRequest, methodNotAllowed } from "../_shared/request-auth.ts";
import {
  resolvePlatformAsaasIntegration,
  TenantIntegrationBrokerError,
} from "../_shared/tenant-integration-broker.ts";
import { requireWolfieProductAccess } from "../_shared/wolfie-product-access.ts";
import {
  wolfieTopupCreationSnapshot,
  wolfieTopupDescription,
  wolfieTopupDueDate,
  wolfieTopupMaySubmitProviderPayment,
  wolfieTopupPaymentMatches,
  wolfieTopupProviderReference,
  wolfieTopupReferenceConflicts,
} from "./provider-safety.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") return methodNotAllowed(corsHeaders);

  const auth = await authorizeRequest(req, {
    corsHeaders,
    allowedRoles: ["STUDENT"],
    allowWolfieDirect: true,
  });
  if (auth.ok === false) return auth.response;
  const accessError = await requireWolfieProductAccess(
    auth.context,
    corsHeaders,
  );
  if (accessError) return accessError;

  const tenantId = auth.context.profile?.tenant_id;
  const studentId = auth.context.userId;
  if (!tenantId || !studentId) {
    return json({ error: "STUDENT_PROFILE_REQUIRED" }, 403);
  }
  let readIntegration: Awaited<
    ReturnType<typeof resolvePlatformAsaasIntegration>
  >;
  try {
    readIntegration = await resolvePlatformAsaasIntegration(
      auth.context.admin,
      "payment.read",
    );
  } catch (error) {
    if (!(error instanceof TenantIntegrationBrokerError)) throw error;
    return json({ error: "ASAAS_NOT_CONFIGURED" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "INVALID_BODY" }, 400);
  }

  const packageId = typeof body.packageId === "string" ? body.packageId : "";
  const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
  if (!UUID.test(packageId)) return json({ error: "INVALID_PACKAGE" }, 400);
  if (!UUID.test(requestKey)) {
    return json({ error: "INVALID_REQUEST_KEY" }, 400);
  }

  let asaasCustomerId: string | null = null;
  let hubAccountId: string | null = null;
  if (tenantId === "wolfie-direct") {
    const { data: membership, error: membershipError } = await auth.context
      .admin
      .from("hub_memberships")
      .select(
        "hub_accounts!inner(id,asaas_customer_id,account_type,owner_user_id,status)",
      )
      .eq("user_id", studentId)
      .eq("status", "ACTIVE")
      .eq("membership_role", "OWNER")
      .eq("hub_accounts.account_type", "PERSONAL")
      .eq("hub_accounts.owner_user_id", studentId)
      .eq("hub_accounts.status", "ACTIVE")
      .order("created_at")
      .limit(1)
      .maybeSingle();
    if (membershipError) {
      console.error("Wolfie direct customer lookup failed", {
        code: membershipError.code,
      });
      return json({ error: "CUSTOMER_NOT_READY" }, 409);
    }
    const account = Array.isArray(membership?.hub_accounts)
      ? membership.hub_accounts[0]
      : membership?.hub_accounts;
    hubAccountId = text(account?.id) || null;
    asaasCustomerId = text(account?.asaas_customer_id) || null;
  } else {
    const { data: profile, error: profileError } = await auth.context.admin
      .from("profiles")
      .select("asaas_customer_id")
      .eq("id", studentId)
      .maybeSingle();
    if (profileError) {
      console.error("Student customer lookup failed", {
        code: profileError.code,
      });
      return json({ error: "CUSTOMER_NOT_READY" }, 409);
    }
    asaasCustomerId = text(profile?.asaas_customer_id) || null;
  }
  if (!asaasCustomerId || (tenantId === "wolfie-direct" && !hubAccountId)) {
    return json({ error: "CUSTOMER_NOT_READY" }, 409);
  }

  const orderColumns =
    "id,tenant_id,student_id,request_key,package_id,package_name,minutes,amount_brl,status,provider_customer_id,provider_payment_id,reconciliation_required,creation_lease_expires_at,created_at";
  const loadOrder = async () =>
    await auth.context.admin.from("wolfie_topup_orders")
      .select(orderColumns)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .eq("request_key", requestKey)
      .maybeSingle();

  let { data: order, error: orderError } = await loadOrder();
  if (orderError) {
    console.error("Topup order lookup failed", { code: orderError.code });
    return json({ error: "TOPUP_UNAVAILABLE" }, 503);
  }
  if (order && order.package_id !== packageId) {
    return json({ error: "IDEMPOTENCY_KEY_CONFLICT" }, 409);
  }

  if (!order) {
    // Preço e minutos SÓ do banco — nunca do cliente.
    const { data: pkg, error: pkgError } = await auth.context.admin
      .from("wolfie_topup_packages")
      .select("id,name,minutes,price_brl")
      .eq("id", packageId)
      .eq("tenant_id", tenantId)
      .eq("active", true)
      .maybeSingle();
    if (pkgError) {
      console.error("Topup package lookup failed", { code: pkgError.code });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }
    if (!pkg) return json({ error: "PACKAGE_NOT_FOUND" }, 404);

    const inserted = await auth.context.admin.from("wolfie_topup_orders")
      .insert({
        tenant_id: tenantId,
        student_id: studentId,
        request_key: requestKey,
        package_id: pkg.id,
        package_name: String(pkg.name).slice(0, 160),
        minutes: Number(pkg.minutes),
        amount_brl: Number(pkg.price_brl),
        status: "PENDING",
        provider_customer_id: asaasCustomerId,
      })
      .select(orderColumns)
      .single();
    order = inserted.data;
    orderError = inserted.error;
    if (orderError?.code === "23505") {
      const raced = await loadOrder();
      order = raced.data;
      orderError = raced.error;
    }
    if (orderError || !order) {
      console.error("Topup order creation failed", {
        code: orderError?.code ?? "missing_order",
      });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }
    if (order.package_id !== packageId) {
      return json({ error: "IDEMPOTENCY_KEY_CONFLICT" }, 409);
    }
  }

  const snapshottedCustomerId = text(order.provider_customer_id);
  if (snapshottedCustomerId && snapshottedCustomerId !== asaasCustomerId) {
    return json({ error: "TOPUP_CUSTOMER_REQUIRES_REVIEW" }, 409);
  }
  if (!snapshottedCustomerId) {
    // Legacy pending orders may acquire their canonical customer exactly once.
    // An order already linked to a provider payment is never retroactively
    // adopted from mutable profile/account state.
    if (text(order.provider_payment_id)) {
      return json({ error: "TOPUP_CUSTOMER_REQUIRES_REVIEW" }, 409);
    }
    const snapshot = await auth.context.admin.from("wolfie_topup_orders")
      .update({
        provider_customer_id: asaasCustomerId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .is("provider_customer_id", null)
      .is("provider_payment_id", null)
      .select(orderColumns)
      .maybeSingle();
    if (snapshot.error || !snapshot.data) {
      const raced = await loadOrder();
      if (
        raced.error || !raced.data ||
        text(raced.data.provider_customer_id) !== asaasCustomerId ||
        text(raced.data.provider_payment_id)
      ) {
        return json({ error: "TOPUP_CUSTOMER_REQUIRES_REVIEW" }, 409);
      }
      order = raced.data;
    } else {
      order = snapshot.data;
    }
  }

  let activeOrder = order;
  // Asaas receives only a server-authored order UUID. Tenant, learner,
  // quantity and price remain immutable snapshots in Postgres.
  const reference = wolfieTopupProviderReference(String(activeOrder.id));
  const paymentDueDate = wolfieTopupDueDate(activeOrder.created_at);
  const paymentDescription = wolfieTopupDescription(activeOrder.package_name);
  const amountBrl = Number(activeOrder.amount_brl);
  const minutes = Number(activeOrder.minutes);
  if (
    !paymentDueDate || !paymentDescription || !Number.isFinite(amountBrl) ||
    amountBrl <= 0 || !Number.isSafeInteger(minutes) || minutes <= 0
  ) {
    console.error("Topup immutable snapshot is invalid", {
      orderId: activeOrder.id,
    });
    return json({ error: "TOPUP_ORDER_REQUIRES_REVIEW" }, 409);
  }
  const expectedPayment = {
    reference,
    customerId: asaasCustomerId,
    value: amountBrl,
    dueDate: paymentDueDate,
    description: paymentDescription,
    splitPolicy: { kind: "NONE" as const },
  };
  const paymentPayload = {
    customer: asaasCustomerId,
    billingType: "PIX",
    value: amountBrl,
    dueDate: paymentDueDate,
    description: paymentDescription,
    externalReference: reference,
  };
  const claimTopupCreation = async () =>
    await claimAsaasCreation(auth.context.admin, {
      tenantId,
      operation: "PAYMENT_CREATE",
      logicalKey: String(activeOrder.id),
      externalReference: reference,
      requestFingerprint: await asaasCreationFingerprint(
        wolfieTopupCreationSnapshot({
          tenantId,
          studentId,
          orderId: String(activeOrder.id),
          packageId: String(activeOrder.package_id),
          packageName: String(activeOrder.package_name),
          minutes,
          amountBrl,
          customerId: asaasCustomerId,
          dueDate: paymentDueDate,
          description: paymentDescription,
          externalReference: reference,
        }),
      ),
    });

  const markOrderForReview = async (reason: string): Promise<void> => {
    const { error } = await auth.context.admin.from("wolfie_topup_orders")
      .update({
        status: "RECONCILIATION_REQUIRED",
        reconciliation_required: true,
        creation_lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", activeOrder.id)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .in("status", ["PENDING", "CREATING", "AWAITING_PAYMENT"]);
    if (error) {
      console.error("Topup review marker failed", {
        code: error.code,
        reason,
      });
    }
  };

  const markOrderAmbiguous = async (): Promise<void> => {
    const { error } = await auth.context.admin.from("wolfie_topup_orders")
      .update({
        reconciliation_required: true,
        creation_lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", activeOrder.id)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .in("status", ["PENDING", "CREATING", "AWAITING_PAYMENT"]);
    if (error) {
      console.error("Topup ambiguity marker failed", { code: error.code });
    }
  };

  const persistPaymentLink = async (paymentId: string): Promise<boolean> => {
    const linkedPaymentId = text(activeOrder.provider_payment_id);
    if (linkedPaymentId && linkedPaymentId !== paymentId) return false;

    let update = auth.context.admin.from("wolfie_topup_orders").update({
      status: "AWAITING_PAYMENT",
      provider_payment_id: paymentId,
      reconciliation_required: false,
      creation_lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
      .eq("id", activeOrder.id)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .in("status", ["PENDING", "CREATING", "AWAITING_PAYMENT"]);
    update = linkedPaymentId
      ? update.eq("provider_payment_id", paymentId)
      : update.is("provider_payment_id", null);
    const { error: paymentLinkError } = await update;
    if (paymentLinkError) {
      console.error("Topup payment link persistence failed", {
        code: paymentLinkError.code,
      });
      return false;
    }

    const verified = await loadOrder();
    if (verified.error || !verified.data) {
      console.error("Topup payment link verification failed", {
        code: verified.error?.code ?? "missing_order",
      });
      return false;
    }
    activeOrder = verified.data;
    return text(activeOrder.provider_payment_id) === paymentId;
  };

  const loadExactProviderPayment = async (
    paymentId: string,
  ): Promise<
    | { kind: "FOUND"; payment: Record<string, unknown> }
    | { kind: "NOT_FOUND" }
    | { kind: "UNAVAILABLE" }
  > => {
    try {
      const response = await fetch(
        `${readIntegration.baseUrl}/payments/${encodeURIComponent(paymentId)}`,
        {
          headers: { "access_token": readIntegration.apiKey },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (response.status === 404) return { kind: "NOT_FOUND" };
      if (!response.ok || !isRecord(payload)) return { kind: "UNAVAILABLE" };
      return { kind: "FOUND", payment: payload };
    } catch {
      return { kind: "UNAVAILABLE" };
    }
  };

  const respondWithPayment = async (payment: Record<string, unknown>) => {
    const paymentId = text(payment.id);
    if (
      !wolfieTopupPaymentMatches(payment, expectedPayment) ||
      !(await persistPaymentLink(paymentId))
    ) {
      return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
    }

    let qr: Record<string, unknown> | null = null;
    try {
      const qrRes = await fetch(
        `${readIntegration.baseUrl}/payments/${
          encodeURIComponent(paymentId)
        }/pixQrCode`,
        {
          headers: { "access_token": readIntegration.apiKey },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const qrPayload: unknown = await qrRes.json().catch(() => null);
      if (qrRes.ok && isRecord(qrPayload)) qr = qrPayload;
    } catch {
      // The charge already exists. Never create another just because its
      // optional QR lookup failed.
      console.warn("Topup QR lookup failed after charge creation");
    }

    return json({
      success: true,
      orderId: activeOrder.id,
      requestKey,
      paymentId,
      minutes,
      value: amountBrl,
      invoiceUrl: typeof payment.invoiceUrl === "string"
        ? payment.invoiceUrl
        : null,
      pixPayload: typeof qr?.payload === "string" ? qr.payload : null,
      pixQrCode: typeof qr?.encodedImage === "string" ? qr.encodedImage : null,
    });
  };

  try {
    if (
      [
        "PAID",
        "SUSPENDED",
        "REVERSED",
        "FAILED",
        "RECONCILIATION_REQUIRED",
      ].includes(String(activeOrder.status))
    ) {
      return json({ error: "TOPUP_ORDER_NOT_PAYABLE" }, 409);
    }

    const locallyLinkedPaymentId = text(activeOrder.provider_payment_id);
    if (locallyLinkedPaymentId && tenantId !== "wolfie-direct") {
      // A crash may happen after the exact payment id is persisted but before
      // the student lifecycle binding is released. Reclaim the one immutable
      // creation attempt first; a local id alone never proves completion.
      const recoveryClaim = await claimTopupCreation();
      if (recoveryClaim.action === "IN_PROGRESS") {
        return json({
          error: "TOPUP_CREATION_IN_PROGRESS",
          retryAfter: recoveryClaim.retry_after_seconds ?? null,
          requestKey,
        }, 202);
      }
      if (recoveryClaim.action === "REVIEW_REQUIRED" || !recoveryClaim.ok) {
        await markOrderForReview("linked_payment_creation_requires_review");
        return json({ error: "TOPUP_ORDER_REQUIRES_REVIEW" }, 409);
      }

      const existingLookup = await loadExactProviderPayment(
        locallyLinkedPaymentId,
      );
      if (existingLookup.kind === "UNAVAILABLE") {
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
      const existing = existingLookup.kind === "FOUND"
        ? existingLookup.payment
        : null;
      const claimedPaymentId = text(recoveryClaim.provider_entity_id);
      if (
        !wolfieTopupPaymentMatches(existing, expectedPayment) ||
        (claimedPaymentId && claimedPaymentId !== locallyLinkedPaymentId) ||
        (recoveryClaim.action === "ALREADY_SUCCEEDED" &&
          claimedPaymentId !== locallyLinkedPaymentId)
      ) {
        await markOrderForReview("local_provider_payment_identity_mismatch");
        return json({ error: "TOPUP_RECONCILIATION_REQUIRED" }, 409);
      }

      // Every path that can persist a school top-up id first binds this exact
      // durable attempt under the student advisory fence. If the process died
      // before recording success, finish that claim from the exact provider
      // GET; release then proves the pre-existing binding and local order CAS.
      if (recoveryClaim.action !== "ALREADY_SUCCEEDED") {
        await recordAsaasCreationState(auth.context.admin, recoveryClaim, {
          status: "SUCCEEDED",
          providerEntityId: locallyLinkedPaymentId,
          providerStatus: text(existing?.status),
        });
      }
      const released = await releaseStudentAsaasCreationLifecycle(
        auth.context.admin,
        recoveryClaim,
        {
          tenantId,
          studentId,
          providerEntityId: locallyLinkedPaymentId,
        },
      );
      if (!released) {
        await markOrderForReview("student_lifecycle_release_failed");
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
      return await respondWithPayment(existing);
    }
    if (locallyLinkedPaymentId) {
      const existingLookup = await loadExactProviderPayment(
        locallyLinkedPaymentId,
      );
      if (existingLookup.kind === "UNAVAILABLE") {
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
      const existing = existingLookup.kind === "FOUND"
        ? existingLookup.payment
        : null;
      if (!wolfieTopupPaymentMatches(existing, expectedPayment)) {
        await markOrderForReview("local_provider_payment_identity_mismatch");
        return json({ error: "TOPUP_RECONCILIATION_REQUIRED" }, 409);
      }
      return await respondWithPayment(existing);
    }

    const creationClaim = await claimTopupCreation();

    const studentLifecycle = {
      tenantId,
      studentId,
      bindingKind: "TOPUP_ORDER" as const,
      expectedCustomerId: asaasCustomerId,
    };
    const bindSchoolLifecycle = async (): Promise<boolean> =>
      tenantId === "wolfie-direct" ||
      await bindStudentAsaasCreationLifecycle(
        auth.context.admin,
        creationClaim,
        studentLifecycle,
      );
    const releaseSchoolLifecycle = async (
      providerPaymentId: string,
    ): Promise<boolean> =>
      tenantId === "wolfie-direct" ||
      await releaseStudentAsaasCreationLifecycle(
        auth.context.admin,
        creationClaim,
        {
          tenantId,
          studentId,
          providerEntityId: providerPaymentId,
        },
      );
    const adoptDirectPayment = async (
      providerPaymentId: string,
      providerStatus: string,
    ): Promise<boolean> => {
      if (tenantId !== "wolfie-direct") return true;
      if (!hubAccountId) return false;
      const { data, error } = await auth.context.admin.rpc(
        "hub_adopt_wolfie_topup_provider_binding",
        {
          p_attempt_id: creationClaim.attempt_id,
          p_claim_token: creationClaim.claim_token || null,
          p_account_id: hubAccountId,
          p_order_id: activeOrder.id,
          p_provider_entity_id: providerPaymentId,
          p_provider_status: providerStatus || null,
          p_provider_customer_id: asaasCustomerId,
        },
      );
      if (error || data?.ok !== true) {
        console.error("Wolfie direct provider adoption blocked", {
          code: error?.code || data?.reason || "unknown",
        });
        return false;
      }
      const refreshed = await loadOrder();
      if (refreshed.error || !refreshed.data) return false;
      activeOrder = refreshed.data;
      return text(activeOrder.provider_payment_id) === providerPaymentId;
    };
    const markLifecycleSubmitting = async (): Promise<void> => {
      if (tenantId !== "wolfie-direct") {
        await markStudentAsaasCreationSubmitting(
          auth.context.admin,
          creationClaim,
          studentLifecycle,
        );
        return;
      }
      if (!hubAccountId) throw new Error("hub_account_scope_missing");
      const { data, error } = await auth.context.admin.rpc(
        "hub_mark_account_provider_creation_submitting",
        {
          p_attempt_id: creationClaim.attempt_id,
          p_claim_token: creationClaim.claim_token || null,
          p_account_id: hubAccountId,
          p_entity_kind: "WOLFIE_TOPUP_ORDER",
          p_entity_id: activeOrder.id,
        },
      );
      if (error || data?.ok !== true) {
        console.error("Wolfie direct submit lifecycle fenced", {
          code: error?.code || data?.reason || "unknown",
        });
        throw new Error("hub_topup_lifecycle_blocked");
      }
    };

    if (creationClaim.action === "ALREADY_SUCCEEDED") {
      if (!await bindSchoolLifecycle()) {
        await markOrderForReview("student_lifecycle_changed_before_recovery");
        return json({ error: "TOPUP_ORDER_REQUIRES_REVIEW" }, 409);
      }
      const claimedPaymentId = text(creationClaim.provider_entity_id);
      const claimedLookup = claimedPaymentId
        ? await loadExactProviderPayment(claimedPaymentId)
        : { kind: "NOT_FOUND" as const };
      if (claimedLookup.kind === "UNAVAILABLE") {
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
      const claimedPayment = claimedLookup.kind === "FOUND"
        ? claimedLookup.payment
        : null;
      if (!wolfieTopupPaymentMatches(claimedPayment, expectedPayment)) {
        await markOrderForReview("claimed_provider_payment_identity_mismatch");
        return json({ error: "TOPUP_RECONCILIATION_REQUIRED" }, 409);
      }
      if (
        tenantId === "wolfie-direct"
          ? !await adoptDirectPayment(
            claimedPaymentId,
            text(claimedPayment?.status),
          )
          : !(await persistPaymentLink(claimedPaymentId)) ||
            !(await releaseSchoolLifecycle(claimedPaymentId))
      ) {
        await markOrderForReview("provider_payment_local_binding_failed");
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
      return await respondWithPayment(claimedPayment);
    }
    if (creationClaim.action === "IN_PROGRESS") {
      return json({
        error: "TOPUP_CREATION_IN_PROGRESS",
        retryAfter: creationClaim.retry_after_seconds ?? null,
        requestKey,
      }, 202);
    }
    if (creationClaim.action === "REVIEW_REQUIRED" || !creationClaim.ok) {
      await markOrderForReview("provider_creation_requires_review");
      return json({ error: "TOPUP_ORDER_REQUIRES_REVIEW" }, 409);
    }

    // The shared lookup exhausts every Asaas page. Querying by reference only
    // ensures a charge owned by a divergent customer cannot be hidden by a
    // provider-side customer filter.
    const providerLookup = await findUniqueAsaasEntity<
      Record<string, unknown>
    >({
      baseUrl: readIntegration.baseUrl,
      apiKey: readIntegration.apiKey,
      path: "payments",
      query: { externalReference: reference },
      matches: (candidate) =>
        wolfieTopupPaymentMatches(candidate, expectedPayment),
      conflicts: (candidate) =>
        wolfieTopupReferenceConflicts(candidate, reference),
    });

    if (
      providerLookup.kind === "DUPLICATE" ||
      providerLookup.kind === "CONFLICT"
    ) {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "BLOCKED",
        error: providerLookup.kind === "DUPLICATE"
          ? "duplicate_wolfie_topup_payments"
          : "wolfie_topup_provider_identity_conflict",
      });
      await markOrderForReview("provider_payment_identity_conflict");
      return json({
        error: providerLookup.kind === "DUPLICATE"
          ? "DUPLICATE_PROVIDER_CHARGE"
          : "PROVIDER_PAYMENT_IDENTITY_CONFLICT",
      }, 409);
    }
    if (providerLookup.kind === "UNAVAILABLE") {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: creationClaim.action === "RECONCILE_REQUIRED"
          ? "UNKNOWN"
          : "RETRY",
        httpStatus: providerLookup.httpStatus,
        error: "wolfie_topup_recovery_lookup_unavailable",
      });
      if (creationClaim.action === "RECONCILE_REQUIRED") {
        await markOrderAmbiguous();
      }
      return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
    }
    if (providerLookup.kind === "FOUND") {
      const recoveredPaymentId = text(providerLookup.entity.id);
      if (!recoveredPaymentId || !await bindSchoolLifecycle()) {
        await recordAsaasCreationState(auth.context.admin, creationClaim, {
          status: "BLOCKED",
          providerEntityId: recoveredPaymentId,
          error: "wolfie_topup_lifecycle_binding_failed",
        });
        await markOrderForReview("provider_payment_lifecycle_binding_failed");
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
      if (tenantId === "wolfie-direct") {
        if (
          !await adoptDirectPayment(
            recoveredPaymentId,
            text(providerLookup.entity.status),
          )
        ) {
          await markOrderForReview("provider_payment_local_binding_failed");
          return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
        }
      } else {
        // The student lifecycle marker remains active across durable provider
        // success and the exact local order CAS.
        if (!(await persistPaymentLink(recoveredPaymentId))) {
          await recordAsaasCreationState(auth.context.admin, creationClaim, {
            status: "BLOCKED",
            providerEntityId: recoveredPaymentId,
            error: "wolfie_topup_local_binding_failed",
          });
          await markOrderForReview("provider_payment_local_binding_failed");
          return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
        }
        await recordAsaasCreationState(auth.context.admin, creationClaim, {
          status: "SUCCEEDED",
          providerEntityId: recoveredPaymentId,
          providerStatus: text(providerLookup.entity.status),
        });
        if (!(await releaseSchoolLifecycle(recoveredPaymentId))) {
          await markOrderForReview("student_lifecycle_release_failed");
          return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
        }
      }
      return await respondWithPayment(providerLookup.entity);
    }

    if (creationClaim.action === "RECONCILE_REQUIRED") {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "UNKNOWN",
        error: "wolfie_topup_payment_not_yet_observed",
      });
      await markOrderAmbiguous();
      return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 409);
    }

    if (
      !wolfieTopupMaySubmitProviderPayment({
        claimAction: creationClaim.action,
        lookupKind: providerLookup.kind,
        localOrderStatus: activeOrder.status,
      })
    ) {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "BLOCKED",
        error: "legacy_or_inconsistent_topup_creation_state",
      });
      await markOrderForReview("legacy_or_inconsistent_creation_state");
      return json({ error: "TOPUP_ORDER_REQUIRES_REVIEW" }, 409);
    }

    let submitIntegration: Awaited<
      ReturnType<typeof resolvePlatformAsaasIntegration>
    >;
    try {
      submitIntegration = await resolvePlatformAsaasIntegration(
        auth.context.admin,
        "payment.create",
      );
    } catch {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "RETRY",
        error: "wolfie_topup_submit_capability_unavailable",
      });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }
    if (
      submitIntegration.integrationId !== readIntegration.integrationId ||
      submitIntegration.tenantId !== readIntegration.tenantId ||
      submitIntegration.provider !== readIntegration.provider ||
      submitIntegration.version !== readIntegration.version ||
      submitIntegration.mode !== readIntegration.mode ||
      submitIntegration.environment !== readIntegration.environment ||
      submitIntegration.baseUrl !== readIntegration.baseUrl ||
      submitIntegration.apiKey !== readIntegration.apiKey
    ) {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "RETRY",
        error: "wolfie_topup_integration_changed_before_submit",
      });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }

    const creatingUpdate = await auth.context.admin
      .from("wolfie_topup_orders")
      .update({
        status: "CREATING",
        creation_lease_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", activeOrder.id)
      .eq("tenant_id", tenantId)
      .eq("student_id", studentId)
      .eq("status", "PENDING")
      .is("provider_payment_id", null)
      .select("id")
      .maybeSingle();
    if (creatingUpdate.error) {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "RETRY",
        error: "wolfie_topup_local_fence_unavailable",
      });
      return json({ error: "TOPUP_UNAVAILABLE" }, 503);
    }
    if (!creatingUpdate.data) {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "BLOCKED",
        error: "wolfie_topup_local_state_changed_before_submit",
      });
      await markOrderForReview("local_state_changed_before_submit");
      return json({ error: "TOPUP_ORDER_REQUIRES_REVIEW" }, 409);
    }

    // The capability fence below is still before the provider boundary. Once
    // it passes, every later failure is reconciled by GET only and this local
    // transition permanently consumes the single allowed POST.
    await markLifecycleSubmitting();
    let freshSubmitIntegration: Awaited<
      ReturnType<typeof resolvePlatformAsaasIntegration>
    >;
    try {
      freshSubmitIntegration = await revalidateAsaasMutationCapability(
        auth.context.admin,
        {
          tenantId: submitIntegration.tenantId,
          purpose: "payment.create",
          expected: submitIntegration,
        },
      );
    } catch (error) {
      const unavailable = error instanceof AsaasCapabilityFenceError &&
        error.failure === "UNAVAILABLE";
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "BLOCKED",
        error: unavailable
          ? "wolfie_topup_capability_unavailable_before_post"
          : "wolfie_topup_capability_changed_before_post",
      });
      await markOrderForReview(
        unavailable
          ? "capability_unavailable_after_submit_mark"
          : "capability_changed_before_post",
      );
      return json({
        error: unavailable
          ? "TOPUP_UNAVAILABLE"
          : "TOPUP_ORDER_REQUIRES_REVIEW",
      }, unavailable ? 503 : 409);
    }
    let paymentRes: Response;
    try {
      paymentRes = await fetch(
        `${freshSubmitIntegration.baseUrl}/payments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "access_token": freshSubmitIntegration.apiKey,
          },
          body: JSON.stringify(paymentPayload),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: "UNKNOWN",
        error: "wolfie_topup_payment_post_outcome_unknown",
      });
      await markOrderAmbiguous();
      return json({ error: "CHARGE_STATUS_UNCERTAIN", requestKey }, 503);
    }

    const payment: unknown = await paymentRes.json().catch(() => null);
    const submittedPaymentMatches = wolfieTopupPaymentMatches(
      payment,
      expectedPayment,
    );
    const providerPaymentId = submittedPaymentMatches && isRecord(payment)
      ? text(payment.id)
      : "";
    const outcome = asaasCreationHttpOutcome(
      paymentRes.ok,
      paymentRes.status,
      providerPaymentId,
    );
    const durableOutcome = paymentRes.ok && !submittedPaymentMatches
      ? "BLOCKED"
      : outcome;
    const providerStatus = isRecord(payment) ? text(payment.status) : "";
    if (durableOutcome === "SUCCEEDED" && tenantId === "wolfie-direct") {
      if (
        !await adoptDirectPayment(providerPaymentId, providerStatus)
      ) {
        await markOrderForReview("provider_payment_local_binding_failed");
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
    } else {
      await recordAsaasCreationState(auth.context.admin, creationClaim, {
        status: durableOutcome,
        providerEntityId: providerPaymentId,
        providerStatus,
        httpStatus: paymentRes.status,
        error: durableOutcome === "SUCCEEDED"
          ? null
          : durableOutcome === "BLOCKED"
          ? "wolfie_topup_post_identity_mismatch"
          : durableOutcome === "FAILED"
          ? "wolfie_topup_payment_creation_rejected"
          : "wolfie_topup_payment_post_outcome_unknown",
      });
    }

    if (durableOutcome === "BLOCKED") {
      await markOrderForReview("provider_post_identity_mismatch");
      return json({ error: "PROVIDER_PAYMENT_IDENTITY_CONFLICT" }, 409);
    }
    if (durableOutcome === "FAILED") {
      await auth.context.admin.from("wolfie_topup_orders").update({
        status: "FAILED",
        reconciliation_required: false,
        creation_lease_expires_at: null,
        updated_at: new Date().toISOString(),
      }).eq("id", activeOrder.id).eq("tenant_id", tenantId).eq(
        "student_id",
        studentId,
      ).eq("status", "CREATING");
      return json({ error: "CHARGE_CREATION_FAILED", requestKey }, 502);
    }
    if (durableOutcome === "UNKNOWN" || !isRecord(payment)) {
      await markOrderAmbiguous();
      return json({ error: "CHARGE_STATUS_UNCERTAIN", requestKey }, 503);
    }
    if (tenantId !== "wolfie-direct") {
      if (
        !(await persistPaymentLink(providerPaymentId)) ||
        !(await releaseSchoolLifecycle(providerPaymentId))
      ) {
        await markOrderForReview("student_lifecycle_release_failed");
        return json({ error: "TOPUP_RECONCILIATION_PENDING" }, 503);
      }
    }
    return await respondWithPayment(payment);
  } catch (error) {
    console.error("Topup creation coordination failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    // A shared guard that has reached SUBMITTING can never authorize a second
    // POST, even if this handler exits before persisting the final state.
    return json({ error: "CHARGE_STATUS_UNCERTAIN", requestKey }, 503);
  }
});
