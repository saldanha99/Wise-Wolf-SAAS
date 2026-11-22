import React, { useEffect, useState } from 'react';
import { AlertCircle, Info, Loader2, Settings2, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';

export const money = (v: unknown) =>
  `R$ ${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const pct = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export const toneOf = (v: number): 'bad' | 'default' | 'good' => (v < 0 ? 'bad' : v === 0 ? 'default' : 'good');

export const Kpi: React.FC<{
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'cost' | 'good' | 'bad';
}> = ({ label, value, hint, tone = 'default' }) => (
  <div className="rounded-2xl border border-brand-border bg-brand-surface p-4 sm:p-5">
    <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">{label}</p>
    <p className={`mt-2 text-xl font-black tracking-tight sm:text-2xl ${tone === 'cost' ? 'text-amber-600'
      : tone === 'good' ? 'text-emerald-600'
        : tone === 'bad' ? 'text-red-600'
          : 'text-brand-text'}`}>
      {value}
    </p>
    {hint && <p className="mt-1 text-[11px] font-medium text-brand-muted">{hint}</p>}
  </div>
);

export const StatusBadge: React.FC<{ margem: number }> = ({ margem }) => (
  <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider ${margem < 0
    ? 'bg-red-100 text-red-700'
    : Math.abs(margem) < 0.5 ? 'bg-brand-surface-2 text-brand-muted' : 'bg-emerald-100 text-emerald-700'}`}>
    {margem < 0 ? 'Prejuízo' : Math.abs(margem) < 0.5 ? 'Empate' : 'Lucro'}
  </span>
);

export interface FinanceAlert { nivel: 'critico' | 'atencao' | 'info'; texto: string }

