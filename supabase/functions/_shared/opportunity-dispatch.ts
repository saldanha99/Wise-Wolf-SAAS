export type OpportunityDispatchMode = "GENERIC" | "TARGETED" | "NONE";

export interface OpportunityDispatchGuard {
  ok: boolean;
  dispatchMode: OpportunityDispatchMode;
  state: string | null;
  targetTeacherId: string | null;
}

export type OpportunityReuseDecision =
  | "BLOCK_DIRECTED"
  | "REUSE_GENERIC"
  | "SKIP_GENERIC"
  | "UNAVAILABLE";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseOpportunityDispatchGuard(
  value: unknown,
): OpportunityDispatchGuard {
  if (!isRecord(value) || value.ok !== true) {
    return {
      ok: false,
      dispatchMode: "NONE",
      state: null,
      targetTeacherId: null,
    };
  }
  const dispatchMode = value.dispatchMode;
  if (
    dispatchMode !== "GENERIC" && dispatchMode !== "TARGETED" &&
    dispatchMode !== "NONE"
  ) {
    return {
      ok: false,
      dispatchMode: "NONE",
      state: null,
      targetTeacherId: null,
    };
  }
  const targetTeacherId = typeof value.targetTeacherId === "string" &&
      UUID_PATTERN.test(value.targetTeacherId)
    ? value.targetTeacherId
    : null;
  if (dispatchMode === "TARGETED" && !targetTeacherId) {
    return {
      ok: false,
      dispatchMode: "NONE",
      state: null,
      targetTeacherId: null,
    };
  }
  return {
    ok: true,
    dispatchMode,
    state: typeof value.state === "string" ? value.state : null,
    targetTeacherId,
  };
}

export function evaluateOpportunityReuseCandidate(
  slotsProposed: unknown,
  guard: OpportunityDispatchGuard,
  requestedDate: string,
  requestedTime: string,
): OpportunityReuseDecision {
  if (!guard.ok) return "UNAVAILABLE";
  if (guard.dispatchMode !== "GENERIC") return "BLOCK_DIRECTED";
  const slot = Array.isArray(slotsProposed) ? slotsProposed[0] : null;
  if (!isRecord(slot)) return "SKIP_GENERIC";
  return slot.date === requestedDate && slot.time === requestedTime
    ? "REUSE_GENERIC"
    : "SKIP_GENERIC";
}

export async function loadOpportunityDispatchGuard(
  admin: any,
  tenantId: string,
  opportunityId: string,
): Promise<OpportunityDispatchGuard> {
  if (!tenantId.trim() || !UUID_PATTERN.test(opportunityId)) {
    return {
      ok: false,
      dispatchMode: "NONE",
      state: null,
      targetTeacherId: null,
    };
  }
  const { data, error } = await admin.rpc(
    "get_opportunity_teacher_dispatch_secure",
    { p_tenant_id: tenantId, p_opportunity_id: opportunityId },
  );
  if (error) {
    return {
      ok: false,
      dispatchMode: "NONE",
      state: null,
      targetTeacherId: null,
    };
  }
  return parseOpportunityDispatchGuard(data);
}
