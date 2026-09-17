/**
 * ENVIO PELO WHATSAPP (Evolution) — com resolução de JID.
 *
 * Muitas contas brasileiras de DDD antigo estão registradas no WhatsApp **sem o
 * 9º dígito**. Mandar para o número "no chute" não bate com o JID real e a
 * mensagem nunca chega — a Evolution ainda responde 200/PENDING, então o envio
 * parece ter dado certo.
 *
 * O `funnel-sweeper` já resolvia o JID antes de enviar; o `sdr-followups` e o
 * `whatsapp-inbound` não — três cópias, uma delas com comportamento diferente.
 *
 * ⚠️ **Medido em 13/08/2026, e o resultado contraria a suspeita inicial:** os 9
 * leads com telefone de 12 dígitos resolvem para o MESMO número (existem assim
 * mesmo no WhatsApp). O valor aqui é unificar o envio e cobrir o caso quando
 * ele aparecer. Antes de atribuir uma falha de entrega ao 9º dígito, consulte
 * `chat/whatsappNumbers` e confirme.
 *
 * ⚠️ Falha ao resolver NÃO cancela o envio: cai no número original. A resolução
 * é uma melhora de acerto, não um pré-requisito — e a Evolution é a mesma peça
 * que pode estar instável no momento.
 */

export interface EnvioEvolution {
  base: string;
  keys: string[];
  instance: string;
  to: string;
  text: string;
  delayMs?: number;
  /**
   * "auto" (padrão): consulta o teto do banco antes do POST.
   * "skip": envio manual de gente (inbox), que não é automação.
   */
  throttle?: "auto" | "skip";
}

