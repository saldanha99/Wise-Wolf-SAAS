/**
 * ACOMPANHAMENTO — a conversa depois do toque (aluno matriculado e professor).
 *
 * Sem banco e sem rede: aqui se lê o que o aluno respondeu (escolheu um horário?
 * quer outro dia? fala de dinheiro?) e se monta o que a IA precisa saber. Quem
 * grava, marca reposição e avisa a coordenação é o `index.ts`.
 *
 * Regra dura da direção (17/09/2026): aluno contratado passa a conversar com a
 * IA SÓ neste acompanhamento, e a IA nunca fala de cobrança, contrato,
 * pagamento ou valor — isso vai para gente, sempre.
 */

import type { CareQuota, CareSlot } from "./care-messages.ts";

export interface CareContext {
  id: string;
  kind: string;
  status: string;
  subject_role: "STUDENT" | "TEACHER";
  subject_id: string;
  subject_name: string | null;
  teacher_id?: string | null;
  teacher_name?: string | null;
  quota?: CareQuota | null;
  reschedule_id?: string | null;
  context?: Record<string, unknown> | null;
  summary?: string | null;
}

export interface CareModelReply {
  reply: string;
  sentiment: "POSITIVE" | "NEUTRAL" | "NEGATIVE";
  summary: string;
  wants_slot: { date: string; time: string } | null;
  handoff: boolean;
  close: boolean;
}

const fold = (text: string): string =>
  String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Dinheiro é assunto de gente: PIX, boleto, mensalidade, contrato, cancelar. */
export function isMoneyOrContractTopic(text: string): boolean {
  return /\b(pix|boleto|fatura|cobran|mensalidade|pagamen|pagar|paguei|valor|preco|preço|desconto|cart[aã]o|assinatura|contrato|cancelar|cancelamento|rescis|reembolso|estorno|vencimento|multa)\b/i
    .test(fold(text));
}

const WEEKDAYS: Record<string, string> = {
  segunda: "Segunda",
  terca: "Terça",
  quarta: "Quarta",
  quinta: "Quinta",
  sexta: "Sexta",
  sabado: "Sábado",
};

