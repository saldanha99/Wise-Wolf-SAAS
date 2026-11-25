import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Calendar, Download, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { localMonth } from '../../lib/dateUtils';
import { User, UserRole } from '../../types';
import { Alerts, FinanceAlert, FinanceSettings, FinanceSettingsButton, Kpi, StatusBadge, money, pct, toneOf } from './financeUi';

// Margem por aluno, por plano e por professor (RPC finance_unit_economics).
// margem = mensalidade − repasse ao professor − IA/Wolfie − taxa Asaas − imposto.
// O repasse vem da mesma view que paga o professor; o total de repasse + o das
// aulas sem aluno (experimental/treino) bate com o custo do DRE.

interface PlanoRow {
  plano: string; preco_lista: number | null; alunos: number; alunos_com_prejuizo: number; alunos_sem_aula: number;
  mensalidade_media: number; aulas_media: number; repasse_medio: number; ia_media: number; asaas_media: number;
  imposto_medio: number; margem_media: number; margem_total: number; margem_pct: number | null;
}
interface ProfRow {
  teacher_id: string; professor: string; alunos: number; aulas: number; receita: number; repasse: number;
  outros_custos: number; margem: number; margem_pct: number | null;
}
interface AlunoRow {
  student_id: string; aluno: string; plano: string; preco_lista: number | null; mensalidade: number; recebido: number;
  aulas: number; repasse: number; voz_minutos: number; ia: number; asaas: number; imposto: number; margem: number;
  margem_pct: number | null;
}
interface Totais {
  alunos: number; alunos_com_prejuizo: number; alunos_sem_aula: number; mensalidades: number; recebido: number;
  repasse: number; ia: number; asaas: number; imposto: number; margem: number; margem_pct: number | null;
  margem_sobre_recebido: number; repasse_fora_de_aluno: number; aulas_fora_de_aluno: number;
}
interface Report {
  month: string; projetado: boolean; config: FinanceSettings; total: Totais;
  planos: PlanoRow[]; professores: ProfRow[]; alunos: AlunoRow[]; alertas: FinanceAlert[];
}

type View = 'planos' | 'professores' | 'alunos';

