export interface VendorTrialLookup {
  token: string | null;
  legacyOpportunityId: string | null;
}

type UnknownRecord = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{20,512}$/;

export function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseVendorTrialLookup(value: string): VendorTrialLookup {
  const url = new URL(value);
  const token = url.searchParams.get("token")?.trim() || null;
  const legacyOpportunityId = url.searchParams.get("legacy")?.trim() || null;
  if (!token || legacyOpportunityId) {
    throw new Error("INVALID_LOOKUP");
  }
  if (token && !TOKEN_PATTERN.test(token)) throw new Error("INVALID_LOOKUP");
  return { token, legacyOpportunityId: null };
}

export function vendorTrialErrorStatus(error: unknown): number {
  switch (error) {
    case "invalid_lookup":
    case "link_not_found":
      return 404;
    case "link_expired":
      return 410;
    case "teacher_schedule_conflict":
    case "teacher_not_active_for_tenant":
    case "link_unavailable":
    case "link_inconsistent":
    case "vendor_tenant_mismatch":
    case "student_tenant_mismatch":
      return 409;
    case "tenant_not_operational":
      return 403;
    default:
      return 500;
  }
}

export function vendorTrialErrorMessage(error: unknown): string {
  switch (error) {
    case "invalid_lookup":
    case "link_not_found":
    case "link_inconsistent":
      return "Link inválido ou expirado.";
    case "link_expired":
      return "O horário deste link expirou. Solicite outro à escola.";
    case "teacher_schedule_conflict":
      return "Esse horário acabou de ficar indisponível.";
    case "teacher_not_active_for_tenant":
      return "O professor não está disponível nesta escola.";
    case "vendor_tenant_mismatch":
    case "student_tenant_mismatch":
      return "Os vínculos deste link precisam ser revisados pela escola.";
    case "link_unavailable":
      return "Este link está indisponível no momento.";
    case "tenant_not_operational":
      return "A escola não está disponível para novas confirmações.";
    default:
      return "Não foi possível validar este horário agora.";
  }
}

export function shouldNotifyTeacher(result: UnknownRecord): boolean {
  return result.ok === true && result.newlyRequested === true &&
    result.state === "AWAITING_TEACHER";
}

export function buildTeacherClaimUrl(
  originValue: unknown,
  opportunityId: unknown,
  claimGeneration: unknown,
): string | null {
  if (
    typeof originValue !== "string" ||
    typeof opportunityId !== "string" ||
    !UUID_PATTERN.test(opportunityId) ||
    !Number.isInteger(claimGeneration) || Number(claimGeneration) < 1
  ) {
    return null;
  }
  try {
    const origin = new URL(originValue.trim());
    const localDevelopment = origin.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(origin.hostname);
    if (
      (origin.protocol !== "https:" && !localDevelopment) ||
      origin.username || origin.password
    ) return null;
    origin.pathname = "/claim-opportunity";
    origin.search = "";
    origin.hash = "";
    origin.searchParams.set("id", opportunityId);
    origin.searchParams.set("g", String(claimGeneration));
    return origin.toString();
  } catch {
    return null;
  }
}
