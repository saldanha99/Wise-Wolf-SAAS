/**
 * Regras de exibição da reposição (espelham as do servidor em
 * `20260918100000_reposicao_com_trilha_e_canais_de_aviso`).
 *
 * O servidor é quem decide: exige motivo na remarcação, grava o evento e
 * avisa a coordenação e a família. Aqui só o que a tela precisa saber antes
 * de chamar a RPC — para pedir o motivo na hora certa e destacar o que é em
 * cima da hora — e o texto do histórico.
 */

export const PENDING_LABEL = 'Pendente';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d/;

/** Reposição já tem data e hora válidas (não é "Pendente"). */
export const hasSlot = (date: string | null | undefined, time: string | null | undefined): boolean =>
  DATE_RE.test((date ?? '').trim()) && TIME_RE.test((time ?? '').trim());

/** Início da reposição no fuso da escola, ou null. */
export const slotStart = (date: string | null | undefined, time: string | null | undefined): Date | null => {
  if (!hasSlot(date, time)) return null;
  const d = new Date(`${(date as string).trim()}T${(time as string).trim().slice(0, 5)}:00-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Mexer numa reposição que começa (ou começava) em menos de 3 h. */
export const isSoon = (date: string | null | undefined, time: string | null | undefined, now: Date = new Date()): boolean => {
  const start = slotStart(date, time);
  if (!start) return false;
  const diff = start.getTime() - now.getTime();
  return diff > -3 * 60 * 60 * 1000 && diff < 3 * 60 * 60 * 1000;
};

/** Remarcar (já tinha data) e mudar de data/hora exige motivo — igual ao servidor. */
export const reasonRequired = (
  current: { date: string | null | undefined; time: string | null | undefined },
  next: { date: string; time: string },
): boolean => {
  if (!hasSlot(current.date, current.time)) return false;
  return (current.date as string).trim() !== next.date.trim()
    || (current.time as string).trim().slice(0, 5) !== next.time.trim().slice(0, 5);
};

export interface RescheduleEventRow {
  id: string;
  reschedule_id: string;
  action: string;
  from_date: string | null;
  from_time: string | null;
  to_date: string | null;
  to_time: string | null;
  source: string;
  reason: string | null;
  em_cima_da_hora: boolean;
  created_at: string;
  actor?: { full_name: string | null } | null;
}

const ACTION_LABEL: Record<string, string> = {
  criada: 'criada',
  marcada: 'marcada',
  remarcada: 'remarcada',
  desmarcada: 'desmarcada',
  professor_trocado: 'passou de professor',
  atestada: 'atestada pela direção',
  dada: 'dada',
};

const SOURCE_LABEL: Record<string, string> = {
  app: 'pela plataforma',
  whatsapp_professor: 'pelo WhatsApp do professor',
  whatsapp_aluno: 'pelo aluno no WhatsApp',
  direcao: 'pela direção',
  sistema: 'pelo sistema',
};

const brDate = (iso: string | null | undefined): string | null => {
  if (!iso || !DATE_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y.slice(2)}`;
};

/** Uma linha do histórico: "remarcada 18/09 16:00 → 21/09 16:00 · pela plataforma · Bruna · motivo: …" */
export const describeRescheduleEvent = (e: RescheduleEventRow): string => {
  const parts: string[] = [ACTION_LABEL[e.action] ?? e.action];
  const from = brDate(e.from_date) ? `${brDate(e.from_date)} ${(e.from_time ?? '').slice(0, 5)}`.trim() : null;
  const to = brDate(e.to_date) ? `${brDate(e.to_date)} ${(e.to_time ?? '').slice(0, 5)}`.trim() : null;
  if (e.action === 'remarcada' && from && to) parts[0] += ` ${from} → ${to}`;
  else if (e.action === 'marcada' && to) parts[0] += ` para ${to}`;
  else if (e.action === 'desmarcada' && from) parts[0] += ` (era ${from})`;
  if (e.em_cima_da_hora) parts[0] += ' ⚠️ em cima da hora';
  parts.push(SOURCE_LABEL[e.source] ?? e.source);
  const who = e.actor?.full_name?.trim();
  if (who) parts.push(who.split(' ')[0]);
  if (e.reason) parts.push(`motivo: ${e.reason}`);
  return parts.join(' · ');
};
