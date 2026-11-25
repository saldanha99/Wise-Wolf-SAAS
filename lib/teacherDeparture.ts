// Saída do professor: tipos das RPCs e textos montados na tela.
// A conta da multa é do servidor (private.teacher_departure_penalty); aqui só
// se formata o que ele devolveu — nunca se recalcula valor no navegador.

export interface DepartureSlot {
  day_of_week: string;
  time_slot: string;
}

export interface DepartureCandidate {
  id: string;
  name: string;
}

export type DepartureOfferStatus = 'PREVIEW' | 'OPEN' | 'CLAIMED' | 'ASSIGNED' | 'CANCELLED';

export interface DepartureStudent {
  offer_id: string | null;
  student_id: string;
  student_name: string;
  blocked: boolean;
  slots: DepartureSlot[];
  status: DepartureOfferStatus;
  claimed_by_name: string | null;
  transfer_status: string | null;
  transfer_cutover: string | null;
  candidates: DepartureCandidate[];
}

export interface DepartureTermPenalty {
  student_id: string;
  student_name: string;
  model: number;
  method: 'MEDIA_DOS_MESES_COMPLETOS' | 'REFERENCIA_X_UNIDADES_X_8_6';
  complete_months: number;
  unit_rate: number;
  units_per_week: number;
  amount: number;
}

export interface DeparturePenalty {
  notice_date: string;
  notice_end: string;
  last_day: string;
  days_served: number;
  days_missing: number;
  contract_version: number;
  contract_clause: string;
  closings: { month: string; amount: number; term_students_share: number }[];
  monthly_base: number;
  general_penalty: number;
  term_penalties: DepartureTermPenalty[];
  term_penalties_total: number;
  total: number;
  transition_bonus_lost: boolean;
  credit: { unpaid_closings: number; current_accrual: number; total: number };
}

export interface DepartureInfo {
  id: string;
  status: 'OPEN' | 'CLOSED';
  notice_received_at: string;
  last_day: string;
  cutover_date: string;
  reason: string;
  created_at: string;
}

export interface MyDepartureOffer {
  offer_id: string;
  student_label: string;
  slots: DepartureSlot[];
  starts_on: string;
}

export const money = (value: number | string | null | undefined): string =>
  `R$ ${Number(value ?? 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

/** "2026-11-27" → "27/11". */
export const dayMonth = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const [, m, d] = iso.slice(0, 10).split('-');
  return d && m ? `${d}/${m}` : '—';
};

export const slotsText = (slots: DepartureSlot[]): string =>
  slots.map(s => `${s.day_of_week} ${s.time_slot}`).join(', ');

/** Situação de cada aluno, em português, para a lista da direção. */
export function studentStatusLabel(s: DepartureStudent): string {
  if (s.status === 'CANCELLED') return 'Retirado da saída';
  if (s.status === 'CLAIMED' || s.status === 'ASSIGNED') {
    const who = s.claimed_by_name ? `com ${s.claimed_by_name.split(' ')[0]}` : 'atribuído';
    if (s.transfer_status === 'PENDING') return `${who} · falta assinar o termo`;
    if (s.transfer_status === 'APPLIED') return `${who} · troca feita`;
    if (s.transfer_status === 'ACCEPTED') return `${who} · troca em ${dayMonth(s.transfer_cutover)}`;
    return who;
  }
  if (s.blocked) return 'Precisa de decisão da direção (cadastro ou financeiro suspenso)';
  if (s.candidates.length === 0) return 'Ninguém tem todos os horários livres';
  return s.status === 'OPEN' ? 'Aberto para os professores' : `${s.candidates.length} professor(es) com os horários livres`;
}

/**
 * Mensagem ao professor que sai, com a conta do servidor. Sempre propõe a
 * compensação por acordo escrito: nenhum contrato permite desconto sozinho.
 */
export function buildPenaltyMessage(teacherName: string, p: DeparturePenalty): string {
  const first = teacherName.trim().split(/\s+/)[0] || teacherName;
  if (p.days_missing <= 0 || p.total <= 0) {
    return `${first}, agradecemos o aviso. Como os 30 dias de transição serão cumpridos, não há multa. Vamos organizar juntos a passagem dos alunos.`;
  }
  const parts: string[] = [];
  if (p.general_penalty > 0) parts.push(`a da cláusula ${p.contract_clause} do contrato geral (${money(p.general_penalty)})`);
  for (const t of p.term_penalties) {
    if (t.amount > 0) parts.push(`a do termo individual de ${t.student_name.split(' ')[0]} (cláusula 5.2, ${money(t.amount)})`);
  }
  const lines = [
    `${first}, pelo contrato o aviso é de 30 dias (de ${dayMonth(p.notice_date)} a ${dayMonth(p.notice_end)}). Encerrando em ${dayMonth(p.last_day)}, ficam ${p.days_missing} dias sem cumprir.`,
    `Isso gera ${parts.join(' e ')}, que somam ${money(p.total)}.`,
  ];
  if (p.credit.total >= p.total) {
    lines.push('A proposta é descontar esse valor do que você tem a receber da escola. Se concordar, é só responder "concordo" aqui.');
  } else {
    lines.push(`Você tem ${money(p.credit.total)} a receber da escola. A proposta é descontar esse valor e acertar a diferença de ${money(p.total - p.credit.total)} por Pix. Se concordar, é só responder "concordo" aqui.`);
  }
  lines.push('Se puder manter alguma aula até os novos professores assumirem, a multa diminui na proporção dos dias. Você tem 5 dias úteis para se manifestar, se quiser.');
  return lines.join('\n\n');
}
