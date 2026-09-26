import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { googleMeetErrorMessage } from '../lib/googleMeet';
import { budgetPercent, formatUsd, pauseReasonText, type MeetSummaryBudget } from '../lib/meetSummary';

// Teto mensal do resumo por IA das aulas (direção, "Conta central Google").
// Depois de toda aula a IA gera o rascunho sozinha; atingido o teto, a geração
// automática para até o mês virar ou a direção aumentar o valor. O botão manual
// da aula continua, com o aviso de custo.
export default function MeetSummaryBudgetCard({ aiEnabled, model }: { aiEnabled: boolean; model?: string | null }) {
  const [budget, setBudget] = useState<MeetSummaryBudget | null>(null);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState<'' | 'load' | 'save'>('load');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setBusy('load'); setError('');
    const { data, error: rpcError } = await supabase.rpc('get_meet_summary_budget');
    if (rpcError || !data?.ok) setError('Não foi possível ler o gasto de IA do mês.');
    else { setBudget(data as MeetSummaryBudget); setCap(String(Number(data.cap_usd))); }
    setBusy('');
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    const value = Number(cap.replace(',', '.'));
    if (!Number.isFinite(value) || value < 0 || value > 500) { setError(googleMeetErrorMessage('summary_cap_invalid')); return; }
    setBusy('save'); setError(''); setMessage('');
    const { data, error: rpcError } = await supabase.rpc('set_meet_summary_monthly_cap', { p_cap_usd: value });
    if (rpcError || !data?.ok) setError(googleMeetErrorMessage(rpcError?.message, 'Não foi possível salvar o teto.'));
    else { setBudget(data as MeetSummaryBudget); setCap(String(Number(data.cap_usd))); setMessage('Teto mensal salvo.'); }
    setBusy('');
  };

  const percent = budget ? budgetPercent(Number(budget.spent_usd), Number(budget.cap_usd)) : 0;
  return <section data-tour="meet-summary-budget" className="space-y-3 rounded-2xl border border-brand-border bg-brand-surface p-5">
    <div className="flex items-center gap-2"><Sparkles size={18} className="text-indigo-600"/><h3 className="font-bold text-brand-text">Resumo automático por IA</h3></div>
    <p className="text-sm text-brand-muted">Depois de cada aula documentada, a IA ({model || 'modelo configurado'}, pelo OpenRouter, num fornecedor que não usa o conteúdo para treinar) escreve o rascunho: objetivo, o que foi praticado, dificuldades e próximo passo, com trechos da transcrição. O professor revisa e aprova; só o aprovado vai para a memória do aluno. A cobrança é por uso, separada da assinatura Google.</p>
    {!aiEnabled && <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-300">O resumo por IA ainda está desligado nesta instalação. Enquanto isso, as notas do Gemini continuam chegando como rascunho.</p>}
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800">{message}</p>}
    {busy === 'load' && !budget && <p className="flex items-center gap-2 text-sm text-brand-muted"><Loader2 size={14} className="animate-spin"/>Lendo o gasto do mês…</p>}
    {budget && <>
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-bold text-brand-text">Gasto em {budget.month}: {formatUsd(budget.spent_usd)} de {formatUsd(budget.cap_usd)}</span>
          <span className="text-brand-muted">{budget.automatic_count} automático(s) · {budget.manual_count} manual(is){budget.failed_count ? ` · ${budget.failed_count} sem rascunho` : ''}</span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-brand-surface-2" role="progressbar" aria-label="Parte do teto mensal já gasta" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full ${budget.cap_reached ? 'bg-amber-500' : 'bg-indigo-600'}`} style={{ width: `${percent}%` }}/>
        </div>
      </div>
      {budget.cap_reached && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900" data-testid="summary-cap-reached">Teto do mês atingido: o rascunho automático parou até o mês virar ou você aumentar o teto. Na aula, o botão de gerar pela IA continua, com o aviso de custo.</p>}
      {budget.paused_until && <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">Rascunho automático pausado: {pauseReasonText(budget.pause_reason)}. Nova verificação às {new Date(budget.paused_until).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm font-bold text-brand-text">Teto mensal (US$)
          <input type="number" min={0} max={500} step={1} value={cap} onChange={event => setCap(event.target.value)} className="mt-1 block w-32 rounded-xl border border-brand-border bg-brand-surface px-3 py-2 font-normal"/>
        </label>
        <button type="button" disabled={!!busy} onClick={() => void save()} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy === 'save' ? 'Salvando…' : 'Salvar teto'}</button>
        <p className="text-xs text-brand-muted">{budget.default_cap ? 'Padrão da plataforma: US$ 20 por mês. ' : ''}Zero desliga o rascunho automático. O gasto conta o valor cobrado pela IA (ou a estimativa, enquanto a cobrança não é confirmada).</p>
      </div>
    </>}
  </section>;
}
