import React, { useEffect, useState } from 'react';
import { ShieldCheck, CheckCircle, XCircle, UserX, Clock, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';

// Aba interna de AUDITORIA DE AULAS do aluno: lista as mesmas confirmações enviadas por
// WhatsApp (attendance_confirmations), permitindo confirmar dentro do sistema.
// Reaproveita o RPC apply_student_response (mesma lógica do link público).

interface Audit {
  id: string; token: string; teacher_name: string;
  class_date: string; class_time: string;
  student_response: string | null; status: string; responded_at: string | null;
}

const RESP_LABEL: Record<string, { txt: string; cls: string }> = {
  STUDENT_PRESENT: { txt: 'Aula confirmada', cls: 'text-emerald-600' },
  TEACHER_NO_SHOW: { txt: 'Professor não veio', cls: 'text-red-600' },
  STUDENT_SELF_ABSENT: { txt: 'Você não pôde ir', cls: 'text-amber-600' },
};
const fmtDate = (d: string) => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }) : '';

const StudentAuditPanel: React.FC = () => {
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const { data } = await supabase.rpc('my_attendance_audits');
    setAudits(Array.isArray(data) ? data : []);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const responder = async (a: Audit, response: 'STUDENT_PRESENT' | 'TEACHER_NO_SHOW' | 'STUDENT_SELF_ABSENT') => {
    setBusy(a.id);
    try {
      const { data, error } = await supabase.rpc('apply_student_response', { p_token: a.token, p_response: response });
      if (error || (data && data.ok === false)) throw new Error(data?.error || error?.message || 'falha');
      await load();
    } catch (e: any) {
      alert('Não foi possível registrar: ' + (e.message || 'tente novamente.'));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return null;
  if (audits.length === 0) return null;

  const pending = audits.filter(a => !a.student_response);
  const done = audits.filter(a => a.student_response);

  return (
    <section id="auditoria-aulas" className="bg-brand-surface border border-brand-border rounded-[2rem] p-6 shadow-sm scroll-mt-24">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={18} className="text-tenant-primary" />
        <h3 className="font-black text-brand-text dark:text-slate-100 text-sm uppercase tracking-widest">Auditoria de Aulas</h3>
        {pending.length > 0 && (
          <span className="ml-auto text-[10px] font-black uppercase bg-amber-100 dark:bg-amber-900/30 text-amber-600 px-3 py-1 rounded-full">
            {pending.length} pendente{pending.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
      <p className="text-xs text-brand-muted mb-4">Confirme aqui se cada aula aconteceu. É a sua garantia (e a nossa) de que está tudo certo.</p>

      {/* Pendentes */}
      {pending.length > 0 ? (
        <div className="space-y-3">
          {pending.map(a => (
            <div key={a.id} className="border border-amber-200 dark:border-amber-900/40 bg-amber-50/50 dark:bg-amber-900/10 rounded-2xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Clock size={14} className="text-amber-500" />
                <p className="text-sm font-bold text-brand-text dark:text-slate-200">
                  {fmtDate(a.class_date)} · {String(a.class_time || '').slice(0, 5)}
                </p>
                <span className="text-xs text-brand-muted">com {a.teacher_name || 'seu professor'}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button onClick={() => responder(a, 'STUDENT_PRESENT')} disabled={busy === a.id}
                  className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-emerald-500 text-white text-[11px] font-black uppercase hover:bg-emerald-600 disabled:opacity-50">
                  {busy === a.id ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle size={13} />} Tive minha aula
                </button>
                <button onClick={() => responder(a, 'TEACHER_NO_SHOW')} disabled={busy === a.id}
                  className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-red-500 text-white text-[11px] font-black uppercase hover:bg-red-600 disabled:opacity-50">
                  <XCircle size={13} /> Prof. não veio
                </button>
                <button onClick={() => responder(a, 'STUDENT_SELF_ABSENT')} disabled={busy === a.id}
                  className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-brand-border text-brand-muted text-[11px] font-black uppercase hover:bg-brand-surface-2 disabled:opacity-50">
                  <UserX size={13} /> Eu não pude
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-emerald-600 font-bold flex items-center gap-1.5"><CheckCircle size={14} /> Tudo auditado! Nenhuma aula pendente.</p>
      )}

      {/* Histórico recente */}
      {done.length > 0 && (
        <div className="mt-5">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted mb-2">Histórico</p>
          <div className="space-y-1.5">
            {done.slice(0, 8).map(a => {
              const r = RESP_LABEL[a.student_response || ''] || { txt: a.student_response || '—', cls: 'text-brand-muted' };
              return (
                <div key={a.id} className="flex items-center justify-between text-xs border-b border-brand-border/50 pb-1.5">
                  <span className="text-brand-muted">{fmtDate(a.class_date)} · {String(a.class_time || '').slice(0, 5)} · {a.teacher_name}</span>
                  <span className={`font-black ${r.cls}`}>{r.txt}</span>
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
