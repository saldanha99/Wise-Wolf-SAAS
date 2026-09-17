import type { CatalogPrice } from "./trial-closing.ts";
import {
  allowedPrices,
  asksFullPriceList,
  complainsAboutRepetition,
  detectFrequencyRequest,
  extractPricesBrl,
  formatFrequencyAnswer,
  formatPriceList,
  hasForeignPrice,
  hasUnansweredPriceQuestion,
  isFollowUpNudge,
  minimumCatalogPrice,
  priceListAlreadySent,
  TABLE_MIN_PRICES,
} from "./lead-pricing.ts";

export const CLASS_DURATION_MINUTES = 30;
export const MINIMUM_PLAN_PRICE_BRL = 169;

type HistoryMessage = { role: string; content: string };
export interface CommercialPolicy {
  classDurationMinutes: number;
  minimumPlanPriceBrl: number;
  strategy: "trial_first_then_minimum_on_insistence";
}

type AtendenteConfig = {
  agents?: {
    atendente?: {
      training?: unknown;
      commercialPolicy?: unknown;
    };
  };
  sdr?: {
    training?: unknown;
    commercialPolicy?: unknown;
  };
};

// "custo" faltava aqui, e em 16/09/2026 um lead perguntou exatamente assim
// ("gostaria de saber qual seria o custo") — a pergunta não foi reconhecida como
// pergunta de preço e ele recebeu um "os valores variam" sem valor nenhum.
const PRICE_REQUEST =
  /\b(pre[cç]o|pre[cç]os|valor|valores|custo|custos|custa|quanto\s+(?:custa|fica|sai|é|seria)|mensalidade|mensalidades|investimento|or[cç]amento|plano|planos)\b/i;
const DURATION_REQUEST =
  /\b(dura[cç][aã]o|quanto\s+tempo|tempo\s+de\s+aula|quantos?\s+minutos?|aulas?\s+de\s+quantos?\s+minutos?)\b/i;
const PRICE_IN_REPLY =
  /(?:R\$\s*\d|\b\d{2,4}(?:[.,]\d{1,2})?\s*(?:reais?|\/\s*m[eê]s|por\s+m[eê]s)|\b(?:cento|duzentos|trezentos|quatrocentos|quinhentos)\b[^.!?\n]{0,30}\breais?\b)/i;
const WRITTEN_WRONG_DURATION_IN_REPLY =
  /\b(?:dez|quinze|vinte|vinte\s+e\s+cinco|quarenta|quarenta\s+e\s+cinco|cinquenta|sessenta|noventa)\s*(?:min|minutos?)\b/i;

const hasWrongDuration = (reply: string, expectedMinutes: number): boolean => {
  if (WRITTEN_WRONG_DURATION_IN_REPLY.test(reply || "")) return true;
  return [...String(reply || "").matchAll(/\b(\d{1,3})\s*(?:min|minutos?)\b/gi)]
    .some((match) => Number(match[1]) !== expectedMinutes);
};

export const isPriceRequest = (text: string): boolean =>
  PRICE_REQUEST.test(text || "");

export const countPriceRequests = (
  history: HistoryMessage[],
  currentMessage: string,
): number =>
  history.filter((message) =>
    message.role === "user" && isPriceRequest(message.content)
  ).length +
  (isPriceRequest(currentMessage) ? 1 : 0);

export function resolveAtendenteTraining(config: unknown): string {
  if (!config || typeof config !== "object") return "";
  const cfg = config as AtendenteConfig;
  const current = cfg.agents?.atendente?.training;
  const legacy = cfg.sdr?.training;
  if (typeof current === "string") return current.trim();
  return typeof legacy === "string" ? legacy.trim() : "";
}

export function resolveCommercialPolicy(
  config: unknown,
): CommercialPolicy | null {
  if (!config || typeof config !== "object") return null;
  const cfg = config as AtendenteConfig;
  const raw = cfg.agents?.atendente?.commercialPolicy ??
    cfg.sdr?.commercialPolicy;
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Record<string, unknown>;
  const duration = Number(candidate.classDurationMinutes);
  const minimum = Number(candidate.minimumPlanPriceBrl);
  if (
    candidate.strategy !== "trial_first_then_minimum_on_insistence" ||
    !Number.isInteger(duration) || duration < 1 || duration > 180 ||
    !Number.isFinite(minimum) || minimum <= 0
  ) return null;
  return {
    classDurationMinutes: duration,
    minimumPlanPriceBrl: minimum,
    strategy: candidate.strategy,
  };
}

