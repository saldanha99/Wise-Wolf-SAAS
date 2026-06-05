import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { GraduationCap, Zap, CheckCircle, XCircle, RefreshCw, CalendarClock, DollarSign, User as UserIcon } from 'lucide-react';
import { User as UserType } from '../types';

// =============================================================
// Painel do diretor: liquidar aulas EXPERIMENTAIS e TREINAMENTOS realizados.
// O pagamento ao professor só entra quando há um class_log COMPLETED. Aqui o
// diretor confirma "compareceu → pagar" (gera o class_log via RPC) ou marca
// "não compareceu" (não paga). Resolve o caso de essas aulas, depois de
// realizadas, não estarem virando pagamento automaticamente.
// =============================================================

interface Props {
  user: UserType;
  tenantId?: string;
}

interface PendingSession {
  appointment_id: string;
  type: 'experimental' | 'training' | string;
  start_time: string;
  student_name: string | null;
  teacher_id: string;
  teacher_name: string | null;
  hourly_rate: number;
}

const TrialTrainingSettlement: React.FC<Props> = ({ user }) => {
  const [sessions, setSessions] = useState<PendingSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('list_pending_trial_sessions');
      if (error) throw error;
      setSessions(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Erro ao carregar sessões pendentes:', err);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const settle = async (s: PendingSession, attended: boolean) => {
    const label = s.type === 'training' ? 'treinamento' : 'aula experimental';
    if (attended) {
      if (!confirm(`Confirmar que o ${label} de ${s.teacher_name} foi realizado e PAGAR R$ ${Number(s.hourly_rate).toFixed(2).replace('.', ',')} ao professor?`)) return;
    } else {
      if (!confirm(`Marcar que o ${label} NÃO aconteceu (professor não será pago)?`)) return;
    }
    setProcessing(s.appointment_id);
    try {
      const { data, error } = await supabase.rpc('settle_trial_session', {
        p_appointment_id: s.appointment_id,
        p_attended: attended,
      });
      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Falha');
      setSessions(prev => prev.filter(x => x.appointment_id !== s.appointment_id));
    } catch (err: any) {
      alert('Erro ao liquidar: ' + (err.message || 'desconhecido'));
    } finally {
      setProcessing(null);
    }
  };

  const fmt = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
  };

  const totalAPagar = sessions.reduce((acc, s) => acc + Number(s.hourly_rate || 0), 0);

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-3xl font-black text-brand-text tracking-tight">Experimentais & Treinamentos</h2>
          <p className="text-brand-muted text-sm">Confirme as aulas realizadas para que o professor seja remunerado.</p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-2 px-4 py-2 bg-brand-surface-2 rounded-xl text-xs font-black uppercase tracking-widest text-brand-muted hover:text-brand-text transition-colors">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Atualizar
        </button>
      </div>

      {/* Resumo */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Aguardando confirmação</p>
          <p className="text-3xl font-black text-brand-text mt-1">{sessions.length}</p>
        </div>
        <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
          <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Total a pagar (se todas confirmadas)</p>
          <p className="text-3xl font-black text-emerald-600 mt-1">R$ {totalAPagar.toFixed(2).replace('.', ',')}</p>
        </div>
      </div>

      {/* Lista */}
      {loading ? (
        <div className="flex justify-center items-center h-48 text-brand-muted gap-2">
          <RefreshCw className="animate-spin" /> Carregando...
        </div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16 border-2 border-dashed border-brand-border rounded-3xl">
          <CheckCircle className="mx-auto text-emerald-400 mb-3" size={40} />
          <p className="text-brand-text font-black">Tudo em dia!</p>
          <p className="text-brand-muted text-xs mt-1">Nenhuma aula experimental ou treinamento aguardando confirmação.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map(s => {
            const isTraining = s.type === 'training';
            const busy = processing === s.appointment_id;
            return (
              <div key={s.appointment_id} className="bg-brand-surface border border-brand-border rounded-2xl p-4 flex flex-col lg:flex-row lg:items-center gap-4">
                {/* Tipo */}
                <div className={`shrink-0 w-12 h-12 rounded-xl flex items-center justify-center text-white ${isTraining ? 'bg-amber-500' : 'bg-indigo-500'}`}>
                  {isTraining ? <Zap size={22} /> : <GraduationCap size={22} />}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-[9px] font-black uppercase tracking-widest px-2 py-0.5 rounded-full ${isTraining ? 'bg-amber-100 text-amber-700' : 'bg-indigo-100 text-indigo-700'}`}>
                      {isTraining ? 'Treinamento' : 'Aula Experimental'}
                    </span>
                    <span className="text-sm font-black text-brand-text truncate">{s.student_name || (isTraining ? 'Treinamento' : 'Aluno')}</span>
                  </div>
                  <div className="flex items-center gap-4 mt-1.5 text-xs text-brand-muted flex-wrap">
                    <span className="flex items-center gap-1"><UserIcon size={12} /> {s.teacher_name || '—'}</span>
                    <span className="flex items-center gap-1"><CalendarClock size={12} /> {fmt(s.start_time)}</span>
                    <span className="flex items-center gap-1 font-bold text-emerald-600"><DollarSign size={12} /> R$ {Number(s.hourly_rate).toFixed(2).replace('.', ',')}</span>
                  </div>
                </div>

                {/* Ações */}
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => settle(s, true)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-xs font-black uppercase tracking-wider hover:bg-emerald-700 transition-colors disabled:opacity-50"
                  >
                    {busy ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />} Compareceu / Pagar
                  </button>
                  <button
                    onClick={() => settle(s, false)}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-2.5 bg-brand-surface-2 text-brand-muted rounded-xl text-xs font-black uppercase tracking-wider hover:text-red-600 transition-colors disabled:opacity-50"
                    title="Não aconteceu — não pagar"
                  >
                    <XCircle size={14} /> Não
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TrialTrainingSettlement;
