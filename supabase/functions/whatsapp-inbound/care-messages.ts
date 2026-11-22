/**
 * ACOMPANHAMENTO — as mensagens que abrem cada conversa (aluno e professor).
 *
 * Sem banco e sem rede. O `care-sweeper` decide QUANDO (RPCs `care_due_*`) e
 * manda; o `whatsapp-inbound` (agente `care`) conduz a resposta. Texto curto,
 * uma pergunta por vez, sem questionário — a direção pediu conversa, não
 * formulário (17/09/2026).
 */

export interface CareSlot {
  date: string;
  day: string;
  time: string;
  label: string;
}

export interface CareQuota {
  limit: number;
  used: number;
  pending_without_date?: number;
}

export function firstName(raw: string | null | undefined): string {
  const first = String(raw || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$/.test(first)
    ? first.charAt(0).toUpperCase() + first.slice(1)
    : "";
}

export function teacherLabel(raw: string | null | undefined): string {
  const first = firstName(raw);
  return first ? `a teacher ${first}` : "a teacher";
}

/** "4 de 4 por direito" / "3 de 4" / "acima das 4 por direito". */
export function quotaSentence(quota: CareQuota | null | undefined): string {
  if (!quota || !Number.isFinite(Number(quota.limit))) return "";
  const limit = Number(quota.limit);
  const used = Math.max(0, Number(quota.used) || 0);
  const remaining = limit - used;
  if (remaining > 0) {
    return `Você tem direito a ${limit} reposições por mês — este mês ainda ${
      remaining === 1 ? "sobra 1" : `sobram ${remaining}`
    }.`;
  }
  return `Este mês você já usou as ${limit} reposições por direito; a partir daqui a reposição depende de combinar com ${"a teacher"}, sem obrigação — mas vale tentar.`;
}

export function slotsSentence(slots: CareSlot[]): string {
  const list = (slots || []).slice(0, 3);
  if (!list.length) return "";
  return list.map((s) => `• ${s.day} ${s.label}`).join("\n");
}

/**
 * Faltou: só um lembrete (decisão da direção, 21/11/2026). A reposição é um ACORDO entre aluno e
 * professor: a escola não oferece, não sugere, não lista e não marca horário, nem manda link.
 * `quota` e `freeSlots` ficam na assinatura só por compatibilidade; não entram no texto.
 */
export function absenceFollowupMessage(input: {
  studentName: string | null;
  teacherName: string | null;
  classDate: string;
  quota?: CareQuota | null;
  freeSlots?: CareSlot[];
}): string {
  const lead = firstName(input.studentName);
  const [y, m, d] = String(input.classDate || "").split("-");
  const aula = y && m && d ? `na aula de ${d}/${m}` : "na sua aula";
  return `Oi${
    lead ? ", " + lead : ""
  }! Sentimos sua falta ${aula}. Lembre de combinar a reposição dessa aula diretamente com ${
    withTeacher(input.teacherName)
  } antes do fim do mês 😉`;
}

/** "a teacher Debora" ou, sem professor conhecido, "seu professor". */
export function withTeacher(teacherName: string | null | undefined): string {
  const first = firstName(teacherName);
  return first ? `a teacher ${first}` : "seu professor";
}

/**
 * Resposta fixa (sem IA) quando o aluno fala de reposição, remarcação ou propõe dia/horário:
 * a escola não marca nem sugere horário de reposição.
 */
export function makeupWithTeacherReply(
  studentName: string | null,
  teacherName: string | null,
): string {
  const lead = firstName(studentName);
  return `${lead ? lead + ", a" : "A"} reposição é combinada diretamente com ${
    withTeacher(teacherName)
  }, antes do fim do mês 😉 É só falar com ela(e) e escolher juntos o melhor horário.`;
}

const MAKEUP_TOPIC =
  /\b(repo[rs]|reposi[cç][aã]o|reposi[cç][oõ]es|remarc|reagend|desmarc|outro (dia|hor[aá]rio)|nova data|marcar (a |uma )?aula|aula extra|encaixe?)\w*/i;
const WEEKDAY =
  /\b(segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo)(-feira)?\b/i;
const TIME_OR_DATE =
  /\b([01]?\d|2[0-3])\s?(h|hs|hrs|:[0-5]\d)\b|\b\d{1,2}\/\d{1,2}\b|\bamanh[aã]\b/i;

/** O aluno trouxe reposição, remarcação ou um dia/horário: a resposta é fixa. */
export function isMakeupOrSlotMessage(text: string): boolean {
  const value = String(text || "");
  return MAKEUP_TOPIC.test(value) ||
    (TIME_OR_DATE.test(value) &&
      /\b(pode|posso|consigo|d[aá]|fica|serve|quero|marca|vaga|livre|dispon)/i
        .test(value)) ||
    (WEEKDAY.test(value) && TIME_OR_DATE.test(value));
}

/**
 * Trava final de qualquer texto da IA para o aluno: se ele citar horário/dia junto de
 * disponibilidade ou reposição, não sai. Volta a resposta fixa.
 */
export function replyOffersSlot(reply: string): boolean {
  const value = String(reply || "");
  const temHorario = TIME_OR_DATE.test(value) || WEEKDAY.test(value);
  const temOferta =
    /\b(livre|dispon[ií]vel|disponibilidade|tem (hor[aá]rio|vaga)|vagas?|hor[aá]rios?|encaix|marquei|marcad[ao]|agend|reserv|serve|prefere)/i
      .test(value);
  // Dia (ou data) + hora juntos já é um horário concreto: não vai para o aluno.
  const horarioConcreto =
    (WEEKDAY.test(value) || /\b\d{1,2}\/\d{1,2}\b/.test(value)) &&
    /\b([01]?\d|2[0-3])\s?(h|:[0-5]\d)/i.test(value);
  return horarioConcreto ||
    (temHorario && (temOferta || MAKEUP_TOPIC.test(value))) ||
    /\bhor[aá]rios? livres?\b/i.test(value);
}

/** Sexta: como foi a semana. Uma pergunta, resposta livre. */
export function weeklyCheckinMessage(input: {
  studentName: string | null;
  teacherName: string | null;
  classesThisWeek: number;
}): string {
  const lead = firstName(input.studentName);
  const teacher = teacherLabel(input.teacherName);
  return `Oi${
    lead ? ", " + lead : ""
  }! Como foi a semana de aulas com ${teacher}? Me conta o que você achou 😊`;
}

/** A cada 30 dias: o curso está te atendendo? */
export function monthlyCheckinMessage(input: {
  studentName: string | null;
  teacherName: string | null;
  monthsEnrolled: number;
}): string {
  const lead = firstName(input.studentName);
  const time = input.monthsEnrolled >= 12
    ? "mais de um ano"
    : input.monthsEnrolled >= 2
    ? `${input.monthsEnrolled} meses`
    : "um mês";
  return `Oi${
    lead ? ", " + lead : ""
  }! Já faz ${time} que você está com a gente 🐺 Queria saber de você: o curso está te atendendo do jeito que você esperava? O que você mudaria?`;
}

/** Professor: o aluno faltou e não respondeu ao contato da escola. */
export function teacherAbsenceNudgeMessage(input: {
  teacherName: string | null;
  studentName: string | null;
  classDate: string;
  quota: CareQuota | null;
  freeSlots: CareSlot[];
}): string {
  const teacher = firstName(input.teacherName);
  const student = firstName(input.studentName) || "o aluno";
  const [y, m, d] = String(input.classDate || "").split("-");
  const when = y && m && d ? `${d}/${m}` : "ontem";
  const remaining = input.quota
    ? Math.max(0, Number(input.quota.limit) - Number(input.quota.used || 0))
    : null;
  const slots = (input.freeSlots || []).slice(0, 2).map((s) => s.label);
  const suggestion = slots.length
    ? `Oi, ${student}! Senti sua falta em ${when}. Quer marcar a reposição? Tenho ${
      slots.join(" ou ")
    }.`
    : `Oi, ${student}! Senti sua falta em ${when}. Quer marcar a reposição? Me diz um dia que fica bom para você.`;
  return `Teacher${
    teacher ? " " + teacher : ""
  }, ${student} faltou em ${when} e não respondeu ao contato da escola. ` +
    (remaining !== null
      ? `Ele(a) ${
        remaining > 0
          ? `ainda tem ${remaining} de 4 reposições este mês`
          : "já usou as 4 reposições por direito este mês"
      }. `
      : "") +
    `Vale uma mensagem sua puxando o comparecimento — quem cobra a reposição fideliza.\n\nSugestão: "${suggestion}"`;
}

/** Professor: 2+ remarcações no mês → a regra da casa, sem sermão. */
export function teacherReschedulePolicyMessage(input: {
  teacherName: string | null;
  reschedules30d: number;
}): string {
  const teacher = firstName(input.teacherName);
  return `Teacher${
    teacher ? " " + teacher : ""
  }, notamos ${input.reschedules30d} remarcações suas nos últimos 30 dias. Lembrando a regra da casa, com carinho:\n\n` +
    `• A primeira opção é a *cobertura*, não a remarcação: mande "Não vou conseguir dar aula dia X" para este número com antecedência e a escola encontra quem dê a aula. O aluno não perde o horário e você não perde o aluno.\n` +
    `• Remarcar com o aluno só se ele topar — o horário dele é contratado; a remarcação pesa mais para quem tem rotina cheia.\n` +
    `• Emergência acontece e a escola dá todo o suporte. O que pedimos é o aviso cedo.\n\n` +
    `Tem algum horário que não está fechando na sua agenda? Me conta que a gente ajusta.`;
}

/** Professor: check-in mensal, resposta livre. */
export function teacherMonthlyCheckinMessage(input: {
  teacherName: string | null;
  classes30d: number;
}): string {
  const teacher = firstName(input.teacherName);
  return `Teacher${
    teacher ? " " + teacher : ""
  }, tudo bem? Passando para saber como estão as aulas 😊 Algum aluno faltando demais, algum horário que não fecha, algo que a escola pode ajustar para você? Pode responder por aqui mesmo.`;
}
