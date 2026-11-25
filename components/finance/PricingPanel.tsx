import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Scale } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { User, UserRole } from '../../types';
import { simulatePrice } from '../../lib/financePricing';
import { Alerts, FinanceAlert, FinanceSettings, FinanceSettingsButton, Kpi, StatusBadge, money, pct } from './financeUi';

// Precificação por plano + ponto de equilíbrio (RPC finance_pricing_overview).
// Base: 3 meses fechados. A simulação de preço roda no navegador com a mesma
// fórmula do SQL (lib/financePricing.ts) e não grava nada — mudar o preço de
// verdade continua no catálogo de planos.

interface PlanoPreco {
  plan_id: string; plano: string; aulas_semana: number; fidelidade_meses: number; preco: number; aulas_mes: number;
  repasse: number; ia: number; asaas: number; imposto: number; margem: number; margem_pct: number | null;
  preco_minimo: number; alunos_no_plano: number;
}
interface Overview {
  base: { de: string; ate: string };
  config: FinanceSettings;
  custo_por_aula: number | null; aulas_base: number; aproveitamento: number | null; ia_por_aluno: number;
  asaas_por_cobranca: number; imposto_pct: number; das_rateado: number;
  meses: { mes: string; alunos_pagantes: number; mensalidades: number; margem_contribuicao: number }[];
  planos: PlanoPreco[];
  equilibrio: {
    despesas_lancadas_mes: number; custos_fixos_extras: number; das_fixo: number; custos_fixos_mes: number;
    alunos_pagantes: number; mensalidade_media: number | null; margem_contribuicao_media: number | null;
    alunos_para_empatar: number | null; receita_para_empatar: number | null; folga_alunos: number | null;
    resultado_estimado: number;
  };
  alertas: FinanceAlert[];
}

const fidelidade = (m: number) => (m >= 12 ? 'anual' : m >= 6 ? 'semestral' : 'mensal');

