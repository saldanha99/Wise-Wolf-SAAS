import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { localMonth, recentMonths } from '../lib/dateUtils';
import {
  FileBarChart, RefreshCw, AlertTriangle, Info, AlertCircle,
  TrendingUp, TrendingDown, Scale, Wallet,
} from 'lucide-react';
import { User as UserType } from '../types';
import { Kpi3D, PageHero3D, Towers3D } from './depth/Depth3D';
import RecurringExpensesManager from './RecurringExpensesManager';
import DreCategorizer from './DreCategorizer';
import DreReportSettings from './DreReportSettings';
import PaymentSplitSettings from './PaymentSplitSettings';

/**
 * DRE gerencial — resultado do mês por COMPETÊNCIA.
 *
 * A diferença para o Fluxo de Caixa não é detalhe de contador, é a razão de a
 * tela existir: o caixa só reconhece o custo com professor quando o fechamento
 * é PAGO, então um mês inteiro de aula dada aparece com custo zero até alguém
 * pagar. Aqui o custo pertence ao mês em que a aula aconteceu. Os dois números
 * estão certos, medem coisas diferentes — e a tela diz isso na cara do diretor
 * em vez de deixar ele descobrir que "os relatórios não batem".
 */

type Kind = 'RECEITA' | 'DEDUCAO' | 'CUSTO' | 'DESPESA';
type Nivel = 'critico' | 'atencao' | 'info';

interface Linha { code: string; label: string; kind: Kind; valor: number; fonte: string; }
interface Alerta { nivel: Nivel; texto: string; }

interface Indicadores {
  aulas: number;
  alunos_atendidos: number;
  receita_por_aluno: number | null;
  custo_por_aula: number | null;
}

interface Dre {
  month: string;
  regime: string;
  receita_bruta: number;
  deducoes: number;
  receita_liquida: number;
  custo_servicos: number;
  lucro_bruto: number;
  margem_bruta_pct: number | null;
  despesas_operacionais: number;
  resultado: number;
  margem_liquida_pct: number | null;
  indicadores: Indicadores;
  linhas: Linha[];
  alertas: Alerta[];
  error?: string;
}

interface Caixa {
  saidas?: { professores?: number; total?: number };
  entradas?: number;
  error?: string;
}

const money = (v: number | null | undefined) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (m: string) => {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};

const monthShort = (m: string) => {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
};

const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);

interface Props { user: UserType; tenantId?: string; }

