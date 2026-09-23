/**
 * FECHAMENTO DA EXPERIMENTAL — leitura de texto humano e escrita de mensagens.
 *
 * Sem banco e sem rede: quem decide estado, pagamento da aula, preço e horário
 * é o banco (migration 20260915179000). Aqui só se lê o que a professora e o
 * aluno escreveram e se monta o que eles vão ler.
 *
 * O fluxo, decidido com a direção em 15/09/2026: 40 min depois da experimental
 * o bot pergunta à professora se a aula aconteceu; com o "sim" a aula é lançada
 * (é o que paga a professora) e o aluno é chamado para escolher frequência,
 * horário e plano; o link de matrícula sai com o preço da tabela e a Gestão é
 * avisada de cada link.
 */

import { parseRenewalSlots, type RenewalSlot } from "./renewal-negotiation.ts";

export interface TrialOutcomeReply {
  outcome: "DONE" | "NO_SHOW" | null;
  level: string | null;
  interest: number | null;
  plan: string | null;
}

export interface CatalogPrice {
  frequency: number;
  duration: number;
  value: number;
}

function foldText(text: string): string {
  return String(text || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function firstName(raw: string | null | undefined): string {
  const first = String(raw || "").trim().split(/\s+/)[0] || "";
  return /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$/.test(first)
    ? first.charAt(0).toUpperCase() + first.slice(1)
    : "";
}

/**
 * Lê a resposta da professora: se a aula aconteceu, o nível do aluno, o
 * interesse de 1 a 5 e quantas aulas por semana ela recomenda.
 * "SIM A2 4 2x" é o formato pedido, mas a ordem não importa e cada pedaço pode
 * vir numa mensagem separada.
 */
export function parseTrialOutcomeReply(text: string): TrialOutcomeReply {
  const source = foldText(text);
  const negative =
    /\b(faltou|nao veio|nao compareceu|nao apareceu|nao aconteceu|nao teve|nao rolou|nao deu|furou|no show|noshow|desmarcou|cancelou)\b/
      .test(source) || /^\s*(nao|n)\b/.test(source);
  const positive =
    /\b(sim|s|aconteceu|ocorreu|rolou|deu certo|fizemos|fiz|feita|realizada|teve aula|dei a aula|compareceu|veio)\b/
      .test(source);
  const outcome: TrialOutcomeReply["outcome"] = negative
    ? "NO_SHOW"
    : positive
    ? "DONE"
    : null;

  const levelMatch = source.match(/\b([abc][12])\b/);
  let level = levelMatch ? levelMatch[1].toUpperCase() : null;
  if (!level) {
    if (/\b(iniciante|basico|comecando|do zero)\b/.test(source)) level = "A1";
    else if (/\b(intermediario)\b/.test(source)) level = "B1";
    else if (/\b(avancado|fluente)\b/.test(source)) level = "C1";
  }

  let plan: string | null = null;
  const planMatch = source.match(/\b([1-7])\s*(?:x|vezes|vez)\b/);
  if (/\bintensivo\b/.test(source)) plan = "intensivo";
  else if (planMatch) {
    const times = Number(planMatch[1]);
    plan = times >= 4 ? "intensivo" : `${times}x_semana`;
  }

  // O interesse é o número solto que sobra depois de tirar nível e frequência —
  // senão o "2" de "2x" viraria nota 2.
  const withoutTokens = source
    .replace(/\b[abc][12]\b/g, " ")
    .replace(/\b[1-7]\s*(?:x|vezes|vez)\b/g, " ")
    .replace(/\b([01]?\d|2[0-3])\s*(?:h|:)\s*[0-5]?\d?\b/g, " ");
  const scored = withoutTokens.match(/\b(?:interesse|nota)\s*([1-5])\b/) ||
    withoutTokens.match(/\b([1-5])\s*\/\s*5\b/) ||
    withoutTokens.match(/\b([1-5])\b/);
  const interest = scored ? Number(scored[1]) : null;

  return { outcome, level, interest, plan };
}

/** "12 meses", "anual", "um ano" → 12; "semestral" → 6; "mensal" → 1. */
export function parseEnrollmentDuration(text: string): number | null {
  const source = foldText(text);
  if (/\b(12\s*meses|anual|um ano|1 ano|fidelidade de 12)\b/.test(source)) {
    return 12;
  }
  if (/\b(6\s*meses|seis meses|semestral|semestre)\b/.test(source)) return 6;
  if (/\b(mensal|sem fidelidade|1\s*mes|um mes|mes a mes)\b/.test(source)) {
    return 1;
  }
  return null;
}

/** Os horários que o aluno escreveu, com a mesma leitura da renovação. */
export function parseEnrollmentSlots(text: string): RenewalSlot[] {
  return parseRenewalSlots(text);
}

export function slotsText(slots: RenewalSlot[]): string {
  return slots.map((slot) => `${slot.day} às ${slot.time}`).join(" · ");
}

export function brlFromNumber(value: number): string {
  return `R$ ${
    Number(value).toFixed(2).replace(".", ",").replace(
      /\B(?=(\d{3})+(?!\d))/g,
      ".",
    )
  }`;
}

/** O cardápio de preços, só das frequências que a escola tem em tabela. */
export function priceTableText(
  prices: CatalogPrice[],
  onlyFrequency?: number | null,
): string {
  const byFrequency = new Map<number, CatalogPrice[]>();
  for (const price of prices) {
    if (onlyFrequency && price.frequency !== onlyFrequency) continue;
    const list = byFrequency.get(price.frequency) || [];
    list.push(price);
    byFrequency.set(price.frequency, list);
  }
  const lines: string[] = [];
  for (const frequency of [...byFrequency.keys()].sort((a, b) => a - b)) {
    const label = (byFrequency.get(frequency) || [])
      .sort((a, b) => a.duration - b.duration)
      .map((price) =>
        price.duration === 1
          ? `${brlFromNumber(price.value)} no mensal`
          : `${brlFromNumber(price.value)} em ${price.duration} meses`
      ).join(" · ");
    lines.push(`• ${frequency}x por semana: ${label}`);
  }
  return lines.join("\n");
}

export function teacherOutcomeQuestion(input: {
  teacherName: string | null;
  leadName: string | null;
  whenText: string;
}): string {
  const teacher = firstName(input.teacherName);
  const lead = firstName(input.leadName) || "o aluno";
  return `Oi${
    teacher ? ", " + teacher : ""
  }! A aula experimental com ${lead} (${input.whenText}) aconteceu?\n\n` +
    `Responda assim: *SIM*, o nível (A1, A2, B1, B2, C1 ou C2), o interesse do aluno de 1 a 5 e quantas aulas por semana você recomenda.\n` +
    `Exemplo: *SIM A2 4 2x*\n\n` +
    `Se ele não apareceu, responda *FALTOU*. Com o seu "sim" eu já lanço a aula (ela entra no seu pagamento) e falo com o aluno sobre a matrícula.`;
}

export function teacherFeedbackAsk(missing: string[]): string {
  const labels: Record<string, string> = {
    nivel: "o nível (A1, A2, B1, B2, C1 ou C2)",
    interesse: "o interesse do aluno de 1 a 5",
    frequencia: "quantas aulas por semana você recomenda (1x, 2x, 3x)",
  };
  const parts = missing.map((item) => labels[item] || item);
  const list = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`
    : parts[0] || "o nível";
  return `Aula lançada, obrigado! 🙌 Só falta ${list} — é o que a escola precisa para liberar a matrícula. Exemplo: *A2 4 2x*`;
}

export function teacherDoneConfirmation(leadName: string | null): string {
  const lead = firstName(leadName) || "o aluno";
  return `Tudo registrado! A aula entrou no seu pagamento e eu já vou falar com ${lead} sobre a matrícula. Obrigado! 🙌`;
}

export function teacherNoShowConfirmation(leadName: string | null): string {
  const lead = firstName(leadName) || "o aluno";
  return `Registrei que ${lead} não compareceu. Vou oferecer outro horário para ele. Obrigado por avisar!`;
}

export function studentPlanQuestion(input: {
  leadName: string | null;
  teacherName: string | null;
  prices: CatalogPrice[];
}): string {
  const lead = firstName(input.leadName);
  const teacher = firstName(input.teacherName);
  return `Oi${lead ? ", " + lead : ""}! Que bom que você fez a aula${
    teacher ? " com a teacher " + teacher : ""
  } 🎉\n\n` +
    `Para garantir sua vaga, me diz duas coisas:\n` +
    `1️⃣ quantas aulas por semana e em quais dias e horários (ex.: segunda e quarta às 19h)\n` +
    `2️⃣ o plano: mensal, 6 meses ou 12 meses\n\n` +
    `Valores por mês:\n${priceTableText(input.prices)}\n\n` +
    `Com a sua resposta eu já te mando o link da matrícula.\n\n` +
    `Se por acaso a aula não tiver acontecido, me avisa por aqui — eu corrijo na hora.`;
}

export function studentNeedMessage(input: {
  need: string[];
  frequency: number | null;
  prices: CatalogPrice[];
}): string {
  const needSlots = input.need.includes("horarios");
  const needPlan = input.need.includes("plano");
  if (needSlots && needPlan) {
    return `Me diz os dias e horários que ficam bons para você (ex.: terça e quinta às 19h) e se prefere mensal, 6 meses ou 12 meses. 😊`;
  }
  if (needSlots) {
    const count = input.frequency
      ? `${input.frequency} aula${input.frequency > 1 ? "s" : ""} por semana`
      : "as aulas";
    return `Perfeito! Agora me diz em quais dias e horários ficam ${count} (ex.: terça e quinta às 19h).`;
  }
  return `Só falta escolher o plano: mensal, 6 meses ou 12 meses.\n\n${
    priceTableText(input.prices, input.frequency)
  }`;
}

export function studentWaitingFeedbackMessage(): string {
  return `Anotei tudo! Estou só confirmando o retorno da professora sobre a aula e já te mando o link da matrícula. 😉`;
}

export function studentOfferMessage(input: {
  leadName: string | null;
  teacherName: string | null;
  url: string;
  value: number;
  frequency: number;
  duration: number;
  slots: RenewalSlot[];
  startDate: string;
}): string {
  const lead = firstName(input.leadName);
  const teacher = firstName(input.teacherName);
  const plan = input.duration === 1
    ? "plano mensal"
    : `plano de ${input.duration} meses`;
  return `Prontinho${lead ? ", " + lead : ""}! 🎉\n\n` +
    `${input.frequency}x por semana · ${plan}\n` +
    `${brlFromNumber(input.value)} por mês, vencimento todo dia 10\n` +
    `${slotsText(input.slots)}${
      teacher ? " · com a teacher " + teacher : ""
    }\n` +
    `Primeira aula em ${input.startDate}\n\n` +
    `É só preencher a matrícula aqui: ${input.url}\n\n` +
    `Qualquer dúvida é só me chamar por aqui.`;
}

export function studentSlotsUnavailableMessage(
  freeSlots: RenewalSlot[],
): string {
  if (freeSlots.length === 0) {
    return `Não consegui confirmar esses horários automaticamente no calendário da professora. Posso pedir uma confirmação direta à coordenação ou você pode me mandar outras opções de dia e horário. 😊`;
  }
  return `Não consegui confirmar automaticamente os horários pedidos. Estes aparecem livres no calendário da professora:\n\n${
    freeSlots.map((slot) => `• ${slot.day} às ${slot.time}`).join("\n")
  }\n\nQuais deles ficam bons para você? Se preferir manter o pedido original, eu encaminho para confirmação direta.`;
}

export function studentNoShowMessage(input: {
  leadName: string | null;
  teacherName: string | null;
}): string {
  const lead = firstName(input.leadName);
  const teacher = firstName(input.teacherName);
  return `Oi${lead ? ", " + lead : ""}! ${
    teacher ? "A teacher " + teacher + " me avisou" : "Fiquei sabendo"
  } que você não conseguiu participar da aula experimental. Acontece! 😊\n\n` +
    `Quer que eu remarque? Me diz um dia e um horário que fiquem bons para você.`;
}

/**
 * O aluno dizendo que a aula NÃO aconteceu.
 *
 * É a segunda fonte do antifraude da experimental: quem diz que deu a aula é
 * quem recebe por ela, então o aluno precisa poder desmentir. Só pega negativa
 * SOBRE A AULA — "não quero 12 meses" e "não sei ainda" seguem para o fluxo
 * normal de escolha de plano.
 */
export function parseTrialDenial(text: string): boolean {
  const source = foldText(text);
  // "não aconteceu" e "não rolou" já falam por si.
  if (/\b(nao|n)\s+(aconteceu|houve|rolou|ocorreu)\b/.test(source)) return true;
  // O resto só vale quando a frase é SOBRE a aula: sem isso, "não tive tempo"
  // e "não sei ainda" virariam contestação e travariam o pagamento à toa.
  const falaDaAula = /\b(aula|experimental|teacher|professora|professor)\b/
    .test(
      source,
    );
  if (!falaDaAula) return false;
  if (
    /\b(nao|n)\s+(teve|tive|fiz|houve|participei|assisti|entrei|consegui)\b/
      .test(source)
  ) return true;
  if (
    /\b(professora?|teacher)\s+(nao|n)\s+(apareceu|veio|entrou|chegou|conectou|deu)\b/
      .test(source)
  ) return true;
  if (/\b(faltei|perdi a aula|nao consegui entrar|nao entrei)\b/.test(source)) {
    return true;
  }
  return false;
}

/** Resposta ao aluno que desmentiu a aula: nada de cobrança nem de venda. */
export function studentDenialAck(): string {
  return `Obrigado por avisar! Registrei aqui que a aula não aconteceu e já passei para a coordenação — essa aula não vai ser contada. Quer que eu remarque sua experimental? Me diz um dia e um horário que fiquem bons para você. 😊`;
}

/**
 * A abertura da conversa 10 minutos depois da experimental (17/09/2026).
 * Antes o aluno recebia de cara "me diz frequência e plano + tabela"; a direção
 * quer gente conversando: primeiro como foi, o que achou da professora — o
 * resto (frequência, valores, horários) vem na conversa, pela atendente.
 */
export function studentPostTrialOpener(input: {
  leadName: string | null;
  teacherName: string | null;
  classLogged?: boolean;
}): string {
  const lead = firstName(input.leadName);
  const teacher = firstName(input.teacherName);
  if (!input.classLogged) {
    return `Oi${lead ? ", " + lead : ""}! A experimental com ${
      teacher ? "a teacher " + teacher : "a professora"
    } estava prevista para hoje. Vocês conseguiram fazer a aula? Se sim, me conta como foi; se não, eu ajudo a reagendar. 😊`;
  }
  return `Oi${lead ? ", " + lead : ""}! Como foi a aula experimental${
    teacher ? " com a teacher " + teacher : ""
  }? 😊\n\nMe conta o que você achou — da aula e da professora.`;
}

/**
 * Briefing da experimental para o professor, antes da aula. A Bruna recebeu
 * "não esqueça da experimental de hoje" sem nome, horário ou telefone
 * (17/09/2026); o professor precisa dos dados para se apresentar ao aluno
 * antes e preparar a aula.
 */
export function teacherTrialBriefing(input: {
  teacherName: string | null;
  whenText: string;
  leadName: string | null;
  leadPhone: string | null;
  goal?: string | null;
  level?: string | null;
  notes?: string | null;
  weeklyAvailability?: string | null;
  interests?: string | null;
  meetingLink?: string | null;
}): string {
  const teacher = firstName(input.teacherName);
  const lead = String(input.leadName || "").trim() ||
    "aluno sem nome no cadastro";
  const phone = formatPhoneBr(input.leadPhone);
  const lines: string[] = [];
  lines.push(
    `🎯 *Experimental ${input.whenText}* — ${lead}${
      teacher ? `\nTeacher ${teacher}, essa aula é sua.` : ""
    }`,
  );
  if (phone) lines.push(`📱 WhatsApp do aluno: ${phone}`);
  const facts: string[] = [];
  // "LP Oportunidade - Oferta 4x/semana" é a origem do formulário, não o
  // objetivo da pessoa; nesse caso o objetivo dito na conversa (interests) vale.
  const goalRaw = String(input.goal || "").trim();
  const goal = /^lp\b/i.test(goalRaw)
    ? String(input.interests || "").trim()
    : goalRaw || String(input.interests || "").trim();
  if (goal) facts.push(`Objetivo: ${goal}`);
  const level = String(input.level || "").trim();
  if (level) facts.push(`Nível: ${level}`);
  if (facts.length) lines.push(`🧭 ${facts.join(" · ")}`);
  const notes = cleanLeadNotes(input.notes);
  if (notes) lines.push(`📝 Contexto: ${notes}`);
  const availability = String(input.weeklyAvailability || "").trim();
  if (availability) {
    lines.push(`🗓️ Disponibilidade dita pelo aluno: ${availability}`);
  }
  const link = String(input.meetingLink || "").trim();
  lines.push(
    link
      ? `🔗 Link da aula: ${link}`
      : `🔗 O link da aula está na plataforma, em *Aulas de Hoje*.`,
  );
  lines.push(
    `Antes da aula: mande uma mensagem para o aluno se apresentando e confirmando horário e link. ` +
      `Use o material *Trial Class* da plataforma e o fundo oficial da escola.\n` +
      `Depois da aula eu te pergunto por aqui se ela aconteceu — é isso que lança a aula e libera a matrícula.`,
  );
  return lines.join("\n\n");
}

/** "5571987168313" → "(71) 98716-8313"; número fora do padrão sai como veio. */
export function formatPhoneBr(raw: string | null | undefined): string {
  const digits = String(raw || "").replace(/\D/g, "").replace(/^55/, "");
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return String(raw || "").trim();
}

/**
 * As notas do CRM acumulam carimbos da IA ("[IA 2026-09-16] …") e UTMs; o
 * professor quer só o que fala do aluno. Ficam as últimas anotações, sem
 * carimbo, num limite que cabe numa bolha.
 */
export function cleanLeadNotes(raw: string | null | undefined): string {
  const parts = String(raw || "").split(/\n+/)
    .map((line) =>
      line.replace(/^\[IA [^\]]*\]\s*/i, "").replace(/^UTMs?:.*$/i, "").trim()
    )
    .filter((line) => line && !/^aguardando aceite/i.test(line));
  if (!parts.length) return "";
  return parts.slice(-3).join(" · ").slice(0, 320);
}
