const operationalTenantStatuses = new Set(["active", "trial", "trialing"]);

type UnknownRecord = Record<string, unknown>;

export interface TenantCommunicationIdentity {
  tenantId: string;
  whatsappEnabled: boolean;
  brandName: string;
  legalName: string;
  taxId: string | null;
  logoUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  supportEmail: string | null;
  supportPhone: string | null;
  portalUrl: string | null;
  talentGroupUrl: string | null;
}

export type TenantCommunicationAudience = "general" | "student" | "teacher";

export interface TenantWhatsAppRouteOptions {
  /** Require the v3 inbound webhook needed to correlate provider receipts. */
  requireDeliveryReceipts?: boolean;
}

export interface TenantWhatsAppRoute {
  instanceName: string;
  ownerPhone: string | null;
  hrGroupId: string | null;
  teachersGroupId: string | null;
  directorsGroupId: string | null;
  identity: TenantCommunicationIdentity;
}

export interface TenantCentralWhatsAppContext {
  instanceName: string;
  identity: TenantCommunicationIdentity;
  ownerUserId: string;
  adminUserIds: string[];
}

export function resolveOwnedTenantWhatsAppDestination(
  route: TenantWhatsAppRoute,
  requestedDestination: unknown,
): string | null {
  const normalized = safeWhatsAppGroupId(requestedDestination) ||
    safePhone(requestedDestination);
  if (!normalized) return null;
  const allowed = new Set(
    [route.directorsGroupId, route.ownerPhone].filter(
      (value): value is string => Boolean(value),
    ),
  );
  return allowed.has(normalized) ? normalized : null;
}

/**
 * Destino que veio da CONFIGURAÇÃO DA PRÓPRIA ESCOLA — não de entrada de
 * requisição.
 *
 * Use esta variante quando o valor sai de uma linha escopada por `tenant_id`
 * que só o admin daquela escola grava (hoje: `dre_report_settings.destino`, via
 * a tela do diretor). Nesse caminho a posse já está estabelecida por
 * construção: o `tenant_id` é resolvido no servidor e a busca é chaveada por
 * ele, então não existe caminho para alcançar o grupo de outra escola.
 *
 * ⚠️ Por que ela precisou existir (medido em 25/08/2026): a trava estrita acima
 * só aceita `directors_group_id` e o telefone do dono. Mas esse campo já tinha
 * OUTRO uso — `accept-opportunity` manda por ele o aviso de experimental
 * aceita, e na Wise Wolf ele aponta para o grupo "EXPERIMENTAL CONFIRMADAS".
 * O grupo que recebe dinheiro é o "Gestão", que não estava registrado em campo
 * nenhum do perfil. Um campo com dois donos: a trava entrou em 22/08 (4e19c07)
 * e os DOIS primeiros pagamentos depois dela — 25/08, R$ 149,00 e R$ 169,00 —
 * foram recusados com "destino não pertence à escola". Até 21/08 os avisos
 * saíam normalmente.
 *
 * ⚠️ Ao medir silêncio de automação, NÃO use `max(automation_sent.ref_date)`:
 * `ref_date` é o `created_at` do PAGAMENTO, não a data do envio. Foi
 * exatamente essa leitura que produziu, no diagnóstico original, um "silêncio de
 * 9 dias e 8 pagamentos" que não existiu. Quem responde "quando saiu o último
 * aviso" é `automation_sent.created_at`.
 *
 * ⚠️ NÃO use esta função para destino vindo do corpo de uma requisição. Para
 * esse caso a trava estrita continua sendo a certa — é ela que impede um
 * diretor de disparar no grupo de outra escola.
 */
export function resolveTenantConfiguredWhatsAppDestination(
  route: TenantWhatsAppRoute,
  configuredDestination: unknown,
): string | null {
  const normalized = safeWhatsAppGroupId(configuredDestination) ||
    safePhone(configuredDestination);
  if (!normalized) return null;
  const allowed = new Set(
    [route.directorsGroupId, route.ownerPhone, normalized].filter(
      (value): value is string => Boolean(value),
    ),
  );
  return allowed.has(normalized) ? normalized : null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function safeCommunicationText(
  value: unknown,
  maximumLength = 120,
): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f<>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength);
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function safePhone(value: unknown): string | null {
  const phone = typeof value === "string" ? value.replace(/\D/g, "") : "";
  if (phone.length === 10 || phone.length === 11) return `55${phone}`;
  return phone.length >= 12 && phone.length <= 15 ? phone : null;
}

export function safeWhatsAppGroupId(value: unknown): string | null {
  const groupId = typeof value === "string" ? value.trim() : "";
  return /^\d{10,25}@g\.us$/.test(groupId) ? groupId : null;
}

function safeTaxId(value: unknown): string | null {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length === 14 ? digits : null;
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value.trim())
    ? value.trim().toUpperCase()
    : fallback;
}

function hostnameUrl(value: unknown): string | null {
  const hostname = typeof value === "string"
    ? value.trim().toLowerCase().replace(/\.$/, "")
    : "";
  if (
    !hostname || hostname.includes(":") || hostname.includes("/") ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)
  ) return null;
  return `https://${hostname}`;
}

