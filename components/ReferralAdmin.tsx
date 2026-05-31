import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Gift, RefreshCw, Save, Wallet, CheckCircle, Users, DollarSign, Power } from 'lucide-react';
import { User as UserType } from '../types';

interface Props { user: UserType; tenantId?: string; }

const RR_LABEL: Record<string, { txt: string; cls: string }> = {
  PENDING: { txt: 'A pagar', cls: 'text-amber-600' },
  CREDITED: { txt: 'Creditado', cls: 'text-emerald-600' },
  PAID: { txt: 'Pago', cls: 'text-emerald-600' },
  CANCELLED: { txt: 'Cancelado', cls: 'text-slate-400' },
};

const ReferralAdmin: React.FC<Props> = () => {
  const [cfg, setCfg] = useState<any>(null);
  const [data, setData] = useState<any>({ stats: {}, rewards: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    const [{ data: settings }, { data: overview }] = await Promise.all([
      supabase.rpc('get_referral_settings'),
      supabase.rpc('list_referrals_overview'),
    ]);
    if (settings && !settings.error) setCfg(settings);
    if (overview && !overview.error) setData(overview);
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const money = (v: any) => `R$ ${Number(v || 0).toFixed(2).replace('.', ',')}`;
  const upd = (k: string, v: any) => setCfg((c: any) => ({ ...c, [k]: v }));

  const save = async () => {
    setSaving(true);
    const { data: res, error } = await supabase.rpc('save_referral_settings', { p: {
      enabled: !!cfg.enabled,
      student_reward_brl: Number(cfg.student_reward_brl) || 0,
      teacher_reward_brl: Number(cfg.teacher_reward_brl) || 0,
      min_payments: Number(cfg.min_payments) || 1,
      monthly_cap: cfg.monthly_cap ? Number(cfg.monthly_cap) : null,
      self_referral_block: cfg.self_referral_block !== false,
      reward_expires_days: cfg.reward_expires_days ? Number(cfg.reward_expires_days) : null,
    }});
    setSaving(false);
    if (error || res?.ok === false) { alert('Erro ao salvar.'); return; }
    load();
  };

  const payReward = async (id: string) => {
    setBusy(id);
    await supabase.rpc('set_referral_reward_status', { p_id: id, p_status: 'PAID' });
    setBusy(null); load();
  };

  if (loading || !cfg) return <div className="py-16 text-center text-brand-muted"><RefreshCw size={24} className="animate-spin mx-auto" /></div>;

  const s = data.stats || {};
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-3 rounded-2xl bg-pink-50 dark:bg-pink-900/20 text-pink-600"><Gift size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Programa de Indicações</h2>
          <p className="text-sm text-brand-muted">Configure recompensas e acompanhe quem indicou quem</p>
        </div>
        <button onClick={load} className="ml-auto p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"><RefreshCw size={18} /></button>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={<Users size={16} />} label="Indicações" value={`${s.total ?? 0}`} />
        <Kpi icon={<Wallet size={16} className="text-amber-500" />} label="A pagar (prof.)" value={money(s.pending_payout)} accent="text-amber-600" />
        <Kpi icon={<DollarSign size={16} className="text-emerald-500" />} label="Creditado (alunos)" value={money(s.credited)} />
        <Kpi icon={<CheckCircle size={16} className="text-emerald-500" />} label="Já pago" value={money(s.paid)} />
      </div>

      {/* Config */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-brand-text">Configuração do programa</h3>
          <button onClick={() => upd('enabled', !cfg.enabled)} className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-bold ${cfg.enabled ? 'bg-emerald-500 text-white' : 'bg-brand-surface-2 text-brand-muted border border-brand-border'}`}>
            <Power size={14} /> {cfg.enabled ? 'Programa ATIVO' : 'Programa desligado'}
          </button>
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          <Field label="Recompensa por aluno (R$)" hint="Crédito p/ aluno que indica">
            <input type="number" value={cfg.student_reward_brl ?? 0} onChange={e => upd('student_reward_brl', e.target.value)} className="w-full px-3 py-2 rounded-xl border border-brand-border bg-brand-surface text-brand-text" />
          </Field>
          <Field label="Recompensa por professor (R$)" hint="Repasse p/ professor que indica">
            <input type="number" value={cfg.teacher_reward_brl ?? 0} onChange={e => upd('teacher_reward_brl', e.target.value)} className="w-full px-3 py-2 rounded-xl border border-brand-border bg-brand-surface text-brand-text" />
          </Field>
          <Field label="Mín. de pagamentos" hint="Premiar só após N pagamentos do indicado">
            <input type="number" value={cfg.min_payments ?? 1} onChange={e => upd('min_payments', e.target.value)} className="w-full px-3 py-2 rounded-xl border border-brand-border bg-brand-surface text-brand-text" />
          </Field>
          <Field label="Teto mensal por indicador" hint="0 = ilimitado">
            <input type="number" value={cfg.monthly_cap ?? 0} onChange={e => upd('monthly_cap', e.target.value)} className="w-full px-3 py-2 rounded-xl border border-brand-border bg-brand-surface text-brand-text" />
          </Field>
          <Field label="Validade do crédito (dias)" hint="Vazio = não expira">
            <input type="number" value={cfg.reward_expires_days ?? ''} onChange={e => upd('reward_expires_days', e.target.value)} className="w-full px-3 py-2 rounded-xl border border-brand-border bg-brand-surface text-brand-text" />
          </Field>
          <Field label="Bloquear auto-indicação" hint="Impede indicar a si mesmo">
            <button onClick={() => upd('self_referral_block', cfg.self_referral_block === false)} className={`w-full px-3 py-2 rounded-xl text-sm font-bold ${cfg.self_referral_block !== false ? 'bg-emerald-500 text-white' : 'bg-brand-surface-2 text-brand-muted border border-brand-border'}`}>
              {cfg.self_referral_block !== false ? 'Ativado' : 'Desativado'}
            </button>
          </Field>
        </div>
        <button onClick={save} disabled={saving} className="mt-4 flex items-center gap-2 px-4 py-2 bg-brand-accent text-white rounded-xl text-sm font-bold disabled:opacity-50">
          <Save size={15} /> {saving ? 'Salvando…' : 'Salvar configuração'}
        </button>
        <p className="text-[11px] text-brand-muted mt-2">💡 A recompensa é gerada automaticamente quando o aluno indicado paga (respeitando o mínimo de pagamentos). Aluno que indica recebe <b>crédito</b>; professor recebe <b>repasse</b> que você marca como pago abaixo.</p>
      </div>

      {/* Recompensas */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <h3 className="text-sm font-bold text-brand-text mb-4">Recompensas</h3>
        {(data.rewards || []).length === 0 ? (
          <div className="py-8 text-center text-brand-muted text-sm opacity-70">Nenhuma indicação recompensada ainda.</div>
        ) : (
          <div className="space-y-2">
            {(data.rewards || []).map((r: any) => {
              const cl = RR_LABEL[r.status] || { txt: r.status, cls: 'text-brand-muted' };
              return (
                <div key={r.id} className="border border-brand-border rounded-xl p-3 flex items-center justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-text">{r.referrer || '—'} <span className="text-[10px] font-black bg-brand-surface-2 px-1.5 py-0.5 rounded">{r.role === 'TEACHER' ? 'PROFESSOR' : 'ALUNO'}</span></p>
                    <p className="text-xs text-brand-muted">indicou {r.referred || '—'} · {money(r.amount)}</p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-xs font-black ${cl.cls}`}>{cl.txt}</span>
                    {r.status === 'PENDING' && <button onClick={() => payReward(r.id)} disabled={busy === r.id} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white text-xs font-bold disabled:opacity-50">Marcar pago</button>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; accent?: string }> = ({ icon, label, value, accent }) => (
  <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
    <div className="flex items-center gap-2 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className={`text-xl font-black ${accent || 'text-brand-text'}`}>{value}</p>
  </div>
);
const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div>
    <label className="block text-xs font-bold text-brand-text mb-1">{label}</label>
    {children}
    {hint && <p className="text-[10px] text-brand-muted mt-1">{hint}</p>}
  </div>
);

export default ReferralAdmin;
