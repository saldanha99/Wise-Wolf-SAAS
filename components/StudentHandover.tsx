import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { readLearningCard } from '../lib/studentLearningCard';
import StudentLearningCard from './StudentLearningCard';

type Evidence = { id: string; occurred_at?: string; class_date?: string; lesson_objective?: string; content_practiced?: string[]; content_covered?: string; recurring_errors?: string[]; student_difficulties?: string; homework_assigned?: string; recommended_next_step?: string };
export default function StudentHandover({ studentId }: { studentId: string }) {
  const [data, setData] = useState<{ memories: Evidence[]; logs: Evidence[]; learning_card?: unknown } | null>(null);
  const [error, setError] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (acknowledge = false) => {
    setBusy(true); setError('');
    try {
      const result = await supabase.rpc('get_student_handover', { p_student_id: studentId, p_acknowledge: acknowledge });
      if (result.error || result.data?.ok !== true) throw new Error('unavailable');
      setData(result.data); if (acknowledge) setAcknowledged(true);
    } catch { setError('Não foi possível acessar o dossiê. Verifique sua vinculação ao aluno.'); }
    finally { setBusy(false); }
  }, [studentId]);
  useEffect(() => { setAcknowledged(false); void load(); }, [load]);
  // Cartão preenchido pelo professor (get_student_handover → learning_card).
  const learningCard = readLearningCard(data?.learning_card);
  const evidence = (entry: Evidence, kind: string) => <article key={entry.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
    <p className="text-xs text-slate-500">{kind} · {(entry.class_date || entry.occurred_at || '').slice(0, 10)}</p>
    <h4 className="mt-1 font-semibold">{entry.lesson_objective || 'Objetivo não registrado'}</h4>
    <dl className="mt-2 space-y-2 text-sm">
      <div><dt className="font-medium">Conteúdo trabalhado</dt><dd>{entry.content_practiced?.join('; ') || entry.content_covered || 'Não registrado'}</dd></div>
      <div><dt className="font-medium">Dificuldades observadas</dt><dd>{entry.recurring_errors?.join('; ') || entry.student_difficulties || 'Não registrado'}</dd></div>
      <div><dt className="font-medium">Tarefa</dt><dd>{entry.homework_assigned || 'Não registrada'}</dd></div>
      <div><dt className="font-medium">Próximo passo</dt><dd>{entry.recommended_next_step || 'Precisa ser definido'}</dd></div>
    </dl>
  </article>;
  return <section className="space-y-4 text-slate-800 dark:text-slate-100">
    <h3 className="text-lg font-bold">Continuidade pedagógica</h3>
    <p className="text-sm text-slate-500">Resumos revisados pela escola e relatos do professor ficam identificados separadamente. Planejamentos e rascunhos de IA não são apresentados como conteúdo já ensinado.</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {!data && busy && <p>Carregando dossiê…</p>}
    {data && <>
      {learningCard && <StudentLearningCard studentId={studentId} card={learningCard}
        onSaved={raw => setData(current => current ? { ...current, learning_card: raw } : current)}
        onReload={() => void load()} />}
      <h4 className="font-semibold">Memória revisada</h4>
      {data.memories.length ? data.memories.map(m => evidence(m, 'Memória revisada')) : <p className="text-sm text-slate-500">Ainda não há memória revisada.</p>}
      <h4 className="font-semibold">Lançamentos recentes — relato docente</h4>
      {data.logs.length ? data.logs.map(l => evidence(l, 'Relato docente')) : <p className="text-sm text-slate-500">Nenhum lançamento disponível.</p>}
      <button disabled={busy || acknowledged} onClick={() => void load(true)} className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{acknowledged ? 'Leitura registrada' : 'Registrar que li este dossiê'}</button>
      <p className="text-xs text-slate-500">A confirmação guarda a versão consultada e quem a leu. Não aprova o conteúdo automaticamente.</p>
    </>}
  </section>;
}
