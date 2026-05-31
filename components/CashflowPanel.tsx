import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { TrendingUp, TrendingDown, Wallet, Clock, RefreshCw, ArrowDownCircle, ArrowUpCircle, AlertTriangle } from 'lucide-react';
import { User as UserType } from '../types';

interface Props { user: UserType; tenantId?: string; }

const CashflowPanel: React.FC<Props> = () => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(new Date().toISOString().slice(0, 7));

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
  const monthOpts = Array.from({ length: 6 }, (_, i) => { const d = new Date(); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7); });

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

export default CashflowPanel;
