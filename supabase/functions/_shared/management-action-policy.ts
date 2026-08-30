export const MANAGEMENT_ACTION_SCHEMA_VERSION = 1;

export type ManagementActionRisk = "medium" | "high" | "critical";

export type ManagementActionType =
  | "conta_pagar"
  | "ajuste_repasse"
  | "cobertura_aula"
  | "transferencia_professor"
  | "repasse_aula"
  | "alterar_horario_aluno";

export type ManagementToolName =
  | "finance.create_payable"
  | "finance.adjust_teacher_payout"
  | "academics.request_lesson_coverage"
  | "academics.transfer_student_teacher"
  | "academics.change_student_schedule";

export interface ManagementToolPolicy {
  actionType: ManagementActionType;
  toolName: ManagementToolName;
  risk: ManagementActionRisk;
  allowedMembershipRoles: readonly ("SCHOOL_ADMIN" | "COORDINATOR")[];
  confirmation: "same_actor";
  description: string;
}

const SCHOOL_ADMIN_ONLY = ["SCHOOL_ADMIN"] as const;
const ACADEMIC_MANAGERS = ["SCHOOL_ADMIN", "COORDINATOR"] as const;

export const MANAGEMENT_TOOL_POLICIES: Record<
  ManagementActionType,
  ManagementToolPolicy
> = {
  conta_pagar: {
    actionType: "conta_pagar",
    toolName: "finance.create_payable",
    risk: "critical",
    allowedMembershipRoles: SCHOOL_ADMIN_ONLY,
    confirmation: "same_actor",
    description: "Cadastrar uma conta a pagar avulsa ou recorrente.",
  },
  ajuste_repasse: {
    actionType: "ajuste_repasse",
    toolName: "finance.adjust_teacher_payout",
    risk: "critical",
    allowedMembershipRoles: SCHOOL_ADMIN_ONLY,
    confirmation: "same_actor",
    description: "Adicionar ou descontar um ajuste no repasse de professor.",
  },
  cobertura_aula: {
    actionType: "cobertura_aula",
    toolName: "academics.request_lesson_coverage",
    risk: "high",
    allowedMembershipRoles: ACADEMIC_MANAGERS,
    confirmation: "same_actor",
    description:
      "Convidar um professor substituto para uma aula pontual; o aceite transfere a contabilizacao da aula.",
  },
  transferencia_professor: {
    actionType: "transferencia_professor",
    toolName: "academics.transfer_student_teacher",
    risk: "critical",
    allowedMembershipRoles: SCHOOL_ADMIN_ONLY,
    confirmation: "same_actor",
    description:
      "Transferir de forma recorrente o aluno e seus horarios para outro professor.",
  },
  // Compatibilidade com intencoes criadas antes de a cobertura pontual ser
  // separada da transferencia recorrente. Novos prompts nao devem emitir este
  // nome ambiguo.
  repasse_aula: {
    actionType: "repasse_aula",
    toolName: "academics.transfer_student_teacher",
    risk: "critical",
    allowedMembershipRoles: SCHOOL_ADMIN_ONLY,
    confirmation: "same_actor",
    description:
      "Alias legado da transferencia recorrente de professor do aluno.",
  },
  alterar_horario_aluno: {
    actionType: "alterar_horario_aluno",
    toolName: "academics.change_student_schedule",
    risk: "high",
    allowedMembershipRoles: ACADEMIC_MANAGERS,
    confirmation: "same_actor",
    description: "Alterar o dia e o horario de uma aula recorrente do aluno.",
  },
};

export function managementToolPolicy(
  value: unknown,
): ManagementToolPolicy | null {
  if (typeof value !== "string") return null;
  return MANAGEMENT_TOOL_POLICIES[value as ManagementActionType] || null;
}

