import React, { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';

/**
 * "Revisar resumos (N)" ao lado de "Lançar Aulas" (22/11/2026).
 *
 * Desde 28/09 o rascunho da IA preenche o lançamento da aula, mas o lançamento
 * NÃO aprova o resumo (decisão registrada no CLAUDE.md). Os professores pararam
 * de abrir a fila em "Salas e continuidade" e o resumo aprovado — o que vai para a
 * memória do aluno, o Planner e o Wolfie — deixou de existir. O botão só lembra e
 * leva à mesma fila (get_meet_summary_review_queue); não aprova nada.
 */
export const ReviewSummariesButton: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    supabase.rpc('get_meet_summary_review_queue').then(({ data, error }) => {
      if (!alive || error || !data) return;
      const items = Array.isArray((data as { items?: unknown[] }).items) ? (data as { items: unknown[] }).items : [];
      setPending(items.length);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!pending) return null;
  return (
    <button
      type="button"
      data-tour="teacher-review-summaries"
      onClick={onOpen}
      className="flex items-center gap-2 rounded-xl border border-amber-400/50 bg-amber-400/10 px-5 py-3 text-xs font-bold text-amber-700 transition-all hover:bg-amber-400/20 dark:text-amber-300"
      title="Resumos das aulas gravadas esperando a sua revisão. O resumo aprovado alimenta a memória do aluno, o Planner e a trilha do Wolfie."
    >
      <ClipboardCheck size={16} aria-hidden="true" />
      <span>Revisar resumos ({pending > 99 ? '99+' : pending})</span>
    </button>
  );
};

export default ReviewSummariesButton;
