import React, { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { localMonth, recentMonths } from '../lib/dateUtils';
import {
  Scale, RefreshCw, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight,
  CalendarX2, PiggyBank, Wallet, TrendingUp, Crown, Zap, Info,
} from 'lucide-react';
import { User as UserType } from '../types';

interface Props { user: UserType; tenantId?: string; }

interface Item {
  motivo: string;
  aluno: string;
  aulas: number;
  folha: number;
  caixinha: number;
  diferenca: number;
  avisos: number;
}

interface Teacher {
  teacher_id: string;
  teacher_name: string;
  previsto: number;
  previsto_aulas: number;
  folha: number;
  folha_aulas: number;
  status: string;
  caixinha: number | null;
  diferenca: number | null;
  pro_labore: boolean;
  sobras: { aulas: number; valor: number };
  ajustes: number;
  turbo: { ativo: boolean; alunos: number; detalhe: any };
  itens: Item[];
}

// Cada motivo é uma ação diferente do diretor — por isso o texto diz o que
// fazer, não só o que aconteceu.
const MOTIVOS: Record<string, { titulo: string; acao: string; cor: string }> = {
  AGENDA_DESATUALIZADA: {
    titulo: 'Agenda desatualizada',
    acao: 'O professor deu mais aula do que a grade registra. O aviso do grupo calcula pela agenda, então mandou custo a menor. Corrija a agenda do aluno.',
    cor: 'text-amber-600 bg-amber-50 dark:bg-amber-900/20',
  },
  PAGOU_SEM_AGENDA: {
    titulo: 'Pagou, mas está sem agenda',
    acao: 'O aluno pagou e o aviso saiu com custo zero, porque não há aula cadastrada na grade dele. Você não separou nada na caixinha e a folha veio inteira. Cadastre a agenda.',
    cor: 'text-rose-600 bg-rose-50 dark:bg-rose-900/20',
  },
  ALUNO_SEM_PAGAMENTO: {
    titulo: 'Aluno não pagou',
    acao: 'Teve aula no mês e nenhuma cobrança liquidada. A escola paga o professor do próprio bolso.',
    cor: 'text-red-600 bg-red-50 dark:bg-red-900/20',
  },
  PAGAMENTO_NAO_LIQUIDADO: {
    titulo: 'Pagamento não liquidado',
    acao: 'A Asaas reconheceu (CONFIRMED) mas o dinheiro ainda não caiu. Confira se liquidou.',
    cor: 'text-orange-600 bg-orange-50 dark:bg-orange-900/20',
  },
  PAGAMENTO_REPETIDO: {
    titulo: 'Custo avisado duas vezes',
    acao: 'O aluno teve mais de uma cobrança no mês (ex.: taxa de matrícula + mensalidade) e cada aviso trouxe o custo INTEIRO do mês. Some só uma vez na caixinha.',
    cor: 'text-violet-600 bg-violet-50 dark:bg-violet-900/20',
  },
  AULA_NAO_LANCADA: {
    titulo: 'Aula prevista e não lançada',
    acao: 'A grade previa a aula e ela não foi lançada. Ou o professor esqueceu, ou a agenda tem horário que não existe mais.',
    cor: 'text-sky-600 bg-sky-50 dark:bg-sky-900/20',
  },
  AULA_SEM_ALUNO: {
    titulo: 'Aula sem aluno vinculado',
    acao: 'Experimental, treinamento ou lançamento avulso — não existe pagamento a que se vincular.',
    cor: 'text-slate-600 bg-slate-100 dark:bg-slate-800',
  },
};

const money = (v: any) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const monthLabel = (m: string) => {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1)
    .toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};

