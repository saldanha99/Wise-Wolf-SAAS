import { reserveNotificationMessage } from "./message.ts";

type Row = Record<string, unknown>;
export interface ReserveRpcClient {
  rpc(name: string, args?: Row): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface ReserveRoute {
  instanceName: string;
  destination: string;
  integrationId: string;
  integrationVersion: number;
  baseUrl: string;
  apiKey: string;
}
export interface ReserveWorkerDependencies {
  client: ReserveRpcClient;
  resolveRoute(tenantId: string): Promise<ReserveRoute | null>;
  hash(value: string): Promise<string>;
  send(route: ReserveRoute, message: string): Promise<{
    outcome: "accepted" | "rejected" | "ambiguous";
    messageId: string | null;
    httpStatus: number | null;
  }>;
}
function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : {};
}
async function rpc(
  client: ReserveRpcClient,
  name: string,
  args: Row = {},
): Promise<unknown> {
  const response = await client.rpc(name, args);
  if (response.error) throw new Error(name);
  return response.data;
}

/** No fetch/credential/log dependencies: tests can exercise the whole fence. */
export async function runReserveSweep(
  dependencies: ReserveWorkerDependencies,
  options: { testMode?: boolean } = {},
) {
  const result = {
    recomputed: 0,
    recomputeFailed: 0,
    accepted: 0,
    delivered: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    errors: [] as string[],
  };
  // Explicit test mode is a hard no-side-effects gate, including no queue mutation.
  if (options.testMode) return { ...result, suppressed: "testMode" };
  // Internal data work is independent of WhatsApp opt-in and calendar windows.
  // Each awaited RPC commits its own transaction before lifecycle recompute,
  // avoiding payment/allocation -> profile lock inversion in the trigger.
  const recomputations = await rpc(
    dependencies.client,
    "claim_prepayment_financial_recomputations",
    { p_limit: 25 },
  );
  if (!Array.isArray(recomputations)) {
    throw new Error("invalid_recompute_response");
  }
  for (const raw of recomputations) {
    const item = object(raw);
    const args = {
      p_tenant: item.tenant_id,
      p_student: item.student_id,
      p_claim_token: item.claim_token,
      p_version: item.version,
    };
    let errorCode: string | null = null;
    try {
      const recomputed = object(
        await rpc(dependencies.client, "recompute_student_financial_status", {
          p_tenant_id: item.tenant_id,
          p_student_id: item.student_id,
        }),
      );
      if (recomputed.ok !== true) {
        errorCode = "financial_recompute_not_confirmed";
      }
    } catch {
      errorCode = "financial_recompute_unavailable";
    }
    try {
      const complete = object(
        await rpc(
          dependencies.client,
          "complete_prepayment_financial_recompute",
          {
            ...args,
            p_error: errorCode,
          },
        ),
      );
      if (complete.ok !== true) errorCode = "financial_recompute_stale_claim";
    } catch {
      errorCode = "financial_recompute_ack_unavailable";
    }
    if (errorCode) {
      result.recomputeFailed++;
      result.errors.push(errorCode);
    } else result.recomputed++;
  }
  const pending = await rpc(
    dependencies.client,
    "monthly_reserve_notification_pending",
    { p_limit: 25 },
  );
  if (!Array.isArray(pending)) throw new Error("invalid_pending_response");
  for (const raw of pending) {
    const target = object(raw);
    const id = String(target.id ?? "");
    if (!id || !target.tenant_id) {
      result.skipped++;
      continue;
    }
    let token = "";
    let authorized = false;
    let outcomePersisted = false;
    let knownProviderResult:
      | Awaited<ReturnType<ReserveWorkerDependencies["send"]>>
      | null = null;
    try {
      const claim = object(
        await rpc(dependencies.client, "claim_monthly_reserve_notification", {
          p_id: id,
        }),
      );
      if (claim.ok !== true) {
        result.skipped++;
        continue;
      }
      token = String(claim.claim_token ?? "");
      if (!token || claim.tenant_id !== target.tenant_id || claim.id !== id) {
        throw new Error("claim_identity_mismatch");
      }
      const source = object(
        await rpc(dependencies.client, "monthly_reserve_notification_source", {
          p_id: id,
        }),
      );
      if (Object.keys(source).length === 0 || source.error) {
        result.skipped++;
        continue;
      }
      const message = reserveNotificationMessage(
        String(claim.notification_kind),
        source,
      );
      if (message.length > 8000) throw new Error("message_too_long");
      const route = await dependencies.resolveRoute(String(claim.tenant_id));
      if (!route || !/^[0-9]{10,25}@g\.us$/.test(route.destination)) {
        result.skipped++;
        continue;
      }
      const prepared = object(
        await rpc(dependencies.client, "prepare_monthly_reserve_notification", {
          p_id: id,
          p_claim_token: token,
          p_source_snapshot: source,
          p_message_body: message,
          p_instance_name: route.instanceName,
          p_destination: route.destination,
          p_integration_id: route.integrationId,
          p_integration_version: route.integrationVersion,
        }),
      );
      if (prepared.ok !== true) {
        result.skipped++;
        continue;
      }
      const [endpointHash, credentialHash] = await Promise.all([
        dependencies.hash(route.baseUrl),
        dependencies.hash(route.apiKey),
      ]);
      const authorization = object(
        await rpc(
          dependencies.client,
          "authorize_monthly_reserve_notification",
          {
            p_id: id,
            p_claim_token: token,
            p_integration_id: route.integrationId,
            p_integration_version: route.integrationVersion,
            p_provider_endpoint_hash: endpointHash,
            p_provider_credential_hash: credentialHash,
          },
        ),
      );
      if (authorization.ok !== true) {
        result.skipped++;
        continue;
      }
      authorized = true;
      // No mutable lookup between the final database fence and the single POST.
      if (
        authorization.id !== id ||
        authorization.destination !== route.destination ||
        String(authorization.instance_name).toLowerCase() !==
          route.instanceName.toLowerCase() ||
        authorization.message_body !== message
      ) throw new Error("authorization_envelope_mismatch");
      const delivery = await dependencies.send(route, message);
      knownProviderResult = delivery;
      const finished = object(
        await rpc(dependencies.client, "finish_monthly_reserve_notification", {
          p_id: id,
          p_claim_token: token,
          p_outcome: delivery.outcome,
          p_provider_message_id: delivery.messageId,
          p_http_status: delivery.httpStatus,
        }),
      );
      if (finished.ok !== true) throw new Error("finish_not_confirmed");
      outcomePersisted = true;
      if (
        finished.status === "SENT" &&
        ["delivered", "read"].includes(String(finished.delivery_status))
      ) result.delivered++;
      else if (
        finished.status === "SUBMITTING" && delivery.outcome === "accepted"
      ) result.accepted++;
      else if (finished.status === "FAILED") result.failed++;
      else result.unknown++;
    } catch (error) {
      if (authorized && !outcomePersisted) {
        // Best-effort record only. Never re-POST after an unknown HTTP/DB result.
        try {
          await rpc(
            dependencies.client,
            "finish_monthly_reserve_notification",
            {
              p_id: id,
              p_claim_token: token,
              p_outcome: knownProviderResult?.outcome ?? "ambiguous",
              p_provider_message_id: knownProviderResult?.messageId ?? null,
              p_http_status: knownProviderResult?.httpStatus ?? null,
            },
          );
        } catch {
          /* Lease expiry durably marks UNKNOWN if the DB is unavailable. */
        }
        result.unknown++;
      }
      result.errors.push(
        error instanceof Error ? error.message : "reserve_worker_failed",
      );
    }
  }
  return result;
}
