// Termo de registro das aulas (Meet): regras de tela e textos.
// As regras que valem estão no banco (migration 20260926120000); aqui ficam
// só o espelho para a tela avisar antes de chamar o servidor.

export type RecordingDecision = 'NONE' | 'ACCEPTED' | 'REFUSED' | 'REVOKED';
export type SignerRelation = 'SELF' | 'GUARDIAN' | 'SCHOOL';

export const CONSENT_PATH = '/registro-das-aulas';

export const DECISION_LABEL: Record<RecordingDecision, string> = {
  NONE: 'Sem resposta',
  ACCEPTED: 'Autorizado',
  REFUSED: 'Não autorizado',
  REVOKED: 'Revogado',
};

export const RELATION_LABEL: Record<SignerRelation, string> = {
  SELF: 'o próprio aluno',
  GUARDIAN: 'responsável',
  SCHOOL: 'registrado pela escola',
};

export function asDecision(value: unknown): RecordingDecision {
  return value === 'ACCEPTED' || value === 'REFUSED' || value === 'REVOKED' ? value : 'NONE';
}

/** Junta espaços repetidos e apara as pontas, como o servidor faz. */
export function normalizeSignerName(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Nome e sobrenome, entre 5 e 120 caracteres (mesma regra do servidor). */
export function isFullName(value: string): boolean {
  const name = normalizeSignerName(value);
  return name.length >= 5 && name.length <= 120 && /^\S+( \S+)+$/.test(name);
}

export function consentLink(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}${CONSENT_PATH}?token=${encodeURIComponent(token)}`;
}

/** Só dígitos; número brasileiro sem DDI ganha o 55. */
export function whatsappDigits(phone: string | null | undefined): string | null {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
}

export function consentWhatsAppMessage(input: {
  studentName: string;
  schoolName?: string | null;
  link: string;
  forGuardian: boolean;
}): string {
  const firstName = normalizeSignerName(input.studentName).split(' ')[0] || 'o aluno';
  const school = input.schoolName?.trim() || 'a escola';
  const opening = input.forGuardian
    ? `Olá! Aqui é da ${school}. Como ${firstName} é menor de idade, precisamos da sua autorização como responsável para o registro das aulas.`
    : `Olá, ${firstName}! Aqui é da ${school}. Precisamos da sua autorização para o registro das aulas.`;
  return [
    opening,
    'As aulas passam a ser transcritas pelo Google Meet (sem vídeo), para registrar o que foi trabalhado e dar continuidade ao aprendizado, inclusive se houver troca de professor.',
    `O termo completo e a autorização estão neste link (leva 1 minuto): ${input.link}`,
    'Dá para mudar de ideia quando quiser, pelo mesmo link.',
  ].join('\n\n');
}

export function whatsappUrl(phone: string | null | undefined, message: string): string | null {
  const digits = whatsappDigits(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

const ERRORS: Record<string, string> = {
  nome_completo_obrigatorio: 'Digite nome e sobrenome.',
  responsavel_obrigatorio: 'Como o aluno é menor de idade, quem autoriza é o responsável.',
  link_expirado: 'Este link expirou ou foi substituído. Peça um novo à escola.',
  relacao_invalida: 'Escolha se você é o aluno ou o responsável.',
  resposta_invalida: 'Não foi possível registrar a resposta. Tente de novo.',
  sem_permissao: 'Você não tem permissão para esta ação.',
  aluno_invalido: 'Aluno não encontrado.',
  pessoa_invalida: 'Pessoa não encontrada.',
  informe_o_motivo: 'Informe o motivo (pelo menos 10 caracteres).',
  complete_seu_nome_no_perfil: 'Complete seu nome no perfil antes de responder.',
  // O professor só autoriza com a conta Google confirmada por login (migration
  // 20260926180000): sem esta entrada o cartão mostrava "Algo deu errado".
  teacher_google_identity_required: 'Confirme sua conta Google antes de autorizar: é ela que entra como coanfitriã da sala.',
};

/** Traduz o código de erro do servidor; mensagem desconhecida vira texto genérico. */
export function consentErrorMessage(raw: string | null | undefined): string {
  const text = String(raw || '');
  const code = Object.keys(ERRORS)
    .sort((a, b) => b.length - a.length)
    .find(key => text.includes(key));
  return code ? ERRORS[code] : 'Algo deu errado. Tente de novo em instantes.';
}

export function formatDecisionDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

type RpcErrorLike = { code?: string | null; message?: string | null } | null | undefined;

/**
 * RPC que ainda não existe no banco (PostgREST devolve PGRST202; Postgres,
 * 42883). A tela mostra o recurso como indisponível em vez de quebrar.
 */
export function isMissingRpcError(error: RpcErrorLike): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  return /could not find the function|function .* does not exist/i.test(String(error.message || ''));
}

export type GoogleIdentityState =
  | { status: 'verified'; email: string; verifiedAt: string }
  | { status: 'missing'; email: string | null }
  | { status: 'unavailable' }
  | { status: 'error' };

/** Resposta de `get_my_google_identity`: `{ email, verified_at }` ou nulo. */
export function googleIdentityState(data: unknown, error: RpcErrorLike): GoogleIdentityState {
  if (error) return isMissingRpcError(error) ? { status: 'unavailable' } : { status: 'error' };
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return { status: 'missing', email: null };
  const record = row as Record<string, unknown>;
  const email = typeof record.email === 'string' && record.email.trim() ? record.email.trim() : null;
  const verifiedAt = typeof record.verified_at === 'string' && record.verified_at.trim() ? record.verified_at : null;
  return email && verifiedAt ? { status: 'verified', email, verifiedAt } : { status: 'missing', email };
}
