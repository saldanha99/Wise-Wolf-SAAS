/**
 * REGRAS DE CONTATO COM O LEAD — quando podemos falar, e o que oferecer.
 *
 * As duas regras aqui viviam soltas dentro do `whatsapp-inbound` e precisavam
 * valer também no `sdr-followups` e no `funnel-sweeper`. Copiar seria repetir o
 * erro clássico deste projeto: duas telas com a mesma regra que divergem, e a
 * cópia errada custa lead ou dinheiro.
 */

/**
 * Quanto tempo o atendimento humano cala o robô.
 *
 * 72h é o tempo de um atendimento humano vivo, inclusive atravessando um fim de
 * semana. Passado isso, quem escreveu volta a ser atendido — e, desde 13/08/2026,
 * também volta a receber prospecção ativa.
 */
export const HANDOFF_TTL_MS = 72 * 3600 * 1000;

export interface LinhaComHandoff {
  ai_handoff?: boolean | null;
  ai_handoff_at?: string | null;
}

/**
 * O humano ainda está no comando deste contato?
 *
 * ⚠️ Sem carimbo (linha anterior à migration do TTL) o handoff conta como
 * VENCIDO: manter um contato mudo sem saber desde quando é exatamente o defeito
 * que o TTL veio corrigir — 112 de 376 mensagens em 30 dias morreram assim.
 */
export function handoffAtivo(row: LinhaComHandoff | null | undefined): boolean {
  if (row?.ai_handoff !== true) return false;
  if (!row.ai_handoff_at) return false;
  const at = new Date(row.ai_handoff_at).getTime();
  if (Number.isNaN(at)) return false;
  return Date.now() - at < HANDOFF_TTL_MS;
}

export interface SlotDeAgenda {
  day_of_week: number;
  start_time: string;
}

/**
 * Alternativas para um horário que não deu certo.
 *
 * Devolve o MESMO horário em outros dias e outros horários no MESMO dia — as
 * duas perguntas que um aluno realmente faz ("e em outro dia?" / "e mais
 * tarde?"). Domingo fica fora (a escola não opera), e a janela 07:00–21:30
 * evita oferecer madrugada por causa de linha suja na disponibilidade.
 *
 * Puro de propósito: quem chama faz a query e monta a frase.
 */
export function pickAlternatives(
  rows: SlotDeAgenda[] | null | undefined,
  reqDow: number,
  reqTime: string,
): { days: number[]; times: string[] } {
  const diasComOHorario = new Set<number>();
  const horariosNoDia = new Set<string>();
  for (const r of (rows || [])) {
    const t = String(r?.start_time ?? "").slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(t)) continue;
    const d = Number(r.day_of_week);
    if (!Number.isInteger(d)) continue;
    if (t === reqTime && d !== reqDow && d >= 1 && d <= 6) diasComOHorario.add(d);
    if (d === reqDow && t >= "07:00" && t <= "21:30") horariosNoDia.add(t);
  }
  return {
    days: [...diasComOHorario].sort((a, b) => a - b),
    times: [...horariosNoDia].sort(),
  };
}
