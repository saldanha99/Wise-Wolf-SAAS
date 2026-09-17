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

/** Faltou ontem: acolhe, dá o direito e já oferece horário. */
export function absenceFollowupMessage(input: {
  studentName: string | null;
  teacherName: string | null;
  classDate: string;
  quota: CareQuota | null;
  freeSlots: CareSlot[];
}): string {
  const lead = firstName(input.studentName);
  const teacher = teacherLabel(input.teacherName);
  const [y, m, d] = String(input.classDate || "").split("-");
  const when = y && m && d ? `${d}/${m}` : "ontem";
  const quota = quotaSentence(input.quota).replace("a teacher", teacher);
  const slots = slotsSentence(input.freeSlots);
  const remaining = input.quota
    ? Number(input.quota.limit) - Number(input.quota.used || 0)
    : 1;
  const offer = remaining > 0
    ? (slots
      ? `${
        teacher.charAt(0).toUpperCase() + teacher.slice(1)
      } tem horário livre em:\n${slots}\n\nQuer um desses, ou prefere outro dia?`
      : `Quer que eu veja um horário para repor, com ${teacher} ou com outro professor?`)
    : `Se quiser tentar repor mesmo assim, me diz um dia e horário que eu vejo com ${teacher}.`;
  return `Oi${
    lead ? ", " + lead : ""
  }! Sentimos sua falta na aula de ${when} com ${teacher} 😊 Tudo bem por aí?\n\n${quota}\n\n${offer}`;
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
