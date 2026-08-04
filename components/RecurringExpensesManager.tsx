import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Repeat, Plus, Pencil, Trash2, RefreshCw, CheckCircle2, PlayCircle, X } from 'lucide-react';

/**
 * Cadastro de despesas fixas mensais.
 *
 * O molde não é saldo: quem entra no resultado é o lançamento materializado no
 * caixa por `run_recurring_expenses`. Por isso a lista mostra "lançada no mês" —
 * cadastrar não basta, é preciso gerar. Depois de gerada, editar o valor daquele
 * mês é trabalho do Lançamentos do Caixa, não daqui.
 */

interface Conta { code: string; label: string; kind: string; }

interface Despesa {
  id: string;
  label: string;
  amount: number;
  account_code: string;
  account_label: string;
  day_of_month: number;
  start_month: string;
  end_month: string | null;
  is_active: boolean;
  notes: string | null;
  vigente: boolean;
  lancada_no_mes: boolean;
}

interface Payload {
  month: string;
  contas: Conta[] | null;
  despesas: Despesa[];
  total_mensal: number;
  error?: string;
}

interface FormState {
  id: string | null;
  label: string;
  amount: string;
  account_code: string;
  day_of_month: number;
  start_month: string;
  end_month: string;
  is_active: boolean;
}

const vazio = (mes: string): FormState => ({
  id: null, label: '', amount: '', account_code: '6.2.01',
  day_of_month: 5, start_month: mes, end_month: '', is_active: true,
});

const money = (v: number) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface Props { month: string; onChanged: () => void; }

