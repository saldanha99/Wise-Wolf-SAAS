import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { PiggyBank, RefreshCw, Check, AlertCircle, TrendingUp, HandCoins } from 'lucide-react';
import PagamentosSemAluno from './PagamentosSemAluno';

/**
 * Dízimo e investimento a cada pagamento — configuração + relatório do mês.
 *
 * O destino NÃO é editável aqui de propósito: é o mesmo grupo do relatório
 * gerencial. Duas listas de grupo saem de sincronia e o aviso passa a ir para um
 * grupo que o diretor achou que tinha desligado.
 *
 * O relatório usa a MESMA RPC do envio (payment_split_breakdown, por dentro de
 * payment_split_report) e não manda nada — nenhum caminho de UI consegue
 * disparar mensagem no grupo.
 */

interface ProfessorCfg { id: string; nome: string; pro_labore: boolean }

interface Settings {
  configurado: boolean;
  is_active: boolean;
  dizimo_pct: number;
  investimento_pct: number;
  escola_pct: number;
  prof_dizimo_pct: number;
  prof_investimento_pct: number;
  prof_prolabore_pct: number;
  destino: string;
  destino_configurado: boolean;
  professores?: ProfessorCfg[];
  error?: string;
}

interface Professor {
  teacher_name?: string;
  aulas?: number;
  custo?: number | null;
  /** false = direção: não recebe por aula, fica com o resto do pagamento. */
  descontado?: boolean;
}

interface Linha {
  payment_id: string;
  aluno?: string;
  quando?: string;
  valor?: number;
  custo_professor?: number;
  professores?: Professor[];
  liquido?: number;
  dizimo?: number;
  investimento?: number;
  sobra?: number;
  sem_aluno?: boolean;
  na_base?: boolean;
}

interface Totais {
  pagamentos?: number;
  recebido?: number;
  custo_professor?: number;
  liquido?: number;
  dizimo?: number;
  investimento?: number;
  sobra?: number;
  fora_da_base?: number;
  fora_da_base_n?: number;
  pro_labore?: number;
}

interface Relatorio {
  month?: string;
  pagamentos?: Linha[];
  totais?: Totais;
  sem_aluno?: number;
  error?: string;
}

const brl = (v: unknown) => {
  const n = Number(v ?? 0);
  const [i, d] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}R$ ${i.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${d}`;
};

const diaCurto = (iso?: string) => {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}` : '—';
};