export type EvolutionSendResult = {
  outcome: "accepted" | "rejected" | "ambiguous";
  messageId: string | null;
  httpStatus: number | null;
  /** Vetado pelo teto (nada foi enviado); `retryAfterMs` diz quando tentar. */
  throttled?: boolean;
  retryAfterMs?: number;
  throttleKind?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// TETO E AQUECIMENTO (17/09/2026). O número da escola foi restringido pelo
// WhatsApp por 21 h depois de ~130 mensagens automáticas em 7 h. Todo envio que
// passa por aqui pergunta ao banco (`whatsapp_outbound_permit`) se pode sair:
// tipo do destino (resposta / equipe / aluno / contato frio), teto por hora e
// por dia, espaçamento aleatório e fator de aquecimento depois de uma
// restrição. Sem `SUPABASE_URL`/chave (testes) a régua não existe; se o banco
// falhar a régua também não trava a mensagem — mas grita no log.
// ─────────────────────────────────────────────────────────────────────────────

export interface OutboundPermit {
  allowed: boolean;
  kind?: string;
  wait_ms?: number;
  reason?: string;
  ledger_id?: string | null;
}

export type OutboundPermitSource = (
  instance: string,
  destination: string,
) => Promise<OutboundPermit | null>;

/** Espera inline máxima dentro de uma request; acima disso o chamador adia. */
export const THROTTLE_MAX_INLINE_WAIT_MS = 12_000;

function envOrNull(name: string): string | null {
  try {
    return Deno.env.get(name)?.trim() || null;
  } catch {
    return null;
  }
}

async function postgrestRpc(
  name: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = envOrNull("SUPABASE_URL");
  const key = envOrNull("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  const resp = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) throw new Error(`rpc_${name}_${resp.status}`);
  return await resp.json();
}

const defaultPermitSource: OutboundPermitSource = async (
  instance,
  destination,
) => {
  if (!envOrNull("SUPABASE_URL") || !envOrNull("SUPABASE_SERVICE_ROLE_KEY")) {
    return null;
  }
  try {
    const data = await postgrestRpc("whatsapp_outbound_permit", {
      p_instance: instance,
      p_destination: destination,
      p_reserve: true,
    });
    return data && typeof data === "object" ? data as OutboundPermit : null;
  } catch (e) {
    console.error("[evolution] teto indisponível; enviando sem régua", {
      instance,
      errorType: e instanceof Error ? e.message : "UnknownError",
    });
    return null;
  }
};

let permitSource: OutboundPermitSource = defaultPermitSource;

/** Só para testes: troca a fonte da permissão. */
export function setOutboundPermitSource(
  source: OutboundPermitSource | null,
): void {
  permitSource = source || defaultPermitSource;
}

async function settlePermit(
  ledgerId: string | null | undefined,
  delivered: boolean,
): Promise<void> {
  if (!ledgerId) return;
  try {
    await postgrestRpc("whatsapp_outbound_settle", {
      p_ledger_id: ledgerId,
      p_delivered: delivered,
    });
  } catch {
    // O livro conta a reserva como "em voo" por 3 min e depois a esquece.
  }
}

/** Pede licença ao teto. Devolve null quando não há régua configurada. */
export async function requestOutboundPermit(
  instance: string,
  destination: string,
): Promise<OutboundPermit | null> {
  return await permitSource(instance, destination);
}

export type EvolutionDestinationOptions =
  & Pick<
    EnvioEvolution,
    "base" | "keys" | "instance" | "to"
  >
  & Partial<Pick<EnvioEvolution, "text" | "delayMs">>;

/**
 * Vale a pena perguntar o JID deste destino?
 *
 * Grupo (`...@g.us`) e JID já resolvido não passam pela consulta: o endpoint
 * responde para NÚMERO, e gastar uma chamada por mensagem de grupo só adiciona
 * latência a cada disparo.
 */
export function precisaResolverJid(to: string): boolean {
  const alvo = String(to || "").trim();
  if (!alvo || alvo.includes("@")) return false;
  return /^\d{10,15}$/.test(alvo.replace(/\D/g, ""));
}

/** O JID real cadastrado no WhatsApp, ou null quando não dá para saber. */
export async function resolveJid(
  base: string,
  keys: string[],
  instance: string,
  phone: string,
): Promise<string | null> {
  if (!precisaResolverJid(phone)) return null;
  for (const key of keys) {
    try {
      const resp = await fetch(
        `${base}/chat/whatsappNumbers/${encodeURIComponent(instance)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: key },
          body: JSON.stringify({ numbers: [phone] }),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      if (resp.status === 401) continue;
      if (!resp.ok) return null;
      const data = await resp.json();
      const entry = Array.isArray(data) ? data[0] : null;
      if (entry?.exists && entry.jid) return String(entry.jid).split("@")[0];
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Resolve o destino que deve ser persistido/autorizado pelo fence.
 *
 * A indisponibilidade do lookup preserva a compatibilidade histórica: o
 * destino original continua sendo usado. Separar esta etapa permite que o
 * chamador resolva o JID antes da transação que sela a submissão.
 */
export async function resolveWhatsAppDestination(
  opts: EvolutionDestinationOptions,
): Promise<string> {
  return (await resolveJid(opts.base, opts.keys, opts.instance, opts.to)) ||
    opts.to;
}

function evolutionMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const key = root.key && typeof root.key === "object" &&
      !Array.isArray(root.key)
    ? root.key as Record<string, unknown>
    : null;
  const value = key?.id || root.id;
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 320)
    : null;
}

export async function sendWhatsTextDetailed(
  opts: EnvioEvolution,
): Promise<EvolutionSendResult> {
  const destination = await resolveWhatsAppDestination(opts);
  return await sendWhatsTextToResolvedDestinationDetailed({
    ...opts,
    to: destination,
  });
}

/**
 * Executa somente o POST de envio para um destino já resolvido e autorizado.
 *
 * Esta função nunca consulta `chat/whatsappNumbers`. Use-a depois que o fence
 * persistente autorizar exatamente `opts.to`, evitando qualquer lookup ou
 * mudança de destino entre o marker SUBMITTING e o POST ao provedor.
 */
export async function sendWhatsTextToResolvedDestinationDetailed(
  opts: EnvioEvolution,
): Promise<EvolutionSendResult> {
  const alvo = opts.to;
  const destinationLastFour = String(alvo).replace(/\D/g, "").slice(-4) ||
    "group";
  let ledgerId: string | null = null;
  if (opts.throttle !== "skip") {
    const permit = await requestOutboundPermit(opts.instance, alvo);
    if (permit && permit.allowed === false) {
      console.warn("[evolution] envio adiado pelo teto", {
        instance: opts.instance,
        destinationLastFour,
        kind: permit.kind,
        reason: permit.reason,
        waitMs: permit.wait_ms,
      });
      return {
        outcome: "rejected",
        messageId: null,
        httpStatus: 429,
        throttled: true,
        retryAfterMs: Math.max(1000, Number(permit.wait_ms || 60_000)),
        throttleKind: permit.kind,
      };
    }
    if (permit?.allowed) {
      ledgerId = permit.ledger_id || null;
      const wait = Math.min(
        Math.max(0, Number(permit.wait_ms || 0)),
        THROTTLE_MAX_INLINE_WAIT_MS,
      );
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  const result = await postSendText(opts, alvo, destinationLastFour);
  await settlePermit(ledgerId, result.outcome === "accepted");
  return result;
}

async function postSendText(
  opts: EnvioEvolution,
  alvo: string,
  destinationLastFour: string,
): Promise<EvolutionSendResult> {
  for (const key of opts.keys) {
    try {
      const resp = await fetch(
        `${opts.base}/message/sendText/${encodeURIComponent(opts.instance)}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: key,
          },
          body: JSON.stringify({
            number: alvo,
            text: opts.text,
            delay: opts.delayMs ?? 1200,
            linkPreview: false,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        },
      );
      // 401 é chave errada: tenta a próxima em vez de desistir do envio.
      if (resp.status === 401) continue;
      if (!resp.ok) {
        const ambiguous = resp.status === 408 || resp.status === 425 ||
          resp.status === 429 || resp.status >= 500;
        console.warn("[evolution] envio recusado", {
          status: resp.status,
          instance: opts.instance,
          destinationLastFour,
          providerRequestId: resp.headers.get("x-request-id") || undefined,
          ambiguous,
        });
        return {
          outcome: ambiguous ? "ambiguous" : "rejected",
          messageId: null,
          httpStatus: resp.status,
        };
      }
      const payload = await resp.json().catch(() => null);
      return {
        outcome: "accepted",
        messageId: evolutionMessageId(payload),
        httpStatus: resp.status,
      };
    } catch (e) {
      console.warn("[evolution] envio falhou", {
        instance: opts.instance,
        destinationLastFour,
        errorType: e instanceof Error ? e.name : "UnknownError",
      });
      return { outcome: "ambiguous", messageId: null, httpStatus: null };
    }
  }
  return { outcome: "rejected", messageId: null, httpStatus: 401 };
}

/** Envia o texto e diz se a Evolution aceitou. Nunca lança. */
export async function sendWhatsText(opts: EnvioEvolution): Promise<boolean> {
  const result = await sendWhatsTextDetailed(opts);
  return result.outcome === "accepted";
}
