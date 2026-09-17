import { isHolidayBR } from "../whatsapp-inbound/holidays.ts";

export interface AvailableTrialSlot {
  date: string;
  time: string;
  teacher_id: string;
  teacher_name: string;
  phone: string;
}

export const localDate = (now = Date.now()) =>
  new Date(now - 3 * 3600000).toISOString().slice(0, 10);
const dayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const minuteOf = (time: string) =>
  Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const periodOf = (time: string) =>
  minuteOf(time) < 720 ? "manha" : minuteOf(time) < 1080 ? "tarde" : "noite";
const normalize = (text: string) =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** This is a suggestion, not a reservation. The acceptance path still owns the agenda. */
export async function loadAvailableTrialSlots(
  sb: any,
  tenantId: string,
  from = localDate(),
  teacherId: string | null = null,
  days = 14,
): Promise<AvailableTrialSlot[]> {
  const { data, error } = await sb.rpc("sdr_available_trial_slots", {
    p_tenant_id: tenantId,
    p_from: from,
    p_days: days,
    p_teacher_id: teacherId,
  });
  if (error) throw new Error("sdr_availability_unavailable");
  return (data || []).filter((slot: AvailableTrialSlot) =>
    !isHolidayBR(slot.date)
  );
}

export function rankTrialAlternatives(
  rows: AvailableTrialSlot[],
  requested: { date: string; time: string } | null,
  preferences = "",
  now = Date.now(),
): AvailableTrialSlot[] {
  const pref = normalize(preferences);
  const days = [
    "domingo",
    "segunda",
    "terca",
    "quarta",
    "quinta",
    "sexta",
    "sabado",
  ];
  const allPeriods = ["manha", "tarde", "noite"];
  // Explicit exclusions are hard constraints; ordinary preferences only rank.
  const excluded = new Set<string>();
  const negative =
    /\b(?:nao(?: posso| consigo| tenho disponibilidade)?|nunca|exceto|menos)\s+(?:(?:pela|de|a|as|na|nas|no|nos)\s+)?(domingo|segunda|terca|quarta|quinta|sexta|sabado|manha|tarde|noite)\b/g;
  for (const match of pref.matchAll(negative)) excluded.add(match[1]);
  const periods = allPeriods.filter((p) =>
    pref.includes(p) && !excluded.has(p)
  );
  const preferredDays = days.map((d, i) =>
    pref.includes(d) && !excluded.has(d) ? i : -1
  ).filter((d) => d >= 0);
  const only = /\b(so|somente|apenas)\b/.test(pref);
  // Janela dita pelo lead ("seg–sex depois das 18h") é filtro duro quando
  // existe opção dentro dela; sem opção nenhuma, "só/somente" fecha a porta
  // e o resto cai no ranqueamento brando de sempre.
  const windows = parseAvailabilityWindows(preferences);
  const inWindow = filterSlotsByWindows(rows, windows);
  const pool = windows.length && inWindow.length
    ? inWindow
    : windows.length && only
    ? []
    : rows;
  const unique = new Map<string, AvailableTrialSlot>();
  for (const row of pool) {
    if (
      Date.parse(`${row.date}T${row.time}:00-03:00`) <= now ||
      isHolidayBR(row.date) || dayOf(row.date) === 0
    ) continue;
    if (
      excluded.has(periodOf(row.time)) || excluded.has(days[dayOf(row.date)])
    ) continue;
    if (only && periods.length && !periods.includes(periodOf(row.time))) {
      continue;
    }
    if (
      only && preferredDays.length && !preferredDays.includes(dayOf(row.date))
    ) continue;
    if (requested?.date === row.date && requested?.time === row.time) continue;
    unique.set(`${row.date}:${row.time}`, row);
  }
  const score = (row: AvailableTrialSlot) =>
    (periods.length && !periods.includes(periodOf(row.time)) ? 10000 : 0) +
    (preferredDays.length && !preferredDays.includes(dayOf(row.date))
      ? 5000
      : 0) +
    (requested
      ? (row.time === requested.time
        ? 0
        : dayOf(row.date) === dayOf(requested.date)
        ? 500
        : 1000) + Math.abs(minuteOf(row.time) - minuteOf(requested.time))
      : 0);
  return [...unique.values()].sort((a, b) =>
    score(a) - score(b) ||
    `${a.date}:${a.time}`.localeCompare(`${b.date}:${b.time}`)
  ).slice(0, 2);
}

