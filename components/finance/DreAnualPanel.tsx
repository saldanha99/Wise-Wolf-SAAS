import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Calendar, Download, Loader2 } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { supabase } from '../../lib/supabase';
import { localMonth } from '../../lib/dateUtils';
import { Alerts, FinanceAlert, money, pct } from './financeUi';

// DRE mensal completo, 12 meses (RPC finance_dre_completo): o DRE gerencial de
// cada mês mais as linhas que ele não tinha — taxas do Asaas, imposto estimado
// (quando não lançado) e custo de IA/Wolfie.

interface MesDre {
  mes: string; receita_bruta: number; deducoes_lancadas: number; taxas_asaas: number; imposto_estimado: number;
  receita_liquida: number; custo_professores: number; custo_ia: number; lucro_bruto: number; margem_bruta_pct: number | null;
  despesas_operacionais: number; resultado: number; margem_liquida_pct: number | null; resultado_dre_gerencial: number;
  recebimentos_a_classificar: number; aulas: number; alunos_atendidos: number;
}
interface DreAnual { ate: string; meses: MesDre[]; total: Record<string, number>; alertas: FinanceAlert[] }

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const label = (m: string) => `${MESES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;

type LineKey = keyof MesDre;
const LINES: { key: LineKey; label: string; sign?: '-' | '='; strong?: boolean }[] = [
  { key: 'receita_bruta', label: 'Receita bruta (mensalidades)', strong: true },
  { key: 'deducoes_lancadas', label: 'Deduções lançadas', sign: '-' },
  { key: 'taxas_asaas', label: 'Taxas do Asaas', sign: '-' },
  { key: 'imposto_estimado', label: 'Imposto estimado', sign: '-' },
  { key: 'receita_liquida', label: 'Receita líquida', sign: '=', strong: true },
  { key: 'custo_professores', label: 'Professores (repasse + ajustes + custos diretos)', sign: '-' },
  { key: 'custo_ia', label: 'IA / Wolfie', sign: '-' },
  { key: 'lucro_bruto', label: 'Lucro bruto', sign: '=', strong: true },
  { key: 'despesas_operacionais', label: 'Despesas operacionais', sign: '-' },
  { key: 'resultado', label: 'Resultado', sign: '=', strong: true },
];

const DreAnualPanel: React.FC = () => {
  const [end, setEnd] = useState(localMonth());
  const [data, setData] = useState<DreAnual | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: d, error: e } = await supabase.rpc('finance_dre_completo', { p_end_month: end });
    if (e) setError(e.message || 'Não foi possível carregar o DRE.');
    else setData(d as DreAnual);
    setLoading(false);
  }, [end]);

  useEffect(() => { void load(); }, [load]);

  const exportCsv = () => {
    if (!data) return;
    const head = ['Linha', ...data.meses.map(m => m.mes)];
    const rows = LINES.map(l => [l.label, ...data.meses.map(m => String(m[l.key] ?? 0).replace('.', ','))]);
    const blob = new Blob(['﻿' + [head, ...rows].map(r => r.map(c => `"${c}"`).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `dre-12-meses-ate-${data.ate}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const chart = (data?.meses || []).map(m => ({ mes: label(m.mes), Receita: m.receita_bruta, Resultado: m.resultado }));

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col items-stretch justify-between gap-4 rounded-4xl border border-brand-border bg-brand-surface p-4 shadow-xs sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0">
          <h2 className="text-2xl font-black tracking-tight text-brand-text">DRE 12 meses</h2>
          <p className="text-sm font-medium text-brand-muted">Resultado mês a mês, já com taxas do Asaas, imposto e custo de IA.</p>
        </div>
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
          <button type="button" onClick={exportCsv} disabled={!data} className="flex items-center justify-center gap-1.5 rounded-xl bg-tenant-primary/10 px-3 py-2 text-xs font-bold text-tenant-primary disabled:opacity-40">
            <Download size={14} /> CSV
          </button>
          <div className="flex items-center gap-2">
            <Calendar size={18} className="shrink-0 text-brand-muted" aria-hidden="true" />
            <input type="month" aria-label="Último mês do DRE" value={end} onChange={(e) => e.target.value && setEnd(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border-none bg-brand-surface-2 px-4 py-2 text-sm font-bold text-brand-text sm:flex-none" />
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" /><p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center p-12"><Loader2 className="animate-spin text-tenant-primary" /></div>
      ) : data ? (
        <>
          <Alerts alerts={data.alertas} />
          <section className="rounded-4xl border border-brand-border bg-brand-surface p-4 shadow-xs sm:p-6" data-tour="dre-12-meses">
            <div className="h-56 sm:h-72">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chart} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="mes" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} width={56} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                  <Tooltip formatter={(v) => money(v)} />
                  <Bar dataKey="Receita" fill="#94A3B8" radius={[6, 6, 0, 0]} />
                  <Line dataKey="Resultado" stroke="#10B981" strokeWidth={2} dot />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="overflow-x-auto rounded-4xl border border-brand-border bg-brand-surface shadow-xs">
            <table className="w-full min-w-[960px] text-xs">
              <thead className="border-b border-brand-border text-[10px] font-black uppercase tracking-widest text-brand-muted">
                <tr>
                  <th className="sticky left-0 z-10 bg-brand-surface px-3 py-2 text-left">Linha</th>
                  {data.meses.map(m => <th key={m.mes} className="px-2 py-2 text-right">{label(m.mes)}</th>)}
                  <th className="px-3 py-2 text-right">12 meses</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-brand-border tabular-nums">
                {LINES.map(l => (
                  <tr key={l.key} className={l.strong ? 'bg-brand-surface-2/60 font-black' : ''}>
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-brand-surface px-3 py-2 text-left">{l.sign && <span className="mr-1 text-brand-muted">{l.sign === '-' ? '−' : '='}</span>}{l.label}</td>
                    {data.meses.map(m => {
                      const v = Number(m[l.key]) || 0;
                      return <td key={m.mes} className={`whitespace-nowrap px-2 py-2 text-right ${l.key === 'resultado' ? (v < 0 ? 'text-red-600' : 'text-emerald-600') : ''}`}>{money(v).replace('R$ ', '')}</td>;
                    })}
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {data.total[l.key] !== undefined ? money(data.total[l.key]).replace('R$ ', '') : money(data.meses.reduce((s, m) => s + (Number(m[l.key]) || 0), 0)).replace('R$ ', '')}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="sticky left-0 z-10 bg-brand-surface px-3 py-2 text-left text-brand-muted">Margem líquida</td>
                  {data.meses.map(m => <td key={m.mes} className="px-2 py-2 text-right text-brand-muted">{pct(m.margem_liquida_pct)}</td>)}
                  <td />
                </tr>
                <tr>
                  <td className="sticky left-0 z-10 bg-brand-surface px-3 py-2 text-left text-brand-muted">Aulas · alunos</td>
                  {data.meses.map(m => <td key={m.mes} className="whitespace-nowrap px-2 py-2 text-right text-brand-muted">{m.aulas} · {m.alunos_atendidos}</td>)}
                  <td />
                </tr>
              </tbody>
            </table>
          </section>
          <p className="text-[11px] text-brand-muted">Receita e custos por competência, como no Resultado (DRE). Imposto estimado só entra no mês sem imposto lançado no caixa (conta 4.1.01). Recebimentos ainda sem classificação ficam fora, como no DRE do mês.</p>
        </>
      ) : null}
    </div>
  );
};

export default DreAnualPanel;