const th = 'px-3 py-2 text-left text-[10px] font-black uppercase tracking-widest text-brand-muted';
const td = 'px-3 py-2 text-sm font-medium text-brand-text whitespace-nowrap';
const tdNum = `${td} text-right tabular-nums`;

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const UnitEconomicsPanel: React.FC<{ user: User }> = ({ user }) => {
  const [month, setMonth] = useState(localMonth());
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('planos');
  const [onlyLoss, setOnlyLoss] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data: d, error: e } = await supabase.rpc('finance_unit_economics', { p_month: month });
    if (e) setError(e.message || 'Não foi possível carregar a margem.');
    else setData(d as Report);
    setLoading(false);
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const alunos = useMemo(
    () => (data?.alunos || []).filter(a => !onlyLoss || a.margem < 0),
    [data, onlyLoss],
  );

  const exportCsv = () => {
    if (!data) return;
    const head = ['Aluno', 'Plano', 'Preço de lista', 'Mensalidade', 'Recebido no mês', 'Aulas', 'Repasse', 'Voz (min)', 'IA', 'Asaas', 'Imposto', 'Margem', 'Margem %'];
    const lines = data.alunos.map(a => [a.aluno, a.plano, a.preco_lista ?? '', a.mensalidade, a.recebido, a.aulas, a.repasse, a.voz_minutos, a.ia, a.asaas, a.imposto, a.margem, a.margem_pct ?? ''].map(csvCell).join(';'));
    const blob = new Blob(['﻿' + [head.map(csvCell).join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `margem-por-aluno-${data.month}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const t = data?.total;
  const canEdit = user.role === UserRole.SCHOOL_ADMIN || user.role === UserRole.SUPER_ADMIN;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col items-stretch justify-between gap-4 rounded-4xl border border-brand-border bg-brand-surface p-4 shadow-xs sm:flex-row sm:items-center sm:p-6">
        <div className="min-w-0">
          <h2 className="text-2xl font-black tracking-tight text-brand-text">Margem por plano</h2>
          <p className="text-sm font-medium text-brand-muted">Mensalidade − professor − IA − Asaas − imposto, por plano, professor e aluno.</p>
        </div>
        <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:items-center">
          <FinanceSettingsButton settings={data?.config} canEdit={canEdit} onSaved={load} />
          <button
            type="button"
            onClick={exportCsv}
            disabled={!data?.alunos?.length}
            className="flex w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-tenant-primary/10 px-3 py-2 text-xs font-bold text-tenant-primary disabled:opacity-40 sm:w-auto"
          >
            <Download size={14} /> CSV
          </button>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Calendar size={18} className="shrink-0 text-brand-muted" aria-hidden="true" />
            <input
              type="month"
              aria-label="Mês da margem"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              className="min-w-0 flex-1 rounded-xl border-none bg-brand-surface-2 px-4 py-2 text-sm font-bold text-brand-text outline-hidden focus:ring-2 focus:ring-tenant-primary sm:flex-none"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-red-700">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <p className="text-sm font-medium">{error}</p>
        </div>
      )}

      {loading && !data ? (
        <div className="flex justify-center p-12"><Loader2 className="animate-spin text-tenant-primary" /></div>
      ) : data && t ? (
        <>
          <Alerts alerts={data.alertas} />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-tour="unit-economics-kpis">
            <Kpi label="Mensalidades" value={money(t.mensalidades)} hint={`${t.alunos} alunos · recebido ${money(t.recebido)}`} />
            <Kpi label="Custos variáveis" value={money(t.repasse + t.ia + t.asaas + t.imposto)} tone="cost"
              hint={`Prof. ${money(t.repasse)} · IA ${money(t.ia)} · Asaas ${money(t.asaas)} · Imp. ${money(t.imposto)}`} />
            <Kpi label={data.projetado ? 'Margem (projeção)' : 'Margem'} value={money(t.margem)} tone={toneOf(t.margem)}
              hint={`${pct(t.margem_pct)} das mensalidades · sobre o recebido ${money(t.margem_sobre_recebido)}`} />
            <Kpi label="Alunos com prejuízo" value={String(t.alunos_com_prejuizo)} tone={t.alunos_com_prejuizo > 0 ? 'bad' : 'good'}
              hint={`${t.alunos_sem_aula} sem aula no mês · experimentais/treino ${money(t.repasse_fora_de_aluno)}`} />
          </div>

          <div className="flex gap-1 overflow-x-auto rounded-2xl bg-brand-surface-2 p-1" role="tablist">
            {([['planos', 'Por plano'], ['professores', 'Por professor'], ['alunos', 'Por aluno']] as [View, string][]).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={`flex-1 whitespace-nowrap rounded-xl px-3 py-2 text-xs font-black uppercase tracking-wider ${view === id ? 'bg-brand-surface text-brand-text shadow-xs' : 'text-brand-muted'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {view === 'planos' && (
            <section className="rounded-4xl border border-brand-border bg-brand-surface shadow-xs" data-tour="unit-economics-plans">
              {/* celular: cartões */}
              <ul className="divide-y divide-brand-border sm:hidden">
                {data.planos.map(p => (
                  <li key={p.plano} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-black text-brand-text">{p.plano}</p>
                        <p className="text-xs text-brand-muted">{p.alunos} alunos · {p.aulas_media} aulas/mês · lista {p.preco_lista ? money(p.preco_lista) : '—'}</p>
                      </div>
                      <StatusBadge margem={p.margem_media} />
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div><dt className="text-brand-muted">Mensalidade</dt><dd className="font-bold">{money(p.mensalidade_media)}</dd></div>
                      <div><dt className="text-brand-muted">Custos</dt><dd className="font-bold text-amber-600">{money(p.repasse_medio + p.ia_media + p.asaas_media + p.imposto_medio)}</dd></div>
                      <div><dt className="text-brand-muted">Margem</dt><dd className={`font-black ${p.margem_media < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(p.margem_media)}</dd></div>
                    </dl>
                    {p.alunos_com_prejuizo > 0 && <p className="mt-2 text-xs font-bold text-red-600">{p.alunos_com_prejuizo} aluno(s) com prejuízo</p>}
                  </li>
                ))}
              </ul>
              {/* desktop: tabela */}
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full">
                  <thead className="border-b border-brand-border">
                    <tr>
                      <th className={th}>Plano</th><th className={`${th} text-right`}>Alunos</th><th className={`${th} text-right`}>Lista</th>
                      <th className={`${th} text-right`}>Mensalidade média</th><th className={`${th} text-right`}>Aulas/mês</th>
                      <th className={`${th} text-right`}>Professor</th><th className={`${th} text-right`}>IA</th><th className={`${th} text-right`}>Asaas</th>
                      <th className={`${th} text-right`}>Imposto</th><th className={`${th} text-right`}>Margem/aluno</th><th className={`${th} text-right`}>%</th>
                      <th className={`${th} text-right`}>Total</th><th className={th}></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-border">
                    {data.planos.map(p => (
                      <tr key={p.plano}>
                        <td className={`${td} font-bold`}>{p.plano}</td>
                        <td className={tdNum}>{p.alunos}{p.alunos_sem_aula > 0 && <span className="text-brand-muted"> ({p.alunos_sem_aula} s/ aula)</span>}</td>
                        <td className={tdNum}>{p.preco_lista ? money(p.preco_lista) : '—'}</td>
                        <td className={tdNum}>{money(p.mensalidade_media)}</td>
                        <td className={tdNum}>{p.aulas_media}</td>
                        <td className={tdNum}>{money(p.repasse_medio)}</td>
                        <td className={tdNum}>{money(p.ia_media)}</td>
                        <td className={tdNum}>{money(p.asaas_media)}</td>
                        <td className={tdNum}>{money(p.imposto_medio)}</td>
                        <td className={`${tdNum} font-black ${p.margem_media < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(p.margem_media)}</td>
                        <td className={tdNum}>{pct(p.margem_pct)}</td>
                        <td className={tdNum}>{money(p.margem_total)}</td>
                        <td className={td}><StatusBadge margem={p.margem_media} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {view === 'professores' && (
            <section className="rounded-4xl border border-brand-border bg-brand-surface shadow-xs">
              <p className="px-4 pt-4 text-xs text-brand-muted sm:px-6">A mensalidade de cada aluno é dividida entre os professores pela proporção de aulas que cada um deu a ele no mês.</p>
              <ul className="divide-y divide-brand-border sm:hidden">
                {data.professores.map(p => (
                  <li key={p.teacher_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-black text-brand-text">{p.professor}</p>
                        <p className="text-xs text-brand-muted">{p.alunos} alunos · {p.aulas} aulas</p>
                      </div>
                      <StatusBadge margem={p.margem} />
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div><dt className="text-brand-muted">Receita</dt><dd className="font-bold">{money(p.receita)}</dd></div>
                      <div><dt className="text-brand-muted">Repasse</dt><dd className="font-bold text-amber-600">{money(p.repasse)}</dd></div>
                      <div><dt className="text-brand-muted">Margem</dt><dd className={`font-black ${p.margem < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(p.margem)} · {pct(p.margem_pct)}</dd></div>
                    </dl>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full">
                  <thead className="border-b border-brand-border">
                    <tr>
                      <th className={th}>Professor</th><th className={`${th} text-right`}>Alunos</th><th className={`${th} text-right`}>Aulas</th>
                      <th className={`${th} text-right`}>Receita rateada</th><th className={`${th} text-right`}>Repasse</th>
                      <th className={`${th} text-right`}>IA + Asaas + imposto</th><th className={`${th} text-right`}>Margem</th><th className={`${th} text-right`}>%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-border">
                    {data.professores.map(p => (
                      <tr key={p.teacher_id}>
                        <td className={`${td} font-bold`}>{p.professor}</td>
                        <td className={tdNum}>{p.alunos}</td>
                        <td className={tdNum}>{p.aulas}</td>
                        <td className={tdNum}>{money(p.receita)}</td>
                        <td className={tdNum}>{money(p.repasse)}</td>
                        <td className={tdNum}>{money(p.outros_custos)}</td>
                        <td className={`${tdNum} font-black ${p.margem < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(p.margem)}</td>
                        <td className={tdNum}>{pct(p.margem_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {view === 'alunos' && (
            <section className="rounded-4xl border border-brand-border bg-brand-surface shadow-xs">
              <label className="flex items-center gap-2 px-4 pt-4 text-xs font-bold text-brand-muted sm:px-6">
                <input type="checkbox" checked={onlyLoss} onChange={(e) => setOnlyLoss(e.target.checked)} /> Só alunos com prejuízo
              </label>
              <ul className="divide-y divide-brand-border sm:hidden">
                {alunos.map(a => (
                  <li key={a.student_id} className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-black text-brand-text">{a.aluno}</p>
                        <p className="text-xs text-brand-muted">{a.plano} · {a.aulas} aulas</p>
                      </div>
                      <StatusBadge margem={a.margem} />
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div><dt className="text-brand-muted">Mensalidade</dt><dd className="font-bold">{money(a.mensalidade)}</dd></div>
                      <div><dt className="text-brand-muted">Custos</dt><dd className="font-bold text-amber-600">{money(a.repasse + a.ia + a.asaas + a.imposto)}</dd></div>
                      <div><dt className="text-brand-muted">Margem</dt><dd className={`font-black ${a.margem < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(a.margem)}</dd></div>
                    </dl>
                  </li>
                ))}
              </ul>
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full">
                  <thead className="border-b border-brand-border">
                    <tr>
                      <th className={th}>Aluno</th><th className={th}>Plano</th><th className={`${th} text-right`}>Mensalidade</th>
                      <th className={`${th} text-right`}>Recebido</th><th className={`${th} text-right`}>Aulas</th><th className={`${th} text-right`}>Professor</th>
                      <th className={`${th} text-right`}>Voz (min)</th><th className={`${th} text-right`}>IA</th><th className={`${th} text-right`}>Asaas</th>
                      <th className={`${th} text-right`}>Imposto</th><th className={`${th} text-right`}>Margem</th><th className={`${th} text-right`}>%</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-brand-border">
                    {alunos.map(a => (
                      <tr key={a.student_id}>
                        <td className={`${td} font-bold`}>{a.aluno}</td>
                        <td className={td}>{a.plano}</td>
                        <td className={tdNum}>{money(a.mensalidade)}</td>
                        <td className={tdNum}>{money(a.recebido)}</td>
                        <td className={tdNum}>{a.aulas}</td>
                        <td className={tdNum}>{money(a.repasse)}</td>
                        <td className={tdNum}>{a.voz_minutos}</td>
                        <td className={tdNum}>{money(a.ia)}</td>
                        <td className={tdNum}>{money(a.asaas)}</td>
                        <td className={tdNum}>{money(a.imposto)}</td>
                        <td className={`${tdNum} font-black ${a.margem < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{money(a.margem)}</td>
                        <td className={tdNum}>{pct(a.margem_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {alunos.length === 0 && <p className="p-6 text-center text-sm text-brand-muted">Nenhum aluno neste filtro.</p>}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
};

export default UnitEconomicsPanel;