export const Alerts: React.FC<{ alerts?: FinanceAlert[] }> = ({ alerts }) => {
  if (!alerts?.length) return null;
  return (
    <div className="space-y-2">
      {alerts.map((a, i) => (
        <div
          key={i}
          className={`flex items-start gap-3 rounded-2xl border p-3 text-sm font-medium sm:p-4 ${a.nivel === 'critico'
            ? 'border-red-200 bg-red-50 text-red-800'
            : a.nivel === 'atencao' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-brand-border bg-brand-surface-2 text-brand-muted'}`}
        >
          {a.nivel === 'info' ? <Info size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
          <p>{a.texto}</p>
        </div>
      ))}
    </div>
  );
};

export interface FinanceSettings {
  tax_mode: 'UNSET' | 'PERCENT_REVENUE' | 'FIXED_MONTHLY';
  tax_percent: number;
  tax_fixed_monthly: number;
  voice_brl_per_minute: number;
  asaas_fee_per_charge: number;
  usd_brl: number;
  extra_fixed_costs_monthly: number;
  saved?: boolean;
}

const numberField = (
  label: string,
  hint: string,
  value: number,
  onChange: (v: number) => void,
  step = '0.01',
) => (
  <label className="block">
    <span className="text-xs font-black uppercase tracking-wider text-brand-muted">{label}</span>
    <input
      type="number"
      inputMode="decimal"
      min="0"
      step={step}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
      className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm font-bold text-brand-text outline-hidden focus:ring-2 focus:ring-tenant-primary"
    />
    <span className="mt-1 block text-[11px] text-brand-muted">{hint}</span>
  </label>
);

/** Configuração usada pela margem, precificação e equilíbrio (tabela finance_settings). */
export const FinanceSettingsButton: React.FC<{
  settings?: FinanceSettings | null;
  canEdit: boolean;
  onSaved: () => void;
}> = ({ settings, canEdit, onSaved }) => {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FinanceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (open && settings) setForm({ ...settings }); }, [open, settings]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const num = (v: number) => (Number.isFinite(v) ? v : 0);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    const { error: e } = await supabase.rpc('finance_settings_save', {
      p_settings: {
        tax_mode: form.tax_mode,
        tax_percent: num(form.tax_percent),
        tax_fixed_monthly: num(form.tax_fixed_monthly),
        voice_brl_per_minute: num(form.voice_brl_per_minute),
        asaas_fee_per_charge: num(form.asaas_fee_per_charge),
        usd_brl: num(form.usd_brl),
        extra_fixed_costs_monthly: num(form.extra_fixed_costs_monthly),
      },
    });
    setSaving(false);
    if (e) { setError(e.message); return; }
    setOpen(false);
    onSaved();
  };

  return (
    <>
      <button
        type="button"
        data-tour="finance-settings"
        onClick={() => setOpen(true)}
        disabled={!settings}
        className="flex w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-brand-surface-2 px-3 py-2 text-xs font-bold text-brand-text disabled:opacity-40 sm:w-auto"
      >
        <Settings2 size={14} /> Configurar
        {settings?.tax_mode === 'UNSET' && <span className="ml-1 h-2 w-2 rounded-full bg-amber-500" aria-label="imposto não configurado" />}
      </button>
      {open && form && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Configuração financeira" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-brand-surface p-5 shadow-xl sm:max-w-lg sm:rounded-3xl sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-black text-brand-text">Configuração financeira</h3>
              <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="rounded-full p-1 text-brand-muted hover:bg-brand-surface-2"><X size={18} /></button>
            </div>
            <fieldset disabled={!canEdit} className="space-y-4">
              <label className="block">
                <span className="text-xs font-black uppercase tracking-wider text-brand-muted">Imposto</span>
                <select
                  value={form.tax_mode}
                  onChange={(e) => setForm({ ...form, tax_mode: e.target.value as FinanceSettings['tax_mode'] })}
                  className="mt-1 w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2 text-sm font-bold text-brand-text"
                >
                  <option value="UNSET">Ainda não informado</option>
                  <option value="PERCENT_REVENUE">% sobre a receita (Simples, Lucro Presumido)</option>
                  <option value="FIXED_MONTHLY">Valor fixo por mês (DAS do MEI)</option>
                </select>
                <span className="mt-1 block text-[11px] text-brand-muted">Confirme com a contabilidade. Sem isso, a margem não desconta imposto.</span>
              </label>
              {form.tax_mode === 'PERCENT_REVENUE' && numberField('Alíquota (%)', 'Alíquota efetiva sobre a mensalidade.', form.tax_percent, (v) => setForm({ ...form, tax_percent: v }))}
              {form.tax_mode === 'FIXED_MONTHLY' && numberField('DAS por mês (R$)', 'Rateado entre os alunos pagantes do mês. Não lance o boleto do DAS também como despesa: ele já entra por aqui.', form.tax_fixed_monthly, (v) => setForm({ ...form, tax_fixed_monthly: v }))}
              {numberField('Custos fixos fora do caixa (R$/mês)', 'Pró-labore, aluguel ou contas pagas por fora do sistema. Entram no ponto de equilíbrio.', form.extra_fixed_costs_monthly, (v) => setForm({ ...form, extra_fixed_costs_monthly: v }))}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                {numberField('Voz (R$/min)', 'Wolfie ao vivo.', form.voice_brl_per_minute, (v) => setForm({ ...form, voice_brl_per_minute: v }), '0.0001')}
                {numberField('Asaas (R$/cobrança)', 'Quando o Asaas não informa.', form.asaas_fee_per_charge, (v) => setForm({ ...form, asaas_fee_per_charge: v }))}
                {numberField('Dólar (R$)', 'IA de texto.', form.usd_brl, (v) => setForm({ ...form, usd_brl: v }), '0.0001')}
              </div>
            </fieldset>
            {!canEdit && <p className="mt-3 text-xs font-medium text-brand-muted">Só a direção altera estes valores.</p>}
            {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-xl px-4 py-2 text-sm font-bold text-brand-muted">Cancelar</button>
              {canEdit && (
                <button type="button" onClick={save} disabled={saving} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
                  {saving && <Loader2 size={14} className="animate-spin" />} Salvar
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