/**
 * O porquê dos 30 minutos, na palavra da direção (áudios de 15/09/2026).
 *
 * Não é aula curta por economia: passando de 30 minutos o cérebro satura e o
 * aprendizado rende menos. E o formato é 100% conversação, montado na rotina e
 * no contexto do aluno — é o que diferencia a escola do curso tradicional, e é
 * isso que justifica o preço quando ele aparece na conversa.
 */
const METODO_30_MIN =
  "As aulas são de 30 minutos, e isso é proposital: passando disso o cérebro " +
  "satura e o aprendizado rende menos. São 100% conversação, montadas na rotina " +
  "e no contexto do aluno — vale para adulto e para criança. A experimental é " +
  "gratuita.";

const METODO_30_MIN_CURTO =
  "As aulas são de 30 minutos, 100% conversação, montadas na rotina e no " +
  "contexto do aluno — e a experimental é gratuita.";

/**
 * Quando o pedido de experimental chega junto com a pergunta de preço, a
 * resposta de preço substituía a promessa de verificar o professor — e o lead
 * nunca ficava sabendo que o pedido tinha sido registrado (Diná, 07:14).
 */
const TRIAL_PROMISE =
  "Sobre a experimental: vou verificar o professor desse horário e te confirmo " +
  "hoje mesmo — se ninguém puder, eu te aviso e a gente combina outra opção 😊";

export function applyCommercialReplyPolicy(opts: {
  history: HistoryMessage[];
  currentMessage: string;
  modelReply: string;
  trialRequested: boolean;
  commercialPolicy: CommercialPolicy | null;
  /** `student_pricing_plans` da escola; sem ele, só o mínimo configurado vale. */
  catalog?: CatalogPrice[];
  consultativeLead?: {
    goal?: string | null;
    level?: string | null;
    afterTrial?: boolean;
  };
}): { reply: string; policy: string | null } {
  const asksPrice = isPriceRequest(opts.currentMessage);
  const asksDuration = DURATION_REQUEST.test(opts.currentMessage || "");
  const priceRequests = countPriceRequests(opts.history, opts.currentMessage);
  const leakedPrice = PRICE_IN_REPLY.test(opts.modelReply || "");
  if (opts.consultativeLead) {
    return applyConsultativePolicy(opts, { asksPrice, asksDuration });
  }
  const wrongDuration = opts.commercialPolicy
    ? hasWrongDuration(
      opts.modelReply,
      opts.commercialPolicy.classDurationMinutes,
    )
    : false;

  const mustCorrectDuration = Boolean(opts.commercialPolicy) &&
    (asksDuration || wrongDuration);
  if (!asksPrice && !leakedPrice && !mustCorrectDuration) {
    return { reply: opts.modelReply, policy: null };
  }

  const facts: string[] = [];
  if (mustCorrectDuration) {
    facts.push(
      `Todas as aulas duram ${
        opts.commercialPolicy!.classDurationMinutes
      } minutos, inclusive a experimental.`,
    );
  }
  if (asksPrice && priceRequests >= 2 && opts.commercialPolicy) {
    facts.push(
      `Temos planos a partir de R$ ${opts.commercialPolicy.minimumPlanPriceBrl}/mês, conforme a frequência e a duração do contrato.`,
    );
  } else if (asksPrice || leakedPrice) {
    facts.push(
      "Os planos variam conforme a frequência, e a melhor opção é apresentada depois da aula experimental.",
    );
  }

  facts.push(
    opts.trialRequested
      // O prazo é a parte que faltava. Metade das experimentais expira sem
      // professor (medido em 13/08/2026), e o lead ficava esperando um retorno
      // que ninguém tinha prometido em prazo nenhum. O `funnel-sweeper` agora
      // cumpre essa promessa com as alternativas da grade.
      ? "Vou verificar o professor para esse horário e te confirmo hoje mesmo — se ninguém puder nesse horário, eu te aviso e ofereço outras opções, combinado?"
      : "Vamos primeiro marcar sua aula experimental gratuita? Qual dia e horário fica melhor para você?",
  );

  const policy = mustCorrectDuration
    ? "corrected_duration"
    : leakedPrice && !asksPrice
    ? "blocked_unsolicited_price"
    : asksPrice && priceRequests >= 2 && opts.commercialPolicy
    ? "minimum_price_after_insistence"
    : asksPrice
    ? "trial_before_price"
    : null;

  return { reply: facts.join(" "), policy };
}

