/// <reference lib="deno.ns" />

/**
 * Cobertura FORÇADA pela coordenação já nasce confirmada, sem o aceite do
 * substituto — e por isso pulava o pacote que o aceite manda (contato do aluno,
 * últimas aulas lançadas, data da última aula com resumo aprovado, sala oficial
 * e link com login do dossiê — o texto do resumo fica no dossiê). Aqui ela
 * passa pela mesma porta do banco
 * (`coverage_briefing_enqueue`, migration 20260928100000), que enfileira na
 * instância central pela `notification_queue` — o teto do WhatsApp vale por
 * cima. O grupo da coordenação não é avisado: quem forçou foi ela, pela tela.
 *
 * Melhor esforço: a cobertura já foi gravada; falha aqui vira aviso na
 * resposta, nunca desfaz a cobertura.
 */
export type BriefingRpc = (
  fn: "coverage_briefing_enqueue",
  args: { p_coverage_id: string; p_notify_group: boolean },
) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;

export const BRIEFING_NOT_QUEUED =
  "cobertura criada, mas o pacote do substituto não foi enfileirado";
export const BRIEFING_NO_TEACHER_PHONE =
  "cobertura criada, mas o substituto não tem WhatsApp no cadastro: o pacote (contato e link do dossiê) não saiu";

/** Devolve o aviso para a tela, ou null quando o pacote foi enfileirado. */
export async function enqueueForcedCoverageBriefing(
  rpc: BriefingRpc,
  coverageId: string,
): Promise<string | null> {
  let response: { data: unknown; error: { code?: string } | null };
  try {
    response = await rpc("coverage_briefing_enqueue", {
      p_coverage_id: coverageId,
      p_notify_group: false,
    });
  } catch {
    console.error("coverage-admin briefing enqueue failed", {
      code: "RPC_THROWN",
    });
    return BRIEFING_NOT_QUEUED;
  }
  if (response.error) {
    console.error("coverage-admin briefing enqueue failed", {
      code: response.error.code ?? "RPC_ERROR",
    });
    return BRIEFING_NOT_QUEUED;
  }
  const result = response.data && typeof response.data === "object" &&
      !Array.isArray(response.data)
    ? response.data as Record<string, unknown>
    : null;
  if (!result || result.ok !== true) {
    console.warn("coverage-admin briefing not queued", {
      error: typeof result?.error === "string" ? result.error : "unknown",
    });
    return BRIEFING_NOT_QUEUED;
  }
  if (result.cover_phone_known === false) return BRIEFING_NO_TEACHER_PHONE;
  return null;
}
