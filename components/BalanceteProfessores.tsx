import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { localMonth, recentMonths } from '../lib/dateUtils';
import {
  Scale, RefreshCw, ChevronDown, ChevronRight, Zap, GraduationCap,
  SlidersHorizontal, Coins, Info,
} from 'lucide-react';
import { User as UserType } from '../types';
import PagamentosSemAluno from './PagamentosSemAluno';

/**
 * Balancete por professor.
 *
 * Duas escolhas que mudam o número na tela:
 *
 * 1. A receita do aluno é RATEADA entre os professores dele, pelo número de
 *    aulas. Sem ratear, aluno com dois professores aparece com a mensalidade
 *    cheia nos dois e o lucro de ambos sai inflado.
 *
 * 2. A receita que não pertence a professor nenhum (pagamento sem aluno
 *    vinculado, ou aluno que pagou e não teve aula no mês) aparece numa linha
 *    própria. Escondê-la faria a soma dos professores não bater com o DRE, e a
 *    primeira reação seria achar que um dos dois relatórios está errado.
 */

type Detalhe = {
  student_id: string;
  student_name: string;
  aulas: number;
  aulas_turbo: number;
  custo: number;
  receita: number;
  lucro: number;
};

type Professor = {
  teacher_id: string;
  teacher_name: string;
  aulas: number;
  alunos: number;
  custo_base: number;
  comissao_turbo: number;
  bonus_treinamento: number;
  ajuste_valor_base: number;
  ajustes_fechamento: number;
  custo_total: number;
  aulas_turbo: number;
  aulas_treinamento: number;
  aulas_ajustadas: number;
  receita: number;
  /** Mensalidade dos alunos atendidos — o que o professor entregou. */
  receita_contratada: number;
  /** contratada − faturada. Positivo = não foi cobrado. Negativo = pagou adiantado/atrasado. */
  nao_faturado: number;
  lucro: number;
  /** Lucro isolando falha de cobrança. É por ele que se compara professor. */
  lucro_contratado: number;
  margem_pct: number | null;
  custo_por_aula: number | null;
  alunos_detalhe: Detalhe[];
};

type Totais = {
  aulas: number;
  custo_base: number;
  comissao_turbo: number;
  bonus_treinamento: number;
  ajuste_valor_base: number;
  ajustes_fechamento: number;
  custo_total: number;
  receita_alocada: number;
  receita_contratada: number;
  nao_faturado: number;
  lucro: number;
  lucro_contratado: number;
};

type Balancete = {
  month: string;
  base_rate: number;
  professores: Professor[];
  totais: Totais;
  receita_total: number;
  receita_sem_aluno: number;
  receita_aluno_sem_aula: number;
  alunos_multi_professor: number;
  error?: string;
};

const money = (v: number | null | undefined) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const pct = (v: number | null) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);

const monthShort = (m: string) => {
  const [y, mo] = m.split('-');
  return new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
};

type SemAulaPorProf = { professor: string; receita: number; alunos: number };
type SemAula = { total: number; por_professor: SemAulaPorProf[]; error?: string };

interface Props { user: UserType; tenantId?: string; }

