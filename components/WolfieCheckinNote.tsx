import React, { useEffect, useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { supabase } from '../lib/supabase';

/** Resultado do check-in do Wolfie na véspera da aula (RPC teacher_wolfie_checkins). */
export interface WolfieCheckin {
  completed_at: string;
  score: number | null;
  topic: string | null;
  class_date: string | null;
  track_score: number | null;
  priority: string | null;
  missed: string[];
}

/**
 * Busca de uma vez os check-ins dos alunos da lista. Falha silenciosa: o
 * painel do professor não pode quebrar por causa de um extra só de leitura.
 */
export function useWolfieCheckins(studentIds: string[]): Record<string, WolfieCheckin> {
  const [checkins, setCheckins] = useState<Record<string, WolfieCheckin>>({});
  const key = [...new Set(studentIds.filter(Boolean))].sort().join(',');
  useEffect(() => {
    if (!key) {
      setCheckins({});
      return;
    }
    let alive = true;
    supabase
      .rpc('teacher_wolfie_checkins', { p_student_ids: key.split(',') })
      .then(({ data, error }) => {
        if (!alive || error || !data || typeof data !== 'object') return;
        setCheckins(data as Record<string, WolfieCheckin>);
      });
    return () => {
      alive = false;
    };
  }, [key]);
  return checkins;
}

export const WolfieCheckinNote: React.FC<{ checkin: WolfieCheckin }> = ({ checkin }) => {
  const missed = (checkin.missed || []).filter(Boolean).slice(0, 2);
  return (
    <div
      data-tour="wolfie-checkin-note"
      className="mt-2 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-brand-text"
    >
      <p className="flex items-center gap-1.5 font-bold text-emerald-700 dark:text-emerald-300">
        <ClipboardCheck size={13} aria-hidden="true" />
        Check-in do Wolfie{checkin.score !== null ? ` · ${checkin.score}%` : ''}
        {checkin.topic ? <span className="font-medium text-brand-muted"> · {checkin.topic}</span> : null}
      </p>
      {missed.length ? (
        <p className="mt-1 text-brand-muted">
          Ainda errou: {missed.map((item) => `“${item.length > 70 ? `${item.slice(0, 70)}…` : item}”`).join(' · ')}
        </p>
      ) : (
        <p className="mt-1 text-brand-muted">Acertou tudo no check-in.</p>
      )}
      {checkin.priority ? <p className="mt-1 text-brand-muted">Prioridade que o Wolfie viu: {checkin.priority}</p> : null}
    </div>
  );
};

export default WolfieCheckinNote;
