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
 * mesmo no WhatsApp). Ou seja, isto NÃO explica a falha do follow-up da lead
 * Cléria (`553399975104`), que segue sem causa conhecida. O valor aqui é
 * unificar o envio e cobrir o caso quando ele aparecer — não é uma correção
 * medida. Antes de atribuir uma falha de entrega ao 9º dígito, consulte
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
      if (!resp.ok) {
        // O MOTIVO da recusa precisa aparecer em algum lugar. Sem isto, um
        // envio recusado vira só um `false` — foi o que aconteceu com o
        // follow-up da lead Cléria em 13/08/2026, cujo número existe no
        // WhatsApp e mesmo assim falhou: sem o corpo da resposta não há como
        // saber se foi limite, sessão caída ou payload.
        const corpo = await resp.text().catch(() => "");
        console.warn("[evolution] envio recusado", {
          status: resp.status,
          instance: opts.instance,
          destino: alvo,
          corpo: corpo.replace(/\s+/g, " ").slice(0, 200),
        });
        return false;
      }
      return true;
    } catch (e) {
      console.warn("[evolution] envio falhou", {
        instance: opts.instance,
        destino: alvo,
        erro: (e as Error).message.slice(0, 120),
      });
      return false;
    }
  }
  return false;
}
