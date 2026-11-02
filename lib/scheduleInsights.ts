// Leitura inteligente da grade semanal (Mapa de Aulas e agenda do professor).
//
// A grade tem 37 linhas de 30 min (06:00–00:00) × 6 dias. Para quase todo
// professor, metade disso é horário em que ele não trabalha: o diretor via um
// paredão de blocos escuros antes de chegar na primeira aula. Estas funções
// decidem o que mostrar e o que resumir — sem mexer em nenhuma regra de agenda.
// Tudo puro e testado (lib/scheduleInsights.test.ts).

export type SlotState = 'booked' | 'event' | 'free' | 'off';

// O estado de UMA célula (dia × horário). Quem chama decide a precedência:
// aula fixa > evento de um dia > livre > fora da grade.
export type SlotReader = (dayIdx: number, time: string) => SlotState;

export type GridRow =
  | { kind: 'time'; time: string }
  | { kind: 'gap'; from: string; to: string; count: number };

const isQuiet = (state: SlotState) => state === 'off';

/**
 * Recolhe horários em que NENHUM dia tem nada (nem aula, nem evento, nem
 * horário livre declarado).
 *
 * - Pontas vazias somem (o dia começa na primeira linha com alguma coisa).
 * - Miolo vazio de `minGap` linhas ou mais vira UMA linha "sem agenda", para o
 *   diretor saber que ali existe um intervalo e não um defeito da tela.
 * - Miolo vazio curto (almoço de 30 min) continua visível: recolher uma linha
 *   só para trocá-la por outra linha não economiza nada.
 */
export const compactRows = (
  times: string[],
  days: number,
  read: SlotReader,
  minGap = 3,
): GridRow[] => {
  const used = times.map(time => {
    for (let d = 0; d < days; d++) if (!isQuiet(read(d, time))) return true;
    return false;
  });
  const first = used.indexOf(true);
  if (first === -1) return [];
  const last = used.lastIndexOf(true);

  const rows: GridRow[] = [];
  let i = first;
  while (i <= last) {
    if (used[i]) {
      rows.push({ kind: 'time', time: times[i] });
      i++;
      continue;
    }
    let j = i;
    while (j <= last && !used[j]) j++;
    const run = j - i;
    if (run >= minGap) {
      rows.push({ kind: 'gap', from: times[i], to: times[j - 1], count: run });
    } else {
      for (let k = i; k < j; k++) rows.push({ kind: 'time', time: times[k] });
    }
    i = j;
  }
  return rows;
};

export interface DayLoad {
  dayIdx: number;
  booked: number;
  events: number;
  free: number;
  // 0–1: quanto do que o professor ofereceu no dia já está ocupado.
  fill: number;
}

export const dayLoads = (times: string[], days: number, read: SlotReader): DayLoad[] =>
  Array.from({ length: days }, (_, dayIdx) => {
    let booked = 0;
    let events = 0;
    let free = 0;
    for (const time of times) {
      const s = read(dayIdx, time);
      if (s === 'booked') booked++;
      else if (s === 'event') events++;
      else if (s === 'free') free++;
    }
    const offered = booked + events + free;
    return { dayIdx, booked, events, free, fill: offered > 0 ? (booked + events) / offered : 0 };
  });

export interface FreeWindow {
  dayIdx: number;
  start: string;
  // Horário em que a janela TERMINA (início do último slot + 30 min).
  end: string;
  slots: number;
}

const addHalfHour = (time: string): string => {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + 30;
  const hh = Math.floor(total / 60) % 24;
  return `${String(hh).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Blocos contínuos de horário livre — o que o diretor procura quando vai
 * encaixar um aluno de 2× na semana ou uma aula de 1 h (dois slots seguidos).
 * Ordem: maior bloco primeiro; empate, o mais cedo na semana.
 */
export const freeWindows = (
  times: string[],
  days: number,
  read: SlotReader,
  minSlots = 2,
): FreeWindow[] => {
  const out: FreeWindow[] = [];
  for (let d = 0; d < days; d++) {
    let i = 0;
    while (i < times.length) {
      if (read(d, times[i]) !== 'free') { i++; continue; }
      let j = i;
      while (j < times.length && read(d, times[j]) === 'free') j++;
      const slots = j - i;
      if (slots >= minSlots) out.push({ dayIdx: d, start: times[i], end: addHalfHour(times[j - 1]), slots });
      i = j;
    }
  }
  return out.sort((a, b) => b.slots - a.slots || a.dayIdx - b.dayIdx || a.start.localeCompare(b.start));
};

/** "1h30", "2h", "30 min" — duração de uma janela em slots de 30 min. */
export const formatSlots = (slots: number): string => {
  const minutes = slots * 30;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${m}` : `${h}h`;
};

/**
 * Linha da grade que contém `now` ("10:47" → "10:30"), ou null fora do
 * horário da grade. Só faz sentido na coluna de hoje da semana atual.
 */
export const currentSlot = (times: string[], now: Date): string | null => {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const slot = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${minutes % 60 < 30 ? '00' : '30'}`;
  return times.includes(slot) ? slot : null;
};

/** Fração (0–1) já percorrida do slot atual, para a linha "agora" andar. */
export const slotProgress = (now: Date): number => (now.getMinutes() % 30) / 30;
