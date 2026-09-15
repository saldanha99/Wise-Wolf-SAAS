/// <reference lib="deno.ns" />
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeScopedAutomation } from "../_shared/automation-auth.ts";
import {
  resolveAsaasIntegration,
  type ResolvedAsaasIntegration,
} from "../_shared/tenant-integration-broker.ts";
import { revalidateAsaasMutationCapability } from "../_shared/asaas-capability-fence.ts";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization,x-client-info,apikey,content-type",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Content-Type": "application/json",
};
type Row = Record<string, unknown>;
const obj = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const safeDate = (v: unknown) =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const sameIntegration = (
  a: ResolvedAsaasIntegration,
  b: ResolvedAsaasIntegration,
) =>
  a.integrationId === b.integrationId && a.tenantId === b.tenantId &&
  a.version === b.version && a.environment === b.environment &&
  a.mode === b.mode && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey;
async function request(
  i: ResolvedAsaasIntegration,
  path: string,
  init: RequestInit = {},
) {
  return await fetch(
    `${i.baseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
    {
      ...init,
      headers: {
        access_token: i.apiKey,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(
        init.method && init.method !== "GET" ? 65000 : 12000,
      ),
    },
  );
}
async function read(i: ResolvedAsaasIntegration, path: string) {
  const r = await request(i, path);
  if (!r.ok) throw new Error(`provider_read_${r.status}`);
  return obj(await r.json());
}
async function allSubscriptions(i: ResolvedAsaasIntegration, customer: string) {
  const out: Row[] = [];
  for (let offset = 0, page = 0; page < 100; page++) {
    const r = await read(
      i,
      `subscriptions?customer=${
        encodeURIComponent(customer)
      }&limit=100&offset=${offset}`,
    );
    if (!Array.isArray(r.data)) throw new Error("provider_collection_invalid");
    out.push(...r.data.map(obj));
    if (r.hasMore !== true) return out;
    if (r.data.length === 0) throw new Error("provider_collection_invalid");
    offset += r.data.length;
  }
  throw new Error("provider_collection_too_large");
}
function validSource(v: unknown) {
  const s = obj(v);
  return typeof s.id === "string" && typeof s.tenant_id === "string" &&
      typeof s.student_id === "string" &&
      ["CREATE_NEW", "REUSE_EXISTING"].includes(String(s.strategy)) &&
      typeof s.customer_id === "string" && /^cus_/.test(s.customer_id) &&
      ["PIX", "BOLETO", "CREDIT_CARD"].includes(String(s.billing_type)) &&
      Number.isSafeInteger(s.monthly_fee_cents) &&
      Number(s.monthly_fee_cents) > 0 && safeDate(s.first_due_date) &&
      safeDate(s.last_due_date) && safeDate(s.service_end_date) &&
      typeof s.external_reference === "string" &&
      /^renewal:[0-9a-f-]{36}:subscription$/.test(s.external_reference)
    ? s
    : null;
}

serve(async (requestEvent) => {
  if (requestEvent.method === "OPTIONS") return new Response("ok", { headers });
  if (requestEvent.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers,
    });
  }
  const auth = await authorizeScopedAutomation(requestEvent, headers);
  if (!auth.ok) return auth.response;
  const body = await requestEvent.json().catch(() => null);
  if (
    !body || typeof body !== "object" || Array.isArray(body) ||
    (body as Row).sweep !== true || Object.keys(body).some((k) => k !== "sweep")
  ) {
    return new Response(JSON.stringify({ error: "invalid_sweep_request" }), {
      status: 400,
      headers,
    });
  }
  const admin = auth.context.admin;
  const claimed = await admin.rpc("claim_student_course_renewal_billing", {
    p_limit: 10,
  });
  if (claimed.error || !Array.isArray(claimed.data)) {
    return new Response(
      JSON.stringify({ error: "billing_queue_unavailable" }),
      { status: 503, headers },
    );
  }
  const result = {
    considered: 0,
    synced: 0,
    review: 0,
    failed: 0,
    errors: [] as string[],
  };
  for (const raw of claimed.data) {
    const claim = obj(raw);
    if (typeof claim.id !== "string" || typeof claim.claim_token !== "string") {
      continue;
    }
    result.considered++;
    const finish = async (
      status: "SYNCED" | "FAILED" | "REVIEW",
      subscription: string | null,
      error: string | null,
    ) => {
      const r = await admin.rpc("finish_student_course_renewal_billing", {
        p_id: claim.id,
        p_claim: claim.claim_token,
        p_status: status,
        p_provider_subscription: subscription,
        p_error: error,
      });
      if (r.error || obj(r.data).ok !== true) {
        throw new Error("billing_finish_failed");
      }
      if (status === "SYNCED") result.synced++;
      else if (status === "REVIEW") result.review++;
      else result.failed++;
    };
    try {
      const sourceResponse = await admin.rpc(
        "student_course_renewal_billing_source",
        { p_id: claim.id, p_claim: claim.claim_token },
      );
      const s = validSource(sourceResponse.data);
      if (sourceResponse.error || !s) {
        await finish("REVIEW", null, "billing_source_invalid");
        continue;
      }
      const purpose = s.strategy === "CREATE_NEW"
        ? "subscription.create"
        : "subscription.update";
      const integration = await resolveAsaasIntegration(
        admin,
        String(s.tenant_id),
        purpose,
      );
      const readIntegration = await resolveAsaasIntegration(
        admin,
        String(s.tenant_id),
        "subscription.read",
      );
      if (!sameIntegration(integration, readIntegration)) {
        await finish("REVIEW", null, "integration_capability_mismatch");
        continue;
      }
      if (s.strategy === "CREATE_NEW") {
        const subscriptions = await allSubscriptions(
          integration,
          String(s.customer_id),
        );
        const matches = subscriptions.filter((x) =>
          x.externalReference === s.external_reference
        );
        if (matches.length > 1) {
          await finish("REVIEW", null, "duplicate_external_reference");
          continue;
        }
        if (matches.length === 1) {
          const found = matches[0];
          if (
            found.customer !== s.customer_id ||
            Number(found.value) !== Number(s.monthly_fee_cents) / 100 ||
            found.cycle !== "MONTHLY" ||
            found.nextDueDate !== s.first_due_date ||
            found.endDate !== s.last_due_date
          ) {
            await finish("REVIEW", null, "provider_reconciliation_conflict");
            continue;
          }
          await finish("SYNCED", String(found.id), null);
          continue;
        }
        const oldId = typeof s.source_subscription_id === "string"
          ? s.source_subscription_id
          : "";
        if (!/^sub_/.test(oldId)) {
          await finish("REVIEW", null, "source_subscription_missing");
          continue;
        }
        const old = await read(
          integration,
          `subscriptions/${encodeURIComponent(oldId)}`,
        );
        if (
          old.customer !== s.customer_id ||
          old.billingType !== s.billing_type ||
          Number(old.value) !== Number(s.monthly_fee_cents) / 100 ||
          old.cycle !== "MONTHLY" ||
          !["EXPIRED", "INACTIVE"].includes(String(old.status))
        ) {
          await finish("REVIEW", null, "source_subscription_changed");
          continue;
        }
        const current = await resolveAsaasIntegration(
          admin,
          String(s.tenant_id),
          "subscription.create",
        );
        if (!sameIntegration(integration, current)) {
          await finish("REVIEW", null, "integration_changed");
          continue;
        }
        await revalidateAsaasMutationCapability(admin, {
          tenantId: String(s.tenant_id),
          purpose: "subscription.create",
          expected: integration,
        });
        const payload: Row = {
          customer: s.customer_id,
          billingType: s.billing_type,
          value: Number(s.monthly_fee_cents) / 100,
          nextDueDate: s.first_due_date,
          cycle: "MONTHLY",
          endDate: s.last_due_date,
          maxPayments: 6,
          description: `Renovação Wise Wolf - 6 meses`,
          externalReference: s.external_reference,
        };
        if (Array.isArray(old.split) && old.split.length) {
          payload.split = old.split;
        }
        let response: Response;
        try {
          response = await request(integration, "subscriptions", {
            method: "POST",
            body: JSON.stringify(payload),
          });
        } catch {
          await finish("REVIEW", null, "provider_create_outcome_unknown");
          continue;
        }
        const created = obj(await response.json().catch(() => null));
        if (!response.ok) {
          await finish(
            response.status >= 500 ||
              [408, 409, 425, 429].includes(response.status)
              ? "REVIEW"
              : "FAILED",
            null,
            `provider_create_${response.status}`,
          );
          continue;
        }
        if (
          typeof created.id !== "string" ||
          created.customer !== s.customer_id ||
          created.externalReference !== s.external_reference
        ) {
          await finish("REVIEW", null, "provider_create_response_invalid");
          continue;
        }
        await finish("SYNCED", created.id, null);
      } else {
        const subId = typeof s.subscription_id === "string"
          ? s.subscription_id
          : "";
        if (!/^sub_/.test(subId)) {
          await finish("REVIEW", null, "subscription_missing");
          continue;
        }
        const currentSub = await read(
          integration,
          `subscriptions/${encodeURIComponent(subId)}`,
        );
        if (
          currentSub.customer !== s.customer_id ||
          currentSub.status !== "ACTIVE" ||
          currentSub.billingType !== s.billing_type ||
          Number(currentSub.value) !== Number(s.monthly_fee_cents) / 100 ||
          currentSub.cycle !== "MONTHLY"
        ) {
          await finish("REVIEW", null, "active_subscription_changed");
          continue;
        }
        const payments = await read(
          integration,
          `subscriptions/${
            encodeURIComponent(subId)
          }/payments?limit=100&offset=0`,
        );
        if (payments.hasMore === true || !Array.isArray(payments.data)) {
          await finish("REVIEW", null, "payments_not_exhaustive");
          continue;
        }
        const first = payments.data.map(obj).filter((p) =>
          p.dueDate === s.first_due_date && p.customer === s.customer_id &&
          p.subscription === subId &&
          Number(p.value) === Number(s.monthly_fee_cents) / 100 &&
          !["DELETED", "REFUNDED"].includes(String(p.status))
        );
        if (first.length !== 1) {
          await finish("REVIEW", null, "first_installment_not_unique");
          continue;
        }
        if (currentSub.endDate !== s.last_due_date) {
          const latest = await resolveAsaasIntegration(
            admin,
            String(s.tenant_id),
            "subscription.update",
          );
          if (!sameIntegration(integration, latest)) {
            await finish("REVIEW", null, "integration_changed");
            continue;
          }
          await revalidateAsaasMutationCapability(admin, {
            tenantId: String(s.tenant_id),
            purpose: "subscription.update",
            expected: integration,
          });
          let updated: Response;
          try {
            updated = await request(
              integration,
              `subscriptions/${encodeURIComponent(subId)}`,
              {
                method: "PUT",
                body: JSON.stringify({
                  endDate: s.last_due_date,
                  status: "ACTIVE",
                  updatePendingPayments: false,
                }),
              },
            );
          } catch {
            await finish("REVIEW", null, "provider_update_outcome_unknown");
            continue;
          }
          if (!updated.ok) {
            await finish(
              updated.status >= 500 ||
                [408, 409, 425, 429].includes(updated.status)
                ? "REVIEW"
                : "FAILED",
              null,
              `provider_update_${updated.status}`,
            );
            continue;
          }
          const proof = await read(
            integration,
            `subscriptions/${encodeURIComponent(subId)}`,
          );
          if (
            proof.endDate !== s.last_due_date ||
            proof.customer !== s.customer_id || proof.status !== "ACTIVE"
          ) {
            await finish(
              "REVIEW",
              null,
              "provider_update_postcondition_failed",
            );
            continue;
          }
        }
        await finish("SYNCED", subId, null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "billing_error";
      try {
        await finish("REVIEW", null, message);
      } catch {
        result.errors.push("billing_finish_failed");
      }
    }
  }
  return new Response(JSON.stringify(result), {
    status: result.errors.length ? 503 : 200,
    headers,
  });
});
