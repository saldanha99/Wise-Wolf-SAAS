// Descrição da origem de um lead em português corrente, a mesma no aviso do
// grupo e na tela "Registros e origens". Lê só a evidência já normalizada no
// banco (crm_leads.origin_evidence); nunca inventa canal que não foi observado.
export type LeadOrigin = Record<string, unknown>;

const text = (v: unknown, max = 160) =>
  String(v ?? "").replace(/[\r\n*_`]/g, " ").trim().slice(0, max);

const FORMS: Record<string, string> = {
  level_quiz: "Teste de nível",
  institutional_site_home: "Formulário da página inicial",
  institutional_site: "Formulário do site",
  "WhatsApp (IA)": "Mensagem no WhatsApp",
};

const words = (slug: string) =>
  decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/** Formulário ou canal em que a pessoa pediu contato. */
export function leadFormLabel(source: unknown): string {
  // A chave do formulário tem "_" (level_quiz): compara antes de limpar o texto.
  const s = String(source ?? "").trim().slice(0, 120);
  if (!s) return "Não informado";
  if (FORMS[s]) return FORMS[s];
  if (s.startsWith("lp-")) return `Landing page "${words(s.slice(3))}"`;
  if (s.startsWith("glossario")) return "Glossário do site";
  if (/blog/i.test(s)) return "Formulário do blog";
  return text(s, 120);
}

/** Página do site em linguagem de gente: "Página inicial", "Blog: ...". */
export function leadPageLabel(path: unknown): string {
  const p = text(path, 240);
  if (!p) return "";
  if (p === "/") return "Página inicial";
  const blog = p.match(/^\/blog\/([^/?#]+)/);
  if (blog) return `artigo do blog "${words(blog[1])}"`;
  const glossary = p.match(/^\/glossario\/([^/?#]+)/);
  if (glossary) return `glossário "${words(glossary[1])}"`;
  return p;
}

const SEARCH_ENGINES: Record<string, string> = {
  google: "Google",
  bing: "Bing",
  duckduckgo: "DuckDuckGo",
  yahoo: "Yahoo",
};

function engineName(host: unknown): string {
  const h = text(host, 120).toLowerCase();
  const key = Object.keys(SEARCH_ENGINES).find((k) => h.includes(k));
  return key ? SEARCH_ENGINES[key] : h || "buscador";
}

const SOCIAL: Record<string, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  "fb.com": "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
  "t.co": "X/Twitter",
};

function socialName(host: unknown): string {
  const h = text(host, 120).toLowerCase();
  const key = Object.keys(SOCIAL).find((k) => h.includes(k));
  return key ? SOCIAL[key] : "Instagram/Facebook";
}

/** Uma frase: de onde a pessoa veio. */
export function leadOriginHeadline(o: LeadOrigin): string {
  const referrer = o.first_referrer_host || o.referrer_host;
  switch (String(o.channel || "")) {
    case "PAID": {
      const platform = String(o.paid_platform || "");
      if (platform === "META_WHATSAPP") {
        return "Anúncio do Meta (Instagram/Facebook) com botão para o WhatsApp";
      }
      if (platform === "META") return "Anúncio do Meta (Instagram/Facebook)";
      if (platform === "GOOGLE") return "Anúncio do Google";
      return `Anúncio pago (${
        text(o.utm_source) || "plataforma não informada"
      })`;
    }
    case "ORGANIC_SEARCH":
      return `Pesquisa no ${engineName(referrer)} (orgânico, sem anúncio)`;
    case "SOCIAL":
      return `Rede social: ${
        socialName(referrer)
      } (link orgânico, sem anúncio comprovado)`;
    case "REFERRAL":
      return `Veio de outro site: ${text(referrer) || "não informado"}`;
    case "TAGGED":
      return `Link com marcação: ${text(o.utm_source)}${
        o.utm_medium ? ` / ${text(o.utm_medium)}` : ""
      }`;
    case "WHATSAPP_LINK":
      return "Clicou num link para o WhatsApp da escola (site, Instagram ou outro link)";
    case "WHATSAPP_DIRECT":
      return "Procurou o número da escola direto no WhatsApp";
    case "WHATSAPP_UNKNOWN":
      return "Mandou mensagem no WhatsApp sem pista de origem (número salvo, indicação ou conversa iniciada pela escola)";
    default:
      return "Sem pista de origem (entrou direto no site ou o navegador não informou de onde veio)";
  }
}

/** Caminho no site: onde entrou e onde pediu contato, quando houver. */
export function leadOriginJourney(o: LeadOrigin): string {
  const first = leadPageLabel(o.first_landing_path || o.landing_path);
  const last = leadPageLabel(o.last_landing_path || o.landing_path);
  if (!first && !last) return "";
  if (!last || first === last) return `Entrou e pediu contato em: ${first}`;
  if (!first) return `Pediu contato em: ${last}`;
  return `Entrou por: ${first} → pediu contato em: ${last}`;
}

/** Linhas de detalhe que só aparecem quando existem. */
export function leadOriginDetails(o: LeadOrigin): string[] {
  const lines: string[] = [];
  if (o.whatsapp_ad_title) {
    lines.push(`Anúncio: ${text(o.whatsapp_ad_title, 120)}`);
  }
  if (o.utm_campaign) lines.push(`Campanha: ${text(o.utm_campaign)}`);
  if (o.utm_content) lines.push(`Peça do anúncio: ${text(o.utm_content)}`);
  if (o.utm_term) lines.push(`Termo pesquisado: ${text(o.utm_term)}`);
  return lines;
}
