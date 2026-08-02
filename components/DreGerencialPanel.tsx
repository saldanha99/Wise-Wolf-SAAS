import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { localMonth, recentMonths } from '../lib/dateUtils';
import {
  FileBarChart, RefreshCw, AlertTriangle, Info, AlertCircle,
  TrendingUp, TrendingDown, Scale, Wallet,
} from 'lucide-react';
import { User as UserType } from '../types';
import RecurringExpensesManager from './RecurringExpensesManager';
import DreCategorizer from './DreCategorizer';
import DreReportSettings from './DreReportSettings';

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

  const monthOpts = recentMonths(12);
  const linhas = dre?.linhas || [];
  const linhasDe = (k: Kind) => linhas.filter(l => l.kind === k && Number(l.valor) !== 0);

  const custoCaixa = Number(caixa?.saidas?.professores || 0);
  const custoCompetencia = Number(dre?.custo_servicos || 0);
  const divergeRegime = Math.abs(custoCaixa - custoCompetencia) >= 0.01;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600"><FileBarChart size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Resultado Gerencial (DRE)</h2>
          <p className="text-sm text-brand-muted">Por competência — o custo da aula pertence ao mês em que ela aconteceu</p>
        </div>
        <select
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="ml-auto text-sm font-bold bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
        >
          {monthOpts.map(m => <option key={m} value={m}>{monthShort(m)}</option>)}
        </select>
        <button
          onClick={() => void load(month)}
          className="p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

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

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi
              icon={<TrendingUp size={16} className="text-emerald-500" />}
              label="Receita líquida"
              value={money(dre.receita_liquida)}
            />
            <Kpi
              icon={<TrendingDown size={16} className="text-red-500" />}
              label="Custo dos serviços"
              value={money(dre.custo_servicos)}
              hint={`${dre.indicadores.aulas} aulas · ${money(dre.indicadores.custo_por_aula)}/aula`}
            />
            <Kpi
              icon={<Scale size={16} className="text-sky-500" />}
              label="Lucro bruto"
              value={money(dre.lucro_bruto)}
              hint={`margem ${pct(dre.margem_bruta_pct)}`}
              accent={dre.lucro_bruto >= 0 ? 'text-brand-text' : 'text-red-600'}
            />
            <Kpi
              icon={<Wallet size={16} className="text-indigo-500" />}
              label="Resultado do mês"
              value={money(dre.resultado)}
              hint={`margem ${pct(dre.margem_liquida_pct)}`}
              accent={dre.resultado >= 0 ? 'text-emerald-600' : 'text-red-600'}
            />
          </div>

          <div className="grid lg:grid-cols-5 gap-6">
            {/* Demonstrativo em cascata */}
            <div className="lg:col-span-3 bg-brand-surface border border-brand-border rounded-2xl p-5">
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
              <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
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
                <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
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

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; hint?: string; accent?: string }> =
  ({ icon, label, value, hint, accent }) => (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
      <div className="flex items-center gap-2 text-brand-muted text-[10px] font-bold uppercase mb-1">{icon}{label}</div>
      <p className={`text-lg font-black ${accent || 'text-brand-text'}`}>{value}</p>
      {hint && <p className="text-[10px] text-brand-muted mt-0.5">{hint}</p>}
    </div>
  );

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
