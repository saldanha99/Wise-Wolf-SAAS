/**
 * REMARCAÇÃO DE EXPERIMENTAL — decisão pura, sem banco e sem rede.
 *
 * O caso real (13/08/2026, lead Rafael Varela): o aluno marcou a experimental
 * para quinta às 12:00, a Teacher Lais ACEITOU (opportunity CLAIMED +
 * appointment `experimental` na agenda dela), e o aluno então falou direto com
 * a professora que não dava meio-dia e sim 16:00. Quando ele avisou a mesma
 * coisa no WhatsApp central, a atendente criou uma SEGUNDA oportunidade às
 * 16:00 e disparou o link de aceite para todos os professores livres — sendo
 * que a aula já tinha dono e o horário já estava resolvido entre os dois.
 *
 * O `dispatchTrial` só sabia deduplicar contra oportunidade AINDA ABERTA e com
 * data+hora IDÊNTICAS. Ou seja: assim que um professor aceitava, o aluno pedir
 * outro horário virava disparo novo — e o `funnel-sweeper` ainda re-disparava a
 * sobra 20 min depois, para a escola inteira.
 *
 * A regra que fica: **experimental com professor já definido se REMARCA, não se
 * redisparar.** Só volta a leiloar quando não há dono, ou quando o dono tem
 * conflito real de agenda no horário novo — e aí quem decide é gente, não o robô.
 */

/** Fuso de Brasília. As edge functions rodam em UTC; a escola pensa em BRT. */
export const BRT_OFFSET = "-03:00";

export interface Slot {
  date: string; // YYYY-MM-DD (BRT)
  time: string; // HH:MM (BRT)
}

/** Compromisso já existente na agenda do professor, para checagem de conflito. */
export interface BusyBlock {
  startIso: string;
  label: string;
}

/** Experimental que já tem professor dono e continua de pé. */
export interface ActiveTrial {
  opportunityId: string;
  appointmentId: string;
  teacherId: string;
  teacherName: string;
  /** Já normalizado; null quando o cadastro não tem telefone utilizável. */
  teacherPhone: string | null;
  /** `appointments.start_time` como está no banco (UTC). */
  startIso: string;
}

export type TrialDecision =
  /** Não existe experimental com dono → leilão normal, como sempre foi. */
  | { action: "broadcast" }
  /** Já existe, no MESMO horário pedido → não faz nada (nem novo disparo). */
  | { action: "keep"; trial: ActiveTrial; slot: Slot }
  /** Já existe em outro horário e o dono está livre → move a aula. */
  | { action: "reschedule"; trial: ActiveTrial; from: Slot; to: Slot; newStartIso: string }
  /** Já existe, mas o dono tem conflito no horário novo → decide um humano. */
  | { action: "escalate"; trial: ActiveTrial; from: Slot; to: Slot; conflict: string };

/** Converte data+hora de Brasília no instante UTC que o banco guarda. */
export function brtStartIso(date: string, time: string): string {
  return new Date(`${date}T${time}:00${BRT_OFFSET}`).toISOString();
}

/** Devolve data e hora de Brasília a partir do instante gravado no banco. */
export function brtSlotFromIso(iso: string): Slot {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  const brt = new Date(d.getTime() - 3 * 3600 * 1000);
  return {
    date: brt.toISOString().slice(0, 10),
    time: brt.toISOString().slice(11, 16),
  };
}

/**
 * A experimental ainda está de pé?
 *
 * Só `scheduled` conta: cancelada, dada (`completed`) ou furada (`no_show`) já
 * encerraram o ciclo, e aí um pedido novo do aluno é uma experimental nova de
 * verdade — tem de ir a leilão.
 *
 * A janela para trás existe porque appointment antigo esquecido em `scheduled`
 * é comum (a liquidação é manual, pelo painel do diretor). Sem ela, uma aula de
 * três semanas atrás sequestraria o agendamento novo do mesmo aluno.
 */
export function isTrialAppointmentActive(
  status: string | null | undefined,
  startIso: string,
  nowIso: string,
  staleDays = 7,
): boolean {
  if (String(status || "").toLowerCase() !== "scheduled") return false;
  const start = new Date(startIso).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(start) || Number.isNaN(now)) return false;
  return start >= now - staleDays * 86400000;
}

/** Minutos entre dois instantes (sempre positivo). */
export function minutesApart(aIso: string, bIso: string): number {
  return Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) / 60000;
}

/**
 * Decide o que fazer com o horário que o lead acabou de pedir.
 *
 * `busy` deve trazer os compromissos do PRÓPRIO professor dono da experimental
 * (a dela mesma, no horário antigo, já sai fora antes de chegar aqui). A regra
 * de intervalo é a mesma da tela de aceite: 30 min de início a início.
 *
 * ⚠️ Disponibilidade DECLARADA (`teacher_availability`) de propósito NÃO entra
 * aqui. A professora e o aluno combinaram o horário novo por fora; exigir que
 * ele estivesse na grade cadastrada recusaria exatamente o caso que existe para
 * ser atendido. O que barra é conflito de verdade — aula marcada em cima.
 */
export function decideTrialAction(opts: {
  existing: ActiveTrial | null;
  requested: Slot;
  busy?: BusyBlock[];
  bufferMinutes?: number;
}): TrialDecision {
  const { existing, requested } = opts;
  if (!existing) return { action: "broadcast" };

  const from = brtSlotFromIso(existing.startIso);
  if (from.date === requested.date && from.time === requested.time) {
    return { action: "keep", trial: existing, slot: requested };
  }

  const newStartIso = brtStartIso(requested.date, requested.time);
  if (Number.isNaN(new Date(newStartIso).getTime())) {
    return { action: "keep", trial: existing, slot: from };
  }

  const buffer = opts.bufferMinutes ?? 30;
  const conflito = (opts.busy || [])
    .filter((b) => b.startIso !== existing.startIso)
    .find((b) => minutesApart(b.startIso, newStartIso) < buffer);

  if (conflito) {
    return { action: "escalate", trial: existing, from, to: requested, conflict: conflito.label };
  }
  return { action: "reschedule", trial: existing, from, to: requested, newStartIso };
}
