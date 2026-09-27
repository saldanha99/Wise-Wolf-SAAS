// "Minhas aulas registradas" — o aluno vê o próprio registro das aulas.
// A regra está no banco (migration 20260927140000, `get_my_lesson_records`):
// só o próprio aluno, só resumos APROVADOS, sem texto bruto nem cartão do
// professor. Aqui ficam a leitura defensiva da resposta e os textos da tela.

import {
  asAuthorizationMode,
  asGuardianReason,
  asNotEffectiveReason,
  formatDecisionDate,
  isMissingRpcError,
  objectionRequestMessage,
  whatsappUrl,
  type AuthorizationMode,
  type GuardianReason,
  type NotEffectiveReason,
  type SignerRelation,
} from './lessonRecordingConsent';

/**
 * Situação do termo do aluno, pela mesma régua que marca as aulas.
 * SCHOOL_AUTHORIZED (migration 20260929100000): a escola autoriza o registro e
 * o aluno não pediu para não registrar — no modo da escola, REFUSED/REVOKED é
 * o pedido para não registrar.
 */
export type StudentConsentStatus = 'AUTHORIZED' | 'SCHOOL_AUTHORIZED' | 'NOT_EFFECTIVE' | 'REFUSED' | 'REVOKED' | 'NONE';

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
  /**
   * Até quando cada cópia bruta desta aula fica no sistema da escola, pelo
   * tipo (nulo = nenhuma cópia viva daquele tipo). Separadas porque o
   * relatório de presença pode durar mais que a transcrição, e aula aprovada
   * só a partir das anotações não tem transcrição.
   */
  transcriptUntil: string | null;
  notesUntil: string | null;
  attendanceUntil: string | null;
}

/** Os prazos das cópias brutas de uma aula. */
export type RawCopies = Pick<StudentLessonRecord, 'transcriptUntil' | 'notesUntil' | 'attendanceUntil'>;

export interface StudentRecordConsent {
  status: StudentConsentStatus;
  decidedAt: string | null;
  signerRelation: SignerRelation | null;
  requiresGuardian: boolean;
  guardianReason: GuardianReason | null;
  /**
   * Por que o aceite gravado não vale (só com NOT_EFFECTIVE): versão anterior
   * à vigente do termo, sem o código do WhatsApp ou dado pelo aluno quando a
   * escola exige o responsável — a mesma régua da página pública.
   */
  notEffectiveReason: NotEffectiveReason | null;
  /**
   * Validade do link vivo do termo (o token não sai do servidor) — só quando
   * se sabe que ele CHEGOU (aberto pela família ou mensagem aceita pelo
   * provedor). Link na fila ou que não saiu vem nulo.
   */
  linkExpiresAt: string | null;
}

