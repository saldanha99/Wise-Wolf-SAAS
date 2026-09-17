/**
 * PREÇO PARA O LEAD — leitura do que ele pediu e escrita da tabela.
 *
 * Sem banco e sem rede. O catálogo (`student_pricing_plans`) chega pronto; aqui
 * só se decide o que o lead perguntou e como a tabela é escrita.
 *
 * O caso que motivou (lead Diná, 17/09/2026 07:12–07:21): ela pediu
 * "estimativa de valores", ouviu "os planos começam em R$ 169"; perguntou
 * "4 vezes na semana qual valor?" e ouviu, DUAS vezes, "esse horário já está
 * aguardando o aceite de um professor". Reclamou de ser tratada "como idiota
 * com essas mensagens repetidas" e a direção respondeu na mão com a tabela
 * inteira. Decisão da direção: quando o lead diz a frequência, a tabela sai —
 * igual a direção manda.
 */

import { brlFromNumber, type CatalogPrice } from "./trial-closing.ts";

/**
 * A lista que a direção manda mostra só os planos com fidelidade (6 e 12
 * meses); o mensal existe no catálogo e a atendente cita se perguntarem por
 * opção sem fidelidade, mas ele não entra na tabela por padrão.
 */
export const LIST_MIN_DURATION_MONTHS = 6;

const fold = (text: string): string =>
  String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const NUMBER_WORDS: Record<string, number> = {
  uma: 1,
  um: 1,
  duas: 2,
  dois: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
};

/**
 * "4 vezes na semana", "4x por semana", "quatro aulas por semana",
 * "4 aulas de 30 min por semana", "3x/semana". Devolve 1–7 ou null.
 * O "30" de "30 min" não entra: o número precisa vir colado a x/vezes/aulas.
 */
export function detectFrequencyRequest(text: string): number | null {
  const source = fold(text);
  const patterns = [
    /\b(\d)\s*(?:x|vezes|aulas?)\b[^.!?\n]{0,25}?\bsemana\b/,
    /\b(uma|um|duas|dois|tres|quatro|cinco|seis|sete)\s+(?:vezes|aulas?)\b[^.!?\n]{0,25}?\bsemana\b/,
    /\b(\d)\s*x\s*\/\s*semana\b/,
    /\bsemana\b[^.!?\n]{0,12}?\b(\d)\s*(?:x|vezes|aulas?)\b/,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const raw = match[1];
    const value = /^\d$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
    if (value && value >= 1 && value <= 7) return value;
  }
  return null;
}

/** "tabela", "lista", "todos os planos", "estimativa de valores", "quais os planos". */
export function asksFullPriceList(text: string): boolean {
  const source = fold(text);
  return /\b(tabela|lista(?:gem)?|todos os (?:planos|valores|precos)|todas as opcoes|opcoes de (?:planos?|valores|preco)|estimativa|quais (?:sao )?os (?:planos|valores|precos)|planos disponiveis|me passa os (?:planos|valores))\b/
    .test(source);
}

/** "??", "?", "e aí", "então?", "oi?", "alô" — o lead cobrando resposta. */
export function isFollowUpNudge(text: string): boolean {
  const source = fold(text).replace(/[\s.!,😊🙏]/gu, "");
  if (!source) return false;
  if (/^\?+$/.test(source)) return true;
  return /^(?:e\s*ai\??|entao\??|oi\??|alo\??|ola\??|e\s*entao\??|e\s*o\s*valor\??|cade\??|e\s*dai\??)$/
    .test(source);
}

/** "Se você não me passar o valor, não tenho interesse" — cobrança com irritação. */
export function complainsAboutRepetition(text: string): boolean {
  const source = fold(text);
  return /\b(repetid|repetindo|mesma (?:mensagem|coisa|resposta)|robo|robozinho|idiota|nao (?:tenho|tem) interesse|nao me pass|so (?:responde|manda) isso|de novo isso|nao respond)/
    .test(source);
}

