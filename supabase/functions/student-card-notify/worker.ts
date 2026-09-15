import {
  cardFailureMessage,
  type CardSource,
  object,
  parseCardSource,
  type Row,
  sameSnapshot,
  type SendResult,
  verifyCardProof,
} from "./core.ts";

export type CardAsaasIntegration = {
  tenantId: string;
  integrationId: string;
  version: number;
  environment: string;
  mode: string;
  baseUrl: string;
  apiKey: string;
};
export type CardRoute = {
  tenantId: string;
  instanceName: string;
  integrationId: string;
  integrationVersion: number;
  mode: string;
  baseUrl: string;
  apiKey: string;
  brandName: string;
  portalUrl: string | null;
};
export type CardWorkerDependencies = {
  client: {
    rpc(
      name: string,
      args: Row,
    ): PromiseLike<{ data: unknown; error: unknown }>;
  };
  resolveRoute(tenantId: string): Promise<CardRoute | null>;
  /** Resolve both read purposes; implementation must ensure identical identity. */
  resolveAsaas(tenantId: string): Promise<CardAsaasIntegration | null>;
  readPayment(integration: CardAsaasIntegration, id: string): Promise<unknown>;
  readSubscription(
    integration: CardAsaasIntegration,
    id: string,
  ): Promise<unknown>;
  hash(value: string): Promise<string>;
  send(
    route: CardRoute,
    destination: string,
    message: string,
  ): Promise<SendResult>;
  now?: () => number;
};

const MAX_PROOF_AGE_MS = 15000;

