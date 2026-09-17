/// <reference lib="deno.ns" />

/**
 * Professor avisando a instância da escola que não vai dar aula.
 *
 * Decisão pura (testável): reconhecer a intenção, a data e o motivo no texto.
 * A I/O (listar as aulas, perguntar "confirma?", abrir a cobertura do dia,
 * avisar o grupo) fica no index.ts. Falso positivo aqui custa uma pergunta
 * de confirmação; falso negativo custa um professor sem resposta — por isso
 * a regex é generosa e a confirmação é obrigatória.
 */

export interface TeacherAbsenceIntent {
  matched: boolean;
  /** 'AAAA-MM-DD' resolvido a partir de hoje/amanhã/DD-MM; null = não dito (assume hoje). */
  date: string | null;
  reason: string;
}

const NEGACAO =
  "(n[aã]o|nao|nn|num)\\s+(vou|consigo|posso|conseguirei|poderei|irei|tenho como|dá pra|da pra)";
const DAR_AULA =
  "(dar|ministrar|fazer|ter|pegar)\\s+(as?\\s+|minhas?\\s+|nenhuma\\s+)?aulas?";

const PATTERNS: RegExp[] = [
  new RegExp(`${NEGACAO}\\s+((conseguir|poder|ter como)\\s+)?${DAR_AULA}`, "i"),
  new RegExp(
    `${NEGACAO}\\s+((conseguir|poder|ter como)\\s+)?(trabalhar|comparecer|atender)`,
    "i",
  ),
  /(estou|to|tô|acordei|amanheci)\s+(muito\s+)?(doente|mal|gripad[oa]|febril|com\s+febre|com\s+dor|sem\s+voz|de\s+cama)/i,
  /(preciso|vou|terei que|tenho que)\s+faltar/i,
  /n[aã]o\s+(dou|darei)\s+aulas?/i,
  /cancelar\s+(as\s+|minhas\s+)?aulas?\s+de\s+(hoje|amanh[aã])/i,
];

export function normalizeAbsenceText(text: string): string {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\s+/g, " ").trim();
}

function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Data mencionada no texto, resolvida contra `today` (AAAA-MM-DD, fuso da escola). */
export function absenceDateFromText(
  text: string,
  today: string,
): string | null {
  const t = normalizeAbsenceText(text);
  if (/\bamanha\b/.test(t)) return addDays(today, 1);
  if (/\bhoje\b|\bagora\b|\bhj\b/.test(t)) return today;
  const dm = t.match(/\bdia\s+(\d{1,2})(?:\s*\/\s*(\d{1,2}))?/) ||
    t.match(/\b(\d{1,2})\s*\/\s*(\d{1,2})\b/);
  if (dm) {
    const day = Number(dm[1]);
    const [y, m] = today.split("-").map(Number);
    const month = dm[2] ? Number(dm[2]) : m;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = y;
      const candidate = `${year}-${String(month).padStart(2, "0")}-${
        String(day).padStart(2, "0")
      }`;
      if (candidate < today) year += 1;
      return `${year}-${String(month).padStart(2, "0")}-${
        String(day).padStart(2, "0")
      }`;
    }
  }
  return null;
}

export function detectTeacherAbsenceIntent(
  text: string,
  today: string,
): TeacherAbsenceIntent {
  const raw = String(text || "").trim();
  const t = normalizeAbsenceText(raw);
  const matched = PATTERNS.some((re) => re.test(t));
  if (!matched) return { matched: false, date: null, reason: "" };
  const date = absenceDateFromText(raw, today);
  const reasonMatch = t.match(
    /(?:porque|pois|por\s+causa\s+de|por\s+conta\s+de|estou|to|tô|acordei|amanheci)\s+(.{3,80}?)(?:[.!,;]|$)/,
  );
  let reason = reasonMatch ? reasonMatch[1].trim() : "";
  if (
    !reason &&
    /(doente|gripe|febre|garganta|dor|medic|hospital|consulta)/.test(t)
  ) reason = "doente";
  if (!reason) reason = "imprevisto";
  return { matched: true, date, reason: reason.slice(0, 120) };
}

/** Resposta do professor ao "confirma?": sim/não. */
export function absenceConfirmationAnswer(text: string): "yes" | "no" | null {
  const t = normalizeAbsenceText(text);
  if (
    /^(sim|s|ss|isso|confirmo|confirma|pode|pode sim|ok|okay|certo|isso mesmo|exato|claro|por favor|com certeza)\b/
      .test(t)
  ) return "yes";
  if (/^(nao|n|nn|cancela|cancelar|deixa|esquece|negativo|errado)\b/.test(t)) {
    return "no";
  }
  return null;
}

/**
 * Resposta a um convite de cobertura pelo texto ("Consigo sim", "aceito",
 * "não consigo", "infelizmente não"). Mais generoso que o sim/não da falta,
 * porque o professor responde como quem conversa com a coordenação.
 */
export function coverageInviteAnswer(text: string): "yes" | "no" | null {
  const t = normalizeAbsenceText(text);
  if (
    /^(nao|n|nn)\b/.test(t) ||
    /^(infelizmente|nao consigo|nao posso|nao vou|nao da|nao tenho como|dessa vez nao)\b/
      .test(t) ||
    /\b(nao (consigo|posso|vou conseguir|vou poder|da|tenho como))\b/.test(t)
  ) return "no";
  // "Combinado"/"ok"/"perfeito" são acuso de recebimento, não aceite: registrar
  // cobertura (e avisar a família) por um "ok" seria pior que perguntar.
  if (
    /^(sim|s|ss|confirmo|confirma|pode sim|claro|com certeza|consigo|aceito|topo|fechado|fechou|bora|posso|pode ser|vou sim|dou|assumo|eu pego|pego)\b/
      .test(t) ||
    /\b(consigo sim|posso sim|aceito sim|pode deixar|deixa comigo)\b/.test(t)
  ) return "yes";
  return null;
}