const BalanceteProfessores: React.FC<Props> = () => {
  const [b, setB] = useState<Balancete | null>(null);
  const [semAula, setSemAula] = useState<SemAula | null>(null);
  const [loading, setLoading] = useState(true);
  const [month, setMonth] = useState<string>(localMonth());
  const [aberto, setAberto] = useState<Record<string, boolean>>({});

  const load = useCallback(async (m: string) => {
    setLoading(true);
    const [{ data }, { data: sa }] = await Promise.all([
      supabase.rpc('balancete_professores', { p_month: m }),
      supabase.rpc('balancete_receita_sem_aula', { p_month: m }),
    ]);
    setB(data && !data.error ? (data as Balancete) : null);
    setSemAula(sa && !sa.error ? (sa as SemAula) : null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(month); }, [month, load]);

  const t = b?.totais;
  const naoAlocada = Number(b?.receita_sem_aluno || 0) + Number(b?.receita_aluno_sem_aula || 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="p-3 rounded-2xl bg-sky-50 dark:bg-sky-900/20 text-sky-600"><Scale size={24} /></div>
        <div>
          <h2 className="text-xl font-bold text-brand-text">Balancete por Professor</h2>
          <p className="text-sm text-brand-muted">Custo aberto por natureza, receita rateada por aulas e lucro por cabeça</p>
        </div>
        <select
          value={month}
          onChange={e => setMonth(e.target.value)}
          className="ml-auto text-sm font-bold bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
        >
          {recentMonths(12).map(m => <option key={m} value={m}>{monthShort(m)}</option>)}
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
      ) : !b || !t ? (
        <div className="py-16 text-center">
          <p className="text-sm font-bold text-brand-text">Não foi possível carregar o balancete</p>
          <p className="text-xs text-brand-muted mt-1">Só a direção da escola tem acesso a esta tela.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Kpi label="Receita atribuída" value={money(t.receita_alocada)} hint={`de ${money(b.receita_total)} no mês`} />
            <Kpi label="Custo com professores" value={money(t.custo_total)} hint={`${t.aulas} aulas`} />
            {/* O número em destaque é o CONTRATADO: é ele que compara professores
                sem punir quem tem aluno que a escola esqueceu de cobrar. */}
            <Kpi
              label="Lucro real das aulas"
              value={money(t.lucro_contratado)}
              hint={`faturado: ${money(t.lucro)}`}
              accent={t.lucro_contratado >= 0 ? 'text-emerald-600' : 'text-red-600'}
            />
            <Kpi
              label="A cobrar"
              value={money(Math.max(0, t.nao_faturado))}
              hint={t.nao_faturado > 0 ? 'mensalidade não faturada' : 'tudo faturado'}
              accent={t.nao_faturado > 0 ? 'text-rose-600' : undefined}
            />
          </div>

          <div className="flex items-start gap-2 text-[11px] text-brand-muted bg-brand-surface border border-brand-border rounded-2xl px-4 py-3">
            <Info size={14} className="text-sky-500 shrink-0 mt-0.5" />
            <p className="leading-relaxed">
              <b>Lucro real</b> usa a mensalidade dos alunos atendidos — é por ele que se compara
              professor, porque não pune quem tem aluno que a escola esqueceu de cobrar.
              <b> Faturado</b> é o que efetivamente entrou e é o que fecha com o DRE.
              A coluna <b>A cobrar</b> é a diferença: dinheiro a recuperar, não desempenho ruim.
            </p>
          </div>

          {/* Categorização do custo */}
          <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
            <h3 className="text-sm font-bold text-brand-text mb-1">Composição do custo</h3>
            <p className="text-[11px] text-brand-muted mb-4">
              Valor base da escola: <b>{money(b.base_rate)}</b> por aula. Tudo acima disso aparece
              separado, com o motivo.
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <Bloco icon={<Coins size={14} className="text-slate-500" />} label="Aulas no valor base" valor={money(t.custo_base)} />
              <Bloco icon={<Zap size={14} className="text-amber-500" />} label="Comissão de turbo" valor={money(t.comissao_turbo)} destaque={t.comissao_turbo > 0} />
              <Bloco icon={<GraduationCap size={14} className="text-indigo-500" />} label="Bônus de treinamento" valor={money(t.bonus_treinamento)} destaque={t.bonus_treinamento > 0} />
              <Bloco icon={<SlidersHorizontal size={14} className="text-sky-500" />} label="Ajuste de valor base" valor={money(t.ajuste_valor_base)} destaque={t.ajuste_valor_base !== 0} />
              <Bloco icon={<SlidersHorizontal size={14} className="text-emerald-500" />} label="Ajustes do fechamento" valor={money(t.ajustes_fechamento)} destaque={t.ajustes_fechamento !== 0} />
            </div>
            {t.comissao_turbo === 0 && (
              <p className="text-[11px] text-brand-muted mt-3">
                Nenhuma comissão de turbo neste mês — a progressiva só liga com 10+ alunos na carteira,
                sem falta do professor no mês e no anterior, e sem conflito de lançamento.
              </p>
            )}
          </div>

          {/* Tabela por professor */}
          <div className="bg-brand-surface border border-brand-border rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[820px]">
                <thead>
                  <tr className="text-[10px] font-black uppercase text-brand-muted border-b border-brand-border">
                    <th className="text-left py-3 px-4">Professor</th>
                    <th className="text-right py-3 px-2">Aulas</th>
                    <th className="text-right py-3 px-2">Alunos</th>
                    <th className="text-right py-3 px-2">Base</th>
                    <th className="text-right py-3 px-2">Turbo</th>
                    <th className="text-right py-3 px-2">Treino</th>
                    <th className="text-right py-3 px-2">Ajustes</th>
                    <th className="text-right py-3 px-2">Custo</th>
                    <th className="text-right py-3 px-2">Faturado</th>
                    <th className="text-right py-3 px-2">A cobrar</th>
                    <th className="text-right py-3 px-2">Lucro real</th>
                    <th className="text-right py-3 px-4">Margem</th>
                  </tr>
                </thead>
                <tbody>
                  {b.professores.map(p => {
                    const ajustes = Number(p.ajuste_valor_base) + Number(p.ajustes_fechamento);
                    const open = !!aberto[p.teacher_id];
                    return (
                      <React.Fragment key={p.teacher_id}>
                        <tr
                          className="border-b border-brand-border hover:bg-brand-surface-2 cursor-pointer"
                          onClick={() => setAberto({ ...aberto, [p.teacher_id]: !open })}
                        >
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-1.5">
                              {open ? <ChevronDown size={14} className="text-brand-muted shrink-0" /> : <ChevronRight size={14} className="text-brand-muted shrink-0" />}
                              <span className="font-bold text-brand-text">{p.teacher_name}</span>
                            </div>
                          </td>
                          <td className="text-right px-2 text-brand-text">{p.aulas}</td>
                          <td className="text-right px-2 text-brand-muted">{p.alunos}</td>
                          <td className="text-right px-2 text-brand-muted">{money(p.custo_base)}</td>
                          <td className={`text-right px-2 ${p.comissao_turbo > 0 ? 'text-amber-600 font-bold' : 'text-brand-muted'}`}>
                            {p.comissao_turbo > 0 ? money(p.comissao_turbo) : '—'}
                          </td>
                          <td className={`text-right px-2 ${p.bonus_treinamento > 0 ? 'text-indigo-600 font-bold' : 'text-brand-muted'}`}>
                            {p.bonus_treinamento > 0 ? money(p.bonus_treinamento) : '—'}
                          </td>
                          <td className={`text-right px-2 ${ajustes !== 0 ? 'text-sky-600 font-bold' : 'text-brand-muted'}`}>
                            {ajustes !== 0 ? money(ajustes) : '—'}
                          </td>
                          <td className="text-right px-2 font-bold text-brand-text">{money(p.custo_total)}</td>
                          <td className="text-right px-2 text-brand-text">{money(p.receita)}</td>
                          <td className={`text-right px-2 ${p.nao_faturado > 0 ? 'text-rose-600 font-bold' : 'text-brand-muted'}`}
                              title={p.nao_faturado < 0 ? 'Recebeu mais que a mensalidade (atrasado de outro mês)' : 'Mensalidade não cobrada'}>
                            {p.nao_faturado > 0 ? money(p.nao_faturado) : '—'}
                          </td>
                          <td className={`text-right px-2 font-black ${p.lucro_contratado >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {money(p.lucro_contratado)}
                          </td>
                          <td className="text-right px-4 text-brand-muted">{pct(p.margem_pct)}</td>
                        </tr>
                        {open && (
                          <tr className="bg-brand-surface-2">
                            <td colSpan={12} className="px-4 py-3">
                              <p className="text-[10px] font-black uppercase text-brand-muted mb-2">
                                Alunos de {p.teacher_name} · {money(p.custo_por_aula)} de custo por aula
                              </p>
                              <div className="space-y-1">
                                {p.alunos_detalhe.map(d => (
                                  <div key={d.student_id} className="flex items-center gap-3 text-xs">
                                    <span className="text-brand-text truncate flex-1">{d.student_name}</span>
                                    <span className="text-brand-muted w-16 text-right">{d.aulas} aulas</span>
                                    <span className="text-brand-muted w-24 text-right">{money(d.custo)}</span>
                                    <span className="text-brand-text w-24 text-right">{money(d.receita)}</span>
                                    <span className={`w-24 text-right font-bold ${d.lucro >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                      {money(d.lucro)}
                                    </span>
                                  </div>
                                ))}
                                {p.alunos_detalhe.length === 0 && (
                                  <p className="text-xs text-brand-muted italic">Sem aula vinculada a aluno neste mês.</p>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {b.professores.length === 0 && (
                    <tr><td colSpan={12} className="py-8 text-center text-brand-muted text-sm">Nenhuma aula pagável neste mês.</td></tr>
                  )}
                </tbody>
                {b.professores.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-brand-border font-black text-brand-text">
                      <td className="py-3 px-4">Total</td>
                      <td className="text-right px-2">{t.aulas}</td>
                      <td className="text-right px-2">—</td>
                      <td className="text-right px-2">{money(t.custo_base)}</td>
                      <td className="text-right px-2">{money(t.comissao_turbo)}</td>
                      <td className="text-right px-2">{money(t.bonus_treinamento)}</td>
                      <td className="text-right px-2">{money(Number(t.ajuste_valor_base) + Number(t.ajustes_fechamento))}</td>
                      <td className="text-right px-2">{money(t.custo_total)}</td>
                      <td className="text-right px-2">{money(t.receita_alocada)}</td>
                      <td className={`text-right px-2 ${t.nao_faturado > 0 ? 'text-rose-600' : ''}`}>{t.nao_faturado > 0 ? money(t.nao_faturado) : '—'}</td>
                      <td className={`text-right px-2 ${t.lucro_contratado >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{money(t.lucro_contratado)}</td>
                      <td className="text-right px-4">—</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* Receita que não pertence a professor nenhum */}
          {naoAlocada > 0 && (
            <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Info size={16} className="text-sky-500" />
                <h3 className="text-sm font-bold text-brand-text">Receita não atribuída a professor</h3>
                <span className="text-xs text-brand-muted">{money(naoAlocada)}</span>
              </div>
              <div className="space-y-1.5 text-sm">
                {b.receita_sem_aluno > 0 && (
                  <div className="flex justify-between gap-2">
                    <span className="text-brand-muted">Pagamento sem aluno vinculado</span>
                    <span className="font-bold text-brand-text">{money(b.receita_sem_aluno)}</span>
                  </div>
                )}
                {b.receita_aluno_sem_aula > 0 && (
                  <>
                    <div className="flex justify-between gap-2">
                      <span className="text-brand-muted">Aluno pagou mas não teve aula no mês</span>
                      <span className="font-bold text-brand-text">{money(b.receita_aluno_sem_aula)}</span>
                    </div>
                    {/* Aqui existe professor — na agenda. Fica fora do lucro (receita sem
                        aula é receita sem custo), mas visível: quase sempre significa aula
                        entregue e não lançada. */}
                    {(semAula?.por_professor || []).map(x => (
                      <div key={x.professor} className="flex justify-between gap-2 pl-4">
                        <span className="text-brand-muted text-xs">
                          ↳ agenda de <b>{x.professor}</b> · {x.alunos} {x.alunos === 1 ? 'aluno' : 'alunos'}
                        </span>
                        <span className="text-brand-text text-xs">{money(x.receita)}</span>
                      </div>
                    ))}
                  </>
                )}
                <div className="border-t border-brand-border pt-1.5 mt-1.5 flex justify-between font-bold text-brand-text">
                  <span>Receita total do mês (igual à do DRE)</span><span>{money(b.receita_total)}</span>
                </div>
              </div>
              {b.receita_aluno_sem_aula > 0 && (
                <p className="text-[11px] text-brand-muted mt-3 leading-relaxed">
                  💡 Aluno que pagou e não teve <b>nenhuma aula lançada</b> quase sempre é aula entregue e
                  não registrada — vale conferir a agenda do professor acima. Esse valor fica <b>fora</b> do
                  lucro deles de propósito: receita sem aula é receita sem custo, e somá-la premiaria
                  justamente quem não lançou.
                </p>
              )}
            </div>
          )}

          <PagamentosSemAluno month={month} onChanged={() => void load(month)} />

          {b.alunos_multi_professor > 0 && (
            <p className="text-[11px] text-brand-muted px-1">
              💡 {b.alunos_multi_professor} {b.alunos_multi_professor === 1 ? 'aluno teve' : 'alunos tiveram'} mais de um
              professor neste mês. A mensalidade foi <b>dividida entre eles na proporção das aulas</b> — sem isso,
              a mesma receita apareceria cheia em cada professor e o lucro sairia inflado.
            </p>
          )}
        </>
      )}
    </div>
  );
};

const Kpi: React.FC<{ label: string; value: string; hint?: string; accent?: string }> = ({ label, value, hint, accent }) => (
  <div className="bg-brand-surface border border-brand-border rounded-2xl p-4">
    <p className="text-brand-muted text-[10px] font-bold uppercase mb-1">{label}</p>
    <p className={`text-lg font-black ${accent || 'text-brand-text'}`}>{value}</p>
    {hint && <p className="text-[10px] text-brand-muted mt-0.5">{hint}</p>}
  </div>
);

const Bloco: React.FC<{ icon: React.ReactNode; label: string; valor: string; destaque?: boolean }> = ({ icon, label, valor, destaque }) => (
  <div className={`rounded-xl p-3 border ${destaque ? 'border-brand-border bg-brand-surface-2' : 'border-brand-border'}`}>
    <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-brand-muted mb-1">{icon}{label}</div>
    <p className={`text-sm font-black ${destaque ? 'text-brand-text' : 'text-brand-muted'}`}>{valor}</p>
  </div>
);

export default BalanceteProfessores;
