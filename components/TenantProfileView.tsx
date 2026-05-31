import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { X, Loader2, Users, GraduationCap, Activity, DollarSign, Globe, Mail, Phone, CheckCircle, AlertTriangle, CreditCard } from 'lucide-react';

interface Props { tenantId: string; onClose: () => void; onChanged?: () => void; }

const TenantProfileView: React.FC<Props> = ({ tenantId, onClose, onChanged }) => {
  const [loading, setLoading] = useState(true);
  const [d, setD] = useState<any>(null);
  const [planSel, setPlanSel] = useState<string>('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_tenant_overview', { p_tenant_id: tenantId });
    setD(error ? { error: error.message } : data);
    if (data?.tenant?.plan_id) setPlanSel(data.tenant.plan_id);
    setLoading(false);
  };
  useEffect(() => { load(); }, [tenantId]);

  const money = (v: any) => v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '—';
  const fmt = (x?: string) => x ? new Date(x.length <= 10 ? x + 'T00:00:00' : x).toLocaleDateString('pt-BR') : '—';

  const assignPlan = async () => {
    if (!planSel) return;
    setSaving(true);
    const { data, error } = await supabase.rpc('assign_tenant_plan', { p_tenant_id: tenantId, p_plan_id: planSel });
    setSaving(false);
    if (error || data?.ok === false) { alert('Erro ao atribuir plano.'); return; }
    load(); onChanged?.();
  };

  const t = d?.tenant; const u = d?.usage;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-brand-surface w-full max-w-2xl rounded-3xl border border-brand-border shadow-2xl my-6" onClick={e => e.stopPropagation()}>
        {loading ? <div className="p-16 flex justify-center"><Loader2 className="animate-spin text-brand-accent" size={32} /></div>
        : d?.error ? <div className="p-12 text-center text-brand-text font-bold">{d.error === 'sem_permissao' ? 'Sem acesso.' : 'Erro ao carregar.'}</div>
        : (
          <>
            <div className="p-6 border-b border-brand-border flex items-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center text-white"><Globe size={26} /></div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-xl font-bold text-brand-text truncate">{t.name}</h2>
                  <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${t.saas_status === 'active' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>{t.saas_status}</span>
                  {t.plan_name && <span className="text-[10px] font-black bg-brand-accent/10 text-brand-accent px-2 py-0.5 rounded-full">{t.plan_name}</span>}
                </div>
                <p className="text-xs text-brand-muted mt-1 flex items-center gap-3 flex-wrap">
                  {t.owner_email && <span className="flex items-center gap-1"><Mail size={11} />{t.owner_email}</span>}
                  {t.owner_phone && <span className="flex items-center gap-1"><Phone size={11} />{t.owner_phone}</span>}
                  <span>Desde {fmt(t.created_at)}</span>
                </p>
              </div>
              <button onClick={onClose} className="p-2 rounded-xl hover:bg-brand-surface-2 text-brand-muted"><X size={20} /></button>
            </div>

            <div className="p-6 space-y-5 max-h-[65vh] overflow-y-auto">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Metric icon={<Users size={16} />} label="Alunos" value={`${u.students}/${t.student_limit || '∞'}`} sub={`${u.student_pct}% do limite`} />
                <Metric icon={<GraduationCap size={16} />} label="Professores" value={`${u.teachers}`} />
                <Metric icon={<Activity size={16} className="text-emerald-500" />} label="Aulas (30d)" value={`${u.classes_30}`} sub={u.last_activity ? `últ. ${fmt(u.last_activity)}` : 'sem atividade'} />
                <Metric icon={<DollarSign size={16} className="text-emerald-500" />} label="MRR" value={t.saas_status === 'active' ? money(t.plan_price) : 'R$ 0,00'} />
              </div>

              {/* Plano / receita */}
              <div className="bg-brand-surface-2/40 border border-brand-border rounded-2xl p-4">
                <p className="text-xs font-bold text-brand-text mb-2 flex items-center gap-1"><CreditCard size={14} /> Plano & Cobrança</p>
                {!t.plan_id && (
                  <div className="flex items-center gap-2 text-xs text-amber-600 mb-2"><AlertTriangle size={14} /> Esta escola não tem plano atribuído (receita não contabilizada).</div>
                )}
                <div className="flex gap-2 items-center flex-wrap">
                  <select value={planSel} onChange={e => setPlanSel(e.target.value)}
                    className="text-sm font-bold bg-brand-surface text-brand-text rounded-xl px-3 py-2 border border-brand-border">
                    <option value="">Selecione um plano…</option>
                    {(d.plans || []).map((p: any) => <option key={p.id} value={p.id}>{p.name} — {money(p.price)}/mês</option>)}
                  </select>
                  <button onClick={assignPlan} disabled={saving || !planSel || planSel === t.plan_id}
                    className="px-4 py-2 bg-brand-accent text-white rounded-xl text-xs font-bold disabled:opacity-50">
                    {saving ? 'Salvando…' : 'Atribuir plano'}
                  </button>
                </div>
                <p className="text-[11px] text-brand-muted mt-2">Próx. ciclo: {fmt(t.current_period_end)} · Asaas: {t.asaas_status || '—'}{t.trial_ends_at ? ` · Trial até ${fmt(t.trial_ends_at)}` : ''}</p>
              </div>

              {/* Faturas */}
              <div>
                <p className="text-xs font-bold text-brand-text mb-2">Faturas (B2B)</p>
                {(d.invoices || []).length === 0 ? (
                  <div className="py-6 text-center text-brand-muted text-sm opacity-70">Nenhuma fatura gerada.</div>
                ) : (
                  <div className="space-y-2">
                    {(d.invoices || []).map((inv: any, i: number) => (
                      <div key={i} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-2">
                        <div><p className="text-sm font-bold text-brand-text">{money(inv.amount)}</p><p className="text-xs text-brand-muted">{inv.period || ''} · vence {fmt(inv.due_date)}</p></div>
                        <span className={`text-xs font-black ${inv.status === 'PAID' || inv.status === 'RECEIVED' ? 'text-emerald-600' : inv.status === 'OVERDUE' ? 'text-red-600' : 'text-amber-600'}`}>{inv.status}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
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

export default TenantProfileView;
