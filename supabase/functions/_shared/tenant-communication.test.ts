/// <reference lib="deno.ns" />

import {
  escapePostgresLikePattern,
  loadTenantCentralWhatsAppInstance,
  loadTenantWhatsAppInstance,
  loadTenantWhatsAppRoute,
  resolveOwnedTenantWhatsAppDestination,
  resolveTenantCommunicationIdentity,
  resolveTenantConfiguredWhatsAppDestination,
  safeWhatsAppGroupId,
} from "./tenant-communication.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface QueryCall {
  table: string;
  method: string;
  args: unknown[];
}

class FakeRouteQuery {
  constructor(
    private readonly table: string,
    private readonly calls: QueryCall[],
    private readonly tenantStatus = "active",
    private readonly whatsappEnabled = true,
    private readonly studentNotificationsEnabled = true,
    private readonly teacherNotificationsEnabled = true,
  ) {}

  private record(method: string, args: unknown[]) {
    this.calls.push({ table: this.table, method, args });
    return this;
  }

  select(...args: unknown[]) {
    return this.record("select", args);
  }

  eq(...args: unknown[]) {
    return this.record("eq", args);
  }

  in(...args: unknown[]) {
    return this.record("in", args);
  }

  order(...args: unknown[]) {
    return this.record("order", args);
  }

  limit(...args: unknown[]) {
    return this.record("limit", args);
  }

  maybeSingle() {
    return Promise.resolve(this.result(true));
  }

  then(
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) {
    return Promise.resolve(this.result(false)).then(onFulfilled, onRejected);
  }

  private result(single: boolean) {
    if (this.table === "tenants") {
      return {
        data: single
          ? {
            id: "school-a",
            name: "School A",
            saas_status: this.tenantStatus,
            whatsapp_enabled: this.whatsappEnabled,
          }
          : [],
        error: null,
      };
    }
    if (this.table === "tenant_admin_settings") {
      return {
        data: single
          ? {
            student_notifications_enabled: this.studentNotificationsEnabled,
            teacher_notifications_enabled: this.teacherNotificationsEnabled,
          }
          : [],
        error: null,
      };
    }
    if (this.table === "whatsapp_instances") {
      return {
        data: single
          ? { instance_name: "school-a-central", user_id: "admin-a" }
          : [],
        error: null,
      };
    }
    if (this.table === "tenant_memberships") {
      return {
        data: single ? { user_id: "teacher-a" } : [{ user_id: "admin-a" }],
        error: null,
      };
    }
    if (this.table === "profiles") {
      return {
        data: [{
          id: "admin-a",
          tenant_id: "school-a",
          phone: "(11) 99999-0000",
          hr_group_id: "1203630@g.us",
          teachers_group_id: "1203631@g.us",
          directors_group_id: "1203632@g.us",
        }],
        error: null,
      };
    }
    return { data: null, error: null };
  }
}

Deno.test("tenant communication identity is canonical and server-derived", () => {
  const identity = resolveTenantCommunicationIdentity({
    id: "school-a",
    name: " Escola A * ",
    saas_status: "ACTIVE",
    whatsapp_enabled: true,
    slug: "escola-a",
    branding: {
      logoUrl: "https://cdn.example/logo.png",
      primaryColor: "#123abc",
      secondaryColor: "invalid",
    },
    school_info: {
      legalName: "Escola A Ltda",
      cnpj: "12.345.678/0001-90",
      email: "CONTATO@ESCOLA-A.EXAMPLE",
      phone: "(11) 99999-0000",
    },
  }, "school-a");

  assert(identity?.brandName === "Escola A", "brand name was not sanitized");
  assert(identity?.legalName === "Escola A Ltda", "legal identity was lost");
  assert(identity?.taxId === "12345678000190", "tenant tax identity was lost");
  assert(identity?.primaryColor === "#123ABC", "configured color was lost");
  assert(
    identity?.secondaryColor === "#0F766E",
    "invalid color did not fail safe",
  );
  assert(
    identity?.supportEmail === "contato@escola-a.example",
    "email was not normalized",
  );
  assert(
    identity?.supportPhone === "5511999990000",
    "phone was not normalized",
  );
  assert(
    identity?.portalUrl === "https://escola-a.wisewolflanguage.com.br",
    "tenant portal was not derived",
  );
});

