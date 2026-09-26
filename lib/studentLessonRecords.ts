// "Minhas aulas registradas" — o aluno vê o próprio registro das aulas.
// A regra está no banco (migration 20260927140000, `get_my_lesson_records`):
// só o próprio aluno, só resumos APROVADOS, sem texto bruto nem cartão do
// professor. Aqui ficam a leitura defensiva da resposta e os textos da tela.

import {
  asGuardianReason,
  formatDecisionDate,
  isMissingRpcError,
  whatsappUrl,
  type GuardianReason,
  type SignerRelation,
} from './lessonRecordingConsent';

/** Situação do termo do aluno, pela mesma régua que marca as aulas. */
export type StudentConsentStatus = 'AUTHORIZED' | 'NOT_EFFECTIVE' | 'REFUSED' | 'REVOKED' | 'NONE';

export interface StudentLessonRecord {
  sessionId: string;
  /** Dia da aula (`AAAA-MM-DD`, calendário da escola). */
  classDate: string | null;
  startsAt: string | null;
  teacherName: string | null;
  approvedAt: string | null;
  objective: string | null;
  practiced: string[];
  nextStep: string | null;
  homework: string | null;
  /** Até quando alguma cópia bruta desta aula fica no sistema; nulo = já apagada. */
  rawCopyUntil: string | null;
}

export interface StudentRecordConsent {
  status: StudentConsentStatus;
  decidedAt: string | null;
  signerRelation: SignerRelation | null;
  requiresGuardian: boolean;
  guardianReason: GuardianReason | null;
  /** Validade do link vivo do termo (o token não sai do servidor). */
  linkExpiresAt: string | null;
}

export interface StudentLessonRecordsView {
  schoolName: string | null;
  schoolWhatsapp: string | null;
  consent: StudentRecordConsent;
  term: { version: string; body: string } | null;
  /** Aulas com transcrição guardada que o professor ainda não aprovou. */
  pendingReview: number;
  records: StudentLessonRecord[];
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const STATUSES: readonly StudentConsentStatus[] = ['AUTHORIZED', 'NOT_EFFECTIVE', 'REFUSED', 'REVOKED', 'NONE'];

function asStatus(value: unknown): StudentConsentStatus {
  return STATUSES.includes(value as StudentConsentStatus) ? (value as StudentConsentStatus) : 'NONE';
}

function asRelation(value: unknown): SignerRelation | null {
  return value === 'SELF' || value === 'GUARDIAN' || value === 'SCHOOL' ? value : null;
}

function parseRecord(value: unknown): StudentLessonRecord | null {
  const row = asObject(value);
  const sessionId = row ? asText(row.session_id) : null;
  if (!row || !sessionId) return null;
  const practiced = Array.isArray(row.content_practiced)
    ? row.content_practiced.map(asText).filter((item): item is string => item !== null)
    : [];
  return {
    sessionId,
    classDate: asText(row.class_date),
    startsAt: asText(row.scheduled_start_at),
    teacherName: asText(row.teacher_name),
    approvedAt: asText(row.approved_at),
    objective: asText(row.lesson_objective),
    practiced,
    nextStep: asText(row.recommended_next_step),
    homework: asText(row.homework_assigned),
    rawCopyUntil: asText(row.raw_copy_until),
  };
}

/** Resposta de `get_my_lesson_records`; formato inesperado vira nulo. */
export function parseStudentLessonRecords(data: unknown): StudentLessonRecordsView | null {
  const root = asObject(data);
  if (!root || root.ok !== true) return null;
  const consent = asObject(root.consent) || {};
  const term = asObject(root.term);
  const termVersion = term ? asText(term.version) : null;
  const termBody = term ? asText(term.body) : null;
  const requiresGuardian = consent.requires_guardian === true;
  const pending = Number(root.pending_review);
  return {
    schoolName: asText(root.school_name),
    schoolWhatsapp: asText(root.school_whatsapp),
    consent: {
      status: asStatus(consent.status),
      decidedAt: asText(consent.decided_at),
      signerRelation: asRelation(consent.signer_relation),
      requiresGuardian,
      guardianReason: asGuardianReason(consent.guardian_reason, requiresGuardian),
      linkExpiresAt: asText(consent.link_expires_at),
    },
    term: termVersion && termBody ? { version: termVersion, body: termBody } : null,
    pendingReview: Number.isFinite(pending) && pending > 0 ? Math.floor(pending) : 0,
    records: Array.isArray(root.records)
      ? root.records.map(parseRecord).filter((row): row is StudentLessonRecord => row !== null)
      : [],
  };
}

/** Data da aula sem mexer no fuso: `AAAA-MM-DD` vira `DD/MM/AAAA`. */
export function formatClassDate(record: Pick<StudentLessonRecord, 'classDate' | 'startsAt'>): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(record.classDate || '');
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  return formatDecisionDate(record.startsAt) || 'Data não informada';
}

