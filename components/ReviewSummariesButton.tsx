import React, { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';

/**
 * "Resumos para revisar (N)" ao lado de "Lançar Aulas".
 *
 * 22/11/2026 (decisão do Vinícius): lançar a aula APROVA o resumo da aula, com o
 * que o professor confirmou no lançamento. A fila que sobra é opcional: aulas
 * ainda não lançadas ou rascunhos sem objetivo/próximo passo. O botão só leva à
 * fila (get_meet_summary_review_queue); não aprova nada sozinho.
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
      title="Resumos de aulas gravadas que ainda não foram aprovados (aula não lançada ou rascunho sem objetivo/próximo passo). Lançar a aula já aprova o resumo."
    >
      <ClipboardCheck size={16} aria-hidden="true" />
      <span>Resumos para revisar ({pending > 99 ? '99+' : pending})</span>
    </button>
  );
};

export default ReviewSummariesButton;
