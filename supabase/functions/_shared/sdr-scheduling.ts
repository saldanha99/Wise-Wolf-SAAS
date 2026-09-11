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
  const unique = new Map<string, AvailableTrialSlot>();
  for (const row of rows) {
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
  const options = slots.map((s) =>
    `${s.date.split("-").reverse().join("/")} às ${s.time}`
  );
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
  return [...byDate].map(([date, times]) =>
    `${date}: ${[...times].sort().join(", ")}`
  ).join(" | ") ||
    "(nenhuma opção livre encontrada; peça outro período ou chame a coordenação)";
}