export function canUseManagementTool(input: {
  profileRole: string | null | undefined;
  membershipRole: string | null | undefined;
  actionType: unknown;
}): boolean {
  const policy = managementToolPolicy(input.actionType);
  if (!policy) return false;
  if (input.profileRole === "SUPER_ADMIN") return true;
  return policy.allowedMembershipRoles.includes(
    input.membershipRole as "SCHOOL_ADMIN" | "COORDINATOR",
  );
}

function jidString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function whatsappPhoneFromJid(value: unknown): string | null {
  const jid = jidString(value);
  if (!jid.endsWith("@s.whatsapp.net")) return null;
  const local = jid.slice(0, -"@s.whatsapp.net".length).replace(/:\d+$/, "");
  const digits = local.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

/**
 * Compara a identidade do participante com o cadastro sem aceitar o atalho
 * perigoso de apenas oito ultimos digitos. Para numeros brasileiros, tolera
 * somente a diferenca historica do nono digito, preservando pais e DDD.
 */
export function managementPhonesMatch(
  participantPhone: unknown,
  profilePhone: unknown,
): boolean {
  const participant = typeof participantPhone === "string"
    ? participantPhone.replace(/\D/g, "")
    : "";
  const profile = typeof profilePhone === "string"
    ? profilePhone.replace(/\D/g, "")
    : "";
  if (!participant || !profile) return false;
  if (participant === profile) return true;

  const brazilianLocal = (digits: string): string | null => {
    if (
      digits.startsWith("55") && (digits.length === 12 || digits.length === 13)
    ) {
      return digits.slice(2);
    }
    return digits.length === 10 || digits.length === 11 ? digits : null;
  };
  const left = brazilianLocal(participant);
  const right = brazilianLocal(profile);
  if (!left || !right || left.slice(0, 2) !== right.slice(0, 2)) return false;

  const subscriber = (local: string): string | null => {
    const raw = local.slice(2);
    if (raw.length === 8) return raw;
    if (raw.length === 9 && raw.startsWith("9")) return raw.slice(1);
    return null;
  };
  const leftSubscriber = subscriber(left);
  const rightSubscriber = subscriber(right);
  return Boolean(
    leftSubscriber && rightSubscriber && leftSubscriber === rightSubscriber,
  );
}

/**
 * Evolution/Baileys identifies a group author in `key.participant`. Newer
 * multi-device payloads can put an opaque `@lid` there and the phone JID in
 * `participantAlt`, so both representations are inspected but only a phone JID
 * is accepted as an identity credential.
 */
export function managementActorPhoneCandidates(item: unknown): string[] {
  if (!item || typeof item !== "object") return [];
  const row = item as Record<string, unknown>;
  const key = row.key && typeof row.key === "object"
    ? (row.key as Record<string, unknown>)
    : {};
  const values = [
    key.participantAlt,
    key.participant,
    row.participantAlt,
    row.participant,
    row.sender,
  ];
  const out: string[] = [];
  for (const value of values) {
    const phone = whatsappPhoneFromJid(value);
    if (phone && !out.includes(phone)) out.push(phone);
  }
  return out;
}

export function confirmationBelongsToActor(
  requestedByUserId: unknown,
  confirmingUserId: unknown,
): boolean {
  const requested = typeof requestedByUserId === "string"
    ? requestedByUserId.trim()
    : "";
  const confirming = typeof confirmingUserId === "string"
    ? confirmingUserId.trim()
    : "";
  return Boolean(requested && confirming && requested === confirming);
}

export function shortManagementActionCode(actionId: unknown): string {
  return typeof actionId === "string"
    ? actionId.replace(/-/g, "").slice(0, 8).toUpperCase()
    : "";
}

export async function constantTimeTokenMatches(
  supplied: string,
  expected: string,
): Promise<boolean> {
  if (!supplied || !expected) return false;
  const encoder = new TextEncoder();
  const [suppliedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const suppliedBytes = new Uint8Array(suppliedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = supplied.length ^ expected.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= suppliedBytes[index] ^ expectedBytes[index];
  }
  return difference === 0;
}
