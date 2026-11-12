/// <reference lib="deno.ns" />
/**
 * Idade do lead e contato do responsável antes da experimental.
 *
 * Regra da direção (11/11/2026): a atendente sempre pergunta a idade. Menor de
 * 18 anos só tem a experimental pedida aos professores depois de passar o
 * contato de um responsável ciente. Caso real (10/11/2026): lead menor de
 * idade — quem perguntou a idade e pediu o contato do responsável foi a
 * equipe, na mão.
 *
 * O modelo PROPÕE (pergunta com naturalidade e devolve `updates.age`); o código
 * VETA: sem idade, ou menor sem telefone do responsável, o pedido de horário
 * não vai aos professores. Funções puras, testadas em `lead-age.test.ts`.
 */

export const ADULT_AGE = 18;

/** Idade plausível de aluno; fora disso é ruído ("tenho 2 filhos", "300"). */
function plausibleAge(n: number): number | null {
  return Number.isInteger(n) && n >= 3 && n <= 99 ? n : null;
}

/** Idade vinda do modelo (`updates.age`), que pode chegar como texto. */
export function normalizeAge(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number"
    ? raw
    : Number(String(raw).match(/\d+/)?.[0]);
  return Number.isFinite(n) ? plausibleAge(Math.trunc(n)) : null;
}

/**
 * Lê a idade dita pelo lead: "tenho 15 anos", "15 anos", "sou de 2010" não
 * (ano de nascimento fica com o modelo). `askedAge` aceita o número sozinho
 * quando a última pergunta da escola foi a idade ("15").
 */
export function parseLeadAge(text: string, askedAge = false): number | null {
  const t = String(text || "").toLowerCase();
  // Inequívoco em qualquer momento: "tenho 15 anos", "15 anos de idade".
  const strong = t.match(/\btenho\s+(\d{1,2})\s*anos\b/) ||
    t.match(/\b(\d{1,2})\s*anos\s+de\s+idade\b/) ||
    t.match(/\bminha\s+idade\s+(?:é|e)\s+(\d{1,2})\b/);
  if (strong) return plausibleAge(Number(strong[1]));
  // "estudei 5 anos" não é idade; "15 anos" só vale como resposta à pergunta.
  if (askedAge) {
    const weak = t.match(/\b(\d{1,2})\s*anos\b/) ||
      t.trim().match(/^(?:tenho\s+)?(\d{1,2})\s*[.!]?$/);
    if (weak) return plausibleAge(Number(weak[1]));
  }
  return null;
}

/** A mensagem da escola pergunta a idade? */
export function asksAge(text: string): boolean {
  return /\b(idade|quantos anos|qual (?:a )?sua idade)\b/i.test(
    String(text || ""),
  );
}

/** A mensagem da escola pede o contato do responsável? */
export function asksGuardian(text: string): boolean {
  return /respons[aá]vel/i.test(String(text || "")) &&
    /(contato|whats|telefone|n[uú]mero|nome)/i.test(String(text || ""));
}

/**
 * Telefone brasileiro numa mensagem ("11987650000 telefone da minha mãe",
 * "(11) 98765-4321"). Devolve só dígitos com 55. Ignora o próprio número do
 * lead — menor que manda o próprio telefone não passou o do responsável.
 */
export function parseGuardianPhone(
  text: string,
  leadPhone = "",
): string | null {
  const candidates = String(text || "").match(/\+?\d[\d\s().-]{8,18}\d/g) || [];
  const own = String(leadPhone || "").replace(/\D/g, "");
  for (const raw of candidates) {
    let d = raw.replace(/\D/g, "");
    if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
      d = d.slice(2);
    }
    if (d.length !== 10 && d.length !== 11) continue;
    if (Number(d.slice(0, 2)) < 11) continue;
    const full = `55${d}`;
    if (
      own && (own === full || own.endsWith(d) || full.endsWith(own.slice(-8)))
    ) {
      continue;
    }
    return full;
  }
  return null;
}

export type TrialAgeGate =
  | { ok: true; minor: boolean }
  | { ok: false; reason: "age_unknown" | "guardian_missing"; ask: string };

/** Pode pedir a experimental aos professores? Se não, o que perguntar. */
export function trialAgeGate(input: {
  age: number | null;
  guardianPhone: string | null;
}): TrialAgeGate {
  if (input.age === null) {
    return {
      ok: false,
      reason: "age_unknown",
      ask:
        "Antes de eu pedir esse horário ao professor, me conta: quantos anos você tem? 😊",
    };
  }
  if (input.age < ADULT_AGE) {
    if (!input.guardianPhone) {
      return {
        ok: false,
        reason: "guardian_missing",
        ask:
          `Como você tem ${input.age} anos, para fazer a experimental precisamos que um responsável (pai, mãe ou responsável legal) esteja ciente. Me passa o nome e o WhatsApp dele(a)? Assim que eu tiver, peço o horário ao professor 😊`,
      };
    }
    return { ok: true, minor: true };
  }
  return { ok: true, minor: false };
}

/** Instrução da atendente — vale para toda escola. */
export const LEAD_AGE_RULE =
  `- IDADE E RESPONSÁVEL (obrigatório): pergunte a idade do lead com naturalidade, de preferência junto com o objetivo, antes de pedir o horário ao professor. Se tiver MENOS DE 18 ANOS, explique que para a experimental um responsável (pai, mãe ou responsável legal) precisa estar ciente e peça o NOME e o WHATSAPP desse responsável; só depois disso o horário vai ao professor. Registre em updates.age (número), updates.guardian_name e updates.guardian_phone (só dígitos) quando o lead informar. Quando a idade (adulto) ou o contato do responsável (menor) chegar DEPOIS de o lead já ter escolhido um horário da lista, preencha schedule_trial com aquele horário e diga que vai verificar com o professor. Nunca peça documento, CPF nem data de nascimento completa.`;