export function resolveTenantCommunicationIdentity(
  tenant: UnknownRecord,
  expectedTenantId: string,
): TenantCommunicationIdentity | null {
  const tenantId = safeCommunicationText(tenant.id, 100);
  const status = typeof tenant.saas_status === "string"
    ? tenant.saas_status.trim().toLowerCase()
    : "";
  const brandName = safeCommunicationText(tenant.name, 120);
  if (
    !tenantId || tenantId !== expectedTenantId || !brandName ||
    !operationalTenantStatuses.has(status)
  ) return null;

  const branding = isRecord(tenant.branding) ? tenant.branding : {};
  const schoolInfo = isRecord(tenant.school_info) ? tenant.school_info : {};
  const customDomain = tenant.custom_domain_verified === true
    ? hostnameUrl(tenant.custom_domain)
    : null;
  const tenantDomain = hostnameUrl(tenant.domain);
  const normalizedSlug = typeof tenant.slug === "string"
    ? tenant.slug.trim().toLowerCase()
    : "";
  const slug = (normalizedSlug === "wisewolf" || normalizedSlug === "system" || tenantId === "school-wise-wolf")
    ? "https://system.wisewolflanguage.com.br"
    : (normalizedSlug && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/.test(normalizedSlug)
      ? `https://${normalizedSlug}.wisewolflanguage.com.br`
      : null);
  const fallbackPortal = tenantId === "school-wise-wolf"
    ? "https://system.wisewolflanguage.com.br"
    : null;

  return {
    tenantId,
    whatsappEnabled: tenant.whatsapp_enabled === true,
    brandName,
    legalName: safeCommunicationText(schoolInfo.legalName, 160) || brandName,
    taxId: safeTaxId(schoolInfo.cnpj),
    logoUrl: safeHttpsUrl(branding.logoUrl),
    primaryColor: safeColor(branding.primaryColor, "#1F2937"),
    secondaryColor: safeColor(branding.secondaryColor, "#0F766E"),
    supportEmail: safeEmail(schoolInfo.email),
    supportPhone: safePhone(schoolInfo.phone),
    portalUrl: customDomain || tenantDomain || slug || fallbackPortal,
    talentGroupUrl: safeHttpsUrl(tenant.talent_group_link),
  };
}

export async function loadTenantCommunicationIdentity(
  admin: any,
  tenantId: string,
): Promise<TenantCommunicationIdentity | null> {
  const normalizedTenantId = safeCommunicationText(tenantId, 100);
  if (!normalizedTenantId) return null;
  const { data, error } = await admin.from("tenants").select(
    "id,name,domain,slug,custom_domain,custom_domain_verified,branding,school_info,saas_status,talent_group_link,whatsapp_enabled",
  ).eq("id", normalizedTenantId).maybeSingle();
  if (error) throw new Error("tenant_communication_lookup_failed");
  return data
    ? resolveTenantCommunicationIdentity(
      data as UnknownRecord,
      normalizedTenantId,
    )
    : null;
}

async function loadTenantWhatsAppIdentity(
  admin: any,
  tenantId: string,
  audience: TenantCommunicationAudience,
): Promise<TenantCommunicationIdentity | null> {
  const identity = await loadTenantCommunicationIdentity(admin, tenantId);
  if (!identity?.whatsappEnabled) return null;
  if (audience === "general") return identity;

  const { data: settings, error: settingsError } = await admin
    .from("tenant_admin_settings")
    .select("student_notifications_enabled,teacher_notifications_enabled")
    .eq("tenant_id", identity.tenantId)
    .maybeSingle();
  if (settingsError) {
    throw new Error("tenant_notification_settings_lookup_failed");
  }
  const enabled = audience === "student"
    ? settings?.student_notifications_enabled === true
    : settings?.teacher_notifications_enabled === true;
  return enabled ? identity : null;
}

