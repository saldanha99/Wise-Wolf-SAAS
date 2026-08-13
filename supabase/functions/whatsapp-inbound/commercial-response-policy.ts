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

const PRICE_REQUEST =
  /\b(pre[cç]o|pre[cç]os|valor|valores|quanto\s+(?:custa|fica|é)|mensalidade|investimento|plano|planos)\b/i;
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

export function applyCommercialReplyPolicy(opts: {
  history: HistoryMessage[];
  currentMessage: string;
  modelReply: string;
  trialRequested: boolean;
  commercialPolicy: CommercialPolicy | null;
}): { reply: string; policy: string | null } {
  const asksPrice = isPriceRequest(opts.currentMessage);
  const asksDuration = DURATION_REQUEST.test(opts.currentMessage || "");
  const priceRequests = countPriceRequests(opts.history, opts.currentMessage);
  const leakedPrice = PRICE_IN_REPLY.test(opts.modelReply || "");
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
