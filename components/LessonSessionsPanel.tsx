import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { googleMeetErrorMessage } from '../lib/googleMeet';
import LessonPedagogicalSummary from './LessonPedagogicalSummary';
import StudentHandover from './StudentHandover';
import LessonRecordingTeacherCard from './LessonRecordingTeacherCard';
import LessonReviewQueue from './LessonReviewQueue';

export type QualitySession = { id: string; student_id: string; student_name: string; teacher_name: string; scheduled_start_at: string; scheduled_end_at: string; class_date: string; status: string; documentation_consent: boolean };
// canMarkDocumentation: só a direção registra ou retira a autorização de
// documentação de uma aula (set_lesson_documentation_consent confere no banco).
// focusStudentId: o dossiê a abrir de cara — vem do link com login que o
// substituto e o novo titular recebem no WhatsApp (lib/studentDossierLink.ts).
// É só destino: quem decide se a pessoa lê é o servidor (get_student_handover).
// O foco NÃO é consumido ao montar: o App o guarda até a pessoa sair do dossiê
// (onFocusClosed — fechar, abrir outra coisa aqui), e o painel montado de novo
// reabre o dossiê. Consumir na montagem deixava o tour do login levar a pessoa
// para outra tela e o dossiê do link nunca mais aparecia.
export default function LessonSessionsPanel({ tenantId, studentId, manager = false, canMarkDocumentation = false, focusStudentId = null, onFocusClosed }: { tenantId?: string; studentId?: string; manager?: boolean; canMarkDocumentation?: boolean; focusStudentId?: string | null; onFocusClosed?: () => void }) {
  const [sessions, setSessions] = useState<QualitySession[]>([]);
  const [selected, setSelected] = useState<QualitySession | null>(null);
  const [handover, setHandover] = useState<string | null>(null);
  const [handoverFromLink, setHandoverFromLink] = useState(false);
  const handoverRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const onFocusClosedRef = useRef(onFocusClosed);
  onFocusClosedRef.current = onFocusClosed;
  useEffect(() => {
    if (!focusStudentId) return;
    setSelected(null);
    setHandover(focusStudentId);
    setHandoverFromLink(true);
  }, [focusStudentId]);
  // A pessoa saiu do dossiê aberto pelo link: o App libera o foco (e os tours).
  function leaveLinkedDossier() {
    if (!handoverFromLink) return;
    setHandoverFromLink(false);
    onFocusClosedRef.current?.();
  }
  useEffect(() => {
    if (handover && handoverFromLink) handoverRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [handover, handoverFromLink]);
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
    {/* Rascunhos (IA e notas do Gemini) esperando revisão: o professor vê os dele; coordenação e direção, os da escola. */}
    {!studentId && <LessonReviewQueue tenantId={tenantId} showTeacher={manager} />}
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
          <button className="font-semibold text-blue-600" onClick={() => { leaveLinkedDossier(); setSelected(session); setHandover(null); }}>Sala e resumo</button>
          <button data-tour="lesson-session-handover" className="text-blue-600" onClick={() => { leaveLinkedDossier(); setHandover(session.student_id); setSelected(null); }}>Dossiê do aluno</button>
          {canMarkDocumentation && <button disabled={busy} onClick={() => void consent(session)} className="text-slate-600">{session.documentation_consent ? 'Revogar autorização' : 'Registrar autorização'}</button>}
          {manager && <button disabled={busy} onClick={() => void report(session)} className="text-slate-600">Registrar ocorrência</button>}
          {manager && new Date(session.scheduled_start_at).getTime() > Date.now() && <button disabled={busy} onClick={() => void replan(session)} className="text-slate-600">Replanejar sessão futura</button>}
        </div>
      </article>)}
    </div>
    {selected && <div className="rounded-xl border p-4"><button className="mb-3 text-sm underline" onClick={() => setSelected(null)}>Fechar detalhes</button><LessonPedagogicalSummary sessionId={selected.id} tenantId={tenantId} /></div>}
    {handover && <div ref={handoverRef} className="rounded-xl border p-4">
      <button className="mb-3 text-sm underline" onClick={() => { leaveLinkedDossier(); setHandover(null); }}>Fechar dossiê</button>
      {handoverFromLink && <p role="note" className="mb-3 rounded-lg bg-blue-50 p-3 text-sm text-blue-900 dark:bg-blue-950 dark:text-blue-100">Dossiê aberto pelo link do WhatsApp. Para quem cobre uma aula ou dá uma reposição marcada, o acesso vale do dia anterior ao dia seguinte da aula; para o novo professor de uma transferência, a partir do aceite.</p>}
      <StudentHandover studentId={handover} viaLink={handoverFromLink} />
    </div>}
  </section>;
}