/**
 * A atendente da Wise Wolf: a IA PROPÕE a frase, o código VETA o número.
 *
 * Até 17/09/2026 esta função SUBSTITUÍA a resposta do modelo por um bloco fixo
 * ("As aulas são de 30 minutos, e isso é proposital… Os planos começam em
 * R$ 169") toda vez que aparecia a palavra "valor" — o mesmo texto, sem a
 * tabela, mesmo quando o lead já tinha dito quantas vezes por semana queria.
 * Agora: resposta do modelo com valores do catálogo passa inteira; valor que
 * não existe no catálogo é barrado; pergunta de preço sem número na resposta
 * ganha o número; frequência dita pelo lead ganha a tabela, como a direção
 * manda na mão.
 */
function applyConsultativePolicy(
  opts: Parameters<typeof applyCommercialReplyPolicy>[0],
  flags: { asksPrice: boolean; asksDuration: boolean },
): { reply: string; policy: string | null } {
  const lead = opts.consultativeLead!;
  const catalog = (opts.catalog || []).filter((price) =>
    Number(price.value) > 0
  );
  const hasCatalog = catalog.length > 0;
  const minimum = minimumCatalogPrice(catalog) ??
    opts.commercialPolicy?.minimumPlanPriceBrl ?? null;
  const allowed = allowedPrices(catalog, minimum);
  const message = opts.currentMessage || "";
  const modelReply = String(opts.modelReply || "");

  const frequency = detectFrequencyRequest(message);
  const wantsList = asksFullPriceList(message);
  const pendingPrice = hasUnansweredPriceQuestion(opts.history, isPriceRequest);
  // "??" ou "se não me passar o valor não tenho interesse" depois de uma
  // pergunta de preço sem resposta é a MESMA pergunta, mais brava.
  const insists = pendingPrice &&
    (isFollowUpNudge(message) || complainsAboutRepetition(message));
  const asksPrice = flags.asksPrice || insists || frequency !== null;
  const listSent = priceListAlreadySent(opts.history);
  const modelPrices = extractPricesBrl(modelReply);
  const foreign = hasForeignPrice(modelReply, allowed);

  const metodoJaDito = opts.history.some((m) =>
    m.role === "assistant" && /isso é proposital/.test(m.content || "")
  );
  const metodo = metodoJaDito ? METODO_30_MIN_CURTO : METODO_30_MIN;
  const wrongDuration = modelReply.split(/[.!?\n]/).some((sentence) =>
    /\b(?:aula|aulas|experimental)\b/i.test(sentence) &&
    hasWrongDuration(sentence, CLASS_DURATION_MINUTES)
  );
  const asksClassDuration = flags.asksDuration &&
    /\b(?:aula|aulas|experimental)\b/i.test(message);
  const trialLine = opts.trialRequested &&
      !/verific|confirmo|te aviso|professor/i.test(modelReply)
    ? TRIAL_PROMISE
    : null;
  const withTrial = (parts: string[]): string =>
    [...parts, ...(trialLine ? [trialLine] : [])].join("\n\n");

  // Sem valor nenhum configurado, ninguém inventa: coordenação.
  if (asksPrice && minimum === null) {
    return {
      reply: withTrial([
        "Não tenho um valor confirmado aqui. A coordenação pode te informar os planos e valores.",
      ]),
      policy: "price_unavailable",
    };
  }

  // 1) Frequência dita → valores daquela frequência + a tabela (uma vez).
  if (frequency !== null && hasCatalog) {
    const answer = formatFrequencyAnswer(catalog, frequency);
    const modelOk = !foreign && modelPrices.length > 0 &&
      (answer === null ||
        catalog.some((p) =>
          p.frequency === frequency && modelPrices.includes(Number(p.value))
        ));
    const head = modelOk
      ? modelReply
      : answer
      ? answer
      : `Não temos plano de ${frequency}x por semana na tabela — as opções são estas:`;
    const parts = [head];
    // O modelo pode ter escrito a tabela ele mesmo (com números certos):
    // anexar a nossa em seguida seria a tabela duas vezes.
    const modelWroteTable = modelOk && modelPrices.length >= TABLE_MIN_PRICES;
    if (!listSent && !modelWroteTable) parts.push(formatPriceList(catalog));
    else if (!modelOk) {
      parts.push("A tabela completa é a que te mandei acima 😊");
    }
    return {
      reply: withTrial(parts),
      policy: modelOk
        ? "frequency_price_answer_model"
        : "frequency_price_answer",
    };
  }

  // 2) Pediu a tabela, ou está cobrando um preço que ficou sem resposta.
  if ((wantsList || insists) && hasCatalog) {
    if (!listSent) {
      const intro = insists
        ? "Desculpa a demora com o valor! Segue a tabela completa:"
        : "Claro! Segue a tabela completa (mensalidade, aulas de 30 minutos):";
      return {
        reply: withTrial([
          intro,
          formatPriceList(catalog),
          "Quer que eu te explique alguma opção? 😊",
        ]),
        policy: "price_list",
      };
    }
    if (!foreign && modelPrices.length > 0) {
      return { reply: withTrial([modelReply]), policy: "price_list_model" };
    }
    return {
      reply: withTrial([
        "Os valores são os da tabela que te mandei acima 😊 Me diz quantas vezes por semana você pensa em fazer que eu te indico a melhor opção.",
      ]),
      policy: "price_list_repeat",
    };
  }

  // 3) Pergunta de preço: a frase do modelo vale se os números forem do catálogo.
  if (asksPrice) {
    if (!foreign && modelPrices.length > 0 && !wrongDuration) {
      return { reply: withTrial([modelReply]), policy: "price_answer_model" };
    }
    // A tabela já foi: repetir "começam em R$ 169" seria o robozinho de novo.
    if (listSent) {
      return {
        reply: withTrial([
          "Os valores são os da tabela que te mandei acima 😊 Me diz quantas vezes por semana você pensa em fazer que eu te indico a melhor opção.",
        ]),
        policy: "price_list_repeat",
      };
    }
    const facts: string[] = [metodo];
    facts.push(
      `Os planos começam em R$ ${minimum} por mês e variam conforme a quantidade de aulas por semana.`,
    );
    facts.push(
      !lead.goal?.trim()
        ? "Para eu te indicar o plano certo: qual é seu principal objetivo com o inglês?"
        : !lead.level?.trim()
        ? "E como você considera seu inglês hoje: iniciante, intermediário ou já consegue se comunicar?"
        : "Quantas vezes por semana você pensa em fazer? Assim te passo o valor certinho.",
    );
    return {
      reply: withTrial(facts),
      policy: foreign ? "blocked_foreign_price" : "consultative_price_answer",
    };
  }

  // 4) Ninguém perguntou preço: número de fora do catálogo é barrado; do
  //    catálogo passa (o lead pode estar continuando o assunto).
  if (foreign) {
    const facts = minimum === null
      ? [
        "Não tenho um valor confirmado aqui. A coordenação pode te informar os planos e valores.",
      ]
      : [
        metodo,
        `Os planos começam em R$ ${minimum} por mês e variam conforme a quantidade de aulas por semana.`,
        "Podemos escolher a frequência de aulas de acordo com sua rotina e seu objetivo.",
      ];
    return { reply: withTrial(facts), policy: "blocked_unsolicited_price" };
  }

  if (wrongDuration || asksClassDuration) {
    return { reply: withTrial([metodo]), policy: "corrected_duration" };
  }
  return { reply: opts.modelReply, policy: null };
}
