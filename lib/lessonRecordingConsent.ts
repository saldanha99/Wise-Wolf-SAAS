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
};

/** Traduz o código de erro do servidor; mensagem desconhecida vira texto genérico. */
export function consentErrorMessage(raw: string | null | undefined): string {
  const text = String(raw || '');
  const code = Object.keys(ERRORS).find(key => text.includes(key));
  return code ? ERRORS[code] : 'Algo deu errado. Tente de novo em instantes.';
}

export function formatDecisionDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