const RecurringExpensesManager: React.FC<Props> = ({ month, onChanged }) => {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: d } = await supabase.rpc('list_recurring_expenses');
    setData(d && !d.error ? (d as Payload) : null);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const salvar = async () => {
    if (!form) return;
    setSaving(true); setErro(null);
    const { data: r } = await supabase.rpc('upsert_recurring_expense', {
      p_id: form.id,
      p_label: form.label,
      p_amount: Number(form.amount.replace(',', '.')),
      p_account_code: form.account_code,
      p_day_of_month: form.day_of_month,
      p_start_month: form.start_month,
      p_end_month: form.end_month || null,
      p_notes: null,
      p_is_active: form.is_active,
    });
    setSaving(false);
    if (r?.error) { setErro(mensagemErro(r.error)); return; }
    setForm(null);
    await load();
    onChanged();
  };

  const remover = async (d: Despesa) => {
    if (!window.confirm(`Excluir "${d.label}"?\n\nOs lançamentos já gerados nos meses anteriores permanecem no caixa — só o molde deixa de existir.`)) return;
    const { data: r } = await supabase.rpc('delete_recurring_expense', { p_id: d.id });
    if (r?.error) { setErro(mensagemErro(r.error)); return; }
    await load();
    onChanged();
  };

  const lancarNoMes = async () => {
    setSaving(true); setErro(null);
    const { data: r } = await supabase.rpc('run_recurring_expenses', { p_month: month });
    setSaving(false);
    if (r?.error) { setErro(mensagemErro(r.error)); return; }
    await load();
    onChanged();
  };

  const pendentes = (data?.despesas || []).filter(d => d.vigente && !d.lancada_no_mes).length;

  return (
    <div className="bg-brand-surface border border-brand-border rounded-2xl p-5">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <Repeat size={16} className="text-indigo-500" />
        <h3 className="text-sm font-bold text-brand-text">Despesas fixas mensais</h3>
        {data && (
          <span className="text-xs text-brand-muted">
            {data.despesas.filter(d => d.vigente).length} vigentes · {money(data.total_mensal)}/mês
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {pendentes > 0 && (
            <button
              onClick={() => void lancarNoMes()}
              disabled={saving}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              <PlayCircle size={14} /> Lançar {pendentes} no mês
            </button>
          )}
          <button
            onClick={() => { setForm(vazio(month)); setErro(null); }}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl border border-brand-border text-brand-text hover:bg-brand-surface-2"
          >
            <Plus size={14} /> Nova
          </button>
        </div>
      </div>

      {erro && (
        <div className="mb-3 text-xs font-bold text-red-600 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
          {erro}
        </div>
      )}

      {form && (
        <div className="mb-4 border border-brand-border rounded-2xl p-4 bg-brand-surface-2">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-black uppercase text-brand-muted">
              {form.id ? 'Editar despesa' : 'Nova despesa fixa'}
            </p>
            <button onClick={() => setForm(null)} className="text-brand-muted hover:text-brand-text"><X size={16} /></button>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <Campo label="Descrição">
              <input
                value={form.label}
                onChange={e => setForm({ ...form, label: e.target.value })}
                placeholder="Internet fibra"
                className="w-full text-sm bg-brand-surface text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              />
            </Campo>
            <Campo label="Valor mensal (R$)">
              <input
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                inputMode="decimal"
                placeholder="450,00"
                className="w-full text-sm bg-brand-surface text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              />
            </Campo>
            <Campo label="Conta do plano">
              <select
                value={form.account_code}
                onChange={e => setForm({ ...form, account_code: e.target.value })}
                className="w-full text-sm bg-brand-surface text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              >
                {(data?.contas || []).map(c => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </Campo>
            <Campo label="Dia do vencimento">
              <input
                type="number" min={1} max={28}
                value={form.day_of_month}
                onChange={e => setForm({ ...form, day_of_month: Number(e.target.value) })}
                className="w-full text-sm bg-brand-surface text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              />
              <span className="text-[10px] text-brand-muted">até 28 (dia 29–31 não existe em todo mês)</span>
            </Campo>
            <Campo label="Vigente a partir de">
              <input
                type="month"
                value={form.start_month}
                onChange={e => setForm({ ...form, start_month: e.target.value })}
                className="w-full text-sm bg-brand-surface text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              />
            </Campo>
            <Campo label="Até (opcional)">
              <input
                type="month"
                value={form.end_month}
                onChange={e => setForm({ ...form, end_month: e.target.value })}
                className="w-full text-sm bg-brand-surface text-brand-text rounded-xl px-3 py-2 border border-brand-border"
              />
              <span className="text-[10px] text-brand-muted">em branco = por prazo indeterminado</span>
            </Campo>
          </div>
          <div className="flex items-center gap-3 mt-4">
            <button
              onClick={() => void salvar()}
              disabled={saving || !form.label.trim() || !form.amount.trim()}
              className="text-xs font-bold px-4 py-2 rounded-xl bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
            >
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <label className="flex items-center gap-2 text-xs text-brand-muted">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={e => setForm({ ...form, is_active: e.target.checked })}
              />
              Ativa
            </label>
          </div>
        </div>
      )}

      {loading ? (
        <div className="py-8 text-center text-brand-muted"><RefreshCw size={18} className="animate-spin mx-auto" /></div>
      ) : !data ? (
        <p className="text-sm text-brand-muted py-4">Não foi possível carregar as despesas fixas.</p>
      ) : data.despesas.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-sm font-bold text-brand-text">Nenhuma despesa fixa cadastrada</p>
          <p className="text-xs text-brand-muted mt-1 max-w-md mx-auto">
            Internet, assinaturas, contabilidade, aluguel. Sem elas o resultado conta só o custo
            com professor — e a margem aparece maior do que é.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {data.despesas.map(d => (
            <div
              key={d.id}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${
                d.vigente ? 'border-brand-border bg-brand-surface-2' : 'border-brand-border opacity-50'
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-brand-text truncate">{d.label}</span>
                  {d.lancada_no_mes && (
                    <span className="flex items-center gap-1 text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 border border-emerald-500/30">
                      <CheckCircle2 size={9} /> lançada
                    </span>
                  )}
                  {!d.is_active && (
                    <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-brand-surface text-brand-muted border border-brand-border">
                      inativa
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-brand-muted truncate">
                  {d.account_label} · vence dia {d.day_of_month}
                  {d.end_month ? ` · até ${d.end_month}` : ''}
                </p>
              </div>
              <span className="text-sm font-black text-brand-text whitespace-nowrap">{money(d.amount)}</span>
              <button
                onClick={() => {
                  setErro(null);
                  setForm({
                    id: d.id, label: d.label, amount: String(d.amount),
                    account_code: d.account_code, day_of_month: d.day_of_month,
                    start_month: d.start_month, end_month: d.end_month || '',
                    is_active: d.is_active,
                  });
                }}
                className="p-1.5 rounded-lg text-brand-muted hover:text-brand-text hover:bg-brand-surface"
                title="Editar"
              >
                <Pencil size={14} />
              </button>
              <button
                onClick={() => void remover(d)}
                className="p-1.5 rounded-lg text-brand-muted hover:text-red-600 hover:bg-red-500/10"
                title="Excluir"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-brand-muted mt-4 leading-relaxed">
        💡 Cadastrar cria o <b>molde</b>. O que entra no resultado é o lançamento gerado no caixa —
        automático todo dia 1º, ou pelo botão acima. Se o valor real do mês vier diferente, corrija o
        lançamento em <b>Lançamentos do Caixa</b>; o molde segue valendo para os meses seguintes.
      </p>
    </div>
  );
};

const Campo: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="block text-[10px] font-black uppercase text-brand-muted mb-1">{label}</label>
    {children}
  </div>
);

const mensagemErro = (code: string): string => {
  const mapa: Record<string, string> = {
    sem_permissao: 'Só a direção pode alterar as despesas fixas.',
    conta_invalida: 'Conta do plano inexistente.',
    conta_de_fonte_automatica: 'Essa conta já é alimentada automaticamente (repasse, comissão, indicação). Lançar aqui contaria duas vezes.',
    label_obrigatorio: 'Descreva a despesa.',
    valor_invalido: 'Informe um valor maior que zero.',
    dia_invalido: 'O dia do vencimento precisa estar entre 1 e 28.',
    mes_inicial_invalido: 'Mês inicial inválido.',
    mes_final_invalido: 'Mês final inválido.',
    nao_encontrada: 'Despesa não encontrada.',
  };
  return mapa[code] || `Não foi possível concluir (${code}).`;
};

export default RecurringExpensesManager;