export function alternativeQuestion(slots: AvailableTrialSlot[]): string {
  if (!slots.length) {
    return "Qual outro dia e período funciona para você? Vou verificar uma nova opção com o professor.";
  }
  const options = slots.map((s) => formatSlotBr(s));
  return `Posso verificar ${
    options.join(" ou ")
  }, sujeito ao aceite do professor. Qual opção funciona para você?`;
}

export function availableMenu(slots: AvailableTrialSlot[]): string {
  const byDate = new Map<string, Set<string>>();
  for (const slot of slots) {
    if (!byDate.has(slot.date)) byDate.set(slot.date, new Set());
    byDate.get(slot.date)!.add(slot.time);
  }
  // A data ISO fica porque schedule_trial precisa dela; o rótulo "sex 18/09"
  // é o que a atendente deve escrever para o lead.
  return [...byDate].map(([date, times]) =>
    `${date} (${WEEKDAY_SHORT[dayOf(date)]} ${date.slice(8, 10)}/${
      date.slice(5, 7)
    }): ${[...times].sort().join(", ")}`
  ).join(" | ") ||
    "(nenhuma opção livre encontrada; peça outro período ou chame a coordenação)";
}

// ─────────────────────────────────────────────────────────────────────────────
// JANELA DE DISPONIBILIDADE DO LEAD (17/09/2026)
//
// A Ana Carolina disse "sábados ou dias de semana depois das 18h". A atendente
// ofereceu "2026-09-19 às 09:00" (sábado sem professor nenhum, data crua) e,
// quando o leilão falhou, sugeriu 18/09 e 21/09 às 10:30 — de manhã, num dia
// útil, ignorando as duas coisas que ela tinha dito. Aqui a frase vira janela
// (dias × faixa de horário), a lista dada ao modelo é filtrada por ela, e a
// resposta que oferece horário fora da lista é vetada pelo código.
// ─────────────────────────────────────────────────────────────────────────────

export interface AvailabilityWindow {
  /** Dias (getDay: 1=seg … 6=sáb); null = qualquer dia. */
  days: number[] | null;
  /** Minutos desde 00:00, inclusive; null = sem limite. */
  fromMin: number | null;
  /** Minutos desde 00:00, exclusivo; null = sem limite. */
  toMin: number | null;
}

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WEEKDAY_LONG = [
  "domingo",
  "segunda",
  "terça",
  "quarta",
  "quinta",
  "sexta",
  "sábado",
];
const HOUR_RE = String
  .raw`(\d{1,2})(?:\s*[:h]\s*(\d{2}))?\s*(?:h(?:rs|s|oras)?\b)?`;
const DAY_PATTERNS: Array<[RegExp, number[]]> = [
  [/\b(?:fim|final|fins|finais)\s+de\s+semana\b|\bfds\b/, [6]],
  [
    /\b(?:dias?\s+(?:de|da)\s+semana|durante\s+a\s+semana|semana\s+(?:toda|inteira)|de\s+segunda\s+a\s+sexta|segunda\s+a\s+sexta|dias?\s+uteis)\b/,
    [1, 2, 3, 4, 5],
  ],
  [/\bsegundas?\b/, [1]],
  [/\btercas?\b/, [2]],
  [/\bquartas?\b/, [3]],
  [/\bquintas?\b/, [4]],
  [/\bsextas?\b/, [5]],
  [/\bsabados?\b/, [6]],
];
const PERIODS: Array<[RegExp, number, number]> = [
  [/\bmanha\b|\bcedo\b/, 6 * 60, 12 * 60],
  [/\btarde\b/, 12 * 60, 18 * 60],
  [/\bnoite\b|\bnoturno\b/, 18 * 60, 24 * 60],
  [
    /\b(?:hora|horario)\s+d[eo]\s+almoco\b|\bmeio[- ]dia\b/,
    11 * 60 + 30,
    14 * 60,
  ],
];