Deno.test("tenant communication fails closed without exact active tenant linkage", () => {
  const activeTenant = {
    id: "school-a",
    name: "Escola A",
    saas_status: "active",
    whatsapp_enabled: true,
  };
  assert(
    resolveTenantCommunicationIdentity(activeTenant, "school-b") === null,
    "cross-tenant identity was accepted",
  );
  assert(
    resolveTenantCommunicationIdentity({
      ...activeTenant,
      saas_status: "past_due",
    }, "school-a") === null,
    "inactive tenant was accepted",
  );
  assert(
    resolveTenantCommunicationIdentity(
      { ...activeTenant, name: "***" },
      "school-a",
    ) === null,
    "empty sanitized brand was accepted",
  );
  const disabledChannelIdentity = resolveTenantCommunicationIdentity(
    { ...activeTenant, whatsapp_enabled: false },
    "school-a",
  );
  assert(
    disabledChannelIdentity?.whatsappEnabled === false,
    "branding identity was hidden when only WhatsApp was disabled",
  );
});

Deno.test("instance lookup escapes LIKE wildcards for case-insensitive exact match", () => {
  assert(
    escapePostgresLikePattern("school_one") === "school\\_one",
    "underscore remained a wildcard",
  );
  assert(
    escapePostgresLikePattern("school%one") === "school\\%one",
    "percent remained a wildcard",
  );
  assert(
    escapePostgresLikePattern("school\\one") === "school\\\\one",
    "escape character was not escaped",
  );
});

Deno.test("WhatsApp group destinations require a canonical group JID", () => {
  assert(
    safeWhatsAppGroupId("120363123456789012@g.us") ===
      "120363123456789012@g.us",
    "valid WhatsApp group JID was rejected",
  );
  for (
    const unsafe of [
      "5511999990000",
      "120363123456789012@s.whatsapp.net",
      "120363123@g.us",
      "120363123456789012@g.us extra",
    ]
  ) {
    assert(
      safeWhatsAppGroupId(unsafe) === null,
      `unsafe group destination was accepted: ${unsafe}`,
    );
  }
});

Deno.test("director destinations must belong to the canonical tenant route", () => {
  const route = {
    instanceName: "school-a-central",
    ownerPhone: "5511999990000",
    hrGroupId: "120363123456789010@g.us",
    teachersGroupId: "120363123456789011@g.us",
    directorsGroupId: "120363123456789012@g.us",
    identity: {
      tenantId: "school-a",
      whatsappEnabled: true,
      brandName: "School A",
      legalName: "School A",
      taxId: null,
      logoUrl: null,
      primaryColor: "#1F2937",
      secondaryColor: "#0F766E",
      supportEmail: null,
      supportPhone: null,
      portalUrl: null,
      talentGroupUrl: null,
    },
  };
  assert(
    resolveOwnedTenantWhatsAppDestination(route, "(11) 99999-0000") ===
      route.ownerPhone,
    "canonical owner phone was rejected",
  );
  assert(
    resolveOwnedTenantWhatsAppDestination(
      route,
      "120363123456789012@g.us",
    ) === route.directorsGroupId,
    "canonical directors group was rejected",
  );
  for (
    const unsafe of [
      "5511888880000",
      route.hrGroupId,
      route.teachersGroupId,
      "120363123456789099@g.us",
    ]
  ) {
    assert(
      resolveOwnedTenantWhatsAppDestination(route, unsafe) === null,
      `non-owned destination was accepted: ${unsafe}`,
    );
  }
});

Deno.test("configured tenant destination is accepted even outside the profile groups", () => {
  // Regressão de 25/08/2026: o grupo que recebe o rateio ("Gestão") não estava
  // em campo nenhum do perfil, porque directors_group_id já tinha outro dono —
  // accept-opportunity manda por ele o aviso de experimental aceita. A trava
  // estrita entrou em 22/08 e recusou os dois primeiros pagamentos que vieram
  // depois dela (25/08, R$ 149,00 e R$ 169,00).
  const route = {
    instanceName: "school-a-central",
    ownerPhone: "5511999990000",
    hrGroupId: null,
    teachersGroupId: "120363123456789011@g.us",
    directorsGroupId: "120363123456789012@g.us",
    identity: {
      tenantId: "school-a",
      whatsappEnabled: true,
      brandName: "School A",
      legalName: "School A",
      taxId: null,
      logoUrl: null,
      primaryColor: "#1F2937",
      secondaryColor: "#0F766E",
      supportEmail: null,
      supportPhone: null,
      portalUrl: null,
      talentGroupUrl: null,
    },
  };

  const grupoGestao = "120363428756333557@g.us";
  assert(
    resolveOwnedTenantWhatsAppDestination(route, grupoGestao) === null,
    "a trava estrita deveria continuar recusando grupo fora do perfil",
  );
  assert(
    resolveTenantConfiguredWhatsAppDestination(route, grupoGestao) ===
      grupoGestao,
    "destino configurado pela própria escola foi recusado",
  );

  // O que a variante NÃO pode fazer é aceitar lixo: continua exigindo JID de
  // grupo ou telefone válido.
  for (const invalido of ["", null, undefined, "nao-e-jid", "javascript:x"]) {
    assert(
      resolveTenantConfiguredWhatsAppDestination(route, invalido) === null,
      `destino inválido foi aceito: ${String(invalido)}`,
    );
  }
});

