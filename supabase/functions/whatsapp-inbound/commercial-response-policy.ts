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

export function applyCommercialReplyPolicy(opts: {
  history: HistoryMessage[];
  currentMessage: string;
  modelReply: string;
  trialRequested: boolean;
  commercialPolicy: CommercialPolicy | null;
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
    const lead = opts.consultativeLead;
    const onlyPrice =
      /\b(?:so|somente|apenas)\b[^.!?\n]{0,35}\b(?:pre[cç]o|valor|valores|quanto|mensalidade)\b/i
        .test(
          opts.currentMessage.normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
        );
    // Até 16/09/2026 o valor só saía na SEGUNDA pergunta, ou quando objetivo e
    // nível já estavam preenchidos. Na prática o lead perguntava o preço e ouvia
    // "os valores variam conforme a quantidade de aulas" — que não é resposta.
    // Decisão da direção: preço perguntado é preço respondido, sempre a partir do
    // mínimo, e junto vem o porquê do método (é o que a direção fala no áudio).
    const mayQuote = asksPrice;
    const wrongDuration = opts.modelReply.split(/[.!?\n]/).some((sentence) =>
      /\b(?:aula|aulas|experimental)\b/i.test(sentence) &&
      hasWrongDuration(sentence, CLASS_DURATION_MINUTES)
    );
    const facts: string[] = [];
    const asksClassDuration = asksDuration &&
      /\b(?:aula|aulas|experimental)\b/i.test(opts.currentMessage);
    if (wrongDuration || asksClassDuration) {
      facts.push(METODO_30_MIN);
    }
    if (mayQuote) {
      // O método explica o preço: sem ele, R$ 169 é só um número solto.
      if (!facts.includes(METODO_30_MIN)) facts.push(METODO_30_MIN);
      facts.push(
        opts.commercialPolicy
          ? `Os planos começam em R$ ${opts.commercialPolicy.minimumPlanPriceBrl} por mês e variam conforme a quantidade de aulas por semana.`
          : "Não tenho um valor confirmado aqui. A coordenação pode te informar os planos e valores.",
      );
      return {
        reply: facts.join("\n\n"),
        policy: opts.commercialPolicy
          ? "consultative_price_answer"
          : "price_unavailable",
      };
    }
    if (asksPrice || leakedPrice) {
      facts.push(
        "Os valores variam conforme a quantidade de aulas por semana.",
      );
      facts.push(
        !lead.goal?.trim()
          ? "Para te orientar melhor, qual é seu principal objetivo com o inglês?"
          : !lead.level?.trim()
          ? "E como você considera seu inglês hoje: iniciante, intermediário ou já consegue se comunicar?"
          : "Podemos escolher a frequência de aulas de acordo com sua rotina e seu objetivo.",
      );
      return {
        reply: facts.join("\n\n"),
        policy: asksPrice
          ? "understand_before_price"
          : "blocked_unsolicited_price",
      };
    }
    if (facts.length) {
      return { reply: facts.join("\n\n"), policy: "corrected_duration" };
    }
    return { reply: opts.modelReply, policy: null };
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
