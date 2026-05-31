import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  X, Loader2, Users, CalendarCheck, AlertTriangle, Star, DollarSign, History,
  UserX, BookOpen, CheckCircle, XCircle, Phone, Wallet, FileDown
} from 'lucide-react';
import TeacherActivityReport from './TeacherActivityReport';

interface Props { teacherId: string; onClose: () => void; }

const PRESENCE: Record<string, { txt: string; cls: string }> = {
  COMPLETED: { txt: 'Realizada', cls: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20' },
  STUDENT_ABSENCE: { txt: 'Falta Aluno', cls: 'bg-orange-50 text-orange-600 dark:bg-orange-900/20' },
  TEACHER_ABSENCE: { txt: 'Falta Prof.', cls: 'bg-red-50 text-red-600 dark:bg-red-900/20' },
  EXPIRED: { txt: 'Expirada', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800' },
};

const TeacherProfileView: React.FC<Props> = ({ teacherId, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<'overview' | 'students' | 'classes' | 'financial' | 'history'>('overview');
  const [showReport, setShowReport] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data, error } = await supabase.rpc('get_teacher_overview', { p_teacher_id: teacherId });
      setD(error ? { error: error.message } : data);
      setLoading(false);
    })();
  }, [teacherId]);

  const fmt = (x?: string) => x ? new Date(x.length <= 10 ? x + 'T00:00:00' : x).toLocaleDateString('pt-BR') : '—';
  const money = (v: any) => v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '—';

  const p = d?.profile; const m = d?.metrics;
  const tabs: [string, string][] = [['overview', 'Visão Geral'], ['students', 'Alunos'], ['classes', 'Aulas'], ['financial', 'Fechamentos'], ['history', 'Histórico']];

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-brand-surface w-full max-w-3xl rounded-3xl border border-brand-border shadow-2xl my-6" onClick={e => e.stopPropagation()}>
        {loading ? <div className="p-16 flex justify-center"><Loader2 className="animate-spin text-brand-accent" size={32} /></div>
        : d?.error ? <div className="p-12 text-center"><AlertTriangle className="mx-auto text-amber-500 mb-3" size={32} /><p className="text-brand-text font-bold">{d.error === 'sem_permissao' ? 'Sem acesso.' : 'Erro ao carregar.'}</p><button onClick={onClose} className="mt-4 px-4 py-2 bg-brand-surface-2 rounded-xl text-sm font-bold">Fechar</button></div>
        : (
          <>
            <div className="p-6 border-b border-brand-border flex items-center gap-4">
              <img src={p.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.full_name || 'P')}`} className="w-16 h-16 rounded-2xl object-cover" alt="" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold text-brand-text truncate">{p.full_name}</h2>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${p.status === 'Ativo' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-700'}`}>{p.status || '—'}</span>
                  {m.avg_rating != null && <span className="text-[10px] font-black bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full flex items-center gap-0.5"><Star size={10} className="fill-current" />{m.avg_rating}</span>}
                </div>
                <p className="text-xs text-brand-muted mt-1 flex items-center gap-3 flex-wrap">
                  {p.email && <span>{p.email}</span>}
                  {p.phone && <span className="flex items-center gap-1"><Phone size={11} />{p.phone}</span>}
                  <span className="flex items-center gap-1"><Wallet size={11} />{money(p.hourly_rate)}/h</span>
                </p>
              </div>
              <button onClick={() => setShowReport(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-tenant-primary/10 text-tenant-primary text-xs font-bold" title="Gerar folha/relatório em PDF para enviar"><FileDown size={14} /> Folha/PDF</button>
              <button onClick={onClose} className="p-2 rounded-xl hover:bg-brand-surface-2 text-brand-muted"><X size={20} /></button>
            </div>

            <div className="flex gap-1 px-4 pt-3 border-b border-brand-border overflow-x-auto">
              {tabs.map(([id, label]) => (
                <button key={id} onClick={() => setTab(id as any)} className={`px-4 py-2.5 text-sm font-bold rounded-t-xl whitespace-nowrap ${tab === id ? 'text-brand-accent border-b-2 border-brand-accent' : 'text-brand-muted hover:text-brand-text'}`}>{label}</button>
              ))}
            </div>

            <div className="p-6 max-h-[60vh] overflow-y-auto">
              {tab === 'overview' && (
                <div className="space-y-5">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Metric icon={<Users size={16} />} label="Alunos" value={`${m.active_students}`} />
                    <Metric icon={<CalendarCheck size={16} className="text-emerald-500" />} label="Aulas (30d)" value={`${m.classes_30}`} />
                    <Metric icon={<UserX size={16} className="text-red-500" />} label="Faltas prof. (30d)" value={`${m.teacher_absence_30}`} sub={`${m.absence_rate}% do total`} />
                    <Metric icon={<AlertTriangle size={16} className="text-amber-500" />} label="Conflitos" value={`${m.conflicts_open}`} />
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <Metric icon={<Star size={16} className="text-yellow-500" />} label="Avaliação" value={m.avg_rating != null ? `${m.avg_rating}★` : '—'} sub={`${m.rating_count} avaliações`} />
                    <Metric icon={<DollarSign size={16} className="text-emerald-500" />} label="Ganhos (mês, est.)" value={money(m.earnings_est)} />
                    <Metric icon={<BookOpen size={16} />} label="Especializações" value={`${(p.specializations || []).length}`} />
                  </div>
                  <div className="bg-brand-surface-2/40 border border-brand-border rounded-2xl p-4">
                    <p className="text-xs font-bold text-brand-text mb-2">Compliance / Cadastro</p>
                    <div className="flex flex-wrap gap-3">
                      <Flag ok={p.pix_ok} label="PIX cadastrado" />
                      <Flag ok={p.contract_ok} label="Contrato assinado" />
                    </div>
                  </div>
                  {(p.specializations || []).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {p.specializations.map((s: string, i: number) => <span key={i} className="text-[10px] font-bold bg-brand-accent/10 text-brand-accent px-2 py-1 rounded-lg">{s}</span>)}
                    </div>
                  )}
                </div>
              )}

              {tab === 'students' && (
                <div className="grid sm:grid-cols-2 gap-2">
                  {(d.students || []).length === 0 ? <Empty txt="Nenhum aluno vinculado." /> :
                    (d.students || []).map((s: any) => (
                      <div key={s.id} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-brand-text truncate">{s.name}</span>
                        {s.module && <span className="text-[10px] font-black bg-brand-accent/10 text-brand-accent px-2 py-0.5 rounded-full shrink-0">{s.module}</span>}
                      </div>
                    ))}
                </div>
              )}

              {tab === 'classes' && (
                <div className="space-y-2">
                  {(d.recent_classes || []).length === 0 ? <Empty txt="Nenhuma aula registrada." /> :
                    (d.recent_classes || []).map((c: any, i: number) => {
                      const pl = PRESENCE[c.presence] || { txt: c.presence, cls: 'bg-slate-100 text-slate-500' };
                      return (
                        <div key={i} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-2">
                          <div><span className="text-sm font-bold text-brand-text">{fmt(c.date)}</span><span className="text-xs text-brand-muted ml-2">{c.student || ''}</span></div>
                          <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${pl.cls}`}>{pl.txt}</span>
                        </div>
                      );
                    })}
                </div>
              )}

              {tab === 'financial' && (
                <div className="space-y-2">
                  {(d.closings || []).length === 0 ? <Empty txt="Nenhum fechamento." /> :
                    (d.closings || []).map((c: any, i: number) => (
                      <div key={i} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-2">
                        <div><p className="text-sm font-bold text-brand-text">{c.month}</p><p className="text-xs text-brand-muted">{money(c.amount)}</p></div>
                        <span className={`text-xs font-black ${c.status === 'PAGO' ? 'text-emerald-600' : 'text-amber-600'}`}>{c.status}</span>
                      </div>
                    ))}
                </div>
              )}

              {tab === 'history' && (
                <div className="space-y-2">
                  {(d.audit || []).length === 0 ? <Empty txt="Nenhuma alteração registrada." /> :
                    (d.audit || []).map((a: any, i: number) => (
                      <div key={i} className="border border-brand-border rounded-xl p-3 text-xs">
                        <p className="text-brand-text"><b>{a.field}</b>: <span className="text-red-500 line-through">{a.old_value || '∅'}</span> → <span className="text-emerald-600">{a.new_value || '∅'}</span></p>
                        <p className="text-brand-muted mt-1">{a.changed_by || 'sistema'} · {fmt(a.changed_at)}</p>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {showReport && <TeacherActivityReport teacherId={teacherId} editable onClose={() => setShowReport(false)} />}
    </div>
  );
};

const Metric: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string }> = ({ icon, label, value, sub }) => (
  <div className="bg-brand-surface-2/50 border border-brand-border rounded-2xl p-3">
    <div className="flex items-center gap-1 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className="text-xl font-black text-brand-text">{value}</p>
    {sub && <p className="text-[10px] text-brand-muted">{sub}</p>}
  </div>
);
const Flag: React.FC<{ ok: boolean; label: string }> = ({ ok, label }) => (
  <span className={`inline-flex items-center gap-1 text-xs font-bold ${ok ? 'text-emerald-600' : 'text-red-500'}`}>
    {ok ? <CheckCircle size={14} /> : <XCircle size={14} />}{label}
  </span>
);
const Empty: React.FC<{ txt: string }> = ({ txt }) => <div className="py-10 text-center text-brand-muted text-sm opacity-70">{txt}</div>;

export default TeacherProfileView;
