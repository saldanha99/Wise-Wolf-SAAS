import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Tags, Sparkles, RefreshCw, Check, AlertCircle } from 'lucide-react';

/**
 * Classificação das despesas do caixa no plano de contas.
 *
 * A IA sugere, o diretor aplica. Ela não grava: o mapa decide como o resultado
 * do mês é lido, e classificação errada gravada em silêncio é pior do que
 * sugestão recusada. Toda sugestão devolvida pela edge já vem validada contra o
 * plano — o que aparece aqui é sempre aplicável.
 */

interface Conta { code: string; label: string; kind: string; }

interface Pendente {
  category: string;
  lancamentos: number;
  total: number;
  exemplos: string[] | null;
}

interface Payload { contas: Conta[] | null; pendentes: Pendente[]; error?: string; }

interface Sugestao {
  category: string;
  account_code: string;
  account_label: string;
  confianca: string;
  motivo: string;
}

const money = (v: number) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CONFIANCA_CLS: Record<string, string> = {
  alta: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  media: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  baixa: 'bg-red-500/10 text-red-600 border-red-500/30',
};

interface Props { onChanged: () => void; }

const DreCategorizer: React.FC<Props> = ({ onChanged }) => {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [pensando, setPensando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [sugestoes, setSugestoes] = useState<Record<string, Sugestao>>({});
  const [erro, setErro] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: d } = await supabase.rpc('dre_uncategorized_expenses');
    setData(d && !d.error ? (d as Payload) : null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const sugerir = async () => {
    setPensando(true); setErro(null);
    const { data: r, error } = await supabase.functions.invoke('dre-categorize', { body: {} });
    setPensando(false);
    if (error || !r || r.error) {
      setErro('A IA não conseguiu classificar agora. Você pode escolher a conta na mão.');
      return;
    }
    const lista = (r.sugestoes || []) as Sugestao[];
    setSugestoes(Object.fromEntries(lista.map(s => [s.category, s])));
    if (lista.length === 0) {
      setErro('A IA não retornou sugestão para nenhuma categoria. Classifique na mão.');
    }
  };

  const aplicar = async (category: string, accountCode: string) => {
    const { data: r } = await supabase.rpc('set_dre_category_account', {
      p_category: category, p_account_code: accountCode,
    });
    if (r?.error) {
      setErro(
        r.error === 'conta_de_fonte_automatica'
          ? 'Essa conta é alimentada automaticamente (repasse, comissão, indicação) — classificar aqui contaria duas vezes.'
          : `Não foi possível aplicar (${r.error}).`,
      );
      return false;
    }
    return true;
  };

  const aplicarUma = async (p: Pendente) => {
    const s = sugestoes[p.category];
    if (!s) return;
    setAplicando(true); setErro(null);
    const ok = await aplicar(p.category, s.account_code);
    setAplicando(false);
    if (!ok) return;
    await load();
    onChanged();
  };

  const aplicarTodas = async () => {
    setAplicando(true); setErro(null);
    const lista: Sugestao[] = Object.keys(sugestoes).map(k => sugestoes[k]);
    for (const s of lista) {
      const ok = await aplicar(s.category, s.account_code);
      if (!ok) break;
    }
    setAplicando(false);
    setSugestoes({});
    await load();
    onChanged();
  };

  const escolherNaMao = async (p: Pendente, code: string) => {
    if (!code) return;
    setAplicando(true); setErro(null);
    const ok = await aplicar(p.category, code);
    setAplicando(false);
    if (!ok) return;
    await load();
    onChanged();
  };

  const pendentes = data?.pendentes || [];
  const contas = data?.contas || [];
  const totalSugerido = Object.keys(sugestoes).length;

  // Sem pendência a seção some: bloco vazio permanente vira ruído na tela.
  if (!loading && pendentes.length === 0) return null;

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <Tags size={16} className="text-amber-500" />
        <h3 className="text-sm font-bold text-brand-text">Despesas sem classificação</h3>
        {pendentes.length > 0 && (
          <span className="text-xs text-brand-muted">
            {pendentes.length} {pendentes.length === 1 ? 'categoria' : 'categorias'}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {totalSugerido > 0 && (
            <button
              onClick={() => void aplicarTodas()}
              disabled={aplicando}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              <Check size={14} /> Aplicar {totalSugerido}
            </button>
          )}
          <button
            onClick={() => void sugerir()}
            disabled={pensando || pendentes.length === 0}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            <Sparkles size={14} className={pensando ? 'animate-pulse' : ''} />
            {pensando ? 'Analisando…' : 'Sugerir com IA'}
          </button>
        </div>
      </div>
      <p className="text-[11px] text-brand-muted mb-4">
        Enquanto a categoria não tem conta, a despesa entra como <b>Outras despesas</b> — ela conta
        no resultado, mas não aparece na linha certa.
      </p>

      {erro && (
        <div className="mb-3 flex items-start gap-2 text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-xl px-3 py-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          <span>{erro}</span>
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-brand-muted"><RefreshCw size={18} className="animate-spin mx-auto" /></div>
      ) : (
        <div className="space-y-2">
          {pendentes.map(p => {
            const s = sugestoes[p.category];
            return (
              <div key={p.category} className="border border-brand-border rounded-xl px-3 py-2.5 bg-brand-surface-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-brand-text truncate">{p.category}</p>
                    <p className="text-[11px] text-brand-muted truncate">
                      {p.lancamentos} {p.lancamentos === 1 ? 'lançamento' : 'lançamentos'} · {money(p.total)}
                      {p.exemplos && p.exemplos.length > 0 ? ` · ex.: ${p.exemplos.slice(0, 2).join(', ')}` : ''}
                    </p>
                  </div>
                  <select
                    defaultValue=""
                    onChange={e => void escolherNaMao(p, e.target.value)}
                    disabled={aplicando}
                    className="text-xs bg-brand-surface text-brand-text rounded-lg px-2 py-1.5 border border-brand-border"
                  >
                    <option value="">Escolher conta…</option>
                    {contas.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
                  </select>
                </div>

                {s && (
                  <div className="flex items-center gap-2 flex-wrap mt-2 pt-2 border-t border-brand-border">
                    <Sparkles size={12} className="text-indigo-500 shrink-0" />
                    <span className="text-xs text-brand-text font-bold">{s.account_label}</span>
                    <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full border ${CONFIANCA_CLS[s.confianca] || CONFIANCA_CLS.baixa}`}>
                      {s.confianca}
                    </span>
                    {s.motivo && <span className="text-[11px] text-brand-muted truncate">{s.motivo}</span>}
                    <button
                      onClick={() => void aplicarUma(p)}
                      disabled={aplicando}
                      className="ml-auto flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg border border-emerald-500/30 text-emerald-600 hover:bg-emerald-500/10 disabled:opacity-50"
                    >
                      <Check size={12} /> Aplicar
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default DreCategorizer;