const mesAtual = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const PaymentSplitSettings: React.FC<{ month?: string }> = ({ month }) => {
  const [s, setS] = useState<Settings | null>(null);
  const [rel, setRel] = useState<Relatorio | null>(null);
  const [loading, setLoading] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [marcando, setMarcando] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'erro'; texto: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [cfg, rep] = await Promise.all([
      supabase.rpc('get_payment_split_settings'),
      supabase.rpc('payment_split_report', { p_month: month ?? null }),
    ]);
    setS(cfg.data && !cfg.data.error ? (cfg.data as Settings) : null);
    setRel(rep.data && !rep.data.error ? (rep.data as Relatorio) : null);
    setLoading(false);
  }, [month]);

  useEffect(() => { void load(); }, [load]);

  const salvar = async () => {
    if (!s) return;
    setSalvando(true); setAviso(null);
    const { data } = await supabase.rpc('save_payment_split_settings', {
      p_dizimo_pct: s.dizimo_pct,
      p_investimento_pct: s.investimento_pct,
      p_escola_pct: s.escola_pct,
      p_prof_dizimo_pct: s.prof_dizimo_pct,
      p_prof_investimento_pct: s.prof_investimento_pct,
      p_prof_prolabore_pct: s.prof_prolabore_pct,
      p_is_active: s.is_active,
    });
    setSalvando(false);
    if (data?.error) {
      const mapa: Record<string, string> = {
        percentual_invalido: 'Percentual inválido.',
        percentual_acima_de_100: 'Dízimo + investimento + escola não pode passar de 100% do líquido.',
        sem_grupo_configurado: 'Configure o grupo no "Relatório automático no WhatsApp" antes de ligar o aviso.',
        sem_permissao: 'Só a direção pode configurar o rateio.',
      };
      setAviso({ tipo: 'erro', texto: mapa[data.error] || `Não foi possível salvar (${data.error}).` });
      return;
    }
    setAviso({ tipo: 'ok', texto: 'Rateio salvo.' });
    await load();
  };

  /** Marcar/desmarcar recalcula a base do mês inteiro, então recarrega o relatório. */
  const alternarProLabore = async (p: ProfessorCfg) => {
    setMarcando(p.id); setAviso(null);
    const { data } = await supabase.rpc('set_payment_split_owner_teacher', {
      p_teacher: p.id,
      p_pro_labore: !p.pro_labore,
    });
    setMarcando(null);
    if (data?.error) {
      setAviso({ tipo: 'erro', texto: 'Não foi possível alterar este professor.' });
      return;
    }
    await load();
  };

  if (loading) {
    return (
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <div className="py-6 text-center text-brand-muted"><RefreshCw size={18} className="animate-spin mx-auto" /></div>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
        <p className="text-sm text-brand-muted">Só a direção pode ver o rateio dos pagamentos.</p>
      </div>
    );
  }

  const t = rel?.totais ?? {};
  const linhas = rel?.pagamentos ?? [];

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <PiggyBank size={16} className="text-emerald-500" />
        <h3 className="text-sm font-bold text-brand-text">Dízimo e investimento</h3>
        <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${
          s.is_active
            ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
            : 'bg-brand-surface-2 text-brand-muted border-brand-border'
        }`}>
          {s.is_active ? 'avisando no grupo' : 'aviso desligado'}
        </span>
      </div>
      <p className="text-[11px] text-brand-muted mb-4">
        Os percentuais incidem sobre o <strong>líquido</strong> (valor do pagamento menos o
        custo do professor daquele aluno), nunca sobre o valor cheio. Com o aviso ligado,
        cada pagamento confirmado na Asaas vira uma mensagem no grupo da direção.
      </p>

      {/* ── Totais do mês: o número que o diretor usa para separar de fato ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-4">
        <div className="rounded-xl border border-brand-border bg-brand-surface-2 p-3">
          <p className="text-[9px] font-black uppercase text-brand-muted">Recebido no mês</p>
          <p className="text-lg font-black text-brand-text">{brl(t.recebido)}</p>
          <p className="text-[10px] text-brand-muted">{t.pagamentos ?? 0} pagamentos</p>
        </div>
        <div className="rounded-xl border border-brand-border bg-brand-surface-2 p-3">
          <p className="text-[9px] font-black uppercase text-brand-muted">− Professores</p>
          <p className="text-lg font-black text-brand-text">{brl(t.custo_professor)}</p>
          <p className="text-[10px] text-brand-muted">base do rateio {brl(t.liquido)}</p>
        </div>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-[9px] font-black uppercase text-amber-700 dark:text-amber-400 flex items-center gap-1">
            <HandCoins size={11} /> Dízimo ({s.dizimo_pct}%)
          </p>
          <p className="text-lg font-black text-amber-700 dark:text-amber-400">{brl(t.dizimo)}</p>
        </div>
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
          <p className="text-[9px] font-black uppercase text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
            <TrendingUp size={11} /> Investimento ({s.investimento_pct}%)
          </p>
          <p className="text-lg font-black text-emerald-700 dark:text-emerald-400">{brl(t.investimento)}</p>
        </div>
      </div>

      {/* Pró-labore só aparece quando existe: escola sem direção dando aula não
          precisa de uma linha zerada ocupando espaço. */}
      {(t.pro_labore ?? 0) > 0 && (
        <div className="grid grid-cols-2 gap-2 mb-4">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-[9px] font-black uppercase text-brand-muted">👑 Pró-labore da direção</p>
            <p className="text-lg font-black text-brand-text">{brl(t.pro_labore)}</p>
            <p className="text-[10px] text-brand-muted">o que sobra dos alunos dela</p>
          </div>
          <div className="rounded-xl border border-brand-border bg-brand-surface-2 p-3">
            <p className="text-[9px] font-black uppercase text-brand-muted">Fica na escola</p>
            <p className="text-lg font-black text-brand-text">{brl(t.sobra)}</p>
          </div>
        </div>
      )}

      {(t.fora_da_base_n ?? 0) > 0 && (
        <div className="mb-3 flex items-start gap-2 text-xs rounded-xl px-3 py-2 border text-brand-muted bg-brand-surface-2 border-brand-border">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>
            <strong>{brl(t.fora_da_base)}</strong> em {t.fora_da_base_n} pagamento(s) entraram{' '}
            <strong>sem aluno vinculado</strong> e ficaram fora da base — não geraram dízimo nem
            investimento. É o tratamento de aporte da direção. Confirme abaixo quem pagou: ao
            vincular, o pagamento entra na base e o dízimo é recalculado.
          </span>
        </div>
      )}

      {/* Confirmar de quem é o pagamento.
          Reaproveita a tela que já existe no Balancete (mesma RPC, mesmo alerta de
          duplicata) em vez de uma segunda cópia da regra — e fica aqui porque é
          aqui que o dinheiro fora da base aparece. */}
      {(t.fora_da_base_n ?? 0) > 0 && (
        <div className="mb-4">
          <PagamentosSemAluno month={month ?? mesAtual()} onChanged={() => void load()} />
        </div>
      )}

      {/* ── Pagamento a pagamento ── */}
      {linhas.length > 0 ? (
        <div className="rounded-xl border border-brand-border overflow-hidden mb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-brand-surface-2 text-brand-muted">
                <tr>
                  <th className="text-left font-black uppercase text-[9px] px-3 py-2">Aluno</th>
                  <th className="text-left font-black uppercase text-[9px] px-3 py-2">Professor</th>
                  <th className="text-right font-black uppercase text-[9px] px-3 py-2">Pago</th>
                  <th className="text-right font-black uppercase text-[9px] px-3 py-2">Professor</th>
                  <th className="text-right font-black uppercase text-[9px] px-3 py-2">Dízimo</th>
                  <th className="text-right font-black uppercase text-[9px] px-3 py-2">Investim.</th>
                </tr>
              </thead>
              <tbody className="text-brand-text">
                {linhas.map(l => (
                  <tr
                    key={l.payment_id}
                    className={`border-t border-brand-border ${l.na_base === false ? 'opacity-60' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <span className="font-bold">{l.aluno}</span>
                      <span className="text-brand-muted"> · {diaCurto(l.quando)}</span>
                    </td>
                    <td className="px-3 py-2 text-brand-muted">
                      {l.na_base === false
                        ? <span className="italic">fora da base</span>
                        : (l.professores?.length
                            ? l.professores.map(p =>
                                `${p.descontado === false ? '👑 ' : ''}${p.teacher_name}`).join(', ')
                            : '—')}
                    </td>
                    <td className="px-3 py-2 text-right">{brl(l.valor)}</td>
                    <td className="px-3 py-2 text-right text-brand-muted">
                      {(l.custo_professor ?? 0) > 0 ? `− ${brl(l.custo_professor)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-amber-600">{brl(l.dizimo)}</td>
                    <td className="px-3 py-2 text-right text-emerald-600">{brl(l.investimento)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <p className="text-xs text-brand-muted mb-4">Nenhum pagamento recebido neste mês ainda.</p>
      )}

      <p className="text-[10px] text-brand-muted mb-4">
        O custo do professor é <strong>previsto</strong> pela agenda do mês (calendário) e pela
        tarifa vigente — é ele que faz um mês com 5 segundas custar mais que um com 4.
        O número real fecha com as aulas lançadas.
      </p>

      {aviso && (
        <div className={`mb-3 flex items-start gap-2 text-xs font-bold rounded-xl px-3 py-2 border ${
          aviso.tipo === 'ok'
            ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
            : 'text-amber-700 dark:text-amber-400 bg-amber-500/10 border-amber-500/30'
        }`}>
          {aviso.tipo === 'ok' ? <Check size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
          <span>{aviso.texto}</span>
        </div>
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-4 border-t border-brand-border">
        <div>
          <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Dízimo (%)</label>
          <input
            type="number" min={0} max={100} step={0.5}
            value={s.dizimo_pct}
            onChange={e => setS({ ...s, dizimo_pct: Number(e.target.value) })}
            className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
          />
        </div>
        <div>
          <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Investimento (%)</label>
          <input
            type="number" min={0} max={100} step={0.5}
            value={s.investimento_pct}
            onChange={e => setS({ ...s, investimento_pct: Number(e.target.value) })}
            className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
          />
        </div>
        <div>
          <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">
            Escola, no aluno da direção (%)
          </label>
          <input
            type="number" min={0} max={100} step={0.5}
            value={s.escola_pct}
            onChange={e => setS({ ...s, escola_pct: Number(e.target.value) })}
            className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
          />
          <span className="text-[10px] text-brand-muted">
            só incide no aluno de quem está marcado com 👑
          </span>
        </div>
        <div>
          <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Avisa no grupo</label>
          <div className="w-full text-sm bg-brand-surface-2 text-brand-muted rounded-xl px-3 py-2 border border-brand-border truncate">
            {s.destino_configurado ? s.destino : 'nenhum grupo configurado'}
          </div>
          <span className="text-[10px] text-brand-muted">
            Mesmo grupo do relatório automático — mude lá embaixo, não aqui.
          </span>
        </div>
      </div>

      {/* Régua do professor contratado: incide sobre o líquido DEPOIS de já
          descontado o salário dele. As três fatias somam 100 e o que sobrar
          fica na escola. */}
      <div className="mt-4 pt-4 border-t border-brand-border">
        <p className="text-[10px] font-black uppercase text-brand-muted mb-1">
          Quando a aula é de professor contratado
        </p>
        <p className="text-[11px] text-brand-muted mb-2">
          Incide sobre o que sobra <strong>depois</strong> do salário do professor. Os campos
          acima valem para o aluno de quem está marcado com 👑.
        </p>
        <div className="grid sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Dízimo (%)</label>
            <input
              type="number" min={0} max={100} step={0.5}
              value={s.prof_dizimo_pct}
              onChange={e => setS({ ...s, prof_dizimo_pct: Number(e.target.value) })}
              className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Investimento (%)</label>
            <input
              type="number" min={0} max={100} step={0.5}
              value={s.prof_investimento_pct}
              onChange={e => setS({ ...s, prof_investimento_pct: Number(e.target.value) })}
              className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
            />
          </div>
          <div>
            <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">Pró-labore (%)</label>
            <input
              type="number" min={0} max={100} step={0.5}
              value={s.prof_prolabore_pct}
              onChange={e => setS({ ...s, prof_prolabore_pct: Number(e.target.value) })}
              className="w-full text-sm bg-brand-surface-2 text-brand-text rounded-xl px-3 py-2 border border-brand-border"
            />
          </div>
        </div>
        <span className="text-[10px] text-brand-muted">
          Soma das três: {(s.prof_dizimo_pct ?? 0) + (s.prof_investimento_pct ?? 0) + (s.prof_prolabore_pct ?? 0)}% —
          o restante fica na escola.
        </span>
      </div>

      {/* Pró-labore: aula da direção não é custo, então não desconta da base. */}
      {(s.professores?.length ?? 0) > 0 && (
        <div className="mt-4 pt-4 border-t border-brand-border">
          <p className="text-[10px] font-black uppercase text-brand-muted mb-1">
            Professores que são pró-labore da direção
          </p>
          <p className="text-[11px] text-brand-muted mb-2">
            Quem for marcado não recebe por aula: o pró-labore dele é o que sobra do que os
            alunos dele pagam, depois do dízimo e do investimento. Por isso a aula dele não
            é descontada antes do rateio.
          </p>
          <div className="flex flex-wrap gap-2">
            {s.professores?.map(p => (
              <button
                key={p.id}
                onClick={() => void alternarProLabore(p)}
                disabled={marcando === p.id}
                className={`text-xs font-bold px-3 py-1.5 rounded-xl border transition-colors disabled:opacity-50 ${
                  p.pro_labore
                    ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40'
                    : 'bg-brand-surface-2 text-brand-muted border-brand-border hover:border-brand-muted'
                }`}
              >
                {p.pro_labore ? '👑 ' : ''}{p.nome}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3 mt-4 flex-wrap">
        <button
          onClick={() => void salvar()}
          disabled={salvando}
          className="text-xs font-bold px-4 py-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {salvando ? 'Salvando…' : 'Salvar rateio'}
        </button>
        <label className="flex items-center gap-2 text-xs text-brand-muted">
          <input
            type="checkbox"
            checked={s.is_active}
            onChange={e => setS({ ...s, is_active: e.target.checked })}
          />
          Avisar no grupo a cada pagamento
        </label>
      </div>
    </div>
  );
};

export default PaymentSplitSettings;
