// Termo de registro das aulas (Meet): regras de tela e textos.
// As regras que valem estão no banco (migrations 20260926120000 e
// 20260926200000); aqui ficam só o espelho para a tela avisar antes de chamar
// o servidor.

export type RecordingDecision = 'NONE' | 'ACCEPTED' | 'REFUSED' | 'REVOKED';
export type SignerRelation = 'SELF' | 'GUARDIAN' | 'SCHOOL';
/** Por que o responsável responde; nulo = adulto comprovado pela escola. */
export type GuardianReason = 'KIDS' | 'MINOR' | 'AGE_UNKNOWN';

/** Nome da edge function que manda o código de 6 dígitos pelo WhatsApp. */
export const CODE_FUNCTION = 'lesson-recording-code';
export const CODE_LENGTH = 6;

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

/** Motivo fora da lista, com responsável exigido, vira idade desconhecida. */
export function asGuardianReason(value: unknown, requiresGuardian?: boolean): GuardianReason | null {
  if (value === 'KIDS' || value === 'MINOR' || value === 'AGE_UNKNOWN') return value;
  return requiresGuardian ? 'AGE_UNKNOWN' : null;
}

/** Explicação para a família de por que quem responde é o responsável. */
export function guardianReasonText(reason: GuardianReason, firstName: string): string {
  if (reason === 'AGE_UNKNOWN') {
    return `A escola ainda não cadastrou a data de nascimento de ${firstName}. Por segurança, quem responde é o responsável legal. Se ${firstName} já tem 18 anos, peça à escola para cadastrar a data de nascimento e abra o link de novo.`;
  }
  return `Como ${firstName} é menor de idade, quem responde é o responsável legal.`;
}

/** Por que um aceite gravado não vale para transcrever (servidor decide). */
export type NotEffectiveReason = 'GUARDIAN_REQUIRED' | 'UNVERIFIED';

export function asNotEffectiveReason(value: unknown): NotEffectiveReason | null {
  return value === 'GUARDIAN_REQUIRED' || value === 'UNVERIFIED' ? value : null;
}

/**
 * Texto da página pública quando a última resposta foi "autorizo" mas ela não
 * vale mais — em vez de "Situação atual: Autorizado", que faria o responsável
 * fechar a página achando que está resolvido.
 */
export function notEffectiveText(reason: NotEffectiveReason, firstName: string): string {
  if (reason === 'UNVERIFIED') {
    return `A autorização anterior foi registrada sem a confirmação pelo WhatsApp e não vale mais. Responda de novo abaixo para as aulas de ${firstName} serem registradas.`;
  }
  return `A autorização anterior foi dada pelo próprio aluno e não vale: ${firstName} é menor de idade (ou a escola não confirmou a idade). O responsável precisa responder abaixo.`;
}

/** Por que o link foi fechado pelo servidor. */
export type LinkBlockedReason = 'CODE_ATTEMPTS' | 'CODE_SENDS';

export function asLinkBlockedReason(value: unknown): LinkBlockedReason | null {
  return value === 'CODE_ATTEMPTS' || value === 'CODE_SENDS' ? value : null;
}

/** Explicação para a escola, no painel, de por que o último link fechou. */
export const LINK_BLOCKED_LABEL: Record<LinkBlockedReason, string> = {
  CODE_ATTEMPTS: 'O último link foi bloqueado: muitos códigos digitados errado. Confirme com a família e gere um link novo.',
  CODE_SENDS: 'O último link foi bloqueado: pediram códigos demais por ele. Confirme com a família e gere um link novo.',
};

/** Painel: telefone do responsável existe no cadastro, mas a escola não confirmou. */
export const GUARDIAN_PHONE_UNCONFIRMED_TEXT =
  'O telefone do responsável no cadastro não foi confirmado pela escola, então o código não sai. Cadastre o responsável em “Contatos verificados” na ficha do aluno (ou corrija o telefone pela ficha) e gere um link novo.';

/** Painel: responsável com o mesmo número do aluno. */
export const GUARDIAN_PHONE_SAME_AS_STUDENT_TEXT =
  'O telefone do responsável é o mesmo do aluno. Confira se esse número é mesmo do responsável: é ele que recebe o código.';

/** Explicação curta para a escola, no painel. */
export const GUARDIAN_REASON_LABEL: Record<GuardianReason, string> = {
  KIDS: 'Turma infantil · responde o responsável',
  MINOR: 'Menor de idade · responde o responsável',
  AGE_UNKNOWN: 'Idade não cadastrada pela escola · responde o responsável',
};

/** Só dígitos, no máximo `max` (campo do código). */
export function onlyDigits(value: string, max = CODE_LENGTH): string {
  return value.replace(/\D/g, '').slice(0, max);
}

export function isSixDigitCode(value: string): boolean {
  return /^[0-9]{6}$/.test(value);
}

