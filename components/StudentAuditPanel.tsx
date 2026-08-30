import React, { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle, XCircle, UserX, Clock, Loader2, CalendarClock, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';

// Área autenticada do aluno. A projeção e a gravação passam por RPCs que
// resolvem a identidade no servidor; nenhum token público de WhatsApp chega ao navegador.

type AttendanceResponse =
  | 'STUDENT_PRESENT'
  | 'TEACHER_NO_SHOW'
  | 'STUDENT_SELF_ABSENT'
  | 'CANCELLED_RESCHEDULED';

interface Audit {
  id: string;
  teacher_name: string;
  class_date: string;
  class_time: string;
  student_response: AttendanceResponse | null;
  status: string;
  responded_at: string | null;
  student_rating?: number | null;
  can_correct?: boolean;
  editable_until?: string | null;
  allowed_responses?: AttendanceResponse[];
}

const RESP_LABEL: Record<AttendanceResponse, { txt: string; cls: string }> = {
  STUDENT_PRESENT: { txt: 'Aula aconteceu e eu participei', cls: 'text-emerald-600' },
  TEACHER_NO_SHOW: { txt: 'Professor não compareceu', cls: 'text-red-600' },
  STUDENT_SELF_ABSENT: { txt: 'Aula aconteceu, mas eu não participei', cls: 'text-amber-600' },
  CANCELLED_RESCHEDULED: { txt: 'Aula cancelada ou remarcada', cls: 'text-sky-600' },
};

const fmtDate = (date: string) => date
  ? new Date(`${date}T00:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' })
  : '';

const fmtDeadline = (deadline?: string | null) => deadline
  ? new Date(deadline).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  : null;

const StudentAuditPanel: React.FC = () => {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase.rpc('my_attendance_audits');
    if (loadError) {
      setError('Não foi possível carregar a auditoria agora.');
    } else {
      setAudits(Array.isArray(data) ? data as Audit[] : []);
      setError('');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const responder = async (audit: Audit, response: AttendanceResponse) => {
    setBusy(audit.id);
    setError('');
    try {
      const { data, error: submitError } = await supabase.rpc('apply_my_attendance_response', {
        p_confirmation_id: audit.id,
        p_response: response,
      });
      if (submitError || (data && data.ok === false)) {
        throw new Error(data?.error || submitError?.message || 'falha');
      }
      setEditing(null);
      await load();
    } catch (submitError: any) {
      const reason = String(submitError?.message || '');
      setError(/locked|window|prazo|expired|expirad|janela_correcao/i.test(reason)
        ? 'O prazo de 30 minutos para corrigir essa resposta terminou. Fale com a escola se precisar de ajuda.'
        : 'Não foi possível registrar. Tente novamente.');
    } finally {
      setBusy(null);
    }
  };

  if (loading) return null;
  if (audits.length === 0 && !error) return null;

  const actionable = audits.filter(audit =>
    (!audit.student_response && audit.can_correct === true) || editing === audit.id
  );
  const done = audits.filter(audit => audit.student_response && editing !== audit.id);
  const unavailable = audits.filter(audit => !audit.student_response && audit.can_correct !== true);

  const responseButtons = (audit: Audit) => {
    const allowed = new Set<AttendanceResponse>(audit.allowed_responses || [
      'STUDENT_PRESENT',
      'TEACHER_NO_SHOW',
      'STUDENT_SELF_ABSENT',
    ]);
    const disabled = busy === audit.id;

    return (
      <div className={`grid grid-cols-1 gap-2 ${allowed.has('CANCELLED_RESCHEDULED') ? 'sm:grid-cols-2 xl:grid-cols-4' : 'sm:grid-cols-3'}`}>
        {allowed.has('STUDENT_PRESENT') && (
          <button type="button" onClick={() => responder(audit, 'STUDENT_PRESENT')} disabled={disabled}
            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl bg-emerald-500 text-white text-[11px] font-black hover:bg-emerald-600 disabled:opacity-50">
            {disabled ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />} Participei da aula
          </button>
        )}
        {allowed.has('STUDENT_SELF_ABSENT') && (
          <button type="button" onClick={() => responder(audit, 'STUDENT_SELF_ABSENT')} disabled={disabled}
            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl border border-brand-border text-brand-muted text-[11px] font-black hover:bg-brand-surface-2 disabled:opacity-50">
            <UserX size={13} /> Eu não participei
          </button>
        )}
        {allowed.has('TEACHER_NO_SHOW') && (
          <button type="button" onClick={() => responder(audit, 'TEACHER_NO_SHOW')} disabled={disabled}
            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl bg-red-500 text-white text-[11px] font-black hover:bg-red-600 disabled:opacity-50">
            <XCircle size={13} /> Professor não veio
          </button>
        )}
        {allowed.has('CANCELLED_RESCHEDULED') && (
          <button type="button" onClick={() => responder(audit, 'CANCELLED_RESCHEDULED')} disabled={disabled}
            className="flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl border border-sky-300 bg-sky-50 text-sky-700 text-[11px] font-black hover:bg-sky-100 disabled:opacity-50 dark:bg-sky-900/20 dark:text-sky-300">
            <CalendarClock size={13} /> Cancelada/remarcada
          </button>
        )}
      </div>
    );
  };

  return (
    <section id="auditoria-aulas" className="bg-brand-surface border border-brand-border rounded-[2rem] p-6 shadow-sm scroll-mt-24">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={18} className="text-tenant-primary" />
        <h3 className="font-black text-brand-text dark:text-slate-100 text-sm uppercase tracking-widest">Auditoria de Aulas</h3>
        {actionable.length > 0 && (
          <span className="ml-auto text-[10px] font-black uppercase bg-amber-100 dark:bg-amber-900/30 text-amber-600 px-3 py-1 rounded-full">
            {actionable.length} pendente{actionable.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <p className="text-xs text-brand-muted mb-2">Conte o que aconteceu em cada aula. A pergunta não presume que nenhuma das versões esteja correta.</p>
      <p className="text-[11px] text-brand-muted mb-4 rounded-xl bg-brand-surface-2 border border-brand-border px-3 py-2 leading-relaxed">
        A escola compara sua resposta com o lançamento do professor para conferir presença e analisar divergências. Gestores autorizados podem consultá-la.
      </p>
      {error && <p role="alert" className="text-xs font-bold text-red-600 mb-3">{error}</p>}

      {actionable.length > 0 ? (
        <div className="space-y-3">
          {actionable.map(audit => (
            <div key={audit.id} className="border border-amber-200 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-900/10 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3 flex-wrap">
                <Clock size={14} className="text-amber-500" />
                <p className="text-sm font-bold text-brand-text dark:text-slate-200">
                  {editing === audit.id ? 'Corrija sua resposta · ' : ''}{fmtDate(audit.class_date)} · {String(audit.class_time || '').slice(0, 5)}
                </p>
                <span className="text-xs text-brand-muted">com {audit.teacher_name || 'seu professor'}</span>
                {editing === audit.id && (
                  <button type="button" onClick={() => setEditing(null)} className="ml-auto text-[11px] font-bold text-brand-muted underline">
                    Cancelar correção
                  </button>
                )}
              </div>
              <p className="text-xs font-bold text-brand-text mb-2">Qual situação descreve melhor o que aconteceu?</p>
              {responseButtons(audit)}
            </div>
          ))}
        </div>
      ) : !error && unavailable.length > 0 ? (
        <p className="text-xs text-brand-muted flex items-center gap-1.5">
          <Clock size={14} /> Não há confirmação disponível para responder agora.
        </p>
      ) : !error ? (
        <p className="text-xs text-emerald-600 font-bold flex items-center gap-1.5"><CheckCircle size={14} /> Tudo auditado! Nenhuma aula pendente.</p>
      ) : null}

      {done.length > 0 && (
        <div className="mt-5">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-2">Histórico</p>
          <div className="space-y-2">
            {done.slice(0, 8).map(audit => {
              const response = RESP_LABEL[audit.student_response as AttendanceResponse]
                || { txt: audit.student_response || '—', cls: 'text-brand-muted' };
              const deadline = fmtDeadline(audit.editable_until);
              return (
                <div key={audit.id} className="flex items-center justify-between gap-3 text-xs border-b border-brand-border/50 pb-2 flex-wrap">
                  <span className="text-brand-muted">{fmtDate(audit.class_date)} · {String(audit.class_time || '').slice(0, 5)} · {audit.teacher_name}</span>
                  <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                    <span className={`font-black ${response.cls}`}>{response.txt}</span>
                    {audit.can_correct && (
                      <button type="button" onClick={() => { setEditing(audit.id); setError(''); }}
                        className="inline-flex items-center gap-1 rounded-lg border border-brand-border px-2 py-1 text-[10px] font-bold text-brand-muted hover:text-brand-text"
                        title={deadline ? `Pode corrigir até ${deadline}` : 'Corrigir durante o prazo disponível'}>
                        <Pencil size={10} /> Corrigir
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
};

export default StudentAuditPanel;
