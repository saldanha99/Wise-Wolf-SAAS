import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { googleMeetErrorMessage } from '../lib/googleMeet';
import LessonPedagogicalSummary from './LessonPedagogicalSummary';
import StudentHandover from './StudentHandover';
import LessonRecordingTeacherCard from './LessonRecordingTeacherCard';

export type QualitySession = { id: string; student_id: string; student_name: string; teacher_name: string; scheduled_start_at: string; scheduled_end_at: string; class_date: string; status: string; documentation_consent: boolean };
// canMarkDocumentation: só a direção registra ou retira a autorização de
// documentação de uma aula (set_lesson_documentation_consent confere no banco).
export default function LessonSessionsPanel({ tenantId, studentId, manager = false, canMarkDocumentation = false }: { tenantId?: string; studentId?: string; manager?: boolean; canMarkDocumentation?: boolean }) {
  const [sessions, setSessions] = useState<QualitySession[]>([]);
  const [selected, setSelected] = useState<QualitySession | null>(null);
  const [handover, setHandover] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true); setError('');
    const { data, error: rpcError } = await supabase.rpc('get_lesson_sessions', { p_student_id: studentId || null });
    if (rpcError || data?.ok !== true) setError('Não foi possível carregar as sessões de aula.');
    else setSessions(data.sessions || []);
    setBusy(false);
  }, [studentId, tenantId]);
  useEffect(() => { setSelected(null); void load(); }, [load]);
  async function consent(session: QualitySession) {
    const turningOn = !session.documentation_consent;
    const reason = window.prompt(turningOn
      ? 'Motivo (obrigatório): registre a autorização do aluno/responsável e onde está o comprovante. Não informe documentos sensíveis. Se o aluno, o responsável ou o professor recusou ou revogou o termo, a documentação não é ligada.'
      : 'Motivo (obrigatório) para retirar a autorização desta aula. A transcrição da sala da escola é desligada no Google.');
    if (reason === null) return;
    if (reason.trim().length < 10) { setError(googleMeetErrorMessage('registre_a_base_e_o_comprovante_da_autorizacao')); return; }
    setBusy(true); setError('');
    const result = await supabase.rpc('set_lesson_documentation_consent', { p_session_id: session.id, p_allowed: turningOn, p_reason: reason.trim() });
    if (result.error || result.data?.ok !== true) setError(googleMeetErrorMessage(result.error?.message, 'Não foi possível registrar a autorização. Descreva a base e o comprovante (mínimo 10 caracteres).'));
    else { setSelected(null); await load(); }
    setBusy(false);
  }
  async function report(session: QualitySession) {
    const description = window.prompt('Descreva a ocorrência observada e a fonte da informação (mínimo 10 caracteres).');
    if (!description) return;
    setBusy(true); setError('');
    const result = await supabase.rpc('create_lesson_quality_case', { p_session_id: session.id, p_category: 'OTHER', p_description: description });
    if (result.error || result.data?.ok !== true) setError('Não foi possível registrar. Confira a descrição e tente novamente.');
    else window.alert('Ocorrência registrada na Central de qualidade.');
    setBusy(false);
  }
  async function replan(session: QualitySession) {
    const reason = window.prompt('Arquivar esta sessão futura e gerar outra a partir da agenda atual? Informe o motivo. O link antigo do Google NÃO é revogado por esta ação e não deve mais ser usado.');
    if (!reason) return;
    setBusy(true); setError('');
    const result = await supabase.rpc('supersede_future_lesson_session', { p_session_id: session.id, p_reason: reason });
    if (result.error || result.data?.ok !== true) setError('Não foi possível replanejar. A sessão precisa ser futura, sem auditoria ou lançamento. Informe um motivo detalhado.');
    else { setSelected(null); await load(); window.alert('Sessão antiga arquivada. Registre nova autorização para preparar a nova sala. O link Google antigo não foi revogado; avise os participantes para não utilizá-lo.'); }
    setBusy(false);
  }
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-bold">Salas e continuidade das aulas</h2><button disabled={busy} onClick={() => void load()} className="rounded-lg border px-3 py-2 text-sm">Atualizar</button></div>
    {!manager && <LessonRecordingTeacherCard />}
    <p className="text-sm text-slate-500">Últimos 7 dias e próximos 7 dias. Blocos consecutivos formam uma sessão pedagógica; os créditos financeiros continuam separados.</p>
    {error && <p role="alert" className="text-red-600">{error}</p>}
    {busy && <p className="text-sm">Carregando…</p>}
    {!busy && !sessions.length && <p className="rounded-xl border p-5 text-slate-500">Nenhuma sessão neste intervalo.</p>}
    <div className="grid gap-3 md:grid-cols-2">
      {sessions.map(session => <article key={session.id} className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <h3 className="font-semibold">{session.student_name}</h3>
        <p className="text-sm text-slate-500">{new Date(session.scheduled_start_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })} · {session.teacher_name}</p>
        <p className="mt-2 text-xs">{session.status === 'LOGGED' ? 'Com lançamento' : 'Prevista'} · Documentação {session.documentation_consent ? 'autorizada' : 'sem autorização registrada'}</p>
        <div className="mt-3 flex flex-wrap gap-3 text-sm">
          <button className="font-semibold text-blue-600" onClick={() => { setSelected(session); setHandover(null); }}>Sala e resumo</button>
          <button className="text-blue-600" onClick={() => { setHandover(session.student_id); setSelected(null); }}>Dossiê do aluno</button>
          {canMarkDocumentation && <button disabled={busy} onClick={() => void consent(session)} className="text-slate-600">{session.documentation_consent ? 'Revogar autorização' : 'Registrar autorização'}</button>}
          {manager && <button disabled={busy} onClick={() => void report(session)} className="text-slate-600">Registrar ocorrência</button>}
          {manager && new Date(session.scheduled_start_at).getTime() > Date.now() && <button disabled={busy} onClick={() => void replan(session)} className="text-slate-600">Replanejar sessão futura</button>}
        </div>
      </article>)}
    </div>
    {selected && <div className="rounded-xl border p-4"><button className="mb-3 text-sm underline" onClick={() => setSelected(null)}>Fechar detalhes</button><LessonPedagogicalSummary sessionId={selected.id} tenantId={tenantId} /></div>}
    {handover && <div className="rounded-xl border p-4"><button className="mb-3 text-sm underline" onClick={() => setHandover(null)}>Fechar dossiê</button><StudentHandover studentId={handover} /></div>}
  </section>;
}