export async function runStudentCardSweep(
  dependencies: CardWorkerDependencies,
  options: { testMode?: boolean; dryRun?: boolean } = {},
) {
  const result = {
    considered: 0,
    accepted: 0,
    delivered: 0,
    unknown: 0,
    rejected: 0,
    deferred: 0,
    suppressed: 0,
    skipped: 0,
    testMode: options.testMode === true,
    dryRun: options.dryRun === true,
    errors: [] as string[],
  };
  // This is an inert simulation, not a provider-backed preview or a queue claim.
  if (result.testMode || result.dryRun) return result;
  const now = dependencies.now ?? Date.now;
  async function rpc(name: string, args: Row): Promise<unknown> {
    const response = await dependencies.client.rpc(name, args);
    if (response.error) throw new Error("card_notification_rpc_unavailable");
    return response.data;
  }
  const pending = await rpc("student_card_notification_pending", {
    p_limit: 25,
  });
  if (!Array.isArray(pending)) {
    throw new Error("card_notification_queue_unavailable");
  }
  // Never enumerate the provider or historical inbox: only DB-matured new events.
  for (const value of pending.slice(0, 25)) {
    const item = object(value);
    if (typeof item.id !== "string" || typeof item.tenant_id !== "string") {
      result.skipped++;
      continue;
    }
    result.considered++;
    const id = item.id;
    const tenantId = item.tenant_id;
    let claimToken: string | null = null;
    let authorized = false;
    let providerResult: SendResult | null = null;
    async function defer(reason: string, suppress = false) {
      const deferred = object(
        await rpc("defer_student_card_notification", {
          p_id: id,
          p_claim_token: claimToken,
          p_reason: reason,
          p_suppress: suppress,
        }),
      );
      if (deferred.ok === true) {
        if (suppress) result.suppressed++;
        else result.deferred++;
      } else result.skipped++;
    }
    async function finish(outcome: SendResult) {
      return object(
        await rpc("finish_student_card_notification", {
          p_id: id,
          p_claim_token: claimToken,
          p_outcome: outcome.outcome,
          p_provider_message_id: outcome.messageId,
          p_http_status: outcome.httpStatus,
        }),
      );
    }
    async function readProof(
      source: CardSource,
      integration: CardAsaasIntegration,
    ) {
      const [payment, subscription] = await Promise.all([
        dependencies.readPayment(integration, source.provider_payment_id),
        dependencies.readSubscription(integration, source.subscription_id),
      ]);
      return verifyCardProof(source, payment, subscription);
    }
    try {
      const claim = object(
        await rpc("claim_student_card_notification", { p_id: id }),
      );
      if (
        claim.ok !== true || claim.id !== id || claim.tenant_id !== tenantId ||
        typeof claim.claim_token !== "string" || !claim.claim_token
      ) {
        result.skipped++;
        continue;
      }
      claimToken = claim.claim_token;
      const source = parseCardSource(
        await rpc("student_card_notification_source", { p_id: id }),
      );
      if (!source) {
        await defer("source_unavailable", true);
        continue;
      }
      if (source.tenant_id !== tenantId) {
        await defer("identity_mismatch", true);
        continue;
      }
      const eventAge = now() - Date.parse(source.event_at);
      if (eventAge < -60000 || eventAge > 35 * 86400000) {
        await defer("source_unavailable", true);
        continue;
      }
      const [route, integration] = await Promise.all([
        dependencies.resolveRoute(tenantId),
        dependencies.resolveAsaas(tenantId),
      ]);
      if (!route || !integration) {
        await defer(!route ? "route_unavailable" : "provider_unavailable");
        continue;
      }
      if (route.tenantId !== tenantId || integration.tenantId !== tenantId) {
        await defer("identity_mismatch", true);
        continue;
      }
      const initial = await readProof(source, integration);
      if (initial.ok === false) {
        await defer(initial.reason, initial.suppress);
        continue;
      }
      const message = cardFailureMessage(
        source,
        route.brandName,
        route.portalUrl,
      );
      const prepared = object(
        await rpc("prepare_student_card_notification", {
          p_id: id,
          p_claim_token: claimToken,
          p_source_snapshot: source,
          p_message_body: message,
          p_instance_name: route.instanceName,
          p_destination: source.recipient_phone,
          p_integration_id: route.integrationId,
          p_integration_version: route.integrationVersion,
          p_asaas_integration_id: integration.integrationId,
          p_asaas_integration_version: integration.version,
          p_asaas_environment: integration.environment,
          p_asaas_mode: integration.mode,
        }),
      );
      if (prepared.ok !== true) {
        await defer("prepare_denied");
        continue;
      }
      // Resolve again BEFORE using a credential for the second observation.
      const beforeObservation = await dependencies.resolveAsaas(tenantId);
      if (!sameSnapshot(beforeObservation, integration)) {
        await defer("integration_changed");
        continue;
      }
      const proofStarted = now();
      const finalProof = await readProof(source, integration);
      if (finalProof.ok === false) {
        await defer(finalProof.reason, finalProof.suppress);
        continue;
      }
      if (!sameSnapshot(initial.proof, finalProof.proof)) {
        await defer("snapshot_changed");
        continue;
      }
      const [finalSource, finalRoute, finalIntegration, endpointHash, keyHash] =
        await Promise.all([
          rpc("student_card_notification_source", { p_id: id }),
          dependencies.resolveRoute(tenantId),
          dependencies.resolveAsaas(tenantId),
          dependencies.hash(route.baseUrl),
          dependencies.hash(route.apiKey),
        ]);
      if (!sameSnapshot(source, parseCardSource(finalSource))) {
        await defer("source_changed");
        continue;
      }
      // This comparison includes credentials (in memory only), not just version.
      if (
        !sameSnapshot(route, finalRoute) ||
        !sameSnapshot(integration, finalIntegration)
      ) {
        await defer("integration_changed");
        continue;
      }
      if (now() - proofStarted > MAX_PROOF_AGE_MS) {
        await defer("provider_unavailable");
        continue;
      }
      const envelope = object(
        await rpc("authorize_student_card_notification", {
          p_id: id,
          p_claim_token: claimToken,
          p_integration_id: route.integrationId,
          p_integration_version: route.integrationVersion,
          p_provider_endpoint_hash: endpointHash,
          p_provider_credential_hash: keyHash,
          p_source_snapshot: source,
          p_provider_payment_snapshot: finalProof.proof.payment,
          p_provider_subscription_snapshot: finalProof.proof.subscription,
        }),
      );
      if (envelope.ok !== true) {
        await defer("authorization_denied");
        continue;
      }
      authorized = true;
      if (
        envelope.id !== id || envelope.destination !== source.recipient_phone ||
        envelope.instance_name !== route.instanceName ||
        envelope.message_body !== message ||
        now() - proofStarted > MAX_PROOF_AGE_MS
      ) {
        // DB fence already sealed. No POST and no automatic retry after ambiguity.
        providerResult = {
          outcome: "ambiguous",
          messageId: null,
          httpStatus: null,
        };
      } else {
        // No mutable lookup or alternate recipient between authorization and POST.
        providerResult = await dependencies.send(
          route,
          source.recipient_phone,
          message,
        );
      }
      const finished = await finish(providerResult);
      if (finished.ok !== true) {
        throw new Error("card_notification_finish_unavailable");
      }
      if (
        finished.status === "SENT" &&
        ["delivered", "read"].includes(String(finished.delivery_status))
      ) {
        result.delivered++;
      } else if (
        finished.status === "SUBMITTING" &&
        providerResult.outcome === "accepted"
      ) {
        result.accepted++;
      } else if (finished.status === "FAILED") result.rejected++;
      else result.unknown++;
    } catch {
      // Never copy provider/DB exception messages (which can contain contact data).
      result.errors.push("card_notification_unavailable");
      if (authorized && claimToken) {
        result.unknown++;
        try {
          await finish(
            providerResult ?? {
              outcome: "ambiguous",
              messageId: null,
              httpStatus: null,
            },
          );
        } catch {
          /* Lease/reconciler must keep UNKNOWN, never retry the POST. */
        }
      } else if (claimToken) {
        try {
          await defer("worker_unavailable");
        } catch { /* Lease expires safely before POST. */ }
      }
    }
  }
  return result;
}
