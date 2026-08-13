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
  | "enrollment_completed"
  | "nome_e_ddd_de_aluno"
  | "aluno_em_atividade";

export interface CommercialIdentity {
  tenantId: string;
  phone?: string | null;
  email?: string | null;
  /** Nome como está no CRM. Usado só para a trava de sósia (ver abaixo). */
  name?: string | null;
  leadStatus?: string | null;
  opportunityId?: string | null;
}

export interface ContractedStudentFact {
  id: string;
  phone?: string | null;
  email?: string | null;
  full_name?: string | null;
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
  /**
   * Ids de aluno com AULA na agenda ou PAGAMENTO recebido.
   *
   * Auditoria de 13/08/2026: **8 alunos ativos e pagantes** estavam com
   * `contract_accepted = false` (matrícula antiga, feita na mão). A trava
   * comercial só olhava a flag de contrato e a tabela `student_contracts`, que
   * está VAZIA — ou seja, para o robô eles não eram alunos. Nenhum estava no
   * CRM na hora da auditoria, então nada foi enviado; era sorte, não desenho.
   *
   * Quem tem aula marcada ou pagou é aluno, com papelada em dia ou não.
   */
  studentsWithActivity?: string[];
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

/** Minúsculas, sem acento e sem espaço sobrando. */
export function normalizarNome(valor: string | null | undefined): string {
  return String(valor || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

/** Distância de edição (Levenshtein), suficiente para "Valani" x "Vilani". */
export function distanciaNome(a: string, b: string): number {
  const s1 = normalizarNome(a), s2 = normalizarNome(b);
  if (s1 === s2) return 0;
  if (!s1 || !s2) return Math.max(s1.length, s2.length);
  const linha = Array.from({ length: s2.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s1.length; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= s2.length; j++) {
      const tmp = linha[j];
      linha[j] = Math.min(
        linha[j] + 1,
        linha[j - 1] + 1,
        anterior + (s1[i - 1] === s2[j - 1] ? 0 : 1),
      );
      anterior = tmp;
    }
  }
  return linha[s2.length];
}

/** DDD do número, ou "" quando não dá para saber. */
export function dddDe(valor: string | null | undefined): string {
  const d = cleanCommercialPhone(valor);
  if (d.length < 10) return "";
  return d.slice(0, -8).replace(/^55/, "").replace(/9$/, "").slice(-2);
}

/**
 * TRAVA DE SÓSIA — o mesmo humano cadastrado duas vezes com telefones diferentes.
 *
 * Aconteceu em 13/08/2026: a aluna **Penha Vilani** (matriculada, contrato
 * aceito) recebeu "ainda tem interesse na aula experimental?". O CRM tinha
 * "Penha Valani" com um telefone que difere do cadastro dela em UM dígito
 * (27 99924792 x 27 999247902). Para o casamento por telefone eram dois
 * estranhos; para quem recebeu, foi a escola perguntando se ela quer conhecer
 * a escola em que estuda.
 *
 * A regra: nome quase idêntico + MESMO DDD + mesma escola ⇒ não manda venda.
 *
 * ⚠️ Ela BLOQUEIA, não vincula. Vincular lead a aluno por semelhança de nome
 * mexeria em cadastro e cobrança a partir de um palpite; recusar uma mensagem
 * de venda, no pior caso, custa um lead não prospectado — e isso um humano
 * conserta em dez segundos.
 *
 * ⚠️ Distância 2 é o limite de propósito. "Ana Silva" e "Ana Souza" distam 2 e
 * seriam bloqueadas; nome curto demais (< 6 letras) fica fora da regra, senão
 * "Ana" bloquearia "Ane".
 */
export function provavelSosiaDeAluno(
  identity: CommercialIdentity,
  aluno: { full_name?: string | null; phone?: string | null },
): boolean {
  const nomeLead = normalizarNome(identity.name);
  const nomeAluno = normalizarNome(aluno.full_name);
  if (nomeLead.length < 6 || nomeAluno.length < 6) return false;
  const ddd = dddDe(identity.phone);
  if (!ddd || ddd !== dddDe(aluno.phone)) return false;
  return distanciaNome(nomeLead, nomeAluno) <= 2;
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

  const comAtividade = new Set(facts.studentsWithActivity || []);
  // Aluno de verdade sem a flag de contrato: aula marcada ou pagamento recebido
  // valem como matrícula. Papelada atrasada não devolve ninguém para o funil de
  // venda.
  if (matchedStudent && comAtividade.has(matchedStudent.id)) {
    return { suppressed: true, reason: "aluno_em_atividade", studentId: matchedStudent.id };
  }

  // Sósia: telefone diverge, mas é a mesma pessoa. Vem DEPOIS do casamento por
  // telefone/e-mail — só entra quando o caminho confiável não achou ninguém —
  // e devolve studentId NULO de propósito: bloqueia a venda sem vincular
  // cadastro a partir de uma semelhança.
  if (!matchedStudent) {
    const sosia = facts.students.find((student) =>
      (student.contract_accepted === true || comAtividade.has(student.id)) &&
      provavelSosiaDeAluno(identity, student)
    );
    if (sosia) {
      return { suppressed: true, reason: "nome_e_ddd_de_aluno", studentId: null };
    }
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
  const [studentsRes, contractsRes, opportunitiesRes, linksRes, agendaRes, pagosRes] = await Promise.all([
    sb.from("profiles")
      // `full_name` entra para a trava de sósia (nome + DDD).
      .select("id, phone, email, full_name, contract_accepted")
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
    // Sinais de que a pessoa É aluno, independentemente da papelada.
    sb.from("bookings")
      .select("student_id")
      .eq("tenant_id", tenantId)
      .not("student_id", "is", null)
      .eq("status", "SCHEDULED"),
    sb.from("student_payments")
      .select("student_id")
      .eq("tenant_id", tenantId)
      .not("student_id", "is", null)
      .in("status", ["RECEIVED", "RECEIVED_IN_CASH"]),
  ]);

  // Falhar fechado é perigoso aqui: um erro de leitura não pode liberar venda indevida.
  const failures = [studentsRes, contractsRes, opportunitiesRes, linksRes, agendaRes, pagosRes]
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
    studentsWithActivity: [
      ...new Set(
        [...(agendaRes.data || []), ...(pagosRes.data || [])]
          .map((row: { student_id?: string | null }) => String(row.student_id || ""))
          .filter(Boolean),
      ),
    ],
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
