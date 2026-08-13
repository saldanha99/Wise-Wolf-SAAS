/**
 * ENVIO PELO WHATSAPP (Evolution) — com resolução de JID.
 *
 * Muitas contas brasileiras de DDD antigo estão registradas no WhatsApp **sem o
 * 9º dígito**. Mandar para o número "no chute" não bate com o JID real e a
 * mensagem nunca chega — a Evolution ainda responde 200/PENDING, então o envio
 * parece ter dado certo.
 *
 * O `funnel-sweeper` já resolvia o JID antes de enviar; o `sdr-followups` e o
 * `whatsapp-inbound` não. Medido em 13/08/2026: o follow-up da lead Cléria
 * (`553399975104`, 12 dígitos) falhou na primeira rodada da prospecção
 * reativada, e **9 leads da base** têm telefone nesse formato.
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
}

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
      const resp = await fetch(`${base}/chat/whatsappNumbers/${encodeURIComponent(instance)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key },
        body: JSON.stringify({ numbers: [phone] }),
        signal: AbortSignal.timeout(10000),
      });
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

/** Envia o texto e diz se a Evolution aceitou. Nunca lança. */
export async function sendWhatsText(opts: EnvioEvolution): Promise<boolean> {
  const alvo = (await resolveJid(opts.base, opts.keys, opts.instance, opts.to)) || opts.to;
  for (const key of opts.keys) {
    try {
      const resp = await fetch(`${opts.base}/message/sendText/${encodeURIComponent(opts.instance)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: key },
        body: JSON.stringify({
          number: alvo,
          text: opts.text,
          delay: opts.delayMs ?? 1200,
          linkPreview: false,
        }),
        signal: AbortSignal.timeout(15000),
      });
      // 401 é chave errada: tenta a próxima em vez de desistir do envio.
      if (resp.status === 401) continue;
      return resp.ok;
    } catch {
      return false;
    }
  }
  return false;
}
