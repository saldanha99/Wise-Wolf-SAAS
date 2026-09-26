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
  contagem_mudou: 'A lista mudou desde a conferência. Confira de novo antes de enviar.',
  envio_em_andamento: 'Já há uma mensagem deste aluno na fila.',
  reenvio_so_depois_de_3_dias: 'O reenvio só é liberado 3 dias depois do último envio.',
  aluno_ja_decidiu: 'Este aluno já respondeu ao termo.',
  sem_contato: 'Sem telefone para enviar. Complete o cadastro do aluno.',
  avisos_de_aluno_desligados: 'Os avisos a alunos estão desligados nas configurações da escola.',
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

// ---------------------------------------------------------------------------
// Envio em lote (migration 20260926210000). As regras valem no banco; aqui só
// os rótulos e as contas que a tela mostra.

export type ConsentRecipient = 'STUDENT' | 'GUARDIAN';
export type RequestState = 'QUEUED' | 'SENT' | 'UNCERTAIN' | 'NOT_SENT';

export const RECIPIENT_LABEL: Record<ConsentRecipient, string> = {
  STUDENT: 'aluno',
  GUARDIAN: 'responsável',
};

export const REQUEST_STATE_LABEL: Record<RequestState, string> = {
  QUEUED: 'Na fila',
  SENT: 'Enviado',
  UNCERTAIN: 'Envio incerto',
  NOT_SENT: 'Não enviado',
};

const MISSING_CONTACT: Record<string, string> = {
  idade_nao_cadastrada:
    'Idade não cadastrada e sem telefone do responsável. Cadastre a data de nascimento (maior de idade recebe no próprio número) ou o telefone do responsável.',
  menor_sem_telefone_do_responsavel: 'Menor de idade sem telefone do responsável no cadastro.',
  sem_telefone: 'Sem telefone no cadastro.',
};

/** Por que o aluno está "sem contato" — com o que falta cadastrar. */
export function missingContactLabel(reason: string | null | undefined): string {
  return MISSING_CONTACT[String(reason || '')] || 'Sem telefone para enviar.';
}

const NOT_SENT: Record<string, string> = {
  aluno_ja_decidiu: 'respondeu antes do envio',
  contato_mudou: 'o contato mudou antes do envio',
  link_substituido_ou_vencido: 'o link foi substituído antes do envio',
  mensagem_alterada: 'a mensagem foi alterada na fila',
  aluno_nao_esta_ativo: 'o aluno deixou de estar ativo',
  termo_mudou_de_versao: 'o termo mudou de versão antes do envio',
  avisos_de_aluno_desligados: 'avisos a alunos desligados',
  no_whatsapp_instance: 'WhatsApp da escola desconectado',
  invalid_phone: 'telefone inválido',
  removido_da_fila: 'removido da fila',
  test_fixture_suppressed: 'conta de teste',
};

/** Motivo de uma mensagem que não saiu, em português. */
export function notSentReasonLabel(reason: string | null | undefined): string {
  const raw = String(reason || '');
  if (NOT_SENT[raw]) return NOT_SENT[raw];
  if (raw.startsWith('provider_http_')) return 'o WhatsApp recusou o envio';
  if (raw.includes('attempts_exhausted')) return 'tentativas esgotadas';
  return 'não saiu';
}

/** "Reenviar" liberado? Quem decide é o servidor; a tela só espelha a data. */
export function resendAllowed(availableAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!availableAt) return false;
  const date = new Date(availableAt);
  return !Number.isNaN(date.getTime()) && date.getTime() <= now.getTime();
}

const TZ = 'America/Sao_Paulo';

function dayKey(date: Date): string {
  return date.toLocaleDateString('pt-BR', { timeZone: TZ });
}

function weekdayAndDay(date: Date): string {
  const weekday = date.toLocaleDateString('pt-BR', { timeZone: TZ, weekday: 'short' }).replace(/\.$/, '');
  const day = date.toLocaleDateString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit' });
  return `${weekday} ${day}`;
}

function clock(date: Date): string {
  return date.toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

/** "sáb 26/09 às 19:50" no horário de Brasília. */
export function formatSendTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${weekdayAndDay(date)} às ${clock(date)}`;
}

/** Janela do lote: "sáb 26/09, das 14:05 às 14:38" ou "de sáb 26/09 às 19:50 até seg 28/09 às 09:12". */
export function sendWindowText(first: string | null | undefined, last: string | null | undefined): string {
  if (!first) return '';
  const start = new Date(first);
  const end = new Date(last || first);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  if (start.getTime() === end.getTime()) return formatSendTime(first);
  if (dayKey(start) === dayKey(end)) return `${weekdayAndDay(start)}, das ${clock(start)} às ${clock(end)}`;
  return `de ${formatSendTime(first)} até ${formatSendTime(last)}`;
}
