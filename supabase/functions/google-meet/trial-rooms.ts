/**
 * Aula experimental conferida pela sala da escola no Meet (31/10/2026).
 *
 * A direção aprovava cada experimental à mão no painel. Agora a sala é criada
 * pela conta central, sem transcrição nem anotações (o lead não aceitou termo
 * nenhum), só com o relatório de presença do Google. Depois da aula, esta
 * decisão diz se professor e lead estiveram na sala — e o banco liquida.
 *
 * Puro de propósito: a regra é o que paga (ou não) o professor, e tem teste.
 * Na dúvida não decide: devolve um resultado que deixa a aula no painel.
 */

export type TrialOutcome =
  | "ATTENDED"
  | "NO_SHOW"
  | "TEACHER_ABSENT"
  | "NO_CONFERENCE"
  | "NO_REPORT"
  | "UNCERTAIN";

export interface TrialAttendanceInput {
  conferenceCount: number;
  conferenceOpen: boolean;
  reportFound: boolean;
  parseError: boolean;
  teacherSeconds: number;
  leadSeconds: number;
  /** Minutos que professor E lead precisam ter ficado na sala. */
  minMinutes: number;
  /** Última rodada (6 h depois do início): sem sala ou sem relatório, encerra. */
  final: boolean;
}

/** Abaixo disso a pessoa não entrou de verdade (clicou e saiu). */
export const TRIAL_PRESENT_FLOOR_SECONDS = 60;

/** null = ainda não dá para decidir; a próxima rodada confere de novo. */
export function trialAttendanceOutcome(
  input: TrialAttendanceInput,
): TrialOutcome | null {
  if (input.conferenceOpen) return null;
  if (input.conferenceCount <= 0) return input.final ? "NO_CONFERENCE" : null;
  if (!input.reportFound) return input.final ? "NO_REPORT" : null;
  if (input.parseError) return "UNCERTAIN";
  const min = Math.max(5, input.minMinutes) * 60;
  const teacher = Math.max(0, input.teacherSeconds || 0);
  const lead = Math.max(0, input.leadSeconds || 0);
  if (teacher >= min && lead >= min) return "ATTENDED";
  if (teacher < TRIAL_PRESENT_FLOOR_SECONDS) return "TEACHER_ABSENT";
  if (teacher >= min && lead < TRIAL_PRESENT_FLOOR_SECONDS) return "NO_SHOW";
  // Os dois entraram, mas pouco: conversa curta, queda, aula fora da sala.
  return "UNCERTAIN";
}

/** Janela em que a conferência da experimental é procurada no Meet. */
export function trialConferenceWindow(startIso: string): {
  start: string;
  end: string;
} {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) throw new Error("invalid_session_window");
  return {
    start: new Date(start - 2 * 3600000).toISOString(),
    end: new Date(start + 4 * 3600000).toISOString(),
  };
}
