// Pista de origem que o próprio WhatsApp manda na mensagem de quem abre a
// conversa: anúncio do Meta com botão para o WhatsApp (externalAdReply /
// conversionSource), link do número (phone_number_hyperlink) ou busca direta
// (global_search_new_chat). Só lê o que veio no evento; sem pista, devolve null.
export type WhatsappEntry = {
  whatsapp_entry?: string;
  whatsapp_entry_app?: string;
  whatsapp_ad?: boolean;
  whatsapp_ad_id?: string;
  whatsapp_ad_title?: string;
  whatsapp_ad_host?: string;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;
const slug = (v: unknown, max: number) => {
  const s = String(v ?? "").trim().toLowerCase();
  return new RegExp(`^[a-z_]{1,${max}}$`).test(s) ? s : "";
};

// O contexto aparece em lugares diferentes conforme o tipo da mensagem.
function contexts(item: unknown): Obj[] {
  const data = obj(item);
  if (!data) return [];
  const found: Obj[] = [];
  const add = (v: unknown) => {
    const o = obj(v);
    if (o) found.push(o);
  };
  add(data.contextInfo);
  const message = obj(data.message);
  if (message) {
    add(message.messageContextInfo);
    for (const value of Object.values(message)) add(obj(value)?.contextInfo);
  }
  return found;
}

export function whatsappEntryEvidence(item: unknown): WhatsappEntry | null {
  const entry: WhatsappEntry = {};
  for (const ctx of contexts(item)) {
    const point = slug(ctx.entryPointConversionSource, 60);
    if (point && !entry.whatsapp_entry) entry.whatsapp_entry = point;
    const app = slug(ctx.entryPointConversionApp, 30);
    if (app && !entry.whatsapp_entry_app) entry.whatsapp_entry_app = app;
    if (/fb_ads|ctwa/i.test(String(ctx.conversionSource ?? ""))) {
      entry.whatsapp_ad = true;
    }
    const ad = obj(ctx.externalAdReply);
    if (
      ad && (String(ad.sourceType ?? "").toLowerCase() === "ad" ||
        ad.ctwaClid || ad.sourceId)
    ) {
      entry.whatsapp_ad = true;
      const id = String(ad.sourceId ?? "").trim();
      if (/^[0-9]{1,30}$/.test(id)) entry.whatsapp_ad_id = id;
      const title = String(ad.title ?? "").replace(/[\r\n\t]+/g, " ").trim();
      if (title) entry.whatsapp_ad_title = title.slice(0, 120);
      try {
        const host = new URL(String(ad.sourceUrl ?? "")).hostname;
        if (/^[a-z0-9.-]{1,120}$/i.test(host)) entry.whatsapp_ad_host = host;
      } catch {
        // sem URL do anúncio
      }
    }
  }
  if (entry.whatsapp_entry?.startsWith("ctwa")) entry.whatsapp_ad = true;
  return Object.keys(entry).length ? entry : null;
}

/** Linha "Origem: {...}" que private.lead_origin_evidence lê nas notas do lead. */
export function whatsappEntryNotes(entry: WhatsappEntry | null | undefined) {
  return entry ? `Origem: ${JSON.stringify(entry)}` : null;
}
