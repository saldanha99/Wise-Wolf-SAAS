/**
 * ETIQUETAS DO WHATSAPP — casamento entre a etiqueta criada no aplicativo e o
 * tipo de contato que o sistema já conhece.
 *
 * A API do WhatsApp aplica etiqueta existente, mas não cria etiqueta: quem cria
 * é a pessoa, no WhatsApp Business. Então aqui se lê o NOME que ela escolheu e
 * se descobre a que tipo ele corresponde — "Lead Professor" e "Candidato" são a
 * mesma coisa para o sistema (candidate), e precisam ser testados antes de
 * "Professor" e de "Lead", senão o nome composto cai na categoria errada.
 */

export interface WhatsAppLabel {
  id: string;
  name: string;
}

export type ContactKind = "student" | "lead" | "teacher" | "candidate";

function fold(text: string): string {
  return String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().trim();
}

/** A que tipo de contato este NOME de etiqueta se refere (ou null). */
export function labelKind(name: string): ContactKind | null {
  const n = fold(name);
  if (!n) return null;
  if (/candidat/.test(n)) return "candidate";
  if (
    /(lead|vaga|curriculo)/.test(n) && /(professor|teacher|docente)/.test(n)
  ) {
    return "candidate";
  }
  if (/(aluno|aluna|student|matricula|matriculado)/.test(n)) return "student";
  if (/(professor|teacher|docente)/.test(n)) return "teacher";
  if (/(lead|prospect|interessad)/.test(n)) return "lead";
  return null;
}

/**
 * Uma etiqueta por tipo. Com duas candidatas ao mesmo tipo fica a de nome mais
 * curto — "Aluno" ganha de "Aluno antigo", que é mais específica e provavelmente
 * não é a etiqueta geral que a escola quer aplicar em massa.
 */
export function mapLabelsByKind(
  labels: WhatsAppLabel[],
): Partial<Record<ContactKind, WhatsAppLabel>> {
  const mapa: Partial<Record<ContactKind, WhatsAppLabel>> = {};
  for (const label of labels || []) {
    const id = String(label?.id ?? "").trim();
    const name = String(label?.name ?? "").trim();
    if (!id || !name) continue;
    const kind = labelKind(name);
    if (!kind) continue;
    const atual = mapa[kind];
    if (!atual || name.length < atual.name.length) mapa[kind] = { id, name };
  }
  return mapa;
}
