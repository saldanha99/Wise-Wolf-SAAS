export const TERMINAL_COMMERCIAL_STATUSES = new Set([
  "CONVERTED",
  "WON",
  "ENROLLED",
  "MATRICULADO",
  "MATRICULADA",
  "CONTRACTED",
  "ACTIVE_STUDENT",
]);

export type CommercialSuppressionReason =
  | "terminal_lead_status"
  | "contract_accepted"
  | "active_contract"
  | "opportunity_converted"
  | "enrollment_in_progress"
  | "enrollment_completed";

export interface CommercialIdentity {
  tenantId: string;
  phone?: string | null;
  email?: string | null;
  leadStatus?: string | null;
  opportunityId?: string | null;
}

export interface ContractedStudentFact {
  id: string;
  phone?: string | null;
  email?: string | null;
  contract_accepted?: boolean | null;
}

export interface StudentContractFact {
  student_id: string;
  status?: string | null;
}

export interface OpportunityFact {
  id: string;
  student_phone?: string | null;
  conversion_status?: string | null;
  student_id?: string | null;
}

export interface EnrollmentLinkFact {
  id: string;
  opportunity_id?: string | null;
  student_phone?: string | null;
  status?: string | null;
}

export interface CommercialContactFacts {
  students: ContractedStudentFact[];
  contracts: StudentContractFact[];
  opportunities: OpportunityFact[];
  enrollmentLinks: EnrollmentLinkFact[];
}

export interface CommercialSuppression {
  suppressed: boolean;
  reason: CommercialSuppressionReason | null;
  studentId: string | null;
}

const allowedContractStatuses = new Set(["ACTIVE", "PAUSED"]);

export function cleanCommercialEmail(value: string | null | undefined): string {
  return String(value || "").trim().toLowerCase();
}

export function cleanCommercialPhone(value: string | null | undefined): string {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits;
}

// Compara celulares brasileiros tolerando DDI e o nono dígito, mas preserva o DDD.
export function commercialPhonesMatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = cleanCommercialPhone(left);
  const b = cleanCommercialPhone(right);
  if (a.length < 10 || b.length < 10 || a.slice(-8) !== b.slice(-8)) return false;
  const areaA = a.slice(0, -8).replace(/^55/, "").replace(/9$/, "").slice(-2);
  const areaB = b.slice(0, -8).replace(/^55/, "").replace(/9$/, "").slice(-2);
  return Boolean(areaA && areaB && areaA === areaB);
}

function identityMatches(
  identity: CommercialIdentity,
  row: { phone?: string | null; email?: string | null },
): boolean {
  const email = cleanCommercialEmail(identity.email);
  const rowEmail = cleanCommercialEmail(row.email);
  return commercialPhonesMatch(identity.phone, row.phone) ||
    Boolean(email && rowEmail && email === rowEmail);
}

export function evaluateCommercialSuppression(
  identity: CommercialIdentity,
  facts: CommercialContactFacts,
): CommercialSuppression {
  const leadStatus = String(identity.leadStatus || "").trim().toUpperCase();
  if (TERMINAL_COMMERCIAL_STATUSES.has(leadStatus)) {
    return { suppressed: true, reason: "terminal_lead_status", studentId: null };
  }

  const matchedStudent = facts.students.find((student) =>
    identityMatches(identity, student)
  );
  if (matchedStudent?.contract_accepted === true) {
    return {
      suppressed: true,
      reason: "contract_accepted",
      studentId: matchedStudent.id,
    };
  }

  const activeStudentIds = new Set(
    facts.contracts
      .filter((contract) =>
        allowedContractStatuses.has(String(contract.status || "").toUpperCase())
      )
      .map((contract) => contract.student_id),
  );
  if (matchedStudent && activeStudentIds.has(matchedStudent.id)) {
    return {
      suppressed: true,
      reason: "active_contract",
      studentId: matchedStudent.id,
    };
  }

  const convertedOpportunity = facts.opportunities.find((opportunity) => {
    const isConverted = String(opportunity.conversion_status || "").toUpperCase() === "WON" ||
      Boolean(opportunity.student_id);
    if (!isConverted) return false;
    return opportunity.id === identity.opportunityId ||
      commercialPhonesMatch(identity.phone, opportunity.student_phone);
  });
  if (convertedOpportunity) {
    return {
      suppressed: true,
      reason: "opportunity_converted",
      studentId: convertedOpportunity.student_id || null,
    };
  }

  const terminalLink = facts.enrollmentLinks.find((link) => {
    const status = String(link.status || "").toUpperCase();
    if (!["PROCESSING", "USED"].includes(status)) return false;
    return link.opportunity_id === identity.opportunityId ||
      commercialPhonesMatch(identity.phone, link.student_phone);
  });
  if (terminalLink) {
    return {
      suppressed: true,
      reason: String(terminalLink.status).toUpperCase() === "USED"
        ? "enrollment_completed"
        : "enrollment_in_progress",
      studentId: null,
    };
  }

  return { suppressed: false, reason: null, studentId: null };
}

export async function loadCommercialContactFacts(
  sb: any,
  tenantId: string,
): Promise<CommercialContactFacts> {
  const [studentsRes, contractsRes, opportunitiesRes, linksRes] = await Promise.all([
    sb.from("profiles")
      .select("id, phone, email, contract_accepted")
      .eq("tenant_id", tenantId)
      .in("role", ["STUDENT", "student"]),
    sb.from("student_contracts")
      .select("student_id, status")
      .eq("tenant_id", tenantId)
      .in("status", ["ACTIVE", "PAUSED"]),
    sb.from("opportunities")
      .select("id, student_phone, conversion_status, student_id")
      .eq("tenant_id", tenantId)
      .or("conversion_status.eq.WON,student_id.not.is.null"),
    sb.from("enrollment_links")
      .select("id, opportunity_id, student_phone, status")
      .eq("tenant_id", tenantId)
      .in("status", ["PROCESSING", "USED"]),
  ]);

  // Falhar fechado é perigoso aqui: um erro de leitura não pode liberar venda indevida.
  const failures = [studentsRes, contractsRes, opportunitiesRes, linksRes]
    .map((result) => result.error)
    .filter(Boolean);
  if (failures.length) {
    throw new Error(`commercial_state_unavailable:${failures[0]?.code || "query"}`);
  }

  return {
    students: studentsRes.data || [],
    contracts: contractsRes.data || [],
    opportunities: opportunitiesRes.data || [],
    enrollmentLinks: linksRes.data || [],
  };
}

export async function reconcileSuppressedLead(
  sb: any,
  leadId: string,
  suppression: CommercialSuppression,
): Promise<void> {
  if (!suppression.suppressed) return;
  await sb.from("crm_leads").update({
    status: "WON",
    ai_handoff: true,
    ...(suppression.studentId ? { student_id: suppression.studentId } : {}),
    last_status_change: new Date().toISOString(),
  }).eq("id", leadId);
}