const toMinutes = (h: string, m: string | undefined): number | null => {
  const hour = Number(h);
  const minute = Number(m || "0");
  if (!Number.isInteger(hour) || hour < 5 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
};
const hhmm = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${
    String(min % 60).padStart(2, "0")
  }`;

/**
 * "Sábados ou durante a semana após as 18h" → [{sáb}, {seg–sex, ≥18:00}].
 * Segmentos separados por "ou"/";"/quebra de linha; dentro de um segmento os
 * dias somam e a faixa de horário é uma só. Trecho negado ("não posso à
 * noite") não vira janela — a exclusão continua com `rankTrialAlternatives`.
 * Hora solta ("às 18h") vale uma hora; com data por perto ("dia 26, 10:30")
 * é escolha de horário, não disponibilidade, e é ignorada.
 */
export function parseAvailabilityWindows(text: string): AvailabilityWindow[] {
  const windows: AvailabilityWindow[] = [];
  const segments = normalize(String(text || "")).split(
    /\s+ou\s+|[;\n]|\.\s+|\bmas\b/,
  );
  for (const raw of segments) {
    const seg = ` ${raw.trim()} `;
    if (!seg.trim()) continue;
    if (/\b(?:nao|nunca|exceto|menos|sem|jamais)\b/.test(seg)) continue;
    const days = new Set<number>();
    for (const [re, list] of DAY_PATTERNS) {
      if (re.test(seg)) list.forEach((d) => days.add(d));
    }
    let fromMin: number | null = null;
    let toMin: number | null = null;
    const range = seg.match(
      new RegExp(
        String.raw`\b(?:entre|das|de)\s+` + HOUR_RE +
          String.raw`\s*(?:e|a|as|ate|-|–)\s+` + HOUR_RE,
      ),
    );
    const after = seg.match(
      new RegExp(
        String
          .raw`\b(?:depois|apos|a\s+partir|apartir)\s+(?:d[aeo]s?|as|de)?\s*` +
          HOUR_RE,
      ),
    );
    const before = seg.match(
      new RegExp(
        String.raw`\b(?:antes|ate)\s+(?:d[aeo]s?|as|de)?\s*` + HOUR_RE,
      ),
    );
    if (range) {
      fromMin = toMinutes(range[1], range[2]);
      toMin = toMinutes(range[3], range[4]);
      if (fromMin !== null && toMin !== null && toMin <= fromMin) toMin = null;
    } else {
      if (after) fromMin = toMinutes(after[1], after[2]);
      if (before) toMin = toMinutes(before[1], before[2]);
    }
    const periodWindows: Array<[number, number]> = [];
    if (fromMin === null && toMin === null) {
      for (const [re, from, to] of PERIODS) {
        if (re.test(seg)) periodWindows.push([from, to]);
      }
      if (!periodWindows.length && !/\d{1,2}\/\d{1,2}|\bdia\s+\d/.test(seg)) {
        const lone = seg.match(
          new RegExp(String.raw`\b(?:as|às|so|somente|apenas)?\s*` + HOUR_RE),
        );
        // hora solta só conta quando vem com marca de hora ("18h", "18:30")
        if (lone && /\d\s*(?:h|:)/.test(lone[0])) {
          const min = toMinutes(lone[1], lone[2]);
          if (min !== null) {
            fromMin = min;
            toMin = Math.min(min + 60, 24 * 60);
          }
        }
      }
    }
    const dayList = days.size ? [...days].sort() : null;
    if (periodWindows.length) {
      for (const [from, to] of periodWindows) {
        windows.push({ days: dayList, fromMin: from, toMin: to });
      }
    } else if (dayList || fromMin !== null || toMin !== null) {
      windows.push({ days: dayList, fromMin, toMin });
    }
  }
  return windows;
}

export function slotInWindows(
  slot: { date: string; time: string },
  windows: AvailabilityWindow[],
): boolean {
  if (!windows.length) return true;
  const day = dayOf(slot.date);
  const min = minuteOf(slot.time);
  return windows.some((w) =>
    (w.days === null || w.days.includes(day)) &&
    (w.fromMin === null || min >= w.fromMin) &&
    (w.toMin === null || min < w.toMin)
  );
}

export function filterSlotsByWindows<T extends { date: string; time: string }>(
  slots: T[],
  windows: AvailabilityWindow[],
): T[] {
  return windows.length
    ? slots.filter((s) => slotInWindows(s, windows))
    : slots;
}

/** "de segunda a sexta depois das 18:00", "sábados", "à noite (18:00–24:00)". */
export function describeWindow(w: AvailabilityWindow): string {
  let days = "";
  if (w.days && w.days.length) {
    const set = [...w.days].sort().join(",");
    days = set === "1,2,3,4,5"
      ? "de segunda a sexta"
      : set === "6"
      ? "aos sábados"
      : w.days.map((d) => WEEKDAY_LONG[d]).join(", ");
  }
  let time = "";
  if (w.fromMin !== null && w.toMin !== null) {
    time = `entre ${hhmm(w.fromMin)} e ${hhmm(w.toMin)}`;
  } else if (w.fromMin !== null) time = `depois das ${hhmm(w.fromMin)}`;
  else if (w.toMin !== null) time = `antes das ${hhmm(w.toMin)}`;
  return [days, time].filter(Boolean).join(" ") || "qualquer horário";
}

/**
 * Fatos para o prompt: o que o lead disse, quantas opções da lista casam e,
 * principalmente, qual pedaço da preferência NÃO tem professor (sábado, na
 * Wise Wolf) — para a atendente dizer isso em vez de inventar.
 */
export function availabilityFacts(
  windows: AvailabilityWindow[],
  slots: Array<{ date: string; time: string }>,
): string {
  if (!windows.length) return "";
  const parts = windows.map((w) => {
    const n = slots.filter((s) => slotInWindows(s, [w])).length;
    return n
      ? `${describeWindow(w)} → ${n} opções na lista`
      : `${describeWindow(w)} → NENHUM professor livre (diga isso com clareza)`;
  });
  return `DISPONIBILIDADE QUE O LEAD JÁ DISSE: ${
    parts.join("; ")
  }. Ofereça SÓ horários que casem com essa disponibilidade; se um pedaço dela não tem professor, diga e proponha o que existe dentro do resto da preferência.`;
}

/** Só os pedaços da preferência sem professor nenhum, em frase para o lead. */
export function unavailablePreferenceNote(
  windows: AvailabilityWindow[],
  slots: Array<{ date: string; time: string }>,
): string {
  const missing = windows.filter((w) =>
    !slots.some((s) => slotInWindows(s, [w]))
  );
  if (!missing.length) return "";
  return `${
    missing.map((w) => describeWindow(w)).join(" e ")
  } não temos professor no momento 😕 `.replace(/^./, (c) => c.toUpperCase());
}

/** "sex 18/09 às 18:00" — nunca a data ISO crua que o modelo copiava. */
export function formatSlotBr(slot: { date: string; time: string }): string {
  const [, m, d] = slot.date.split("-");
  return `${WEEKDAY_SHORT[dayOf(slot.date)]} ${d}/${m} às ${slot.time}`;
}

export function humanizeIsoDates(text: string): string {
  return String(text || "").replace(
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    (_m, _y, mm, dd) => `${dd}/${mm}`,
  );
}

/** Pares data+horário que a resposta oferece ("19/09 às 09:00", ISO ou dd/mm). */
export function offeredSlotsInReply(
  reply: string,
): Array<{ monthDay: string; time: string }> {
  const text = humanizeIsoDates(reply);
  const out: Array<{ monthDay: string; time: string }> = [];
  const dateRe = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
  for (const m of text.matchAll(dateRe)) {
    const tail = text.slice(
      m.index! + m[0].length,
      m.index! + m[0].length + 60,
    );
    const t = tail.match(/(\d{1,2})[:h](\d{2})\b/);
    if (!t) continue;
    const dd = m[1].padStart(2, "0");
    const mm = m[2].padStart(2, "0");
    out.push({
      monthDay: `${mm}-${dd}`,
      time: `${t[1].padStart(2, "0")}:${t[2]}`,
    });
  }
  return out;
}

/** true quando a resposta oferece data+horário que não está na lista livre. */
export function replyOffersUnknownSlot(
  reply: string,
  slots: Array<{ date: string; time: string }>,
): boolean {
  const known = new Set(slots.map((s) => `${s.date.slice(5)} ${s.time}`));
  return offeredSlotsInReply(reply).some((o) =>
    !known.has(`${o.monthDay} ${o.time}`)
  );
}