export async function loadTenantWhatsAppInstance(
  admin: any,
  tenantId: string,
  userId: string | null,
  audience: TenantCommunicationAudience = "general",
): Promise<string | null> {
  const normalizedTenantId = safeCommunicationText(tenantId, 100);
  const normalizedUserId = safeCommunicationText(userId, 100);
  if (!normalizedTenantId || !normalizedUserId) return null;
  if (!await loadTenantWhatsAppIdentity(admin, normalizedTenantId, audience)) {
    return null;
  }

  const { data: membership, error: membershipError } = await admin
    .from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", normalizedTenantId)
    .eq("user_id", normalizedUserId)
    .eq("status", "ACTIVE")
    .limit(1)
    .maybeSingle();
  if (membershipError) throw new Error("tenant_membership_lookup_failed");
  if (String(membership?.user_id || "") !== normalizedUserId) return null;

  const { data: instance, error: instanceError } = await admin
    .from("whatsapp_instances")
    .select("instance_name")
    .eq("tenant_id", normalizedTenantId)
    .eq("user_id", normalizedUserId)
    .in("status", ["connected", "open"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (instanceError) throw new Error("tenant_whatsapp_route_lookup_failed");
  return safeCommunicationText(instance?.instance_name, 120) || null;
}

async function loadActiveTenantAdminUserIds(
  admin: any,
  tenantId: string,
): Promise<string[]> {
  const { data: memberships, error: membershipError } = await admin
    .from("tenant_memberships")
    .select("user_id")
    .eq("tenant_id", tenantId)
    .eq("role", "SCHOOL_ADMIN")
    .eq("status", "ACTIVE")
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(10);
  if (membershipError) throw new Error("tenant_admin_route_lookup_failed");
  const rows = Array.isArray(memberships) ? memberships as UnknownRecord[] : [];
  return [
    ...new Set<string>(
      rows.map((row) => String(row.user_id || ""))
        .filter(Boolean),
    ),
  ];
}

async function loadTenantAdminWhatsAppInstance(
  admin: any,
  tenantId: string,
  adminUserIds: string[],
  options: TenantWhatsAppRouteOptions = {},
): Promise<{ instanceName: string; ownerUserId: string } | null> {
  if (!adminUserIds.length) return null;
  let query = admin
    .from("whatsapp_instances")
    .select("instance_name,user_id")
    .eq("tenant_id", tenantId)
    .in("user_id", adminUserIds)
    .in("status", ["connected", "open"]);
  if (options.requireDeliveryReceipts === true) {
    query = query
      .eq("inbox_enabled", true)
      .eq("webhook_auth_version", 3);
  }
  const { data: instance, error: instanceError } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (instanceError) throw new Error("tenant_whatsapp_route_lookup_failed");
  const instanceName = safeCommunicationText(instance?.instance_name, 120);
  const ownerUserId = safeCommunicationText(instance?.user_id, 100);
  return instanceName && adminUserIds.includes(ownerUserId)
    ? { instanceName, ownerUserId }
    : null;
}

export async function loadTenantCentralWhatsAppInstance(
  admin: any,
  tenantId: string,
  audience: TenantCommunicationAudience = "general",
): Promise<string | null> {
  const context = await loadTenantCentralWhatsAppContext(
    admin,
    tenantId,
    audience,
  );
  return context?.instanceName || null;
}

export async function loadTenantCentralWhatsAppContext(
  admin: any,
  tenantId: string,
  audience: TenantCommunicationAudience = "general",
  options: TenantWhatsAppRouteOptions = {},
): Promise<TenantCentralWhatsAppContext | null> {
  const normalizedTenantId = safeCommunicationText(tenantId, 100);
  if (!normalizedTenantId) return null;
  const identity = await loadTenantWhatsAppIdentity(
    admin,
    normalizedTenantId,
    audience,
  );
  if (!identity) return null;
  const adminUserIds = await loadActiveTenantAdminUserIds(
    admin,
    normalizedTenantId,
  );
  const route = await loadTenantAdminWhatsAppInstance(
    admin,
    normalizedTenantId,
    adminUserIds,
    options,
  );
  return route
    ? {
      instanceName: route.instanceName,
      identity,
      ownerUserId: route.ownerUserId,
      adminUserIds,
    }
    : null;
}

export async function loadTenantWhatsAppRoute(
  admin: any,
  tenantId: string,
  audience: TenantCommunicationAudience = "general",
  options: TenantWhatsAppRouteOptions = {},
): Promise<TenantWhatsAppRoute | null> {
  const normalizedTenantId = safeCommunicationText(tenantId, 100);
  if (!normalizedTenantId) return null;
  const central = await loadTenantCentralWhatsAppContext(
    admin,
    normalizedTenantId,
    audience,
    options,
  );
  if (!central) return null;
  const instanceRoute = {
    instanceName: central.instanceName,
    ownerUserId: central.ownerUserId,
  };
  const userIds = central.adminUserIds;
  const profileUserIds = [
    instanceRoute.ownerUserId,
    ...userIds.filter((userId) => userId !== instanceRoute.ownerUserId),
  ];
  let profiles: UnknownRecord[] = [];
  if (profileUserIds.length) {
    const { data, error } = await admin.from("profiles")
      .select("id,phone,hr_group_id,teachers_group_id,directors_group_id")
      .in("id", profileUserIds);
    if (error) throw new Error("tenant_admin_contact_lookup_failed");
    profiles = (data || []) as UnknownRecord[];
  }
  const orderedProfiles = profileUserIds.map((userId) =>
    profiles.find((profile) => profile.id === userId)
  ).filter((profile): profile is UnknownRecord => Boolean(profile));
  const firstValue = (field: string): string | null => {
    for (const profile of orderedProfiles) {
      const value = safeCommunicationText(profile[field], 160);
      if (value) return value;
    }
    return null;
  };

  return {
    instanceName: instanceRoute.instanceName,
    ownerPhone: safePhone(firstValue("phone")),
    hrGroupId: safeWhatsAppGroupId(firstValue("hr_group_id")),
    teachersGroupId: safeWhatsAppGroupId(firstValue("teachers_group_id")),
    directorsGroupId: safeWhatsAppGroupId(firstValue("directors_group_id")),
    identity: central.identity,
  };
}

export function escapePostgresLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