function parseTime(text: string): string | null {
  const source = fold(text);
  const m = source.match(/\b(\d{1,2})\s*(?::|h)\s*(\d{2})?\b/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  if (hour > 23 || (minute !== 0 && minute !== 30)) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function parseWeekday(text: string): string | null {
  const source = fold(text);
  for (const [key, name] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${key}\\b`).test(source)) return name;
  }
  return null;
}

function parseDayMonth(text: string): string | null {
  const m = String(text || "").match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (!m) return null;
  return `${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; // MM-DD
}

/**
 * O aluno escolheu um dos horários oferecidos? Aceita "1", "o primeiro",
 * "sexta", "9h", "18/09 às 10:30", "pode ser o das 10:30". Devolve o slot ou
 * null — em dúvida (dois slots batem), null: a IA pergunta qual.
 */
export function pickOfferedSlot(
  text: string,
  slots: CareSlot[],
): CareSlot | null {
  const offered = (slots || []).filter((s) => s && s.date && s.time);
  if (!offered.length) return null;
  const source = fold(text).trim();
  const ordinal = source.match(
    /^(?:o |a |pode ser o |pode ser a |quero o |quero a |vou de |fico com o |fico com a )?(1|2|3|primeir[oa]|segund[oa]|terceir[oa]|ultim[oa])\b[\s!.]*$/,
  );
  // "segunda" sozinha é dia da semana quando há slot na segunda — só vira
  // ordinal ("a segunda opção") quando não há.
  const ordinalIsWeekday = ordinal && /^segunda$/.test(ordinal[1]) &&
    offered.some((s) => s.day === "Segunda");
  if (ordinal && !ordinalIsWeekday) {
    const key = ordinal[1];
    const index = /^(1|primeir)/.test(key)
      ? 0
      : /^(2|segund)/.test(key)
      ? 1
      : /^(3|terceir)/.test(key)
      ? 2
      : offered.length - 1;
    return offered[index] || null;
  }
  const time = parseTime(source);
  const weekday = parseWeekday(source);
  const dayMonth = parseDayMonth(text);
  let candidates = offered;
  if (dayMonth) {
    candidates = candidates.filter((s) => s.date.slice(5) === dayMonth);
  }
  if (weekday) candidates = candidates.filter((s) => s.day === weekday);
  if (time) candidates = candidates.filter((s) => s.time === time);
  if (!dayMonth && !weekday && !time) return null;
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Pedido de horário fora da lista ("quinta às 19h", "sexta 10h"): dia da semana
 * + hora → a data mais próxima daquele dia (a partir de amanhã). Sem hora não
 * dá para marcar; a IA pergunta.
 */
export function parseRequestedSlot(
  text: string,
  todayIso: string,
): { date: string; day: string; time: string } | null {
  const weekday = parseWeekday(text);
  const time = parseTime(text);
  const dayMonth = parseDayMonth(text);
  if (!time) return null;
  const today = new Date(`${todayIso}T12:00:00Z`);
  if (dayMonth) {
    const [mm, dd] = dayMonth.split("-");
    const year = today.getUTCFullYear();
    let candidate = new Date(Date.UTC(year, Number(mm) - 1, Number(dd), 12));
    if (candidate.getTime() <= today.getTime()) {
      candidate = new Date(Date.UTC(year + 1, Number(mm) - 1, Number(dd), 12));
    }
    const dayName = [
      "Domingo",
      "Segunda",
      "Terça",
      "Quarta",
      "Quinta",
      "Sexta",
      "Sábado",
    ][candidate.getUTCDay()];
    return { date: candidate.toISOString().slice(0, 10), day: dayName, time };
  }
  if (!weekday) return null;
  const target = Object.values(WEEKDAYS).indexOf(weekday) + 1; // 1..6
  for (let i = 1; i <= 7; i++) {
    const candidate = new Date(today.getTime() + i * 86400000);
    if (candidate.getUTCDay() === target) {
      return { date: candidate.toISOString().slice(0, 10), day: weekday, time };
    }
  }
  return null;
}

/** Lê o JSON do modelo com tolerância; sem `reply` não há resposta. */
export function parseCareModelReply(raw: unknown): CareModelReply | null {
  const value = raw && typeof raw === "object"
    ? raw as Record<string, unknown>
    : null;
  if (!value) return null;
  const reply = String(value.reply || "").trim();
  if (!reply) return null;
  const sentiment = ["POSITIVE", "NEUTRAL", "NEGATIVE"].includes(
      String(value.sentiment || "").toUpperCase(),
    )
    ? String(value.sentiment).toUpperCase() as CareModelReply["sentiment"]
    : "NEUTRAL";
  const slot = value.wants_slot && typeof value.wants_slot === "object"
    ? value.wants_slot as Record<string, unknown>
    : null;
  const wants = slot &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(slot.date || "")) &&
      /^\d{2}:\d{2}$/.test(String(slot.time || ""))
    ? { date: String(slot.date), time: String(slot.time) }
    : null;
  return {
    reply: reply.slice(0, 1200),
    sentiment,
    summary: String(value.summary || "").trim().slice(0, 400),
    wants_slot: wants,
    handoff: value.handoff === true,
    close: value.close === true,
  };
}

const KIND_GOAL: Record<string, string> = {
  ABSENCE_FOLLOWUP:
    "O aluno faltou à aula e você abriu a conversa oferecendo a reposição. Objetivo: acolher, entender o motivo sem cobrar, e fechar um horário de reposição (se ele ainda tiver direito). Se ele disser que a rotina mudou, anote e ofereça falar com a coordenação sobre o horário fixo.",
  WEEKLY_CHECKIN:
    "Você perguntou como foi a semana de aulas. Objetivo: ouvir de verdade — o que gostou, o que travou —, reagir ao que ele disser e, se houver incômodo com a professora, ritmo ou conteúdo, registrar e encaminhar.",
  MONTHLY_CHECKIN:
    "Você perguntou se o curso está atendendo o que ele esperava. Objetivo: entender expectativa x realidade (fala? entende? sente evolução?), acolher crítica sem se defender, e registrar o que a escola precisa ajustar.",
};

/** O que a IA precisa para conduzir como gente — e o que ela NUNCA faz. */
export function buildCareSystemPrompt(input: {
  agentName: string;
  schoolName: string;
  ctx: CareContext;
  offeredSlots: CareSlot[];
  todayIso: string;
}): string {
  const { ctx } = input;
  const student = String(ctx.subject_name || "").split(/\s+/)[0] || "o aluno";
  const teacher = ctx.teacher_name
    ? `Teacher ${String(ctx.teacher_name).split(/\s+/)[0]}`
    : "a professora";
  const quota = ctx.quota
    ? `Reposições por direito: ${ctx.quota.limit} por mês; usadas este mês: ${ctx.quota.used}; ${
      Number(ctx.quota.limit) - Number(ctx.quota.used) > 0
        ? `ainda tem ${Number(ctx.quota.limit) - Number(ctx.quota.used)}`
        : "acima do direito — a partir daqui é combinação com a professora, sem obrigação"
    }.`
    : "";
  const slots = input.offeredSlots.length
    ? `Horários livres de ${teacher} que você pode oferecer (só estes): ${
      input.offeredSlots.map((s) => `${s.day} ${s.label} (${s.date} ${s.time})`)
        .join("; ")
    }.`
    : `Sem horário livre de ${teacher} nos próximos dias: se ele quiser repor, diga que vai pedir à coordenação um encaixe (com ela ou com outro professor).`;
  return [
    `Você é ${input.agentName}, da equipe da ${input.schoolName}, conversando pelo WhatsApp com ${student}, aluno(a) matriculado(a). Você é uma pessoa da escola cuidando do aluno — não um robô de pesquisa.`,
    `SITUAÇÃO: ${
      KIND_GOAL[ctx.kind] || "Conversa de acompanhamento com o aluno."
    }`,
    `Professor(a) do aluno: ${teacher}. Hoje: ${input.todayIso}. ${quota} ${slots}`,
    ctx.summary ? `Já anotado nesta conversa: ${ctx.summary}` : "",
    "COMO CONVERSAR: curto (1 a 3 frases), tom de WhatsApp, no máximo 1 emoji, UMA pergunta por vez. Reaja ao que ele disse antes de perguntar. Nunca repita uma frase que já mandou (o histórico mostra). Não mande questionário nem peça nota.",
    "REGRAS DURAS: NUNCA fale de cobrança, pagamento, valor, boleto, PIX, contrato, cancelamento ou multa — se ele tocar nisso, diga que vai passar para a coordenação e marque handoff=true. Não prometa mudança de professor, de horário fixo ou de plano: registre e diga que a coordenação retorna (handoff=true). Não invente horário fora da lista. Reposição só dentro do direito; acima disso, diga que depende de combinar com a professora e encaminhe.",
    'QUANDO O ALUNO ESCOLHER UM HORÁRIO DA LISTA: preencha wants_slot com date e time exatos daquele item e confirme em uma frase (ex.: "Fechado: sexta 18/09 às 09:00 com a Teacher Lais — ela já fica sabendo"). Se ele pedir um horário fora da lista, não confirme: diga que vai verificar com a professora e deixe wants_slot com o horário pedido (date/time) para o sistema conferir.',
    "SENTIMENTO: sentiment=NEGATIVE quando ele reclama, está insatisfeito ou quer parar; POSITIVE quando elogia ou está satisfeito; NEUTRAL no resto. summary = uma linha objetiva para a coordenação (o que ele disse e o que precisa). close=true quando a conversa se encerrou naturalmente (despedida, agradecimento sem pendência).",
    'Responda SOMENTE com JSON válido: {"reply": "texto ao aluno", "sentiment": "POSITIVE|NEUTRAL|NEGATIVE", "summary": "uma linha", "wants_slot": {"date": "YYYY-MM-DD", "time": "HH:MM"} | null, "handoff": false, "close": false}',
  ].filter(Boolean).join("\n");
}

/** Resposta pronta quando o aluno traz dinheiro/contrato: nada de IA aqui. */
export function moneyHandoffReply(studentName: string | null): string {
  const first = String(studentName || "").trim().split(/\s+/)[0];
  return `${
    first ? first + ", " : ""
  }esse assunto eu passo para a coordenação, que te responde por aqui mesmo em breve, tá? 😊`;
}
