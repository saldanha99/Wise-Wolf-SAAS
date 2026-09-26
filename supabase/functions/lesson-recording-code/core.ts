// Código de confirmação do termo de registro das aulas — regras puras.
//
// O código nasce no banco (`issue_lesson_recording_consent_code`, só
// service_role), que guarda apenas o hash; esta edge recebe o código uma vez,
// manda pelo WhatsApp da escola e nunca o devolve ao navegador nem o loga.

export type CodeRelation = "SELF" | "GUARDIAN";

export interface CodeRequest {
  token: string;
  relation: CodeRelation;
}

export interface IssuedCode {
  challengeId: string;
  code: string;
  destination: string;
  destinationMasked: string;
  relation: CodeRelation;
  tenantId: string;
  schoolName: string | null;
  studentFirstName: string | null;
  expiresAt: string;
}

export interface IssueFailure {
  error: string;
  retryAfterSeconds: number | null;
}

export type SettleStatus = "SENT" | "AMBIGUOUS" | "NOT_SENT";

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

/** Corpo aceito: `{ token: <64 hex>, relation: "SELF" | "GUARDIAN" }`. */
export function parseCodeRequest(body: unknown): CodeRequest | null {
  if (!isRecord(body)) return null;
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const relation = body.relation;
  if (!TOKEN_PATTERN.test(token)) return null;
  if (relation !== "SELF" && relation !== "GUARDIAN") return null;
  return { token, relation };
}

/** Resposta do banco: o código emitido ou o motivo da recusa. */
export function parseIssuedCode(data: unknown): IssuedCode | IssueFailure {
  if (!isRecord(data)) {
    return { error: "indisponivel", retryAfterSeconds: null };
  }
  if (data.ok !== true) {
    const retry = Number(data.retry_after_seconds);
    return {
      error: text(data.error, 60) || "indisponivel",
      retryAfterSeconds: Number.isFinite(retry) && retry > 0
        ? Math.ceil(retry)
        : null,
    };
  }
  const challengeId = text(data.challenge_id, 36);
  const code = text(data.code, 6);
  const destination = text(data.destination, 15);
  const tenantId = text(data.tenant_id, 160);
  const relation = data.relation;
  const expiresAt = text(data.expires_at, 64);
  if (
    !challengeId || !UUID_PATTERN.test(challengeId) ||
    !code || !/^[0-9]{6}$/.test(code) ||
    !destination || !/^[0-9]{12,15}$/.test(destination) ||
    !tenantId || !expiresAt ||
    (relation !== "SELF" && relation !== "GUARDIAN")
  ) {
    return { error: "indisponivel", retryAfterSeconds: null };
  }
  return {
    challengeId,
    code,
    destination,
    destinationMasked: text(data.destination_masked, 40) || "",
    relation,
    tenantId,
    schoolName: text(data.school_name, 120),
    studentFirstName: text(data.student_first_name, 60),
    expiresAt,
  };
}

/** Texto do WhatsApp: o código, para quê, validade e o aviso de não repassar. */
export function buildCodeMessage(input: {
  schoolName: string | null;
  studentFirstName: string | null;
  relation: CodeRelation;
  code: string;
}): string {
  const school = input.schoolName?.trim() || "Escola";
  const about = input.relation === "SELF"
    ? "do registro das suas aulas"
    : `do registro das aulas de ${
      input.studentFirstName?.trim() || "seu filho(a)"
    }`;
  return [
    `*${school}*: seu código para confirmar a autorização ${about} é *${input.code}*.`,
    "Ele vale por 10 minutos. Digite o código na página do termo.",
    "Não repasse este código para ninguém — a escola nunca pede o código por mensagem ou ligação.",
  ].join("\n\n");
}

/**
 * Como o envio termina no banco: aceito = SENT; vetado pelo teto ou recusado
 * = NOT_SENT (nada saiu, não conta no limite); resposta incerta = AMBIGUOUS
 * (pode ter chegado, conta no limite de 3 por hora).
 */
export function settleStatusFor(result: {
  outcome: "accepted" | "rejected" | "ambiguous";
  throttled?: boolean;
}): SettleStatus {
  if (result.outcome === "accepted") return "SENT";
  if (result.outcome === "rejected" || result.throttled) return "NOT_SENT";
  return "AMBIGUOUS";
}

/** Status HTTP para cada recusa do banco. */
export function httpStatusForIssueError(error: string): number {
  switch (error) {
    case "resposta_invalida":
      return 400;
    case "link_expirado":
      return 410;
    case "responsavel_obrigatorio":
    case "telefone_nao_cadastrado":
      return 409;
    case "limite_de_envios":
      return 429;
    default:
      return 503;
  }
}
