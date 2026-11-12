/// <reference lib="deno.ns" />
/**
 * Frequência pretendida do lead (direção, 12/11/2026).
 *
 * Antes da experimental a atendente SONDA quantas vezes por semana o lead
 * pensa em estudar — deixando claro que é só para checar se o horário dele tem
 * vaga para continuar depois. Com a resposta, o sistema estima, a partir dos
 * mesmos horários livres que a atendente já consulta (14 dias), em quantos dias
 * da semana cada professor tem aquele horário livre. É ESPECULAÇÃO: nada é
 * reservado; a regra de ouro é nunca dizer "reservado" ou "garantido".
 */

export interface FreeSlot {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  teacher_id: string;
  teacher_name: string;
}

const NUMBER_WORDS: Record<string, number> = {
  uma: 1,
  um: 1,
  duas: 2,
  dois: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
};

const fold = (text: string) =>
  text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * "2x por semana", "duas vezes", "3 vezes na semana", "todo dia" → número.
 * Só aceita quando o texto fala de frequência (vez/vezes/x/semana/dia):
 * "tenho 2 filhos" não vira 2x.
 */
export function parseWeeklyFrequency(raw: string): number | null {
  const text = fold(raw || "");
  if (
    /\b(todo|todos os) dias?\b|\bdiariamente\b|\bde segunda a sexta\b/.test(
      text,
    )
  ) {
    return 5;
  }
  const m = text.match(
    /\b(\d|uma|um|duas|dois|tres|quatro|cinco|seis)\s*(?:x|vez|vezes)\b(?:\s*(?:por|na|a|ao|p\/)?\s*(?:semana|semanal))?/,
  );
  if (!m) return null;
  const n = /^\d$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
  return n >= 1 && n <= 6 ? n : null;
}

const minuteOf = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

export const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/**
 * Dias da semana (1=seg … 6=sáb) em que o professor tem `time` livre, ou até
 * `toleranceMin` minutos antes/depois — o horário do aluno raramente precisa
 * ser idêntico nos dias. Domingo não conta.
 */
export function teacherWeeklyDays(
  slots: FreeSlot[],
  teacherId: string,
  time: string,
  toleranceMin = 30,
): number[] {
  const target = minuteOf(time);
  const days = new Set<number>();
  for (const s of slots) {
    if (s.teacher_id !== teacherId) continue;
    if (Math.abs(minuteOf(s.time) - target) > toleranceMin) continue;
    const dow = weekdayOf(s.date);
    if (dow >= 1 && dow <= 6) days.add(dow);
  }
  return [...days].sort((a, b) => a - b);
}

/** Maior número de dias que algum professor livre naquele horário oferece. */
export function slotWeeklyCapacity(
  slot: FreeSlot,
  all: FreeSlot[],
): { days: number[]; teacherName: string } {
  let best = { days: [] as number[], teacherName: slot.teacher_name };
  for (const candidate of all) {
    if (candidate.date !== slot.date || candidate.time !== slot.time) continue;
    const days = teacherWeeklyDays(all, candidate.teacher_id, slot.time);
    if (days.length > best.days.length) {
      best = { days, teacherName: candidate.teacher_name };
    }
  }
  return best;
}

/**
 * Horários de experimental que comportam a frequência pretendida. Sem
 * frequência, devolve a lista como veio. Se nenhum horário comporta, devolve
 * a lista original com `fits = false` — a atendente explica e oferece o mais
 * próximo, mas o agendamento nunca é bloqueado por causa disto.
 */
export function slotsFittingFrequency<T extends FreeSlot>(
  menu: T[],
  all: FreeSlot[],
  frequency: number | null,
): { slots: T[]; fits: boolean } {
  if (!frequency || frequency <= 1) return { slots: menu, fits: true };
  const fitting = menu.filter((slot) =>
    slotWeeklyCapacity(slot, all).days.length >= frequency
  );
  return fitting.length
    ? { slots: fitting, fits: true }
    : { slots: menu, fits: false };
}

const firstName = (raw: string) =>
  String(raw || "").trim().split(/\s+/)[0] || "";

/**
 * Fatos curtos para o prompt: por horário (HH:MM), quantos dias por semana o
 * melhor professor livre teria. A atendente transforma isso numa frase.
 */
export function weeklyFrequencyFacts(
  menu: FreeSlot[],
  all: FreeSlot[],
  frequency: number | null,
  fits: boolean,
  limit = 4,
): string {
  const byTime = new Map<string, { days: number[]; teacherName: string }>();
  for (const slot of menu) {
    const cap = slotWeeklyCapacity(slot, all);
    const prev = byTime.get(slot.time);
    if (!prev || cap.days.length > prev.days.length) byTime.set(slot.time, cap);
  }
  const lines = [...byTime.entries()]
    .sort((a, b) =>
      b[1].days.length - a[1].days.length || a[0].localeCompare(b[0])
    )
    .slice(0, limit)
    .map(([time, cap]) =>
      `• ${time}: Teacher ${firstName(cap.teacherName)} tem ${
        cap.days.map((d) => WEEKDAY_SHORT[d]).join(", ") || "só este dia"
      } livres (${cap.days.length}x/semana)`
    );
  if (!lines.length) return "";
  const head = frequency
    ? fits
      ? `PRÉVIA DE CONTINUIDADE (lead pensa em ~${frequency}x/semana; a lista acima já mostra só horários que comportam isso):`
      : `PRÉVIA DE CONTINUIDADE (lead pensa em ~${frequency}x/semana; NENHUM horário da lista comporta isso hoje — diga com transparência quantos dias cabem e ofereça o horário que chega mais perto):`
    : "PRÉVIA DE CONTINUIDADE (estimativa por horário, caso o lead diga a frequência):";
  return `\n${head}\n${lines.join("\n")}`;
}

/** Regra fixa do prompt: sondagem transparente, uma vez, sem prometer vaga. */
export const LEAD_FREQUENCY_RULE =
  `- FREQUÊNCIA PRETENDIDA: quando o lead estiver escolhendo o horário da experimental e ainda não se souber quantas vezes por semana ele pensa em estudar, pergunte UMA vez, deixando claro o motivo e que não é compromisso. Ex.: "Pra eu já ver qual professor combina com sua rotina: se você gostar da aula, quantas vezes por semana pensa em estudar? Não precisa ser exato, é só pra eu checar se o horário que você escolheu tem vaga pra continuar depois." Grave a resposta em updates.weekly_frequency (número de 1 a 6). Se ele não souber ou não quiser dizer, siga sem insistir. Com a frequência conhecida, use a PRÉVIA DE CONTINUIDADE em UMA frase ("às 19h tem professor com seg, qua e sex livres, então dá pra seguir nesse horário"). NUNCA diga "reservado", "garantido" ou "vaga confirmada" — diga "tem vaga hoje" ou "dá pra seguir". Nunca deixe de marcar a experimental só por causa da frequência.`;
