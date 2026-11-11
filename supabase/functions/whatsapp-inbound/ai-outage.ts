// IA FORA DO AR NÃO É "HUMANO ASSUMIU" (11/11/2026).
//
// Até aqui, quando Gemini e OpenRouter falhavam, a atendente mandava "já já
// alguém da equipe te responde", marcava `ai_handoff = true` e avisava o
// `ownerPhone` — que é o PRÓPRIO número central. Resultado medido em 11/11/2026:
// cota do Gemini estourada (429) e OpenRouter sem saldo (402); todo lead recebia
// uma mensagem e ficava mudo por 72 h, e o aviso saía do número para ele mesmo,
// sem notificar ninguém. Parecia que o robô "passava tudo para o humano".
//
// Agora a falha do provedor é uma ESPERA: o lead recebe um único aviso neutro, a
// mensagem fica pendente na fila (`defer_sdr_work`) e a IA responde sozinha
// quando voltar. Só depois de AI_OUTAGE_GIVE_UP_MS sem IA o contato vai para
// humano. A direção recebe a CAUSA (sem crédito / cota / chave) no grupo.

/** Intervalo entre novas tentativas da mesma conversa. */
export const AI_OUTAGE_RETRY_SECONDS = 120;
/** Depois disso sem IA, a conversa vai para um humano. */
export const AI_OUTAGE_GIVE_UP_MS = 6 * 3600_000;
/** No máximo um alerta de indisponibilidade por escola nesse intervalo. */
export const AI_OUTAGE_ALERT_EVERY_MS = 3600_000;

export const AI_OUTAGE_HOLD_REPLY =
  "Oi! Recebi sua mensagem 😊 Só um instante que já te respondo por aqui, tá?";

export type AiFailureCause =
  | "sem_credito"
  | "cota_excedida"
  | "chave_invalida"
  | "chave_ausente"
  | "instavel"
  | "resposta_invalida";

export interface AiFailure {
  causes: AiFailureCause[];
  /** Frase curta para a direção, sem dado de lead. */
  summary: string;
}

const PROVIDER_LABEL = (entry: string) =>
  /^gemini\//i.test(entry) || /GEMINI_API_KEY/.test(entry)
    ? "Gemini (Google)"
    : "OpenRouter";

function causeOf(entry: string): AiFailureCause {
  if (/ausente/i.test(entry)) return "chave_ausente";
  const status = Number(entry.match(/HTTP (\d{3})/)?.[1] || 0);
  if (status === 402) return "sem_credito";
  if (status === 429) return "cota_excedida";
  if (status === 401 || status === 403) return "chave_invalida";
  if (status >= 500 || /timeout|timed out|abort|network|fetch/i.test(entry)) {
    return "instavel";
  }
  if (/sem JSON|vazio/i.test(entry)) return "resposta_invalida";
  return status ? "instavel" : "resposta_invalida";
}

const CAUSE_TEXT: Record<AiFailureCause, string> = {
  sem_credito: "sem crédito",
  cota_excedida: "cota excedida",
  chave_invalida: "chave recusada",
  chave_ausente: "chave não configurada",
  instavel: "instável/fora do ar",
  resposta_invalida: "resposta inválida",
};

/** Lê o `diag` do `callAI` e diz por que cada provedor falhou. */
export function classifyAiFailure(diag: readonly string[]): AiFailure {
  const byProvider = new Map<string, Set<AiFailureCause>>();
  const causes = new Set<AiFailureCause>();
  for (const raw of diag) {
    const entry = String(raw || "");
    if (!entry.trim()) continue;
    const cause = causeOf(entry);
    causes.add(cause);
    const label = PROVIDER_LABEL(entry);
    if (!byProvider.has(label)) byProvider.set(label, new Set());
    byProvider.get(label)!.add(cause);
  }
  const summary = [...byProvider.entries()]
    .map(([label, set]) =>
      `${label}: ${[...set].map((c) => CAUSE_TEXT[c]).join(", ")}`
    )
    .join(" · ") || "nenhum provedor respondeu";
  return { causes: [...causes], summary };
}

/** O que a direção precisa fazer, na linguagem dela. */
export function aiFailureAction(failure: AiFailure): string {
  const steps: string[] = [];
  if (failure.causes.includes("sem_credito")) {
    steps.push("colocar crédito no OpenRouter (openrouter.ai → Credits)");
  }
  if (failure.causes.includes("cota_excedida")) {
    steps.push("ativar faturamento ou aumentar a cota da chave do Gemini (Google AI Studio)");
  }
  if (
    failure.causes.includes("chave_invalida") ||
    failure.causes.includes("chave_ausente")
  ) {
    steps.push("conferir as chaves de IA configuradas no servidor");
  }
  if (!steps.length) steps.push("aguardar; a plataforma tenta de novo sozinha");
  return steps.join("; ");
}

export interface AiOutageState {
  now: number;
  /** Aviso de espera mais recente enviado a ESTE lead (ms), se houver. */
  lastHoldToLeadAt: number | null;
  /** Último alerta de indisponibilidade da escola (ms), se houver. */
  lastTenantAlertAt: number | null;
}

export interface AiOutagePlan {
  /** Mandar o aviso neutro ao lead agora. */
  sendHold: boolean;
  /** Avisar a direção agora. */
  alertDirection: boolean;
  /** Desistir da espera e entregar o contato a um humano. */
  giveUp: boolean;
  /** Segundos até a próxima tentativa (quando não desiste). */
  retryInSeconds: number;
}

export function planAiOutage(state: AiOutageState): AiOutagePlan {
  const waitingSince = state.lastHoldToLeadAt;
  const giveUp = waitingSince !== null &&
    state.now - waitingSince >= AI_OUTAGE_GIVE_UP_MS;
  return {
    sendHold: waitingSince === null,
    alertDirection: state.lastTenantAlertAt === null ||
      state.now - state.lastTenantAlertAt >= AI_OUTAGE_ALERT_EVERY_MS,
    giveUp,
    retryInSeconds: AI_OUTAGE_RETRY_SECONDS,
  };
}

/**
 * Linha do prompt quando a resposta sai atrasada por causa da queda: a IA pede
 * desculpas UMA vez e segue o atendimento, sem repetir a apresentação.
 */
export function delayedReplyInstruction(minutesLate: number): string {
  const m = Math.max(1, Math.round(minutesLate));
  return `\nATRASO: esta resposta sai ${m} min depois da mensagem do lead (o sistema ficou instável). Comece com um pedido de desculpas curto pela demora, sem explicar o motivo técnico, e siga normalmente.`;
}