/** "30 segundos", "2 minutos", "1 hora". */
export function formatWait(seconds: number | null | undefined): string {
  const total = Math.max(1, Math.ceil(Number(seconds) || 60));
  if (total < 60) return `${total} segundos`;
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return minutes === 1 ? '1 minuto' : `${minutes} minutos`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? '1 hora' : `${hours} horas`;
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
  guardianReason?: GuardianReason | null;
}): string {
  const firstName = normalizeSignerName(input.studentName).split(' ')[0] || 'o aluno';
  const school = input.schoolName?.trim() || 'a escola';
  const opening = !input.forGuardian
    ? `Olá, ${firstName}! Aqui é da ${school}. Precisamos da sua autorização para o registro das aulas.`
    : input.guardianReason === 'AGE_UNKNOWN'
      ? `Olá! Aqui é da ${school}. Precisamos da autorização do responsável por ${firstName} para o registro das aulas.`
      : `Olá! Aqui é da ${school}. Como ${firstName} é menor de idade, precisamos da sua autorização como responsável para o registro das aulas.`;
  return [
    opening,
    'As aulas passam a ser transcritas pelo Google Meet (sem vídeo), para registrar o que foi trabalhado e dar continuidade ao aprendizado, inclusive se houver troca de professor.',
    `O termo completo e a autorização estão neste link (leva 1 minuto): ${input.link}`,
    'Para confirmar que é você, a página manda um código de 6 dígitos para este WhatsApp.',
    'Dá para mudar de ideia quando quiser, pelo mesmo link.',
  ].join('\n\n');
}

export function whatsappUrl(phone: string | null | undefined, message: string): string | null {
  const digits = whatsappDigits(phone);
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : null;
}

const ERRORS: Record<string, string> = {
  nome_completo_obrigatorio: 'Digite nome e sobrenome.',
  responsavel_obrigatorio: 'Quem autoriza é o responsável: o aluno é menor de idade ou a escola ainda não cadastrou a data de nascimento.',
  codigo_incorreto: 'Código incorreto. Confira a mensagem no WhatsApp e digite de novo.',
  codigo_invalido: 'Digite os 6 números do código.',
  codigo_expirado: 'O código venceu ou não vale mais. Peça um código novo.',
  codigo_bloqueado: 'Muitas tentativas erradas. Peça um código novo.',
  limite_de_envios: 'Já mandamos 3 códigos na última hora. Espere um pouco para pedir outro.',
  limite_diario: 'Já mandamos 6 códigos por este link hoje. Espere para pedir outro.',
  link_bloqueado: 'Este link foi bloqueado por segurança (muitos códigos pedidos ou digitados errado). Peça um link novo à escola.',
  aguarde: 'O WhatsApp da escola está com fila. Tente pedir o código de novo em instantes.',
  telefone_nao_cadastrado: 'A escola não tem este WhatsApp no cadastro. Peça à escola para cadastrar e mandar um link novo.',
  whatsapp_indisponivel: 'O WhatsApp da escola está fora do ar agora. Tente de novo mais tarde ou fale com a escola.',
  whatsapp_recusou: 'O WhatsApp não aceitou a mensagem para este número. Fale com a escola.',
  teacher_google_identity_required: 'Confirme sua conta Google antes de autorizar: é ela que entra como coanfitriã da sala.',
  kids_classification_requires_direction: 'Só a direção ou a coordenação classifica o aluno como infantil.',
  data_de_nascimento_invalida: 'Data de nascimento inválida.',
  link_expirado: 'Este link expirou ou foi substituído. Peça um novo à escola.',
  relacao_invalida: 'Escolha se você é o aluno ou o responsável.',
  resposta_invalida: 'Não foi possível registrar a resposta. Tente de novo.',
  sem_permissao: 'Você não tem permissão para esta ação.',
  aluno_invalido: 'Aluno não encontrado.',
  pessoa_invalida: 'Pessoa não encontrada.',
  informe_o_motivo: 'Informe o motivo (pelo menos 10 caracteres).',
  complete_seu_nome_no_perfil: 'Complete seu nome no perfil antes de responder.',
};

/** Traduz o código de erro do servidor; mensagem desconhecida vira texto genérico. */
export function consentErrorMessage(raw: string | null | undefined): string {
  const text = String(raw || '');
  const code = Object.keys(ERRORS)
    .sort((a, b) => b.length - a.length)
    .find(key => text.includes(key));
  return code ? ERRORS[code] : 'Algo deu errado. Tente de novo em instantes.';
}

/** Erro do código com as tentativas restantes ou a espera, quando o servidor diz. */
export function codeErrorMessage(input: {
  error?: string | null;
  attemptsLeft?: number | null;
  retryAfterSeconds?: number | null;
}): string {
  const code = String(input.error || '');
  if (code === 'codigo_incorreto' && Number(input.attemptsLeft) > 0) {
    const left = Number(input.attemptsLeft);
    return `Código incorreto. ${left === 1 ? 'Resta 1 tentativa' : `Restam ${left} tentativas`} para este código.`;
  }
  if ((code === 'limite_de_envios' || code === 'limite_diario' || code === 'aguarde') && input.retryAfterSeconds) {
    return `${consentErrorMessage(code)} Tente em ${formatWait(input.retryAfterSeconds)}.`;
  }
  return consentErrorMessage(code);
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