/** Hora de início no relógio da escola (Brasília). */
export function formatClassTime(startsAt: string | null): string {
  if (!startsAt) return '';
  const date = new Date(startsAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

/** O que ainda existe desta aula além do resumo. */
export function rawCopyText(rawCopyUntil: string | null): string {
  const until = formatDecisionDate(rawCopyUntil);
  return until
    ? `A transcrição desta aula fica no sistema da escola até ${until}; depois fica só este resumo.`
    : 'A transcrição desta aula já foi apagada do sistema da escola; fica só este resumo.';
}

export function pendingReviewText(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '1 aula tem transcrição guardada esperando a revisão do professor. O resumo aparece aqui quando ele aprovar — a transcrição, não.'
    : `${count} aulas têm transcrição guardada esperando a revisão do professor. Os resumos aparecem aqui quando ele aprovar — as transcrições, não.`;
}

export const CONSENT_STATUS_LABEL: Record<StudentConsentStatus, string> = {
  AUTHORIZED: 'Autorizado',
  NOT_EFFECTIVE: 'Autorização pendente de confirmação',
  REFUSED: 'Não autorizado',
  REVOKED: 'Revogado',
  NONE: 'Sem resposta',
};

/** Frase da situação do termo, dita para o aluno. */
export function consentStatusText(consent: StudentRecordConsent): string {
  const when = formatDecisionDate(consent.decidedAt);
  const since = when ? ` desde ${when}` : '';
  switch (consent.status) {
    case 'AUTHORIZED':
      return `Registro autorizado${since}${consent.signerRelation === 'GUARDIAN' ? ' pelo seu responsável' : ''}: as aulas na sala da escola no Google Meet podem ser transcritas (quando o professor da aula também autorizou).`;
    case 'NOT_EFFECTIVE':
      return consent.requiresGuardian
        ? 'Existe uma autorização gravada, mas ela não vale: quem precisa responder é o seu responsável. Enquanto isso, as aulas não são transcritas.'
        : 'Existe uma autorização gravada, mas ela ainda não foi confirmada pelo código do WhatsApp. Enquanto isso, as aulas não são transcritas.';
    case 'REFUSED':
      return `O registro das aulas não foi autorizado${since}. As aulas acontecem normalmente, sem transcrição.`;
    case 'REVOKED':
      return `A autorização foi revogada${since}. As aulas seguintes não são transcritas.`;
    default:
      return 'Ainda não há resposta ao termo. Sem autorização, as aulas acontecem normalmente, sem transcrição.';
  }
}

/** Como revogar: pelo link do termo (se houver um vivo) ou pela escola. */
export function revokeHowToText(consent: StudentRecordConsent): string {
  const whose = consent.requiresGuardian ? 'do seu responsável' : 'do seu cadastro';
  const until = formatDecisionDate(consent.linkExpiresAt);
  if (until) {
    return `Para revogar, abra o link do termo que a escola mandou para o WhatsApp ${whose} (vale até ${until}) e escolha "Não autorizo" — a página confirma com um código de 6 dígitos. Também dá para pedir a revogação à escola pelo WhatsApp.`;
  }
  return `Para revogar, peça à escola pelo WhatsApp: ela registra a revogação ou manda um link novo do termo para o WhatsApp ${whose}.`;
}

/** Mensagem pronta para pedir a exclusão do registro. */
export function exclusionRequestMessage(schoolName: string | null): string {
  const school = schoolName || 'escola';
  return `Olá! Sou aluno(a) da ${school} e quero pedir a exclusão do registro das minhas aulas (resumos aprovados, transcrições e arquivos do Google).`;
}

/** Link do WhatsApp da escola com o pedido já escrito; sem número, nulo. */
export function exclusionRequestUrl(view: Pick<StudentLessonRecordsView, 'schoolName' | 'schoolWhatsapp'>): string | null {
  return whatsappUrl(view.schoolWhatsapp, exclusionRequestMessage(view.schoolName));
}

type RpcErrorLike = { code?: string | null; message?: string | null } | null | undefined;

export function lessonRecordsErrorMessage(error: RpcErrorLike): string {
  if (isMissingRpcError(error)) return 'O registro das aulas ainda não está disponível. Tente de novo mais tarde.';
  if (String(error?.message || '').includes('somente_o_aluno')) return 'Esta tela mostra o registro das aulas do próprio aluno.';
  return 'Não foi possível carregar o registro das suas aulas. Tente de novo em instantes.';
}
