import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { localMonth, recentMonths } from '../lib/dateUtils';
import { TrendingUp, TrendingDown, Wallet, Clock, RefreshCw, ArrowDownCircle, ArrowUpCircle, AlertTriangle, Gauge } from 'lucide-react';
import { User as UserType } from '../types';

interface Props { user: UserType; tenantId?: string; }

const CashflowPanel: React.FC<Props> = ({ tenantId }) => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(localMonth());

  const load = async (m: string) => {
    setLoading(true);
    const { data: d } = await supabase.rpc('get_cashflow', { p_month: m });
    setData(d?.error ? null : d);
    setLoading(false);
  };
  useEffect(() => { load(month); }, [month]);

  const money = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const monthLabel = (m: string) => { const [y, mo] = m.split('-'); return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }); };

  const saidas = data?.saidas || {};
  const inad = data?.inadimplencia || {};
  const serie = data?.serie || [];
  const maxSerie = Math.max(1, ...serie.map((s: any) => Number(s.entradas || 0)));

  // opções de mês (últimos 6)
  const monthOpts = recentMonths(6);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="p-3 rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600"><Wallet size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Fluxo de Caixa</h2>
          <p className="text-sm text-brand-muted">Entradas, saídas, saldo e inadimplência — conciliação automática</p>
        </div>
        <select value={month} onChange={e => setMonth(e.target.value)} className="ml-auto text-sm font-bold bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border">
          {monthOpts.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <button onClick={() => load(month)} className="p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"><RefreshCw size={18} className={loading ? 'animate-spin' : ''} /></button>
      </div>

      {loading || !data ? <div className="py-16 text-center text-brand-muted"><RefreshCw size={24} className="animate-spin mx-auto" /></div> : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi icon={<ArrowDownCircle size={16} className="text-emerald-500" />} label="Entradas" value={money(data.entradas)} accent="text-emerald-600" />
            <Kpi icon={<ArrowUpCircle size={16} className="text-red-500" />} label="Saídas" value={money(saidas.total)} accent="text-red-600" />
            <Kpi icon={<Wallet size={16} />} label="Saldo do mês" value={money(data.saldo)} accent={Number(data.saldo) >= 0 ? 'text-emerald-600' : 'text-red-600'} />
            <Kpi icon={<Clock size={16} className="text-amber-500" />} label="A receber (mês)" value={money(data.a_receber)} accent="text-amber-600" />
          </div>

          {/* Radar MEI — receita bruta do ano × teto do regime */}
          <MeiRadar tenantId={tenantId} />

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Série de entradas */}
            <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
              <h3 className="text-sm font-bold text-brand-text mb-4 flex items-center gap-2"><TrendingUp size={16} className="text-emerald-600" /> Receita (6 meses)</h3>
              <div className="flex items-end justify-between gap-2 h-40">
                {serie.map((s: any, i: number) => (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full flex items-end justify-center" style={{ height: '120px' }}>
                      <div className="w-8 rounded-t-lg bg-gradient-to-t from-emerald-500 to-emerald-400" style={{ height: `${Math.max(4, Math.round(120 * Number(s.entradas) / maxSerie))}px` }} title={money(s.entradas)} />
                    </div>
                    <span className="text-[9px] font-bold text-brand-muted">{monthLabel(s.mes)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Saídas + inadimplência */}
            <div className="space-y-4">
              <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
                <h3 className="text-sm font-bold text-brand-text mb-3 flex items-center gap-2"><TrendingDown size={16} className="text-red-600" /> Saídas do mês</h3>
                <div className="space-y-1.5 text-sm">
                  <Row k="Repasse a professores" v={money(saidas.professores)} />
                  <Row k="Comissões de vendedor" v={money(saidas.vendedores)} />
                  <Row k="Recompensas de indicação" v={money(saidas.indicacoes)} />
                  <Row k="Despesas avulsas" v={money(saidas.despesas)} />
                  <div className="border-t border-brand-border pt-1.5 mt-1.5 flex justify-between font-bold text-brand-text"><span>Total</span><span>{money(saidas.total)}</span></div>
                </div>
              </div>
              <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
                <h3 className="text-sm font-bold text-brand-text mb-3 flex items-center gap-2"><AlertTriangle size={16} className="text-amber-600" /> Inadimplência <span className="text-xs text-brand-muted font-normal">({inad.count || 0} cobranças · {money(inad.total)})</span></h3>
                <div className="space-y-1.5 text-sm">
                  <Row k="Vencido 1–30 dias" v={money(inad.d1_30)} />
                  <Row k="Vencido 31–60 dias" v={money(inad.d31_60)} />
                  <Row k="Vencido 60+ dias" v={money(inad.d60plus)} danger />
                </div>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-brand-muted px-1">💡 Entradas vêm dos pagamentos efetivamente recebidos (concil. automática). Saídas somam repasses de professores pagos + comissões + indicações pagas. O saldo é o resultado real do mês.</p>
        </>
      )}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; accent?: string }> = ({ icon, label, value, accent }) => (
  <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
    <div className="flex items-center gap-2 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
    <p className={`text-lg font-black ${accent || 'text-brand-text'}`}>{value}</p>
  </div>
);
const Row: React.FC<{ k: string; v: string; danger?: boolean }> = ({ k, v, danger }) => (
  <div className="flex justify-between gap-2"><span className="text-brand-muted">{k}</span><span className={danger ? 'text-red-600 font-bold' : 'text-brand-text font-medium'}>{v}</span></div>
);

// ── Radar MEI: acumulado do ano vs teto (R$ 81k) com projeção e comparativo Simples ──
const MeiRadar: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
  const [r, setR] = useState<any>(null);
  useEffect(() => {
    if (!tenantId) return;
    supabase.rpc('get_mei_radar', { p_tenant: tenantId }).then(({ data }) => setR(data?.error ? null : data));
  }, [tenantId]);
  if (!r) return null;

  const money = (v: any) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const proj = Math.max(Number(r.projecao_media || 0), Number(r.projecao_ritmo_3m || 0));
  const pctProj = Number(r.pct_projecao_teto || 0);
  const pctAno = Math.min(100, Number(r.pct_teto || 0));
  const margem = Math.max(0, Number(r.teto) - Number(r.receita_acumulada));
  const nivel = pctProj >= 100 || Number(r.pct_teto) >= 90 ? 'red' : pctProj >= 75 ? 'amber' : 'emerald';
  const badgeCls = nivel === 'red'
    ? 'bg-red-500/10 text-red-600 border-red-500/30'
    : nivel === 'amber'
    ? 'bg-amber-500/10 text-amber-600 border-amber-500/30'
    : 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30';
  const barCls = nivel === 'red' ? 'bg-red-500' : nivel === 'amber' ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-4">
        <h3 className="text-sm font-bold text-brand-text flex items-center gap-2">
          <Gauge size={16} className="text-indigo-500" /> Radar MEI {r.ano}
        </h3>
        <span className={`text-[10px] font-black uppercase px-3 py-1 rounded-full border ${badgeCls}`}>
          Projeção do ano: {pctProj.toFixed(0)}% do teto
        </span>
      </div>

      {/* Barra: acumulado × teto */}
      <div className="mb-1 flex justify-between text-[11px] font-bold text-brand-muted">
        <span>{money(r.receita_acumulada)} acumulado</span>
        <span>teto {money(r.teto)}</span>
      </div>
      <div className="h-3 bg-brand-surface-2 rounded-full overflow-hidden">
        <div className={`h-full ${barCls} rounded-full transition-all`} style={{ width: `${pctAno}%` }} />
      </div>
      <p className="text-[10px] text-brand-muted mt-1">{Number(r.pct_teto).toFixed(1)}% do teto usado · margem restante {money(margem)}</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
        <div><p className="text-[10px] font-bold uppercase text-brand-muted">Média mensal</p><p className="text-sm font-black text-brand-text">{money(r.media_mensal)}</p></div>
        <div><p className="text-[10px] font-bold uppercase text-brand-muted">Ritmo (3 meses)</p><p className="text-sm font-black text-brand-text">{money(r.ritmo_3m)}</p></div>
        <div><p className="text-[10px] font-bold uppercase text-brand-muted">Projeção do ano</p><p className={`text-sm font-black ${nivel === 'emerald' ? 'text-brand-text' : nivel === 'amber' ? 'text-amber-600' : 'text-red-600'}`}>{money(proj)}</p></div>
        <div><p className="text-[10px] font-bold uppercase text-brand-muted">Como ME (Simples III ~6%)</p><p className="text-sm font-black text-brand-text">{money(r.simples_anexo3_estimado_ano)}/ano</p></div>
      </div>

      <p className="text-[10px] text-brand-muted mt-3 leading-relaxed">
        Até {money(r.teto_tolerancia)} (teto +20%): permanece MEI até 31/12, paga DAS complementar e vira ME em janeiro.
        Acima disso: desenquadramento <b>retroativo</b> com multa — planeje com o contador antes.
      </p>
    </div>
  );
};

export default CashflowPanel;
