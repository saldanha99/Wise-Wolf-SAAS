import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { originLabel, reviewDeadline, waitingText, type MeetReviewItem } from '../lib/meetSummary';
import LessonPedagogicalSummary from './LessonPedagogicalSummary';

// "Aulas para revisar": rascunhos (da IA ou das notas do Gemini) esperando o
// professor. O professor vê as aulas que ele deu; coordenação e direção veem as
// da escola (get_meet_summary_review_queue decide). Cada item mostra até quando
// pode ser aprovado — depois disso as fontes são apagadas e a aprovação é
// recusada. Só o aprovado vai para a memória do aluno.
export default function LessonReviewQueue({ tenantId, showTeacher = false }: { tenantId?: string; showTeacher?: boolean }) {
  const [items, setItems] = useState<MeetReviewItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(async () => {
    setBusy(true);
    const { data, error } = await supabase.rpc('get_meet_summary_review_queue');
    if (error || data?.ok !== true) { setFailed(true); setItems(null); }
    else { setFailed(false); setItems(Array.isArray(data.items) ? data.items : []); }
    setBusy(false);
  }, []);
  useEffect(() => { void load(); }, [load, tenantId]);

  const stale = (items || []).filter(item => item.stale).length;
  return <section data-tour="meet-review-queue" className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 font-semibold"><ClipboardCheck size={18}/>Aulas para revisar{items && items.length > 0 ? ` (${items.length})` : ''}</h3>
      <button type="button" disabled={busy} onClick={() => void load()} aria-label="Atualizar aulas para revisar" className="rounded-lg border px-2 py-1 text-sm"><RefreshCw size={14} className={busy ? 'animate-spin' : ''}/></button>
    </div>
    <p className="text-sm text-slate-500">Depois da aula chegam as notas do Gemini e o rascunho da IA. Confira com os trechos da transcrição, complete o objetivo e o próximo passo e aprove: só o aprovado vai para a memória do aluno.{stale > 0 ? ` ${stale} ${stale === 1 ? 'está parado' : 'estão parados'} há 3 dias ou mais.` : ''}</p>
    {failed && <p className="text-sm text-slate-500">Não foi possível carregar as aulas para revisar agora.</p>}
    {items && items.length === 0 && <p className="text-sm text-slate-500">Nenhuma aula esperando revisão.</p>}
    {items && items.length > 0 && <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {items.map(item => {
        const deadline = reviewDeadline(item.approvable_until);
        return <li key={item.session_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <div className="min-w-0">
            <p className="font-semibold">{item.student_name || 'Aluno'}{showTeacher && item.teacher_name ? <span className="font-normal text-slate-500"> · {item.teacher_name}</span> : null}</p>
            <p className="text-slate-500">{new Date(item.scheduled_start_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} · {originLabel(item.origin)} · <span className={item.stale ? 'font-semibold text-amber-700' : ''}>{waitingText(item.pending_since)}</span></p>
            <p className={deadline.urgent ? 'font-semibold text-red-700' : 'text-slate-500'}>{deadline.text}</p>
          </div>
          <button type="button" onClick={() => { if (open === item.session_id) { setOpen(null); void load(); } else setOpen(item.session_id); }} className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white">{open === item.session_id ? 'Fechar' : 'Revisar'}</button>
          {open === item.session_id && <div className="w-full pt-2"><LessonPedagogicalSummary sessionId={item.session_id} tenantId={tenantId}/></div>}
        </li>;
      })}
    </ul>}
  </section>;
}
