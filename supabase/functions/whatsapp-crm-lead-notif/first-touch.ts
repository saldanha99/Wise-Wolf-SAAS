// Primeira mensagem para quem acabou de preencher o formulário da escola.
//
// Até 15/09/2026 o formulário respondia "nossa equipe entrará em contato em
// breve" e parava ali: o lead não entrava no robô (ai_handled ficava false, nada
// em ai_wa_messages) e o primeiro toque da varredura estava desligado. De 01 a
// 15/09, 31 leads de formulário nunca receberam uma segunda mensagem.
//
// Agora a resposta ao formulário já vem da atendente, e ela pergunta dias e
// horários logo de cara: o que mais trava a experimental é achar professor livre
// no horário do aluno (18 de 25 conversas do período eram sobre horário).
//
// Responder o formulário na hora, a qualquer hora, não é contato frio: a pessoa
// acabou de pedir. O teto anti-bloqueio continua valendo para a varredura dos
// leads antigos (funnel-sweeper).

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;

/**
 * A atendente está ligada para a escola? Só `sdr.enabled === false` desliga.
 * `sdr.first_touch` NÃO entra aqui: ele governa o contato com lead antigo, não
 * a resposta a quem acabou de preencher o formulário.
 */
export function sdrEnabled(cfg: unknown): boolean {
  return asRecord(asRecord(cfg)?.sdr)?.enabled !== false;
}

/** Nome configurado da atendente, cru — quem chama passa pelo filtro de texto. */
export function sdrAgentName(cfg: unknown): unknown {
  return asRecord(asRecord(asRecord(cfg)?.agents)?.atendente)?.name;
}

/** Primeiro nome apresentável, ou "" quando o campo não parece um nome. */
export function greetFirstName(raw: string | null): string {
  const first = (raw || "").trim().split(/\s+/)[0] || "";
  if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$/.test(first)) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

export function leadOpeningMessage(input: {
  name: string | null;
  sdrName: string | null;
  brandName: string;
}): string {
  const first = greetFirstName(input.name);
  const who = input.sdrName
    ? `${input.sdrName}, da ${input.brandName}`
    : `a equipe da ${input.brandName}`;
  return `Oi${
    first ? ", " + first : ""
  }! Aqui é ${who} 😊 Recebi seu cadastro agora. A primeira aula é experimental e gratuita, e eu já quero deixar ela marcada pra você.\n\nMe conta: quais dias e horários ficam bons pra você? E o inglês é pra trabalho, viagem ou outro objetivo?`;
}

/** A resposta antiga, para escola com a atendente desligada. */
export function formWelcomeMessage(
  name: string | null,
  brandName: string,
): string {
  const first = greetFirstName(name);
  return `*Olá${
    first ? " " + first : ""
  }, bem-vindo(a) à ${brandName}!*\n\nRecebemos seu interesse e nossa equipe entrará em contato em breve para agendar sua aula experimental gratuita. 🚀`;
}

/** Janela em que um segundo cadastro do mesmo telefone não gera outra mensagem. */
export const DUPLICATE_WINDOW_MS = 12 * 3600 * 1000;

/** Já falamos com este telefone há pouco? (dois cadastros seguidos, duplo clique) */
export function recentlyMessaged(
  lastOutAt: string | null,
  now: number,
): boolean {
  if (!lastOutAt) return false;
  const at = new Date(lastOutAt).getTime();
  return Number.isFinite(at) && now - at < DUPLICATE_WINDOW_MS;
}
