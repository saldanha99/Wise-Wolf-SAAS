import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import {
  type AsaasMutationGuardResult,
  type CanonicalAsaasMutationTarget,
  guardAsaasMutationTarget,
} from "../_shared/asaas-mutation-guard.ts";

type FetchLike = typeof fetch;
export type ReadIdentity = {
  id: string;
  tenant_id: string;
  asaas_customer_id: string | null;
  subscription_id: string | null;
  cpf: string | null;
  guardian_cpf: string | null;
  guardian_name: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
};

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";
const digits = (value: unknown): string => text(value).replace(/\D/g, "");
const document = (value: unknown): string => {
  const normalized = digits(value);
  return [11, 14].includes(normalized.length) && !/^(\d)\1+$/.test(normalized)
    ? normalized
    : "";
};
const phone = (value: unknown): string => {
  let normalized = digits(value);
  if ([12, 13].includes(normalized.length) && normalized.startsWith("55")) {
    normalized = normalized.slice(2);
  }
  return [10, 11].includes(normalized.length) ? normalized : "";
};
const name = (value: unknown): string =>
  text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").toLowerCase();

// Esta prova autoriza somente o espelho de status. Não serve para cobrança,
// renovação, cancelamento ou alteração da referência no provedor.
export function proveLegacySubscriptionRead(
  target: CanonicalAsaasMutationTarget,
  local: ReadIdentity,
  bindings: { id: string }[],
  subscription: Record<string, unknown>,
  customer: Record<string, unknown>,
): boolean {
  if (
    target.resource !== "subscription" ||
    target.subscriptionMatch !== "entity_id" ||
    target.entityId !== target.subscriptionId ||
    local.id !== target.studentId || local.tenant_id !== target.tenantId ||
    local.asaas_customer_id !== target.customerId ||
    local.subscription_id !== target.entityId ||
    bindings.length !== 1 || bindings[0].id !== local.id ||
    text(subscription.id) !== target.entityId ||
    text(subscription.customer) !== target.customerId ||
    text(subscription.externalReference) ||
    text(customer.id) !== target.customerId
  ) return false;

  const providerDocument = document(customer.cpfCnpj);
  const studentDocument = document(local.cpf);
  const guardianDocument = text(local.guardian_name)
    ? document(local.guardian_cpf)
    : "";
  if (text(local.cpf) && !studentDocument) return false;
  if (text(local.guardian_cpf) && !guardianDocument) return false;
  // Documento existente e divergente não pode ser contornado por contato.
  if (studentDocument || guardianDocument) {
    return Boolean(
      providerDocument &&
        [studentDocument, guardianDocument].includes(providerDocument),
    );
  }
  const localEmail = text(local.email).toLowerCase();
  const localPhone = phone(local.phone);
  // Cadastro legado sem documento exige os três sinais independentes, além
  // dos IDs já vinculados e únicos na base inteira, inclusive outras escolas.
  return Boolean(
    localEmail && localPhone && name(local.full_name) &&
      localEmail === text(customer.email).toLowerCase() &&
      name(local.full_name) === name(customer.name) &&
      [phone(customer.mobilePhone), phone(customer.phone)].includes(localPhone),
  );
}

export type SubscriptionReadResult = AsaasMutationGuardResult & {
  identitySnapshot?: Omit<
    ReadIdentity,
    "id" | "tenant_id" | "asaas_customer_id" | "subscription_id"
  >;
};

export async function readSubscriptionForStatusSync(input: {
  admin: SupabaseClient;
  baseUrl: string;
  apiKey: string;
  target: CanonicalAsaasMutationTarget;
  fetcher?: FetchLike;
}): Promise<SubscriptionReadResult> {
  const target = input.target;
  if (
    target.resource !== "subscription" ||
    target.subscriptionMatch !== "entity_id" ||
    target.entityId !== target.subscriptionId || !target.tenantId ||
    !/^[0-9a-f-]{36}$/i.test(target.studentId) ||
    !/^[\w-]{1,240}$/.test(target.entityId) ||
    !/^[\w-]{1,240}$/.test(target.customerId)
  ) {
    return {
      ok: false,
      code: "CANONICAL_BINDING_INVALID",
      providerStatus: null,
    };
  }

  const fetcher = input.fetcher || fetch;
  const get = (path: string) =>
    fetcher(`${input.baseUrl.replace(/\/$/, "")}${path}`, {
      method: "GET",
      headers: { access_token: input.apiKey },
      signal: AbortSignal.timeout(12_000),
    });
  try {
    const response = await get(
      `/subscriptions/${encodeURIComponent(target.entityId)}`,
    );
    if (response.status === 404) {
      return { ok: false, code: "NOT_FOUND", providerStatus: 404 };
    }
    if (!response.ok) {
      return {
        ok: false,
        code: "LOOKUP_FAILED",
        providerStatus: response.status,
      };
    }
    const subscription: unknown = await response.clone().json().catch(() =>
      null
    );
    if (
      !subscription || typeof subscription !== "object" ||
      Array.isArray(subscription)
    ) {
      return { ok: false, code: "IDENTITY_MISMATCH", providerStatus: 200 };
    }
    const entity = subscription as Record<string, unknown>;
    // Referências existentes continuam passando pelo guard canônico original.
    if (text(entity.externalReference)) {
      return await guardAsaasMutationTarget({
        ...input,
        operation: "sync_subscription_status_read",
        fetcher: () => Promise.resolve(response.clone()),
      });
    }
    const { data: local, error: localError } = await input.admin.from(
      "profiles",
    )
      .select(
        "id,tenant_id,asaas_customer_id,subscription_id,cpf,guardian_cpf,guardian_name,full_name,email,phone",
      )
      .eq("id", target.studentId).eq("tenant_id", target.tenantId)
      .eq("role", "STUDENT").maybeSingle();
    const { data: bindings, error: bindingError } = await input.admin.from(
      "profiles",
    )
      .select("id").eq("role", "STUDENT")
      .or(
        `asaas_customer_id.eq.${target.customerId},subscription_id.eq.${target.entityId}`,
      )
      .limit(2);
    if (localError || bindingError || !local || !bindings) {
      return { ok: false, code: "REFERENCE_UNAVAILABLE", providerStatus: 200 };
    }
    const customerResponse = await get(
      `/customers/${encodeURIComponent(target.customerId)}`,
    );
    if (!customerResponse.ok) {
      return {
        ok: false,
        code: "LOOKUP_FAILED",
        providerStatus: customerResponse.status,
      };
    }
    const customer: unknown = await customerResponse.json().catch(() => null);
    if (
      !customer || typeof customer !== "object" || Array.isArray(customer) ||
      !proveLegacySubscriptionRead(
        target,
        local as ReadIdentity,
        bindings,
        entity,
        customer as Record<string, unknown>,
      )
    ) {
      return { ok: false, code: "IDENTITY_MISMATCH", providerStatus: 200 };
    }
    const {
      cpf,
      guardian_cpf,
      guardian_name,
      full_name,
      email,
      phone: localPhone,
    } = local as ReadIdentity;
    return {
      ok: true,
      entity: {
        ...entity,
        status: entity.deleted === true ? "DELETED" : entity.status,
      },
      providerStatus: 200,
      identitySnapshot: {
        cpf,
        guardian_cpf,
        guardian_name,
        full_name,
        email,
        phone: localPhone,
      },
    };
  } catch {
    return { ok: false, code: "LOOKUP_FAILED", providerStatus: null };
  }
}
