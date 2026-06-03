import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  X, Loader2, Flame, Gem, Heart, CalendarCheck, AlertTriangle, TrendingUp,
  BookOpen, MessageSquarePlus, DollarSign, History, User as UserIcon, Phone, Trophy, Users, ArrowRightLeft
} from 'lucide-react';
import { User as UserType } from '../types';
import TeacherTransferGenerator from './TeacherTransferGenerator';

interface Props {
  studentId: string;
  user: UserType;
  onClose: () => void;
}

const PRESENCE_LABEL: Record<string, { txt: string; cls: string }> = {
  COMPLETED: { txt: 'Realizada', cls: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20' },
  STUDENT_ABSENCE: { txt: 'Falta Aluno', cls: 'bg-orange-50 text-orange-600 dark:bg-orange-900/20' },
  TEACHER_ABSENCE: { txt: 'Falta Prof.', cls: 'bg-red-50 text-red-600 dark:bg-red-900/20' },
  EXPIRED: { txt: 'Expirada', cls: 'bg-slate-100 text-slate-500 dark:bg-slate-800' },
  'Falta Justificada': { txt: 'Falta Just.', cls: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20' },
};
const PAY_LABEL: Record<string, { txt: string; cls: string }> = {
  RECEIVED: { txt: 'Pago', cls: 'text-emerald-600' },
  RECEIVED_IN_CASH: { txt: 'Pago (dinheiro)', cls: 'text-emerald-600' },
  PENDING: { txt: 'Pendente', cls: 'text-amber-600' },
  OVERDUE: { txt: 'Atrasado', cls: 'text-red-600' },
  DUNNING_REQUESTED: { txt: 'Em cobrança', cls: 'text-red-600' },
};
const NOTE_CATS = ['GERAL', 'PROGRESSO', 'COMPORTAMENTO', 'DIFICULDADE', 'ELOGIO'];

const StudentProfileView: React.FC<Props> = ({ studentId, user, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'overview' | 'classes' | 'notes' | 'financial' | 'history'>('overview');
  const [newNote, setNewNote] = useState('');
  const [noteCat, setNoteCat] = useState('GERAL');
  const [savingNote, setSavingNote] = useState(false);

  const [creditBalance, setCreditBalance] = useState<number>(0);
  const [applying, setApplying] = useState(false);

  // Alunos vinculados: perfis que têm este titular como responsável financeiro (guardian_id)
  const [dependents, setDependents] = useState<any[]>([]);
  const [showTransfer, setShowTransfer] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data: d, error } = await supabase.rpc('get_student_overview', { p_student_id: studentId });
    if (error || d?.error) {
      setData({ error: d?.error || error?.message || 'erro' });
    } else {
      setData(d);
      if (d?.can_edit_financial) {
        const { data: bal } = await supabase.rpc('get_student_credit_balance', { p_student_id: studentId });
        setCreditBalance(Number(bal) || 0);
      }
    }
    // Busca beneficiários cobrados no CPF deste titular (não bloqueante)
    try {
      const { data: deps } = await supabase
        .from('profiles')
        .select('id, full_name, email, monthly_fee, subscription_id, status_financial')
        .eq('guardian_id', studentId)
        .order('full_name', { ascending: true });
      setDependents(deps || []);
    } catch (_) {
      setDependents([]);
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, [studentId]);

  const isAdmin = data?.can_edit_financial === true;

  const applyCredit = async () => {
    if (creditBalance <= 0) return;
    if (!confirm(`Aplicar R$ ${creditBalance.toFixed(2).replace('.', ',')} de crédito na próxima cobrança pendente deste aluno?`)) return;
    setApplying(true);
    const { data: res, error } = await supabase.rpc('apply_credit_next_pending', { p_student_id: studentId });
    setApplying(false);
    if (error || res?.ok === false) { alert(res?.error === 'sem_cobranca_pendente' ? 'Sem cobrança pendente para aplicar.' : 'Erro ao aplicar crédito.'); return; }
    alert(`Crédito aplicado: R$ ${Number(res.applied || 0).toFixed(2).replace('.', ',')}.\n⚠️ Se a cobrança estiver sincronizada na Asaas, ajuste o valor lá também.`);
    load();
  };

  const addNote = async () => {
    if (!newNote.trim()) return;
    setSavingNote(true);
    const { error } = await supabase.from('student_teacher_notes').insert({
      tenant_id: (user as any).tenantId || (user as any).tenant_id,
      student_id: studentId,
      author_id: user.id,
      author_name: (user as any).name || (user as any).full_name || 'Professor',
      category: noteCat,
      note: newNote.trim(),
    });
    setSavingNote(false);
    if (!error) { setNewNote(''); load(); }
    else alert('Erro ao salvar observação: ' + error.message);
  };

  const fmtDate = (d?: string) => d ? new Date(d.length <= 10 ? d + 'T00:00:00' : d).toLocaleDateString('pt-BR') : '—';
  const money = (v: any) => v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '—';

  const p = data?.profile;
  const freq = data?.frequency;
  const gami = data?.gamification;
  const risk = (() => {
    // recomputa nível de risco a partir dos dados (mesma lógica da lista)
    const reasons: string[] = [];
    if ((data?.financial?.first_overdue_at) || (data?.payments || []).some((x: any) => x.status === 'OVERDUE')) reasons.push('Pagamento em atraso');
    if (freq && freq.rate != null && (freq.attended_90 + freq.absent_90) >= 3 && freq.rate < 60) reasons.push(`Frequência baixa (${freq.rate}%)`);
    const lvl = reasons.length >= 2 ? 'HIGH' : reasons.length === 1 ? 'MEDIUM' : 'LOW';
    return { lvl, reasons };
  })();

  const tabs: [string, string][] = [
    ['overview', 'Visão Geral'],
    ['classes', 'Aulas'],
    ['notes', 'Observações'],
    ...(isAdmin ? [['financial', 'Financeiro'], ['history', 'Histórico']] as [string, string][] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-brand-surface w-full max-w-3xl rounded-3xl border border-brand-border shadow-2xl my-6" onClick={e => e.stopPropagation()}>
        {loading ? (
          <div className="p-16 flex justify-center"><Loader2 className="animate-spin text-brand-accent" size={32} /></div>
        ) : data?.error ? (
          <div className="p-12 text-center">
            <AlertTriangle className="mx-auto text-amber-500 mb-3" size={32} />
            <p className="text-brand-text font-bold">{data.error === 'sem_permissao' ? 'Você não tem acesso a este aluno.' : 'Não foi possível carregar.'}</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 bg-brand-surface-2 rounded-xl text-sm font-bold">Fechar</button>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="p-6 border-b border-brand-border flex items-center gap-4">
              <img src={p.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(p.full_name || 'A')}`} className="w-16 h-16 rounded-2xl object-cover" alt={p.full_name} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold text-brand-text truncate">{p.full_name}</h2>
                  {p.is_kids && <span className="text-[10px] font-black bg-pink-100 text-pink-600 px-2 py-0.5 rounded-full">🧸 KIDS</span>}
                  {p.module && <span className="text-[10px] font-black bg-brand-accent/10 text-brand-accent px-2 py-0.5 rounded-full">{p.module}</span>}
                  {risk.lvl !== 'LOW' && (
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${risk.lvl === 'HIGH' ? 'bg-red-500 text-white' : 'bg-amber-400 text-amber-900'}`}>
                      {risk.lvl === 'HIGH' ? '⚠ ALTO RISCO' : '⚠ ATENÇÃO'}
                    </span>
                  )}
                </div>
                <p className="text-xs text-brand-muted mt-1 flex items-center gap-3 flex-wrap">
                  {p.professor_name && <span className="flex items-center gap-1"><UserIcon size={11} />{p.professor_name}</span>}
                  {p.phone && <span className="flex items-center gap-1"><Phone size={11} />{p.phone}</span>}
                  <span>Desde {fmtDate(p.start_date || p.created_at)}</span>
                </p>
              </div>
              {isAdmin && (
                <button onClick={() => setShowTransfer(true)} title="Transferir de professor"
                  className="px-3 py-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-300 hover:bg-indigo-100 text-xs font-black uppercase tracking-widest flex items-center gap-1.5 shrink-0">
                  <ArrowRightLeft size={14} /> Transferir
                </button>
              )}
              <button onClick={onClose} className="p-2 rounded-xl hover:bg-brand-surface-2 text-brand-muted"><X size={20} /></button>
            </div>

            {showTransfer && (
              <TeacherTransferGenerator
                tenantId={(user as any)?.tenantId || (user as any)?.tenant_id}
                student={{ id: studentId, full_name: p.full_name, professor_id: p.professor_id, class_frequency: p.class_frequency }}
                onClose={() => setShowTransfer(false)}
              />
            )}

            {/* Tabs */}
            <div className="flex gap-1 px-4 pt-3 border-b border-brand-border overflow-x-auto">
              {tabs.map(([id, label]) => (
                <button key={id} onClick={() => setTab(id as any)}
                  className={`px-4 py-2.5 text-sm font-bold rounded-t-xl whitespace-nowrap transition-all ${tab === id ? 'text-brand-accent border-b-2 border-brand-accent' : 'text-brand-muted hover:text-brand-text'}`}>
                  {label}
                </button>
              ))}
            </div>

            <div className="p-6 max-h-[60vh] overflow-y-auto">
              {/* OVERVIEW */}
              {tab === 'overview' && (
                <div className="space-y-5">
                  {risk.reasons.length > 0 && (
                    <div className="bg-red-50/60 dark:bg-red-900/10 border border-red-200 dark:border-red-900/30 rounded-2xl p-4">
                      <p className="text-xs font-bold text-red-600 mb-2 flex items-center gap-1"><AlertTriangle size={14} /> Sinais de risco de evasão</p>
                      <div className="flex flex-wrap gap-2">
                        {risk.reasons.map((r, i) => <span key={i} className="text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-2 py-1 rounded-lg">{r}</span>)}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <Metric icon={<CalendarCheck size={16} />} label="Frequência (90d)" value={freq?.rate != null ? `${freq.rate}%` : '—'} sub={`${freq?.attended_90 || 0} aulas / ${freq?.absent_90 || 0} faltas`} />
                    <Metric icon={<Flame size={16} className="text-orange-500" />} label="Ofensiva" value={`${gami?.streak || 0}`} sub="dias seguidos" />
                    <Metric icon={<Gem size={16} className="text-sky-500" />} label="XP" value={`${gami?.xp || 0}`} sub={`Nível ${gami?.level || 1}`} />
                    <Metric icon={<Heart size={16} className="text-rose-500" />} label="Vidas" value={`${gami?.hearts ?? 5}/5`} sub="gamificação" />
                  </div>
                  <div className="grid md:grid-cols-2 gap-3">
                    <InfoBox title="Dados">
                      <Row k="Profissão" v={p.occupation} />
                      <Row k="E-mail" v={p.email} />
                      {p.is_kids && <><Row k="Responsável" v={p.guardian_name} /><Row k="Tel. responsável" v={p.guardian_phone} /></>}
                      <Row k="Interesses" v={Array.isArray(p.interests) ? p.interests.join(', ') : p.interests} />
                    </InfoBox>
                    {isAdmin && (
                      <InfoBox title="Financeiro">
                        <Row k="Mensalidade" v={money(data.financial?.monthly_fee)} />
                        <Row k="Vencimento" v={data.financial?.due_day ? `dia ${data.financial.due_day}` : '—'} />
                        <Row k="Status" v={data.financial?.status_financial} />
                      </InfoBox>
                    )}
                  </div>

                  {/* Alunos vinculados (beneficiários cobrados no CPF deste titular) */}
                  {dependents.length > 0 && (
                    <div className="bg-indigo-50/60 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-900/30 rounded-2xl p-4">
                      <p className="text-xs font-bold text-indigo-700 dark:text-indigo-300 mb-3 flex items-center gap-1.5">
                        <Users size={14} /> Alunos vinculados — cobrados neste CPF ({dependents.length})
                      </p>
                      <div className="space-y-2">
                        {dependents.map((dep) => (
                          <div key={dep.id} className="flex items-center justify-between gap-3 bg-brand-surface dark:bg-slate-900 border border-brand-border rounded-xl px-3 py-2">
                            <div className="min-w-0">
                              <p className="text-sm font-bold text-brand-text dark:text-slate-200 truncate">{dep.full_name}</p>
                              <p className="text-[11px] text-brand-muted truncate">{dep.email || '—'}</p>
                            </div>
                            <div className="text-right shrink-0">
                              {isAdmin && <p className="text-sm font-bold text-brand-text dark:text-slate-200">{money(dep.monthly_fee)}</p>}
                              <p className="text-[10px] font-bold uppercase tracking-widest text-brand-muted">
                                {dep.subscription_id ? 'Assinatura ativa' : 'Sem assinatura'}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                      {isAdmin && (
                        <p className="text-[11px] text-brand-muted mt-2 pt-2 border-t border-indigo-200/60 dark:border-indigo-900/30">
                          Total mensal neste CPF (titular + vinculados):{' '}
                          <strong className="text-brand-text dark:text-slate-200">
                            {money((Number(data.financial?.monthly_fee) || 0) + dependents.reduce((s, d) => s + (Number(d.monthly_fee) || 0), 0))}
                          </strong>
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* CLASSES */}
              {tab === 'classes' && (
                <div className="space-y-2">
                  {(data.classes || []).length === 0 ? <Empty txt="Nenhuma aula registrada." /> :
                    (data.classes || []).map((c: any, i: number) => {
                      const pl = PRESENCE_LABEL[c.presence] || { txt: c.presence, cls: 'bg-slate-100 text-slate-500' };
                      return (
                        <div key={i} className="border border-brand-border rounded-xl p-3 bg-brand-surface-2/40">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-sm font-bold text-brand-text">{fmtDate(c.date)}</span>
                            <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${pl.cls}`}>{pl.txt}</span>
                          </div>
                          {c.content && <p className="text-xs text-brand-muted mt-1"><b>Conteúdo:</b> {c.content}</p>}
                          {c.difficulties && <p className="text-xs text-brand-muted mt-0.5"><b>Dificuldades:</b> {c.difficulties}</p>}
                          {c.homework && <p className="text-xs text-brand-muted mt-0.5"><b>Tarefa:</b> {c.homework}</p>}
                          {c.teacher && <p className="text-[10px] text-brand-muted mt-1">Prof. {c.teacher}</p>}
                        </div>
                      );
                    })}
                </div>
              )}

              {/* NOTES */}
              {tab === 'notes' && (
                <div className="space-y-4">
                  <div className="bg-brand-surface-2/50 border border-brand-border rounded-2xl p-4">
                    <p className="text-xs font-bold text-brand-text mb-2 flex items-center gap-1"><MessageSquarePlus size={14} /> Nova observação</p>
                    <div className="flex gap-2 mb-2 flex-wrap">
                      {NOTE_CATS.map(c => (
                        <button key={c} onClick={() => setNoteCat(c)} className={`text-[10px] font-bold px-2 py-1 rounded-lg ${noteCat === c ? 'bg-brand-accent text-white' : 'bg-brand-surface text-brand-muted border border-brand-border'}`}>{c}</button>
                      ))}
                    </div>
                    <textarea value={newNote} onChange={e => setNewNote(e.target.value)} rows={2} placeholder="Ex: Evoluiu muito no speaking, mas precisa reforçar past tense."
                      className="w-full text-sm p-3 rounded-xl border border-brand-border bg-brand-surface text-brand-text resize-none" />
                    <button onClick={addNote} disabled={savingNote || !newNote.trim()} className="mt-2 px-4 py-2 bg-brand-accent text-white rounded-xl text-xs font-bold disabled:opacity-50">
                      {savingNote ? 'Salvando…' : 'Adicionar'}
                    </button>
                  </div>
                  {(data.notes || []).length === 0 ? <Empty txt="Nenhuma observação ainda." /> :
                    (data.notes || []).map((n: any) => (
                      <div key={n.id} className="border border-brand-border rounded-xl p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-black bg-brand-accent/10 text-brand-accent px-2 py-0.5 rounded-full">{n.category}</span>
                          <span className="text-[10px] text-brand-muted">{n.author_name} · {fmtDate(n.created_at)}</span>
                        </div>
                        <p className="text-sm text-brand-text mt-2">{n.note}</p>
                      </div>
                    ))}
                </div>
              )}

              {/* FINANCIAL (admin) */}
              {tab === 'financial' && isAdmin && (
                <div className="space-y-2">
                  {creditBalance > 0 && (
                    <div className="bg-emerald-50/60 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-900/30 rounded-xl p-3 flex items-center justify-between gap-2 mb-2">
                      <div className="text-sm">
                        <span className="font-bold text-emerald-700 dark:text-emerald-400">💰 Crédito disponível: {money(creditBalance)}</span>
                        <p className="text-[11px] text-brand-muted">de indicações — aplicável na próxima cobrança</p>
                      </div>
                      <button onClick={applyCredit} disabled={applying} className="px-3 py-2 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl text-xs font-bold disabled:opacity-50 shrink-0">
                        {applying ? 'Aplicando…' : 'Aplicar crédito'}
                      </button>
                    </div>
                  )}
                  {(data.payments || []).length === 0 ? <Empty txt="Nenhuma cobrança registrada." /> :
                    (data.payments || []).map((pay: any, i: number) => {
                      const pl = PAY_LABEL[pay.status] || { txt: pay.status, cls: 'text-brand-muted' };
                      return (
                        <div key={i} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-bold text-brand-text">{money(pay.value)}</p>
                            <p className="text-xs text-brand-muted truncate">{pay.description || 'Mensalidade'} · vence {fmtDate(pay.due_date)}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <span className={`text-xs font-black ${pl.cls}`}>{pl.txt}</span>
                            {pay.invoice_url && <a href={pay.invoice_url} target="_blank" rel="noreferrer" className="block text-[10px] text-brand-accent underline">ver fatura</a>}
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* HISTORY (admin) */}
              {tab === 'history' && isAdmin && (
                <div className="space-y-2">
                  {(data.audit || []).length === 0 ? <Empty txt="Nenhuma alteração registrada." /> :
                    (data.audit || []).map((a: any, i: number) => (
                      <div key={i} className="border border-brand-border rounded-xl p-3 text-xs">
                        <p className="text-brand-text"><b>{a.field}</b>: <span className="text-red-500 line-through">{a.old_value || '∅'}</span> → <span className="text-emerald-600">{a.new_value || '∅'}</span></p>
                        <p className="text-brand-muted mt-1">{a.changed_by || 'sistema'} · {fmtDate(a.changed_at)}</p>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const Metric: React.FC<{ icon: React.ReactNode; label: string; value: string; sub: string }> = ({ icon, label, value, sub }) => (
  <div className="bg-brand-surface-2/50 border border-brand-border rounded-2xl p-3">
    <div className="flex items-center gap-1 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className="text-xl font-black text-brand-text">{value}</p>
    <p className="text-[10px] text-brand-muted">{sub}</p>
  </div>
);
const InfoBox: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="bg-brand-surface-2/40 border border-brand-border rounded-2xl p-4">
    <p className="text-xs font-bold text-brand-text mb-2">{title}</p>
    <div className="space-y-1">{children}</div>
  </div>
);
const Row: React.FC<{ k: string; v: any }> = ({ k, v }) => (
  <div className="flex justify-between gap-2 text-xs"><span className="text-brand-muted">{k}</span><span className="text-brand-text text-right truncate max-w-[60%]">{v || '—'}</span></div>
);
const Empty: React.FC<{ txt: string }> = ({ txt }) => (
  <div className="py-10 text-center text-brand-muted text-sm opacity-70">{txt}</div>
);

export default StudentProfileView;
