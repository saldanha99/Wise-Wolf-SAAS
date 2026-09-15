/**
 * NEGOCIAÇÃO DE RENOVAÇÃO — leitura e escrita de mensagens, sem banco e sem rede.
 *
 * Fluxo definido pela direção em 15/09/2026: o aluno que está renovando pede
 * outro horário no WhatsApp → pergunta-se primeiro ao professor que já dá aula
 * para ele → se ele não puder, ele propõe outro horário e o pedido volta ao
 * aluno → só sem acordo procura-se outro professor → a Gestão aprova e o link sai.
 *
 * Este módulo só LÊ texto humano e ESCREVE mensagens. Quem decide estado,
 * choque de agenda e valor é o banco (migration 20260915175000). O modelo de
 * linguagem ajuda a entender o aluno; os horários que valem são os que o
 * parser abaixo consegue ler — e o banco revalida.
 */

export interface RenewalSlot {
  day: string; // Segunda … Sábado
  time: string; // HH:MM
}

const DAYS: Array<[RegExp, string]> = [
  [/^seg(unda)?(-feira)?$/, "Segunda"],
  [/^ter(ca)?(-feira)?$/, "Terça"],
  [/^qua(rta)?(-feira)?$/, "Quarta"],
  [/^qui(nta)?(-feira)?$/, "Quinta"],
  [/^sex(ta)?(-feira)?$/, "Sexta"],
  [/^sab(ado)?$/, "Sábado"],
];