Deno.test("WhatsApp route is tenant-scoped and prefers a connected recent instance", async () => {
  const calls: QueryCall[] = [];
  const admin = {
    from(table: string) {
      return new FakeRouteQuery(table, calls);
    },
  };

  const route = await loadTenantWhatsAppRoute(admin, "school-a");
  assert(
    route?.instanceName === "school-a-central",
    "central instance was not resolved",
  );
  assert(
    route?.ownerPhone === "5511999990000",
    "active admin contact was not normalized",
  );

  const instanceCalls = calls.filter((call) =>
    call.table === "whatsapp_instances"
  );
  assert(
    instanceCalls.some((call) =>
      call.method === "eq" && call.args[0] === "tenant_id" &&
      call.args[1] === "school-a"
    ),
    "instance lookup was not scoped to the exact tenant",
  );
  assert(
    instanceCalls.some((call) =>
      call.method === "in" && call.args[0] === "status" &&
      JSON.stringify(call.args[1]) === JSON.stringify(["connected", "open"])
    ),
    "instance lookup accepted a disconnected route",
  );
  assert(
    instanceCalls.some((call) =>
      call.method === "in" && call.args[0] === "user_id" &&
      JSON.stringify(call.args[1]) === JSON.stringify(["admin-a"])
    ),
    "institutional route accepted an instance outside active school admins",
  );
  assert(
    instanceCalls.some((call) =>
      call.method === "order" && call.args[0] === "updated_at" &&
      (call.args[1] as { ascending?: boolean })?.ascending === false
    ),
    "instance lookup did not prefer the most recent route",
  );
  assert(
    calls.some((call) =>
      call.table === "tenant_memberships" && call.method === "eq" &&
      call.args[0] === "status" && call.args[1] === "ACTIVE"
    ),
    "owner contact was not restricted to an active membership",
  );
  assert(
    calls.some((call) =>
      call.table === "profiles" && call.method === "in" &&
      call.args[0] === "id" &&
      JSON.stringify(call.args[1]) === JSON.stringify(["admin-a"])
    ),
    "owner profile lookup did not use active membership IDs",
  );
  assert(
    calls.every((call) =>
      call.table !== "profiles" || call.method !== "select" ||
      !String(call.args[0] || "").includes("whatsapp_instance")
    ),
    "owner profile lookup read the legacy WhatsApp instance",
  );
});

Deno.test("receipt-capable route filters before choosing the newest admin instance", async () => {
  const calls: QueryCall[] = [];
  const admin = {
    from(table: string) {
      return new FakeRouteQuery(table, calls);
    },
  };

  const route = await loadTenantWhatsAppRoute(
    admin,
    "school-a",
    "general",
    { requireDeliveryReceipts: true },
  );
  assert(route?.instanceName === "school-a-central", "route was not resolved");
  const instanceCalls = calls.filter((call) =>
    call.table === "whatsapp_instances"
  );
  assert(
    instanceCalls.some((call) =>
      call.method === "eq" && call.args[0] === "inbox_enabled" &&
      call.args[1] === true
    ),
    "newer instance without an inbox could win route selection",
  );
  assert(
    instanceCalls.some((call) =>
      call.method === "eq" && call.args[0] === "webhook_auth_version" &&
      call.args[1] === 3
    ),
    "instance without authenticated v3 receipts could win route selection",
  );
  const receiptFilter = instanceCalls.findIndex((call) =>
    call.method === "eq" && call.args[0] === "webhook_auth_version"
  );
  const newestOrder = instanceCalls.findIndex((call) =>
    call.method === "order" && call.args[0] === "updated_at"
  );
  assert(
    receiptFilter >= 0 && receiptFilter < newestOrder,
    "route ordered all instances before excluding receipt-ineligible ones",
  );
});

