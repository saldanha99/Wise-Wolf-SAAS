// Textos do resumo automático das aulas (fila "Aulas para revisar" e teto
// mensal de IA). Puro, sem Supabase: as telas e os testes usam direto.

const DAY_MS = 86_400_000;

export interface MeetReviewItem {
  session_id: string;
  student_id: string;
  student_name: string | null;
  teacher_id: string;
  teacher_name: string | null;
  class_date: string;
  scheduled_start_at: string;
  version_id: string;
  version: number;
  origin: 'GEMINI_API' | 'GOOGLE_SMART_NOTES' | 'HUMAN_REVIEW' | string;
  draft_created_at: string;
  pending_since: string | null;
  // Fim da retenção da fonte que vence primeiro: depois dele o servidor recusa
  // a aprovação (a fonte some) e o rascunho sai da fila.
  approvable_until: string | null;
  stale: boolean;
}

export interface MeetSummaryBudget {
  ok: boolean;
  month: string;
  cap_usd: number;
  default_cap: boolean;
  spent_usd: number;
  remaining_usd: number;
  cap_reached: boolean;
  paused_until: string | null;
  pause_reason: string | null;
  automatic_count: number;
  manual_count: number;
  failed_count: number;
  // Sugestões da IA para o cartão do aluno (20260928130000): o MESMO teto;
  // spent_usd já inclui. Ausentes em banco anterior à migration.
  card_suggestion_count?: number;
  card_suggestion_spent_usd?: number;
}

const dateBr = (iso: string) =>
  new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });

export function originLabel(origin: string): string {
  if (origin === 'GEMINI_API') return 'Rascunho da IA';
  if (origin === 'GOOGLE_SMART_NOTES') return 'Notas do Gemini';
  return 'Revisão';
}

/** "Esperando desde hoje" / "Esperando há 1 dia" / "Esperando há N dias". */
export function waitingText(pendingSince: string | null, now = Date.now()): string {
  if (!pendingSince) return 'Esperando revisão';
  const days = Math.floor((now - Date.parse(pendingSince)) / DAY_MS);
  if (!Number.isFinite(days) || days <= 0) return 'Esperando desde hoje';
  return days === 1 ? 'Esperando há 1 dia' : `Esperando há ${days} dias`;
}

/**
 * Até quando o rascunho pode ser aprovado. Urgente com 7 dias ou menos: depois
 * do prazo a fonte é apagada e a aprovação é recusada.
 */
export function reviewDeadline(approvableUntil: string | null, now = Date.now()): { text: string; urgent: boolean } {
  if (!approvableUntil) return { text: 'Sem prazo das fontes', urgent: false };
  const until = Date.parse(approvableUntil);
  if (!Number.isFinite(until)) return { text: 'Sem prazo das fontes', urgent: false };
  const daysLeft = Math.ceil((until - now) / DAY_MS);
  if (daysLeft <= 1) return { text: `Aprovar até ${dateBr(approvableUntil)} (último dia)`, urgent: true };
  if (daysLeft <= 7) return { text: `Aprovar até ${dateBr(approvableUntil)} (faltam ${daysLeft} dias)`, urgent: true };
  return { text: `Aprovar até ${dateBr(approvableUntil)}`, urgent: false };
}

export const formatUsd = (value: unknown): string => `US$ ${Number(value || 0).toFixed(2)}`;

/** Parte do teto já gasta, de 0 a 100 (teto zero = cheio). */
export function budgetPercent(spent: number, cap: number): number {
  if (!(cap > 0)) return 100;
  return Math.max(0, Math.min(100, Math.round((spent / cap) * 100)));
}

const PAUSE_REASONS: Record<string, string> = {
  google_summary_ai_not_configured: 'a IA do resumo não está ligada no servidor (GOOGLE_MEET_SUMMARY_AI_ENABLED, chave do OpenRouter ou modelo)',
  google_summary_pricing_required: 'o preço do modelo não está cadastrado',
  google_summary_provider_rejected: 'o OpenRouter recusou a chave ou o modelo',
  google_summary_provider_credits: 'a conta do OpenRouter está sem créditos',
};
export function pauseReasonText(code: string | null | undefined): string {
  return (code && PAUSE_REASONS[code]) || 'a IA do resumo está indisponível no momento';
}

const GENERATION_ERRORS: Record<string, string> = {
  invalid_summary_evidence: 'nenhuma citação do rascunho conferia com a transcrição',
  google_summary_evidence_required: 'o rascunho veio sem citações da aula',
  google_summary_response_invalid: 'a IA devolveu uma resposta ilegível',
  google_summary_response_truncated: 'a resposta da IA veio cortada',
  google_summary_provider_unavailable: 'o provedor da IA não respondeu',
  google_summary_provider_rejected: 'o provedor recusou a chave ou o modelo',
  google_summary_provider_credits: 'a conta do provedor está sem créditos',
  google_summary_rate_limited: 'o provedor pediu para esperar',
  google_summary_refused: 'o modelo se recusou a resumir',
  google_summary_worker_lost: 'a geração foi interrompida',
  documentation_consent_required: 'a autorização da aula foi retirada durante a geração',
  summary_reviewed_meanwhile: 'a aula foi revisada enquanto a IA escrevia',
};
export function generationErrorText(code: string | null | undefined): string {
  return (code && GENERATION_ERRORS[code]) || 'falha na geração';
}

/** Menor validade entre as fontes de um rascunho (as que ainda estão na tela). */
export function draftApprovableUntil(
  sourceIds: string[] | null | undefined,
  artifacts: { id: string; expires_at?: string | null }[],
): string | null {
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact.expires_at || null]));
  let earliest: string | null = null;
  for (const id of sourceIds || []) {
    const expires = byId.get(id);
    if (!expires) continue;
    if (!earliest || Date.parse(expires) < Date.parse(earliest)) earliest = expires;
  }
  return earliest;
}
