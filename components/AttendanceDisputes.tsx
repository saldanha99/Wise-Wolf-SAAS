import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { ShieldAlert, CheckCircle, XCircle, Clock, RefreshCw, AlertTriangle, User as UserIcon } from 'lucide-react';
import { User as UserType } from '../types';

interface Props {
  user: UserType;
  tenantId?: string;
}

interface Conf {
  id: string;
  class_log_id: string;
  teacher_id: string;
  student_name: string;
  teacher_name: string;
  class_date: string;
  class_time: string;
  teacher_reported: string;
  student_response: string | null;
  status: string;
  responded_at: string | null;
  created_at: string;
}

// Traduções amigáveis
const REPORTED_LABEL: Record<string, string> = {
  COMPLETED: 'Professor lançou: Aula realizada',
  STUDENT_ABSENCE: 'Professor lançou: Aluno faltou',
};
const RESPONSE_LABEL: Record<string, string> = {
  STUDENT_PRESENT: 'Aluno diz: tive minha aula normalmente',
  TEACHER_NO_SHOW: 'Aluno diz: o professor NÃO apareceu',
  STUDENT_SELF_ABSENT: 'Aluno diz: eu que faltei',
};

const AttendanceDisputes: React.FC<Props> = ({ user, tenantId }) => {
  const [conflicts, setConflicts] = useState<Conf[]>([]);
  const [alerts, setAlerts] = useState<Conf[]>([]);
  const [stats, setStats] = useState({ pending: 0, confirmed: 0, conflict: 0 });
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);

  const SELECT_COLS = 'id, class_log_id, teacher_id, student_name, teacher_name, class_date, class_time, teacher_reported, student_response, status, responded_at, created_at';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Conflitos confirmados (já têm lançamento + resposta divergente) → resolver pagamento
      let q = supabase
        .from('attendance_confirmations')
        .select(SELECT_COLS)
        .eq('status', 'CONFLICT')
        .order('responded_at', { ascending: false });
      if (tenantId) q = q.eq('tenant_id', tenantId);
      const { data: conf } = await q;
      setConflicts((conf as Conf[]) || []);

      // Alertas: aluno disse que o PROFESSOR NÃO APARECEU e o professor ainda não lançou a aula.
      // Sinal de fraude: professor pode estar adiando o lançamento para depois marcar "falta do aluno".
      let aq = supabase
        .from('attendance_confirmations')
        .select(SELECT_COLS)
        .eq('status', 'AWAITING_TEACHER')
        .eq('student_response', 'TEACHER_NO_SHOW')
        .order('responded_at', { ascending: false });
      if (tenantId) aq = aq.eq('tenant_id', tenantId);
      const { data: al } = await aq;
      setAlerts((al as Conf[]) || []);

      // Estatísticas gerais (últimos 60 dias)
      const since = new Date(); since.setDate(since.getDate() - 60);
      let sq = supabase
        .from('attendance_confirmations')
        .select('status')
        .gte('created_at', since.toISOString());
      if (tenantId) sq = sq.eq('tenant_id', tenantId);
      const { data: all } = await sq;
      const counts = { pending: 0, confirmed: 0, conflict: 0 };
      (all || []).forEach((r: any) => {
        if (r.status === 'PENDING' || r.status === 'AWAITING_TEACHER') counts.pending++;
        else if (r.status === 'CONFIRMED' || r.status === 'RESOLVED_PAID') counts.confirmed++;
        else if (r.status === 'CONFLICT') counts.conflict++;
      });
      setStats(counts);
    } catch (e) {
      console.error('Erro ao carregar disputas:', e);
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (c: Conf, pay: boolean) => {
    const verb = pay ? 'PAGAR' : 'NÃO pagar';
    if (!confirm(`Confirmar: ${verb} a aula de ${c.teacher_name} (aluno ${c.student_name}, ${c.class_date})?`)) return;
    setResolving(c.id);
    try {
      const note = pay ? 'Admin decidiu pagar após análise' : 'Admin decidiu não pagar (presença não comprovada)';
      const { data, error } = await supabase.rpc('resolve_attendance_conflict', {
        p_confirmation_id: c.id,
        p_pay: pay,
        p_note: note,
      });
      if (error || (data && data.ok === false)) throw new Error(error?.message || data?.error || 'Falha');
      setConflicts(prev => prev.filter(x => x.id !== c.id));
    } catch (e: any) {
      alert(`Erro ao resolver: ${e.message}`);
    } finally {
      setResolving(null);
    }
  };

  const fmtDate = (d: string) => d ? new Date(d + 'T00:00:00').toLocaleDateString('pt-BR') : '';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-red-50 dark:bg-red-900/20 text-red-600">
          <ShieldAlert size={24} />
        </div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Verificação de Presença</h2>
          <p className="text-sm text-brand-muted">Conflitos entre o que o professor lançou e o que o aluno confirmou</p>
        </div>
        <button onClick={load} className="ml-auto p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text transition-all" title="Atualizar">
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
          <div className="flex items-center gap-2 text-amber-600 mb-1"><Clock size={16} /><span className="text-xs font-bold uppercase">Aguardando aluno</span></div>
          <p className="text-2xl font-black text-brand-text">{stats.pending}</p>
        </div>
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
          <div className="flex items-center gap-2 text-emerald-600 mb-1"><CheckCircle size={16} /><span className="text-xs font-bold uppercase">Confirmadas</span></div>
          <p className="text-2xl font-black text-brand-text">{stats.confirmed}</p>
        </div>
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
          <div className="flex items-center gap-2 text-red-600 mb-1"><AlertTriangle size={16} /><span className="text-xs font-bold uppercase">Em conflito</span></div>
          <p className="text-2xl font-black text-brand-text">{stats.conflict}</p>
        </div>
      </div>

      {/* Lista de conflitos */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <h3 className="text-sm font-bold text-brand-text mb-4 flex items-center gap-2">
          <AlertTriangle size={16} className="text-red-600" /> Conflitos para resolver
          {conflicts.length > 0 && <span className="text-[10px] bg-red-500 text-white px-2 py-0.5 rounded-full">{conflicts.length}</span>}
        </h3>

        {loading ? (
          <div className="py-12 text-center text-brand-muted"><RefreshCw size={24} className="animate-spin mx-auto mb-2" />Carregando…</div>
        ) : conflicts.length === 0 ? (
          <div className="py-12 flex flex-col items-center text-brand-muted opacity-70">
            <CheckCircle size={40} strokeWidth={1.5} className="mb-3 text-emerald-500" />
            <p className="text-sm font-bold">Nenhum conflito pendente 🎉</p>
            <p className="text-xs mt-1">As aulas com divergência aparecem aqui para sua decisão.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {conflicts.map(c => (
              <div key={c.id} className="border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-900/10 rounded-xl p-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-bold text-brand-text">
                      <UserIcon size={14} className="text-brand-muted" /> {c.teacher_name || 'Professor'} <span className="text-brand-muted font-normal">·</span> aluno {c.student_name || '—'}
                    </div>
                    <p className="text-xs text-brand-muted mt-0.5">Aula de {fmtDate(c.class_date)}{c.class_time ? ` às ${String(c.class_time).slice(0,5)}` : ''}</p>
                    <div className="mt-3 space-y-1.5">
                      <p className="text-xs flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-indigo-500 shrink-0" />{REPORTED_LABEL[c.teacher_reported] || c.teacher_reported}</p>
                      <p className="text-xs flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />{c.student_response ? RESPONSE_LABEL[c.student_response] : '—'}</p>
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => resolve(c, true)}
                      disabled={resolving === c.id}
                      className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
                      title="Liberar o pagamento desta aula ao professor"
                    >
                      <CheckCircle size={14} /> Pagar
                    </button>
                    <button
                      onClick={() => resolve(c, false)}
                      disabled={resolving === c.id}
                      className="px-3 py-2 rounded-xl bg-red-500 hover:bg-red-600 text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50"
                      title="Manter retido — não pagar esta aula"
                    >
                      <XCircle size={14} /> Não pagar
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Alertas: aluno relatou ausência do professor sem lançamento ainda */}
      {alerts.length > 0 && (
        <div className="bg-amber-50/60 dark:bg-amber-900/10 border border-amber-300 dark:border-amber-900/40 rounded-2xl p-5">
          <h3 className="text-sm font-bold text-amber-700 dark:text-amber-400 mb-1 flex items-center gap-2">
            <AlertTriangle size={16} /> Alertas — aluno relatou ausência do professor
            <span className="text-[10px] bg-amber-500 text-white px-2 py-0.5 rounded-full">{alerts.length}</span>
          </h3>
          <p className="text-xs text-amber-700/80 dark:text-amber-300/70 mb-4">
            O aluno disse que o professor não apareceu, mas o professor ainda <b>não lançou</b> esta aula.
            Fique de olho: se ele lançar como "falta do aluno", a aula vira conflito automaticamente e será retida.
          </p>
          <div className="space-y-2">
            {alerts.map(a => (
              <div key={a.id} className="bg-brand-surface border border-amber-200 dark:border-amber-900/30 rounded-xl p-3 flex items-center gap-3 flex-wrap">
                <UserIcon size={14} className="text-brand-muted shrink-0" />
                <span className="text-sm font-bold text-brand-text">{a.teacher_name || 'Professor'}</span>
                <span className="text-xs text-brand-muted">· aluno {a.student_name || '—'}</span>
                <span className="text-xs text-brand-muted">· {fmtDate(a.class_date)}{a.class_time ? ` às ${String(a.class_time).slice(0,5)}` : ''}</span>
                <span className="ml-auto text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-400 px-2 py-1 rounded-full uppercase">Aguardando lançamento</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-brand-muted leading-relaxed px-1">
        💡 Como funciona: após cada aula, o aluno recebe no WhatsApp (pelo número central da escola) um link de 1 toque para confirmar se a aula aconteceu.
        Se a resposta do aluno divergir do que o professor lançou, a aula entra em conflito e fica <b>retida do pagamento</b> até você decidir aqui.
      </p>
    </div>
  );
};

export default AttendanceDisputes;