Deno.test("personal WhatsApp route requires an exact user inside the tenant", async () => {
  const calls: QueryCall[] = [];
  const admin = {
    from(table: string) {
      return new FakeRouteQuery(table, calls);
    },
  };

  const instance = await loadTenantWhatsAppInstance(
    admin,
    "school-a",
    "teacher-a",
  );
  assert(instance === "school-a-central", "personal instance was not resolved");
  assert(
    calls.some((call) =>
      call.table === "whatsapp_instances" && call.method === "eq" &&
      call.args[0] === "tenant_id" && call.args[1] === "school-a"
    ),
    "personal instance lookup omitted the tenant boundary",
  );
  assert(
    calls.some((call) =>
      call.table === "whatsapp_instances" && call.method === "eq" &&
      call.args[0] === "user_id" && call.args[1] === "teacher-a"
    ),
    "personal instance lookup omitted the exact owner",
  );
  assert(
    calls.some((call) =>
      call.table === "tenant_memberships" && call.method === "eq" &&
      call.args[0] === "user_id" && call.args[1] === "teacher-a"
    ),
    "personal instance lookup omitted active membership validation",
  );
  assert(
    await loadTenantWhatsAppInstance(admin, "school-a", null) === null,
    "personal instance lookup accepted an empty owner",
  );
});

Deno.test("WhatsApp loaders fail closed for a non-operational tenant", async () => {
  for (const tenantStatus of ["blocked", "past_due"]) {
    const calls: QueryCall[] = [];
    const admin = {
      from(table: string) {
        return new FakeRouteQuery(table, calls, tenantStatus);
      },
    };

    assert(
      await loadTenantWhatsAppInstance(admin, "school-a", "teacher-a") === null,
      `personal route accepted tenant status ${tenantStatus}`,
    );
    assert(
      await loadTenantCentralWhatsAppInstance(admin, "school-a") === null,
      `central instance accepted tenant status ${tenantStatus}`,
    );
    assert(
      await loadTenantWhatsAppRoute(admin, "school-a") === null,
      `institutional route accepted tenant status ${tenantStatus}`,
    );
    assert(
      calls.every((call) => call.table !== "whatsapp_instances"),
      `tenant status ${tenantStatus} reached the WhatsApp instance table`,
    );
  }
});

Deno.test("WhatsApp loaders fail closed when the tenant channel is disabled", async () => {
  const calls: QueryCall[] = [];
  const admin = {
    from(table: string) {
      return new FakeRouteQuery(table, calls, "active", false);
    },
  };

  assert(
    await loadTenantWhatsAppInstance(admin, "school-a", "teacher-a") === null,
    "personal route ignored the tenant WhatsApp switch",
  );
  assert(
    await loadTenantCentralWhatsAppInstance(admin, "school-a") === null,
    "central route ignored the tenant WhatsApp switch",
  );
  assert(
    await loadTenantWhatsAppRoute(admin, "school-a") === null,
    "institutional route ignored the tenant WhatsApp switch",
  );
  assert(
    calls.every((call) => call.table !== "whatsapp_instances"),
    "disabled tenant reached the WhatsApp instance table",
  );
});

Deno.test("audience switches suppress student and teacher notifications independently", async () => {
  const studentCalls: QueryCall[] = [];
  const studentAdmin = {
    from(table: string) {
      return new FakeRouteQuery(
        table,
        studentCalls,
        "active",
        true,
        false,
        true,
      );
    },
  };
  assert(
    await loadTenantCentralWhatsAppInstance(
      studentAdmin,
      "school-a",
      "student",
    ) === null,
    "student route ignored the student notification switch",
  );
  assert(
    studentCalls.every((call) => call.table !== "whatsapp_instances"),
    "disabled student audience reached the instance table",
  );

  const teacherCalls: QueryCall[] = [];
  const teacherAdmin = {
    from(table: string) {
      return new FakeRouteQuery(
        table,
        teacherCalls,
        "active",
        true,
        true,
        false,
      );
    },
  };
  assert(
    await loadTenantWhatsAppRoute(teacherAdmin, "school-a", "teacher") === null,
    "teacher route ignored the teacher notification switch",
  );
  assert(
    teacherCalls.every((call) => call.table !== "whatsapp_instances"),
    "disabled teacher audience reached the instance table",
  );

  assert(
    await loadTenantWhatsAppRoute(studentAdmin, "school-a", "teacher") !== null,
    "enabled teacher audience was suppressed",
  );
});