/** Todos os R$ que aparecem no texto, como número. */
export function extractPricesBrl(text: string): number[] {
  const values: number[] = [];
  const brl = /R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/g;
  const source = String(text || "");
  for (const match of source.matchAll(brl)) {
    const whole = match[1].replace(/\./g, "");
    const cents = match[2] ? `.${match[2].padEnd(2, "0")}` : "";
    const value = Number(`${whole}${cents}`);
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  // "299 reais" / "299 por mês" sem o R$ — lido sobre o texto já sem os R$,
  // senão "R$355/mês" contaria duas vezes.
  const rest = source.replace(brl, " ");
  for (
    const match of rest.matchAll(
      /\b(\d{2,4})(?:,(\d{1,2}))?\s*(?:reais|\/\s*m[eê]s|por\s+m[eê]s)\b/gi,
    )
  ) {
    const value = Number(
      `${match[1]}${match[2] ? "." + match[2].padEnd(2, "0") : ""}`,
    );
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  return values;
}

/** Os valores que a atendente pode escrever: os do catálogo, mais o mínimo configurado. */
export function allowedPrices(
  catalog: CatalogPrice[],
  minimumPlanPriceBrl?: number | null,
): Set<number> {
  const allowed = new Set<number>();
  for (const price of catalog) allowed.add(Number(price.value));
  if (minimumPlanPriceBrl && minimumPlanPriceBrl > 0) {
    allowed.add(Number(minimumPlanPriceBrl));
  }
  return allowed;
}

/** Alguma mensalidade escrita na resposta não está no catálogo? */
export function hasForeignPrice(reply: string, allowed: Set<number>): boolean {
  return extractPricesBrl(reply).some((value) => !allowed.has(value));
}

/** O menor valor do catálogo — "a partir de". */
export function minimumCatalogPrice(catalog: CatalogPrice[]): number | null {
  const values = catalog.map((price) => Number(price.value)).filter((value) =>
    Number.isFinite(value) && value > 0
  );
  return values.length ? Math.min(...values) : null;
}

/** "R$198" para inteiro, "R$ 198,50" quando tem centavos — como a direção escreve. */
export function brlShort(value: number): string {
  const number = Number(value);
  if (Number.isInteger(number)) return `R$${number}`;
  return brlFromNumber(number);
}

const durationTitle = (months: number): string =>
  months === 1 ? "Plano mensal (sem fidelidade)" : `Planos de ${months} meses`;

/**
 * A tabela no formato que a direção manda (mensagem de 17/09/2026 08:03):
 * um bloco por duração, uma linha por frequência, do menor para o maior
 * compromisso. A duração mais longa ganha "(com desconto)" quando é mais
 * barata que a anterior na mesma frequência.
 */
export function formatPriceList(
  catalog: CatalogPrice[],
  opts: { minDuration?: number } = {},
): string {
  const minDuration = opts.minDuration ?? LIST_MIN_DURATION_MONTHS;
  const byDuration = new Map<number, CatalogPrice[]>();
  for (const price of catalog) {
    if (!(Number(price.value) > 0)) continue;
    if (Number(price.duration) < minDuration) continue;
    const list = byDuration.get(price.duration) || [];
    list.push(price);
    byDuration.set(price.duration, list);
  }
  const durations = [...byDuration.keys()].sort((a, b) => a - b);
  const blocks: string[] = [];
  let previous: CatalogPrice[] | null = null;
  for (const duration of durations) {
    const rows = (byDuration.get(duration) || []).sort((a, b) =>
      a.frequency - b.frequency
    );
    const cheaper = previous
      ? rows.some((row) => {
        const before = previous!.find((p) => p.frequency === row.frequency);
        return before ? Number(row.value) < Number(before.value) : false;
      })
      : false;
    const title = `🔹 ${durationTitle(duration)}${
      cheaper ? " (com desconto)" : ""
    }`;
    const lines = rows.map((row) =>
      `✅ ${row.frequency}x por semana – ${brlShort(row.value)}/mês`
    );
    blocks.push([title, ...lines].join("\n"));
    previous = rows;
  }
  return blocks.join("\n\n");
}

/**
 * "4x por semana fica R$355/mês no plano de 6 meses ou R$299/mês no de 12."
 * Sem essa frequência no catálogo, devolve null — quem responde é a tabela.
 */
export function formatFrequencyAnswer(
  catalog: CatalogPrice[],
  frequency: number,
  opts: { minDuration?: number } = {},
): string | null {
  const minDuration = opts.minDuration ?? LIST_MIN_DURATION_MONTHS;
  const rows = catalog
    .filter((price) =>
      price.frequency === frequency && Number(price.value) > 0 &&
      Number(price.duration) >= minDuration
    )
    .sort((a, b) => a.duration - b.duration);
  if (!rows.length) return null;
  const parts = rows.map((row, index) =>
    `${brlShort(row.value)}/mês ${
      index === 0 ? "no plano" : "no"
    } de ${row.duration} meses`
  );
  const joined = parts.length > 1
    ? `${parts.slice(0, -1).join(", ")} ou ${parts[parts.length - 1]}`
    : parts[0];
  return `${frequency}x por semana fica ${joined}.`;
}

/** Linhas de fato para o modelo: ele escreve com naturalidade, mas só com estes números. */
export function catalogFactsForPrompt(catalog: CatalogPrice[]): string {
  const rows = [...catalog]
    .filter((price) => Number(price.value) > 0)
    .sort((a, b) => a.duration - b.duration || a.frequency - b.frequency);
  if (!rows.length) return "";
  const byDuration = new Map<number, string[]>();
  for (const row of rows) {
    const list = byDuration.get(row.duration) || [];
    list.push(`${row.frequency}x/semana ${brlShort(row.value)}/mês`);
    byDuration.set(row.duration, list);
  }
  return [...byDuration.entries()].map(([duration, items]) =>
    `${duration === 1 ? "Mensal (sem fidelidade)" : `${duration} meses`}: ${
      items.join(" · ")
    }`
  ).join("\n");
}

type HistoryMessage = { role: string; content: string };

/** Uma resposta com 4+ valores é uma tabela, mesmo sem o formato da direção. */
export const TABLE_MIN_PRICES = 4;

/** A tabela já foi para este lead (nesta conversa)? */
export function priceListAlreadySent(history: HistoryMessage[]): boolean {
  return history.some((message) =>
    message.role === "assistant" &&
    (/🔹 Planos? de \d+ meses|🔹 Plano mensal/.test(message.content || "") ||
      extractPricesBrl(message.content || "").length >= TABLE_MIN_PRICES)
  );
}

/**
 * O lead perguntou preço (ou disse a frequência) e, desde então, nenhuma
 * resposta trouxe um valor? Então a pergunta está em aberto — "??" ou uma
 * reclamação depois disso é cobrança de preço, não conversa nova.
 */
export function hasUnansweredPriceQuestion(
  history: HistoryMessage[],
  isPriceRequest: (text: string) => boolean,
): boolean {
  let pending = false;
  for (const message of history) {
    if (message.role === "user") {
      if (
        isPriceRequest(message.content) ||
        detectFrequencyRequest(message.content) !== null
      ) pending = true;
      continue;
    }
    if (
      message.role === "assistant" && pending &&
      extractPricesBrl(message.content).length > 0
    ) pending = false;
  }
  return pending;
}

/**
 * A mensagem fala de dia/horário? É o que decide se um `schedule_trial`
 * repetido pelo modelo é pedido de verdade ou eco do pedido anterior.
 * "4 vezes na semana qual valor?" não é pedido de horário.
 */
export function mentionsSchedule(text: string): boolean {
  const source = fold(text);
  if (/\b\d{1,2}\s*(?:h|hs|hrs|horas?)\b/.test(source)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(source)) return true;
  if (/\b(?:as|às)\s+\d{1,2}\b/.test(source)) return true;
  return /\b(segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|hoje|horario|horarios|marcar|agendar|remarcar|agendamento|experimental|manha|tarde|noite|meio[- ]dia)\b/
    .test(source);
}
