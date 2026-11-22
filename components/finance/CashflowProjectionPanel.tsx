import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { Bar, CartesianGrid, Legend, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { supabase } from '../../lib/supabase';
import { Alerts, FinanceAlert, Kpi, money } from './financeUi';

// Fluxo de caixa projetado (RPC finance_cashflow_projection): mês corrente
// (realizado + o que falta) e os próximos meses pela carteira atual.

interface MesProj {
  mes: string; corrente: boolean; entradas: number; entradas_recebidas: number; cobrancas_geradas: number;
  cobrancas_geradas_qtd: number; assinaturas_previstas: number; assinaturas_previstas_qtd: number;
  saidas: number; saidas_realizadas: number; repasse_realizado: number; repasse: number; despesas_fixas: number; imposto: number;
  asaas: number; ia: number; saldo_mes: number; saldo_acumulado: number;
}
interface Projection {
  base: { de: string; ate: string };
  premissas: { repasse_medio_mes: number; despesas_fixas_media_mes: number; custos_fixos_extras: number; ia_media_mes: number; fechamentos_pendentes: number };
  inadimplencia: { total: number; count: number } | null;
  meses: MesProj[];
  alertas: FinanceAlert[];
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const label = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;

const CashflowProjectionPanel: React.FC = () => {
  const [months, setMonths] = useState(6);
  const [data, setData] = useState<Projection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: d, error: e } = await supabase.rpc('finance_cashflow_projection', { p_months: months });
    if (e) setError(e.message || 'Não foi possível carregar a projeção.');
    else setData(d as Projection);
    setLoading(false);
  }, [months]);

  useEffect(() => { void load(); }, [load]);

  const chart = (data?.meses || []).map(m => ({ mes: label(m.mes), Entradas: m.entradas, Saídas: m.saidas, Acumulado: m.saldo_acumulado }));
  const cur = data?.meses?.[0];
  const last = data?.meses?.[data.meses.length - 1];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col items-stretch justify-between gap-4 rounded-4xl border border-brand-border bg-brand-surface p-4 shadow-xs sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0">
          <h2 className="text-2xl font-black tracking-tight text-brand-text">Caixa projetado</h2>
          <p className="text-sm font-medium text-brand-muted">O que deve entrar e sair nos próximos meses, pela carteira de hoje.{data && <> Médias de {data.base.de} a {data.base.ate}.</>}</p>
        </div>
        <select
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
          aria-label="Meses da projeção"
          className="rounded-xl border-none bg-brand-surface-2 px-4 py-2 text-sm font-bold text-brand-text"
        >
          <option value={3}>3 meses</option>
          <option value={6}>6 meses</option>
          <option value={12}>12 meses</option>
        </select>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" /><p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center p-12"><Loader2 className="animate-spin text-tenant-primary" /></div>
      ) : data && cur && last ? (
        <>
          <Alerts alerts={data.alertas} />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-tour="cashflow-projection">
            <Kpi label="Este mês: entradas" value={money(cur.entradas)} hint={`Recebido ${money(cur.entradas_recebidas)} · a receber ${money(cur.cobrancas_geradas)}`} />
            <Kpi label="Este mês: saídas" value={money(cur.saidas)} tone="cost" hint={`Já saiu ${money(cur.saidas_realizadas)}`} />
            <Kpi label="Saldo do mês" value={money(cur.saldo_mes)} tone={cur.saldo_mes < 0 ? 'bad' : 'good'} />
            <Kpi label={`Acumulado até ${label(last.mes)}`} value={money(last.saldo_acumulado)} tone={last.saldo_acumulado < 0 ? 'bad' : 'good'}
              hint={data.inadimplencia ? `Fora: ${money(data.inadimplencia.total)} vencidos` : undefined} />
          </div>

          <section className="rounded-4xl border border-brand-border bg-brand-surface p-4 shadow-xs sm:p-6">
            <div className="h-64 sm:h-80">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                  <Tooltip formatter={(v) => money(v)} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="Entradas" fill="#10B981" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="Saídas" fill="#F59E0B" radius={[6, 6, 0, 0]} />
                  <Line dataKey="Acumulado" stroke="rgb(var(--tenant-primary-rgb))" strokeWidth={2} dot />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="overflow-x-auto rounded-4xl border border-brand-border bg-brand-surface shadow-xs">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b border-brand-border text-[10px] font-black uppercase tracking-widest text-brand-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Mês</th><th className="px-3 py-2 text-right">Cobranças</th><th className="px-3 py-2 text-right">Assinaturas</th>
                  <th className="px-3 py-2 text-right">Entradas</th><th className="px-3 py-2 text-right">Professores</th><th className="px-3 py-2 text-right">Despesas fixas</th>
                  <th className="px-3 py-2 text-right">Imposto + Asaas + IA</th><th className="px-3 py-2 text-right">Saídas</th><th className="px-3 py-2 text-right">Saldo</th><th className="px-3 py-2 text-right">Acumulado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border tabular-nums">
                {data.meses.map(m => (
                  <tr key={m.mes}>
                    <td className="px-3 py-2 font-bold">{label(m.mes)}{m.corrente && <span className="ml-1 text-[10px] font-black uppercase text-brand-muted">atual</span>}</td>
                    <td className="px-3 py-2 text-right">{money(m.cobrancas_geradas + m.entradas_recebidas)}</td>
                    <td className="px-3 py-2 text-right">{money(m.assinaturas_previstas)}</td>
                    <td className="px-3 py-2 text-right font-bold text-emerald-600">{money(m.entradas)}</td>
                    <td className="px-3 py-2 text-right">{money(m.repasse)}</td>
                    <td className="px-3 py-2 text-right">{money(m.despesas_fixas)}</td>
                    <td className="px-3 py-2 text-right">{money(m.imposto + m.asaas + m.ia)}</td>
                    <td className="px-3 py-2 text-right font-bold text-amber-600">{money(m.saidas)}</td>
                    <td className={`px-3 py-2 text-right font-black ${m.saldo_mes < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(m.saldo_mes)}</td>
                    <td className="px-3 py-2 text-right">{money(m.saldo_acumulado)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <p className="text-[11px] text-brand-muted">
            Professores: média de {money(data.premissas.repasse_medio_mes)}/mês, pagos no mês seguinte ao da aula. Despesas: média lançada de {money(data.premissas.despesas_fixas_media_mes)}/mês
            {data.premissas.custos_fixos_extras > 0 && <> + extras {money(data.premissas.custos_fixos_extras)}</>}. Assinaturas = mensalidade dos alunos ativos que ainda não têm cobrança gerada no mês (quem pagou o plano adiantado fica fora).
          </p>
        </>
      ) : null}
    </div>
  );
};

export default CashflowProjectionPanel;