const DreGerencialPanel: React.FC<Props> = () => {
  const [dre, setDre] = useState<Dre | null>(null);
  const [caixa, setCaixa] = useState<Caixa | null>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(localMonth());

  const load = useCallback(async (m: string) => {
    setLoading(true);
    const [{ data: d }, { data: c }] = await Promise.all([
      supabase.rpc('dre_gerencial', { p_month: m }),
      supabase.rpc('get_cashflow', { p_month: m }),
    ]);
    setDre(d && !d.error ? (d as Dre) : null);
    setCaixa(c && !c.error ? (c as Caixa) : null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(month); }, [month, load]);

  // Tendência: resultado dos 6 meses que terminam no mês escolhido. Carrega à
  // parte — o demonstrativo do mês não espera por ela.
  const [trend, setTrend] = useState<{ month: string; resultado: number; receita: number }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const months = recentMonths(12).filter(m => m <= month).sort().slice(-6);
    setTrend(null);
    void Promise.all(months.map(m => supabase.rpc('dre_gerencial', { p_month: m })))
      .then(results => {
        if (cancelled) return;
        setTrend(results.map((r, i) => {
          const d = r.data as Dre | null;
          return { month: months[i], resultado: d && !d.error ? Number(d.resultado || 0) : 0, receita: d && !d.error ? Number(d.receita_liquida || 0) : 0 };
        }));
      })
      .catch(() => { if (!cancelled) setTrend([]); });
    return () => { cancelled = true; };
  }, [month]);

  const monthOpts = recentMonths(12);
  const linhas = dre?.linhas || [];
  const linhasDe = (k: Kind) => linhas.filter(l => l.kind === k && Number(l.valor) !== 0);

  const custoCaixa = Number(caixa?.saidas?.professores || 0);
  const custoCompetencia = Number(dre?.custo_servicos || 0);
  const divergeRegime = Math.abs(custoCaixa - custoCompetencia) >= 0.01;

  return (
    <div className="ww-stage space-y-6">
      <PageHero3D
        icon={<FileBarChart size={26} />}
        eyebrow="Relatórios"
        title="Resultado Gerencial (DRE)"
        subtitle="Por competência — o custo da aula pertence ao mês em que ela aconteceu"
        tone="violet"
        actions={
          <div className="flex items-center gap-2">
            <select
              value={month}
              onChange={e => setMonth(e.target.value)}
              aria-label="Mês do resultado"
              className="flex-1 sm:flex-none text-sm font-bold bg-brand-surface text-brand-text rounded-xl px-3 py-2.5 border border-brand-border shadow-sm"
            >
              {monthOpts.map(m => <option key={m} value={m}>{monthShort(m)}</option>)}
            </select>
            <button
              onClick={() => void load(month)}
              aria-label="Atualizar resultado"
              className="ww-lift p-2.5 rounded-xl border border-brand-border bg-brand-surface text-brand-muted hover:text-brand-text shadow-sm"
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        }
      />

      {loading ? (
        <div className="py-16 text-center text-brand-muted"><RefreshCw size={24} className="animate-spin mx-auto" /></div>
      ) : !dre ? (
        <div className="py-16 text-center">
          <p className="text-sm font-bold text-brand-text">Não foi possível carregar o resultado</p>
          <p className="text-xs text-brand-muted mt-1">Só a direção da escola tem acesso a esta tela.</p>
        </div>
      ) : (
        <>
          {/* Alertas primeiro: um DRE sem despesa lançada mente para cima. */}
          {dre.alertas.length > 0 && (
            <div className="space-y-2">
              {dre.alertas.map((a, i) => <AlertaBox key={i} alerta={a} />)}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <Kpi3D
              icon={<TrendingUp size={20} />}
              tone="emerald"
              label="Receita líquida"
              value={money(dre.receita_liquida)}
              hint={`${dre.indicadores.alunos_atendidos} alunos · ${money(dre.indicadores.receita_por_aluno)}/aluno`}
            />
            <Kpi3D
              icon={<TrendingDown size={20} />}
              tone="rose"
              label="Custo dos serviços"
              value={money(dre.custo_servicos)}
              hint={`${dre.indicadores.aulas} aulas · ${money(dre.indicadores.custo_por_aula)}/aula`}
            />
            <Kpi3D
              icon={<Scale size={20} />}
              tone="sky"
              label="Lucro bruto"
              value={money(dre.lucro_bruto)}
              hint={`margem ${pct(dre.margem_bruta_pct)}`}
              valueClassName={dre.lucro_bruto >= 0 ? '' : 'text-red-600'}
              ring={dre.margem_bruta_pct !== null && dre.margem_bruta_pct >= 0 ? dre.margem_bruta_pct : null}
            />
            <Kpi3D
              icon={<Wallet size={20} />}
              tone={dre.resultado >= 0 ? 'violet' : 'rose'}
              label="Resultado do mês"
              value={money(dre.resultado)}
              hint={`margem ${pct(dre.margem_liquida_pct)}`}
              valueClassName={dre.resultado >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600'}
            />
          </div>

          <div data-tour="dre-cascade" className="grid lg:grid-cols-2 gap-6">
            <div className="ww-slab p-5">
              <h3 className="text-sm font-black text-brand-text">Do faturamento ao resultado</h3>
              <p className="text-[11px] text-brand-muted">Quanto sobra de cada etapa em {monthLabel(month)}.</p>
              <Towers3D
                height={130}
                ariaLabel={`Cascata do resultado de ${monthLabel(month)}`}
                format={v => money(v).replace(',00', '')}
                data={[
                  { key: 'rec', label: 'Receita', sublabel: 'líquida', value: dre.receita_liquida, tone: 'emerald', caption: 'Receita líquida' },
                  { key: 'cus', label: 'Professores', sublabel: 'custo', value: dre.custo_servicos, tone: 'rose', caption: 'Custo dos serviços prestados' },
                  { key: 'bru', label: 'Lucro', sublabel: 'bruto', value: dre.lucro_bruto, tone: 'sky', caption: 'Lucro bruto' },
                  { key: 'des', label: 'Despesas', sublabel: 'operacionais', value: dre.despesas_operacionais, tone: 'amber', caption: 'Despesas operacionais' },
                  { key: 'res', label: 'Resultado', sublabel: dre.resultado >= 0 ? 'positivo' : 'negativo', value: dre.resultado, tone: dre.resultado >= 0 ? 'violet' : 'rose', highlight: true, caption: 'Resultado do mês' },
                ]}
              />
            </div>
            <div className="ww-slab p-5">
              <h3 className="text-sm font-black text-brand-text">Resultado nos últimos 6 meses</h3>
              <p className="text-[11px] text-brand-muted">Mesma conta do mês, mês a mês. Torre vermelha = mês no prejuízo.</p>
              {trend === null ? (
                <div className="h-[190px] grid place-items-center text-brand-muted"><RefreshCw size={18} className="animate-spin" /></div>
              ) : trend.length === 0 ? (
                <p className="py-16 text-center text-xs text-brand-muted">Não foi possível montar a tendência.</p>
              ) : (
                <Towers3D
                  height={130}
                  ariaLabel="Resultado dos últimos seis meses"
                  format={v => money(v).replace(',00', '')}
                  data={trend.map(t => ({
                    key: t.month,
                    label: monthShort(t.month),
                    sublabel: `receita ${money(t.receita).replace(',00', '')}`,
                    value: t.resultado,
                    tone: t.resultado >= 0 ? (t.month === month ? 'violet' : 'emerald') : 'rose',
                    highlight: t.month === month,
                    caption: `${monthLabel(t.month)}: resultado ${money(t.resultado)}`,
                  }))}
                />
              )}
            </div>
          </div>

          <div className="grid lg:grid-cols-5 gap-6">
            {/* Demonstrativo em cascata */}
            <div className="lg:col-span-3 ww-slab p-5">
              <h3 className="text-sm font-bold text-brand-text mb-1">Demonstrativo de {monthLabel(month)}</h3>
              <p className="text-[11px] text-brand-muted mb-4">Cada linha mostra de onde o número veio.</p>

              <div className="space-y-0.5">
                <Grupo titulo="Receita" />
                {linhasDe('RECEITA').map(l => <LinhaDre key={l.code} linha={l} />)}
                {linhasDe('DEDUCAO').map(l => <LinhaDre key={l.code} linha={l} negativa />)}
                <Subtotal label="= Receita líquida" valor={dre.receita_liquida} />

                <Grupo titulo="Custo dos serviços prestados" />
                {linhasDe('CUSTO').length === 0 && <Vazio texto="Nenhum custo direto no mês" />}
                {linhasDe('CUSTO').map(l => <LinhaDre key={l.code} linha={l} negativa />)}
                <Subtotal label="= Lucro bruto" valor={dre.lucro_bruto} />

                <Grupo titulo="Despesas operacionais" />
                {linhasDe('DESPESA').length === 0 && <Vazio texto="Nenhuma despesa operacional lançada" />}
                {linhasDe('DESPESA').map(l => <LinhaDre key={l.code} linha={l} negativa />)}

                <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t-2 border-brand-border">
                  <span className="text-sm font-black text-brand-text">= Resultado do mês</span>
                  <span className={`text-lg font-black ${dre.resultado >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {money(dre.resultado)}
                  </span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-2 space-y-4">
              {/* Indicadores da operação */}
              <div className="ww-slab p-5">
                <h3 className="text-sm font-bold text-brand-text mb-3">Indicadores da operação</h3>
                <div className="grid grid-cols-2 gap-3">
                  <Indicador label="Aulas no mês" valor={String(dre.indicadores.aulas)} />
                  <Indicador label="Alunos atendidos" valor={String(dre.indicadores.alunos_atendidos)} />
                  <Indicador label="Receita por aluno" valor={money(dre.indicadores.receita_por_aluno)} />
                  <Indicador label="Custo por aula" valor={money(dre.indicadores.custo_por_aula)} />
                </div>
              </div>

              {/* Reconciliação com o caixa */}
              {caixa && (
                <div className="ww-slab p-5">
                  <h3 className="text-sm font-bold text-brand-text mb-3">Por que difere do Fluxo de Caixa</h3>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-brand-muted">Custo com professor — competência</span>
                      <span className="font-bold text-brand-text">{money(custoCompetencia)}</span>
                    </div>
                    <div className="flex justify-between gap-2">
                      <span className="text-brand-muted">Custo com professor — caixa</span>
                      <span className="font-bold text-brand-text">{money(custoCaixa)}</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-brand-muted mt-3 leading-relaxed">
                    {divergeRegime ? (
                      <>
                        Os dois estão certos. Esta tela conta a aula <b>no mês em que ela aconteceu</b>;
                        o Fluxo de Caixa conta o repasse <b>no mês em que ele foi pago</b>. Enquanto o
                        fechamento não é pago, o caixa mostra menos custo do que a escola de fato teve.
                      </>
                    ) : (
                      <>Neste mês os dois regimes coincidem — o que foi entregue já foi pago.</>
                    )}
                  </p>
                </div>
              )}
            </div>
          </div>

          <DreCategorizer onChanged={() => void load(month)} />
          <RecurringExpensesManager month={month} onChanged={() => void load(month)} />
          <PaymentSplitSettings month={month} />
          <DreReportSettings />
        </>
      )}
    </div>
  );
};

const AlertaBox: React.FC<{ alerta: Alerta }> = ({ alerta }) => {
  const estilo: Record<Nivel, { cls: string; icon: React.ReactNode }> = {
    critico: {
      cls: 'bg-red-500/10 border-red-500/30 text-red-700 dark:text-red-400',
      icon: <AlertTriangle size={16} className="text-red-500 shrink-0 mt-0.5" />,
    },
    atencao: {
      cls: 'bg-amber-500/10 border-amber-500/30 text-amber-700 dark:text-amber-400',
      icon: <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />,
    },
    info: {
      cls: 'bg-sky-500/10 border-sky-500/30 text-sky-700 dark:text-sky-400',
      icon: <Info size={16} className="text-sky-500 shrink-0 mt-0.5" />,
    },
  };
  const e = estilo[alerta.nivel] || estilo.info;
  return (
    <div className={`flex items-start gap-2 border rounded-2xl px-4 py-3 ${e.cls}`}>
      {e.icon}
      <p className="text-xs font-medium leading-relaxed">{alerta.texto}</p>
    </div>
  );
};

const Grupo: React.FC<{ titulo: string }> = ({ titulo }) => (
  <p className="text-[10px] font-black uppercase text-brand-muted pt-4 pb-1">{titulo}</p>
);

const LinhaDre: React.FC<{ linha: Linha; negativa?: boolean }> = ({ linha, negativa }) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <div className="min-w-0">
      <span className="text-sm text-brand-text">{linha.label}</span>
      <span className="block text-[10px] text-brand-muted truncate">{linha.fonte}</span>
    </div>
    <span className={`text-sm font-bold whitespace-nowrap ${negativa ? 'text-red-600' : 'text-brand-text'}`}>
      {negativa ? '−' : ''}{money(linha.valor)}
    </span>
  </div>
);

const Subtotal: React.FC<{ label: string; valor: number }> = ({ label, valor }) => (
  <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-brand-border">
    <span className="text-sm font-bold text-brand-text">{label}</span>
    <span className="text-sm font-black text-brand-text">{money(valor)}</span>
  </div>
);

const Vazio: React.FC<{ texto: string }> = ({ texto }) => (
  <p className="text-xs text-brand-muted italic py-1">{texto}</p>
);

const Indicador: React.FC<{ label: string; valor: string }> = ({ label, valor }) => (
  <div>
    <p className="text-[10px] font-bold uppercase text-brand-muted">{label}</p>
    <p className="text-sm font-black text-brand-text">{valor}</p>
  </div>
);

export default DreGerencialPanel;