export interface StudentLessonRecordsView {
  schoolName: string | null;
  /** Como a escola autoriza o registro (servidor antigo = aceite individual). */
  authorizationMode: AuthorizationMode;
  schoolWhatsapp: string | null;
  consent: StudentRecordConsent;
  term: { version: string; body: string } | null;
  /**
   * Aulas com transcrição/anotações guardadas esperando a revisão do
   * professor (a que ele rejeitou por último não conta).
   */
  pendingReview: number;
  records: StudentLessonRecord[];
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const STATUSES: readonly StudentConsentStatus[] = ['AUTHORIZED', 'SCHOOL_AUTHORIZED', 'NOT_EFFECTIVE', 'REFUSED', 'REVOKED', 'NONE'];

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
    transcriptUntil: asText(row.transcript_until),
    notesUntil: asText(row.notes_until),
    attendanceUntil: asText(row.attendance_until),
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
    authorizationMode: asAuthorizationMode(root.authorization_mode),
    schoolWhatsapp: asText(root.school_whatsapp),
    consent: {
      status: asStatus(consent.status),
      decidedAt: asText(consent.decided_at),
      signerRelation: asRelation(consent.signer_relation),
      requiresGuardian,
      guardianReason: asGuardianReason(consent.guardian_reason, requiresGuardian),
      notEffectiveReason: asNotEffectiveReason(consent.not_effective_reason),
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

/** "a", "a e b", "a, b e c". */
function joinPt(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

/**
 * As cópias brutas desta aula que ainda estão no sistema da escola, cada uma
 * com o nome e o prazo dela. Não diz que "fica só o resumo": o resumo
 * aprovado (inclusive o texto das anotações revisado pelo professor) fica,
 * e a tela explica isso na seção "O que é guardado".
 */
export function rawCopyText(copies: RawCopies): string {
  const parts: string[] = [];
  const transcript = formatDecisionDate(copies.transcriptUntil);
  const notes = formatDecisionDate(copies.notesUntil);
  const attendance = formatDecisionDate(copies.attendanceUntil);
  if (transcript) parts.push(`transcrição até ${transcript}`);
  if (notes) parts.push(`anotações do Google até ${notes}`);
  if (attendance) parts.push(`relatório de presença até ${attendance}`);
  if (parts.length === 0) {
    return 'Nenhuma cópia da transcrição, das anotações ou da presença desta aula está guardada no sistema da escola.';
  }
  return `Cópias desta aula no sistema da escola: ${joinPt(parts)}. Depois disso, são apagadas.`;
}

export function pendingReviewText(count: number): string {
  if (count <= 0) return '';
  return count === 1
    ? '1 aula registrada está esperando a revisão do professor (a transcrição ou as anotações dela estão guardadas). O resumo aparece aqui se ele aprovar — o texto bruto, não.'
    : `${count} aulas registradas estão esperando a revisão do professor (a transcrição ou as anotações delas estão guardadas). Os resumos aparecem aqui se ele aprovar — o texto bruto, não.`;
}

export const CONSENT_STATUS_LABEL: Record<StudentConsentStatus, string> = {
  AUTHORIZED: 'Autorizado',
  SCHOOL_AUTHORIZED: 'Autorizado pela escola',
  NOT_EFFECTIVE: 'Autorização pendente de confirmação',
  REFUSED: 'Não autorizado',
  REVOKED: 'Revogado',
  NONE: 'Sem resposta',
};

/** Frase da situação do termo, dita para o aluno. */
export function consentStatusText(consent: StudentRecordConsent, mode: AuthorizationMode = 'INDIVIDUAL_CONSENT'): string {
  const when = formatDecisionDate(consent.decidedAt);
  const since = when ? ` desde ${when}` : '';
  if (mode === 'SCHOOL_DEFAULT') {
    if (consent.status === 'REFUSED' || consent.status === 'REVOKED') {
      return `Existe o pedido para não registrar as suas aulas${since}. Elas acontecem normalmente, sem transcrição.`;
    }
    if (consent.status === 'SCHOOL_AUTHORIZED') {
      return 'O registro das aulas faz parte das aulas da escola: as aulas na sala da escola no Google Meet são transcritas (sem vídeo). Você pode pedir para não ser registrado a qualquer momento, sem prejuízo das aulas.';
    }
    return 'As suas aulas não estão sendo registradas agora. Se tiver dúvida, fale com a escola.';
  }
  switch (consent.status) {
    case 'SCHOOL_AUTHORIZED':
      return 'O registro das aulas foi autorizado pela escola.';
    case 'AUTHORIZED':
      return `Registro autorizado${since}${consent.signerRelation === 'GUARDIAN' ? ' pelo seu responsável' : ''}: as aulas na sala da escola no Google Meet podem ser transcritas (quando o professor da aula também autorizou).`;
    case 'NOT_EFFECTIVE':
      // O motivo vem do servidor. Sem ele (resposta antiga), cai na régua de
      // antes: responsável exigido ou falta do código.
      if (consent.notEffectiveReason === 'TERM_UPDATED') {
        return `O termo mudou depois da autorização${when ? ` de ${when}` : ''}: ela não vale para as próximas aulas até ${consent.requiresGuardian ? 'o seu responsável ler e aceitar' : 'você ler e aceitar'} a versão nova. Enquanto isso, as aulas não são transcritas.`;
      }
      if (consent.notEffectiveReason === 'UNVERIFIED') {
        return 'Existe uma autorização gravada, mas ela ainda não foi confirmada pelo código do WhatsApp. Enquanto isso, as aulas não são transcritas.';
      }
      return consent.notEffectiveReason === 'GUARDIAN_REQUIRED' || consent.requiresGuardian
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

/**
 * Como revogar: pelo link do termo — só quando o servidor sabe que ele chegou
 * (aberto ou mensagem aceita) — ou pela escola. No modo da escola, como pedir
 * para não registrar (ou para voltar a registrar).
 */
export function revokeHowToText(consent: StudentRecordConsent, mode: AuthorizationMode = 'INDIVIDUAL_CONSENT'): string {
  if (mode === 'SCHOOL_DEFAULT') {
    if (consent.status === 'REFUSED' || consent.status === 'REVOKED') {
      return 'Para voltar a ter as aulas registradas, fale com a escola pelo WhatsApp.';
    }
    return `Para pedir que as suas aulas não sejam registradas, mande a mensagem pelo WhatsApp da escola (o botão abaixo já leva o texto pronto)${consent.requiresGuardian ? ' — sendo menor de idade, o pedido pode vir do seu responsável' : ''}. O pedido vale para as aulas seguintes, sem prejuízo das aulas.`;
  }
  const whose = consent.requiresGuardian ? 'do seu responsável' : 'do seu cadastro';
  const until = formatDecisionDate(consent.linkExpiresAt);
  if (until) {
    return `Para revogar, abra o link do termo que a escola mandou para o WhatsApp ${whose} (vale até ${until}) e escolha "Não autorizo" — a página confirma com um código de 6 dígitos. Também dá para pedir a revogação à escola pelo WhatsApp.`;
  }
  return `Para revogar, peça à escola pelo WhatsApp: ela registra a revogação ou manda um link novo do termo para o WhatsApp ${whose}.`;
}

/**
 * Mensagem pronta para pedir a exclusão do registro. Genérica de propósito:
 * quem cumpre é a direção, pelo botão "Apagar registros das aulas deste
 * aluno" da ficha (erase_student_lesson_records), que mostra antes o que sai.
 */
export function exclusionRequestMessage(schoolName: string | null): string {
  const school = schoolName || 'escola';
  return `Olá! Sou aluno(a) da ${school} e quero pedir a exclusão do registro das minhas aulas.`;
}

/** Link do WhatsApp da escola com o pedido para não registrar já escrito; sem número, nulo. */
export function objectionRequestUrl(view: Pick<StudentLessonRecordsView, 'schoolName' | 'schoolWhatsapp'>): string | null {
  return whatsappUrl(view.schoolWhatsapp, objectionRequestMessage(view.schoolName));
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