function foldText(text: string): string {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Lê dias e horas escritos como gente escreve:
 * "segunda 14h, terça e sexta 14:30" → Seg 14:00, Ter 14:30, Sex 14:30.
 * Um horário vale para os dias citados antes dele; horário antes de qualquer
 * dia vale para os dias que vierem depois sem horário próprio.
 */
export function parseRenewalSlots(text: string): RenewalSlot[] {
  const source = foldText(text);
  const tokens: Array<{ index: number; day?: string; time?: string }> = [];
  const dayRe =
    /\b(seg(?:unda)?(?:-feira)?|ter(?:ca)?(?:-feira)?|qua(?:rta)?(?:-feira)?|qui(?:nta)?(?:-feira)?|sex(?:ta)?(?:-feira)?|sab(?:ado)?)\b/g;
  for (const match of source.matchAll(dayRe)) {
    const day = DAYS.find(([re]) => re.test(match[1]))?.[1];
    if (day) tokens.push({ index: match.index ?? 0, day });
  }
  const timeRe =
    /(?:\bas\s+)?\b([01]?\d|2[0-3])\s*(?:h\s*([0-5]\d)?|:([0-5]\d))(?![\d])/g;
  for (const match of source.matchAll(timeRe)) {
    const minutes = match[2] ?? match[3] ?? "00";
    tokens.push({
      index: match.index ?? 0,
      time: `${pad2(Number(match[1]))}:${minutes}`,
    });
  }
  const bareRe = /\bas\s+([01]?\d|2[0-3])\b(?!\s*(?:x|vez|h|:))/g;
  for (const match of source.matchAll(bareRe)) {
    if (tokens.some((token) => token.time && token.index === match.index)) {
      continue;
    }
    tokens.push({ index: match.index ?? 0, time: `${pad2(Number(match[1]))}:00` });
  }
  tokens.sort((a, b) => a.index - b.index);

  const slots: RenewalSlot[] = [];
  let pending: string[] = [];
  let leadingTime: string | null = null;
  let lastTime: string | null = null;
  for (const token of tokens) {
    if (token.day) {
      if (!pending.includes(token.day)) pending.push(token.day);
      continue;
    }
    if (!token.time) continue;
    if (pending.length === 0) {
      if (slots.length === 0) leadingTime = token.time;
      lastTime = token.time;
      continue;
    }
    for (const day of pending) slots.push({ day, time: token.time });
    pending = [];
    lastTime = token.time;
  }
  const trailingTime = leadingTime ?? lastTime;
  if (pending.length && trailingTime) {
    for (const day of pending) slots.push({ day, time: trailingTime });
  }
  const seen = new Set<string>();
  return slots.filter((slot) => {
    const key = `${slot.day} ${slot.time}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "3x", "3 vezes", "três vezes por semana" → 3. */
export function parseRenewalFrequency(text: string): number | null {
  const source = foldText(text);
  const digit = source.match(/\b([1-7])\s*(?:x|vezes|vez)\b/);
  if (digit) return Number(digit[1]);
  const words: Record<string, number> = {
    uma: 1,
    duas: 2,
    tres: 3,
    quatro: 4,
    cinco: 5,
    seis: 6,
  };
  const word = source.match(/\b(uma|duas|tres|quatro|cinco|seis)\s+vez(?:es)?\b/);
  return word ? words[word[1]] : null;
}

/** Código curto da mensagem (#A1B2C3D4). */
export function renewalReplyCode(text: string): string | null {
  const match = String(text || "").toUpperCase().match(/(?:#|\b)([A-F0-9]{8})\b/);
  return match?.[1] || null;
}

export type RenewalTeacherReply =
  | { decision: "ACCEPT" }
  | { decision: "DECLINE" }
  | { decision: "COUNTER"; slots: RenewalSlot[] }
  | { decision: "UNKNOWN" };

/**
 * Resposta do professor ao pedido de horário. Horário citado = contraproposta,
 * mesmo começando com "não" ("não consigo, mas posso seg 15h").
 */
export function classifyRenewalTeacherReply(text: string): RenewalTeacherReply {
  const withoutCode = String(text || "").replace(/#?\b[A-Fa-f0-9]{8}\b/g, " ");
  const reply = foldText(withoutCode).replace(/\s+/g, " ").trim();
  if (!reply) return { decision: "UNKNOWN" };
  const slots = parseRenewalSlots(withoutCode);
  if (slots.length) return { decision: "COUNTER", slots };
  if (/\b(talvez|acho que|nao sei|vou ver|confirmo depois)\b/.test(reply)) {
    return { decision: "UNKNOWN" };
  }
  if (/^(nao|n)\b|\b(nao consigo|nao posso|sem horario|indisponivel|impossivel)\b/.test(reply)) {
    return { decision: "DECLINE" };
  }
  if (/^(sim|s|pode|posso|consigo|confirmo|aceito|fechado|ok|beleza|combinado)\b/.test(reply)) {
    return { decision: "ACCEPT" };
  }
  return { decision: "UNKNOWN" };
}

export type RenewalManagementCommand =
  | { action: "approve"; code: string; feeCents: number | null }
  | { action: "decline"; code: string };

/** "aprovar #A1B2C3D4", "aprovar #A1B2C3D4 261", "aprovar A1B2C3D4 R$ 261,00", "recusar #A1B2C3D4". */
export function parseRenewalManagementCommand(
  text: string,
): RenewalManagementCommand | null {
  const match = foldText(text).match(
    /^\s*(aprovar|aprova|aprovado|aprovo|recusar|recusa|recusado|negar|nega)\s+#?([a-f0-9]{8})\b(?:\s+(?:por\s+)?(?:r\$\s*)?(\d{2,5})(?:[.,](\d{2}))?)?\s*$/,
  );
  if (!match) return null;
  const code = match[2].toUpperCase();
  if (/^(recus|neg)/.test(match[1])) return { action: "decline", code };
  const feeCents = match[3]
    ? Number(match[3]) * 100 + Number(match[4] ?? "0")
    : null;
  return { action: "approve", code, feeCents };
}

export function renewalSlotsText(slots: RenewalSlot[]): string {
  const parts = slots.map((slot) => `${slot.day} ${slot.time}`);
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

export function brl(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2).replace(".", ",")}`;
}

function firstName(name: string | null | undefined, fallback: string): string {
  return String(name || "").trim().split(/\s+/)[0] || fallback;
}

export function teacherRenewalRequestMessage(input: {
  teacherName: string | null;
  studentName: string | null;
  classesPerWeek: number;
  slots: RenewalSlot[];
  busySlots: RenewalSlot[];
  code: string;
  currentTeacher: boolean;
}): string {
  const intro = input.currentTeacher
    ? `a renovação de *${input.studentName || "seu aluno"}* está em andamento e ele(a) pediu`
    : `temos uma renovação de *${input.studentName || "aluno"}* procurando professor. O pedido é`;
  const busy = input.busySlots.length
    ? `\n⚠️ Pela agenda você já tem aula em ${renewalSlotsText(input.busySlots)}.`
    : "";
  return `Oi, ${firstName(input.teacherName, "teacher")}! ${
    intro.charAt(0).toUpperCase() + intro.slice(1)
  } *${input.classesPerWeek}x por semana*: ${renewalSlotsText(input.slots)}.${busy}\n\nVocê consegue? Responda:\n• *SIM #${input.code}* — fechado\n• *NÃO #${input.code}* — não consigo\n• ou proponha outro horário, ex.: *#${input.code} seg 15h, qua 15h, sex 15h*`;
}

export function managementRenewalApprovalMessage(input: {
  studentName: string | null;
  teacherName: string | null;
  classesPerWeek: number;
  slots: RenewalSlot[];
  suggestedFeeCents: number | null;
  code: string;
}): string {
  const fee = input.suggestedFeeCents
    ? `💰 Valor sugerido: *${brl(input.suggestedFeeCents)}*/mês`
    : "💰 Sem valor na tabela para essa frequência: informe o valor ao aprovar";
  const approve = input.suggestedFeeCents
    ? `*aprovar #${input.code}* (ou *aprovar #${input.code} 261* para outro valor)`
    : `*aprovar #${input.code} <valor>* — ex.: *aprovar #${input.code} 261*`;
  return `🔁 *RENOVAÇÃO — APROVAR?*\n\n👤 Aluno(a): *${
    input.studentName || "Aluno"
  }*\n👩‍🏫 ${input.teacherName || "Professor(a)"} confirmou\n🕑 ${input.classesPerWeek}x por semana: ${
    renewalSlotsText(input.slots)
  }\n${fee}\n\nPara aprovar: ${approve}\nPara recusar: *recusar #${input.code}*`;
}

export function studentRenewalProposalMessage(input: {
  studentName: string | null;
  teacherName: string | null;
  slots: RenewalSlot[];
}): string {
  return `${firstName(input.studentName, "Oi")}, a teacher ${
    firstName(input.teacherName, "")
  } não consegue nos horários que você pediu, mas pode em: *${
    renewalSlotsText(input.slots)
  }*. Esses horários funcionam para você? Responda *sim* para seguirmos, ou me diga outros horários.`;
}