const PricingPanel: React.FC<{ user: User }> = ({ user }) => {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sim, setSim] = useState<Record<string, string>>({});
  const [extraStudents, setExtraStudents] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: d, error: e } = await supabase.rpc('finance_pricing_overview');
    if (e) setError(e.message || 'Não foi possível carregar a precificação.');
    else setData(d as Overview);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const cost = useCallback((p: PlanoPreco) => ({
    repasse: p.repasse, ia: p.ia, asaas: p.asaas,
    impostoPct: data?.imposto_pct || 0, dasRateado: data?.das_rateado || 0,
  }), [data]);

  const eq = data?.equilibrio;
  const simulatedFixed = useMemo(() => {
    if (!eq) return null;
    const contrib = Number(eq.margem_contribuicao_media) || 0;
    const alunos = Math.max(0, (Number(eq.alunos_pagantes) || 0) + (Number(extraStudents) || 0));
    return { alunos, resultado: Math.round((alunos * contrib - eq.custos_fixos_mes) * 100) / 100 };
  }, [eq, extraStudents]);

  const canEdit = user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col items-stretch justify-between gap-4 rounded-4xl border border-brand-border bg-brand-surface p-4 shadow-xs sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0">
          <h2 className="text-2xl font-black tracking-tight text-brand-text">Preços e equilíbrio</h2>
          <p className="text-sm font-medium text-brand-muted">
            Quanto cada plano deixa por aluno, o preço mínimo e quantos alunos pagam as contas.
            {data && <> Base: {data.base.de} a {data.base.ate}.</>}
          </p>
        </div>
        <FinanceSettingsButton settings={data?.config} canEdit={canEdit} onSaved={load} />
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center p-12"><Loader2 className="animate-spin text-tenant-primary" /></div>
      ) : data && eq ? (
        <>
          <Alerts alerts={data.alertas} />

          {/* Ponto de equilíbrio */}
          <section className="rounded-4xl border border-brand-border bg-brand-surface p-4 shadow-xs sm:p-6" data-tour="break-even">
            <div className="mb-4 flex items-center gap-2">
              <Scale size={18} className="text-tenant-primary" />
              <h3 className="text-sm font-black uppercase tracking-wider text-brand-text">Ponto de equilíbrio</h3>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Custos fixos/mês" value={money(eq.custos_fixos_mes)} tone="cost"
                hint={`Lançadas ${money(eq.despesas_lancadas_mes)} · extras ${money(eq.custos_fixos_extras)}${eq.das_fixo ? ` · DAS ${money(eq.das_fixo)}` : ''}`} />
              <Kpi label="Contribuição/aluno" value={money(eq.margem_contribuicao_media)}
                hint={`Mensalidade média ${money(eq.mensalidade_media)} − custos variáveis`} />
              <Kpi label="Alunos para empatar" value={eq.alunos_para_empatar == null ? '—' : String(eq.alunos_para_empatar)}
                hint={eq.receita_para_empatar == null ? 'Contribuição não é positiva' : `≈ ${money(eq.receita_para_empatar)} de mensalidades`} />
              <Kpi label="Pagantes hoje" value={String(eq.alunos_pagantes)}
                tone={(eq.folga_alunos ?? -1) >= 0 ? 'good' : 'bad'}
                hint={eq.folga_alunos == null ? '' : eq.folga_alunos >= 0 ? `${eq.folga_alunos} acima do equilíbrio` : `faltam ${-eq.folga_alunos}`} />
            </div>
            <div className="mt-4 flex flex-col gap-2 rounded-2xl bg-brand-surface-2 p-3 text-sm sm:flex-row sm:items-center sm:gap-4">
              <label className="flex flex-wrap items-center gap-2 font-bold text-brand-text">
                E se a escola tiver
                <input
                  type="number"
                  inputMode="numeric"
                  value={extraStudents}
                  placeholder="0"
                  onChange={(e) => setExtraStudents(e.target.value)}
                  className="w-20 rounded-lg border border-brand-border bg-brand-surface px-2 py-1 text-right font-bold"
                  aria-label="Alunos a mais ou a menos"
                />
                alunos a mais (ou −)?
              </label>
              {simulatedFixed && (
                <span className="text-brand-muted">
                  {simulatedFixed.alunos} pagantes → resultado estimado{' '}
                  <b className={simulatedFixed.resultado < 0 ? 'text-red-600' : 'text-emerald-600'}>{money(simulatedFixed.resultado)}</b>/mês
                </span>
              )}
            </div>
            <p className="mt-3 text-[11px] text-brand-muted">
              Contribuição = mensalidade contratada − professor − IA − Asaas{data.imposto_pct ? ' − imposto' : ''}. Inadimplência não está descontada.
              Fórmula: alunos para empatar = custos fixos ÷ contribuição média (arredondado para cima).
            </p>
          </section>

          {/* Planos */}
          <section className="rounded-4xl border border-brand-border bg-brand-surface shadow-xs" data-tour="pricing-plans">
            <div className="p-4 sm:p-6 sm:pb-2">
              <h3 className="text-sm font-black uppercase tracking-wider text-brand-text">Planos do catálogo</h3>
              <p className="text-xs text-brand-muted">
                Custo por aula {money(data.custo_por_aula)} ({data.aulas_base} aulas na base) · {pct(data.aproveitamento == null ? null : data.aproveitamento * 100)} das aulas previstas acontecem ·
                IA {money(data.ia_por_aluno)}/aluno · Asaas {money(data.asaas_por_cobranca)}/cobrança. Digite um preço para simular.
              </p>
            </div>
            <ul className="divide-y divide-brand-border">
              {data.planos.map(p => {
                const raw = sim[p.plan_id];
                const simPrice = raw === undefined || raw === '' ? null : Number(raw.replace(',', '.'));
                const s = simPrice == null ? null : simulatePrice(simPrice, cost(p));
                return (
                  <li key={p.plan_id} className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-[1.4fr_repeat(4,1fr)_1.3fr] sm:items-center sm:px-6">
                    <div className="col-span-2 sm:col-span-1">
                      <p className="font-black text-brand-text">{p.aulas_semana}x/semana · {fidelidade(p.fidelidade_meses)}</p>
                      <p className="text-xs text-brand-muted">{p.plano} · {p.alunos_no_plano} aluno(s) · {p.aulas_mes} aulas/mês</p>
                    </div>
                    <div><p className="text-[10px] font-black uppercase text-brand-muted">Preço</p><p className="font-bold">{money(p.preco)}</p></div>
                    <div><p className="text-[10px] font-black uppercase text-brand-muted">Custo</p><p className="font-bold text-amber-600">{money(p.repasse + p.ia + p.asaas + p.imposto)}</p></div>
                    <div>
                      <p className="text-[10px] font-black uppercase text-brand-muted">Margem</p>
                      <p className={`font-black ${p.margem < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(p.margem)} <span className="text-xs font-bold text-brand-muted">{pct(p.margem_pct)}</span></p>
                    </div>
                    <div><p className="text-[10px] font-black uppercase text-brand-muted">Preço mínimo</p><p className="font-bold">{money(p.preco_minimo)}</p></div>
                    <div className="col-span-2 rounded-xl bg-brand-surface-2 p-2 sm:col-span-1">
                      <label className="flex flex-wrap items-center gap-2 text-xs font-bold text-brand-muted">
                        Simular
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder={String(p.preco)}
                          value={raw ?? ''}
                          onChange={(e) => setSim({ ...sim, [p.plan_id]: e.target.value })}
                          className="w-24 rounded-lg border border-brand-border bg-brand-surface px-2 py-1 text-right text-sm font-bold text-brand-text"
                          aria-label={`Simular preço do plano ${p.plano}`}
                        />
                      </label>
                      {s ? (
                        <p className="mt-1 flex items-center gap-2 text-xs">
                          <StatusBadge margem={s.margem} />
                          <span className={`font-black ${s.margem < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(s.margem)}</span>
                          <span className="text-brand-muted">{pct(s.margemPct)}</span>
                        </p>
                      ) : (
                        <p className="mt-1 text-xs"><StatusBadge margem={p.margem} /></p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
};

export default PricingPanel;