const PayrollReconciliationPanel: React.FC<Props> = () => {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [month, setMonth] = useState<string>(localMonth());
  const [aberto, setAberto] = useState<Record<string, boolean>>({});

  const load = async (m: string) => {
    setLoading(true);
    setErro(null);
    const { data: d, error } = await supabase.rpc('teacher_payroll_reconciliation', { p_month: m });
    if (error) { setErro(error.message); setData(null); }
    else if (d?.error) { setErro(d.error === 'sem_permissao' ? 'Sem permissão para ver a folha.' : String(d.error)); setData(null); }
    else setData(d);
    setLoading(false);
  };
  useEffect(() => { load(month); }, [month]);

  const professores: Teacher[] = useMemo(() => data?.professores || [], [data]);
  const totais = data?.totais || {};
  const monthOpts = recentMonths(6);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="p-3 rounded-2xl bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600"><Scale size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Caixinha × Folha</h2>
          <p className="text-sm text-brand-muted">Por que o que você separou não bate com o que vai pagar</p>
        </div>
        <select
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="ml-auto text-sm font-bold bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
        >
          {monthOpts.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <button onClick={() => load(month)} className="p-2 rounded-xl border border-brand-border text-brand-muted hover:text-brand-text">
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* A regra de ouro — é o que evita desconfiar do fechamento sem motivo */}
      <div className="flex gap-3 p-4 rounded-2xl bg-brand-surface-2 border border-brand-border">
        <Info size={18} className="text-indigo-500 shrink-0 mt-0.5" />
        <div className="text-sm text-brand-muted leading-relaxed">
          <span className="font-bold text-brand-text">Para pagar, manda a folha.</span>{' '}
          A caixinha diz quanto desse custo já está coberto por dinheiro que entrou.
          A diferença é o que a escola está bancando no mês — não é erro do fechamento.
          <br />
          <span className="text-xs">
            Caixinha = agenda do aluno × dias do mês × tarifa, somada a cada pagamento avisado no grupo ·
            Folha = aula efetivamente lançada.
          </span>
        </div>
      </div>

      {erro && (
        <div className="p-4 rounded-2xl bg-red-50 dark:bg-red-900/20 text-red-600 text-sm font-semibold flex items-center gap-2">
          <AlertTriangle size={18} /> {erro}
        </div>
      )}

      {loading ? (
        <div className="py-16 text-center text-brand-muted"><RefreshCw size={24} className="animate-spin mx-auto" /></div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Kpi icon={<TrendingUp size={16} className="text-sky-500" />} label="Previsto pela agenda" value={money(totais.previsto)} hint="o que a grade diz que o mês custa" />
            <Kpi icon={<Wallet size={16} className="text-indigo-500" />} label="Folha (a pagar)" value={money(totais.folha)} accent="text-indigo-600" hint="aula lançada — é o que manda" />
            <Kpi icon={<PiggyBank size={16} className="text-emerald-500" />} label="Caixinha" value={money(totais.caixinha)} accent="text-emerald-600" hint="somado dos avisos do grupo" />
            <Kpi
              icon={<AlertTriangle size={16} className="text-amber-500" />}
              label="Descoberto"
              value={money(totais.diferenca)}
              accent={Number(totais.diferenca) > 0 ? 'text-amber-600' : 'text-emerald-600'}
              hint="folha − caixinha"
            />
          </div>

          {Number(totais.pro_labore_fora) > 0 && (
            <p className="text-xs text-brand-muted flex items-center gap-1.5">
              <Crown size={13} className="text-amber-500" />
              {totais.pro_labore_fora === 1 ? '1 professor da direção fica' : `${totais.pro_labore_fora} professores da direção ficam`} fora da caixinha:
              a régua deles é pró-labore, o aviso não traz custo descontado.
            </p>
          )}

          <div className="space-y-3">
            {professores.map(t => {
              const dif = Number(t.diferenca || 0);
              const bate = !t.pro_labore && Math.abs(dif) < 0.01;
              const open = !!aberto[t.teacher_id];
              return (
                <div key={t.teacher_id} className="rounded-2xl border border-brand-border bg-brand-surface overflow-hidden">
                  <button
                    onClick={() => setAberto(a => ({ ...a, [t.teacher_id]: !a[t.teacher_id] }))}
                    className="w-full flex items-center gap-3 p-4 text-left hover:bg-brand-surface-2 transition-colors"
                  >
                    {t.itens.length > 0
                      ? (open ? <ChevronDown size={18} className="text-brand-muted shrink-0" /> : <ChevronRight size={18} className="text-brand-muted shrink-0" />)
                      : <span className="w-[18px] shrink-0" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-brand-text truncate">{t.teacher_name}</span>
                        {t.pro_labore && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-600 flex items-center gap-1">
                            <Crown size={10} /> DIREÇÃO
                          </span>
                        )}
                        {t.turbo?.ativo && (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-violet-50 dark:bg-violet-900/20 text-violet-600 flex items-center gap-1">
                            <Zap size={10} /> TURBO
                          </span>
                        )}
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-brand-surface-2 text-brand-muted">{t.status}</span>
                      </div>
                      <div className="text-xs text-brand-muted mt-1 flex gap-3 flex-wrap">
                        <span>Previsto <b className="text-brand-text">{money(t.previsto)}</b> ({t.previsto_aulas})</span>
                        <span>Folha <b className="text-brand-text">{money(t.folha)}</b> ({t.folha_aulas})</span>
                        <span>Caixinha <b className="text-brand-text">{t.pro_labore ? '—' : money(t.caixinha)}</b></span>
                        {Number(t.sobras?.valor) > 0 && <span className="text-sky-600">+{money(t.sobras.valor)} de mês anterior</span>}
                        {Number(t.ajustes) !== 0 && <span className="text-violet-600">ajuste {money(t.ajustes)}</span>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      {t.pro_labore ? (
                        <span className="text-xs text-brand-muted">pró-labore</span>
                      ) : bate ? (
                        <span className="text-sm font-bold text-emerald-600 flex items-center gap-1"><CheckCircle2 size={15} /> bate</span>
                      ) : (
                        <>
                          <div className={`text-lg font-bold ${dif > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{money(Math.abs(dif))}</div>
                          <div className="text-[10px] text-brand-muted uppercase font-bold">{dif > 0 ? 'descoberto' : 'caixinha a mais'}</div>
                        </>
                      )}
                    </div>
                  </button>

                  {open && t.itens.length > 0 && (
                    <div className="border-t border-brand-border divide-y divide-brand-border">
                      {t.itens.map((it, i) => {
                        const m = MOTIVOS[it.motivo] || { titulo: it.motivo, acao: '', cor: 'text-brand-muted bg-brand-surface-2' };
                        return (
                          <div key={i} className="p-4 flex gap-3">
                            <span className={`text-[10px] font-bold px-2 py-1 rounded-lg h-fit whitespace-nowrap ${m.cor}`}>{m.titulo}</span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-2 flex-wrap">
                                <span className="font-semibold text-brand-text text-sm">{it.aluno}</span>
                                <span className="text-xs text-brand-muted">
                                  folha {money(it.folha)} · caixinha {money(it.caixinha)}
                                  {it.avisos > 1 && ` · ${it.avisos} avisos`}
                                </span>
                              </div>
                              <p className="text-xs text-brand-muted mt-1 leading-relaxed">{m.acao}</p>
                            </div>
                            <span className={`font-bold text-sm shrink-0 ${Number(it.diferenca) > 0 ? 'text-amber-600' : 'text-violet-600'}`}>
                              {Number(it.diferenca) > 0 ? '+' : ''}{money(it.diferenca)}
                            </span>
                          </div>
                        );
                      })}
                      {Number(t.sobras?.valor) > 0 && (
                        <div className="p-4 flex gap-3">
                          <span className="text-[10px] font-bold px-2 py-1 rounded-lg h-fit whitespace-nowrap text-sky-600 bg-sky-50 dark:bg-sky-900/20">Aula de mês anterior</span>
                          <div className="min-w-0 flex-1">
                            <span className="font-semibold text-brand-text text-sm">{t.sobras.aulas} aula(s) atrasada(s)</span>
                            <p className="text-xs text-brand-muted mt-1 leading-relaxed">
                              Lançadas depois do fechamento do mês de origem, então entram nesta folha.
                              O pagamento do aluno já foi rateado no mês em que a aula aconteceu.
                            </p>
                          </div>
                          <span className="font-bold text-sm shrink-0 text-sky-600">+{money(t.sobras.valor)}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {open && t.itens.length === 0 && !t.pro_labore && (
                    <div className="border-t border-brand-border p-4 text-sm text-brand-muted flex items-center gap-2">
                      <CheckCircle2 size={16} className="text-emerald-500" /> Caixinha e folha batem — nada a conciliar.
                    </div>
                  )}
                </div>
              );
            })}

            {professores.length === 0 && (
              <div className="py-16 text-center text-brand-muted">
                <CalendarX2 size={28} className="mx-auto mb-2 opacity-50" />
                Nenhum professor com movimento em {monthLabel(month)}.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; accent?: string; hint?: string }> =
  ({ icon, label, value, accent, hint }) => (
    <div className="p-4 rounded-2xl bg-brand-surface border border-brand-border">
      <div className="flex items-center gap-1.5 text-xs font-bold text-brand-muted uppercase tracking-wide">{icon}{label}</div>
      <div className={`text-xl font-bold mt-1 ${accent || 'text-brand-text'}`}>{value}</div>
      {hint && <div className="text-[10px] text-brand-muted mt-0.5">{hint}</div>}
    </div>
  );

export default PayrollReconciliationPanel;
