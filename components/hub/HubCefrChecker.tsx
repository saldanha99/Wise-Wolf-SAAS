import React, { useState } from 'react';
import { AlertCircle, Check, Copy, Gauge, RefreshCw } from 'lucide-react';
import { hubAiErrorMessage, invokeHubAi } from './hubAi';
import type { HubBootstrap } from './types';

// Verificador de nível CEFR (Fase 2): o professor cola um texto e vê o nível
// estimado, o porquê, os trechos difíceis e, se escolher um nível-alvo, a
// versão simplificada. Cota própria: `educator_ai.cefr_check`.

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const CONFIDENCE: Record<string, string> = { low: 'baixa', medium: 'média', high: 'alta' };

interface CefrResponse {
  metrics: { words: number; sentences: number; avg_words_per_sentence: number; long_words_pct: number; metrics_band: string };
  result: {
    estimated_level: string;
    confidence: string;
    summary_pt: string;
    reasons_pt: string[];
    above_level: Array<{ excerpt: string; issue_pt: string; suggestion: string }>;
    simplified_text: string;
    glossary: Array<{ term: string; translation_pt: string }>;
    target_level: string | null;
    above_target: boolean | null;
  };
}

const inputClass = 'w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-hidden focus:ring-4 focus:ring-tenant-primary/10';

const HubCefrChecker: React.FC<{ bootstrap: HubBootstrap; onRefresh: () => Promise<void>; onUpgrade: () => void }> = ({ bootstrap, onRefresh, onUpgrade }) => {
  const entitlement = bootstrap.entitlements['educator_ai.cefr_check'];
  const remaining = !entitlement ? 0 : entitlement.limit == null ? null : Math.max(entitlement.limit - (entitlement.used || 0), 0);
  const [text, setText] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState<CefrResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (text.trim().split(/\s+/).length < 15) { setError(hubAiErrorMessage(new Error('CEFR_TEXT_TOO_SHORT'))); return; }
    setBusy(true);
    setError('');
    try {
      const payload = await invokeHubAi({ action: 'cefr_check', accountId: bootstrap.account.id, text, ...(target ? { targetLevel: target } : {}) });
      if (!payload.result || !payload.metrics) throw new Error('EMPTY');
      setData(payload as unknown as CefrResponse);
      await onRefresh();
    } catch (caught) {
      setError(hubAiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const copySimplified = async () => {
    if (!data?.result.simplified_text) return;
    try {
      await navigator.clipboard.writeText(data.result.simplified_text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Não foi possível copiar.');
    }
  };

  if (!entitlement || entitlement.limit === 0) {
    return (
      <section className="mx-auto max-w-2xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-8 text-center shadow-xs">
        <h1 className="text-2xl font-black text-brand-text">Verificador de nível não incluído neste plano</h1>
        <button type="button" onClick={onUpgrade} className="mt-6 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Ver planos</button>
      </section>
    );
  }

  const r = data?.result;
  return (
    <div className="space-y-5">
      <form onSubmit={submit} data-tour="hub-cefr-checker" className="rounded-4xl border border-brand-border bg-brand-surface p-5 shadow-xs sm:p-7">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Educador IA · Verificar nível</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-brand-text">Qual é o nível CEFR deste texto?</h1>
            <p className="mt-1 text-sm text-brand-muted">Cole um texto em inglês. Escolha o nível do seu aluno para ver os trechos difíceis e receber a versão simplificada.</p>
          </div>
          <p className="shrink-0 rounded-2xl bg-brand-surface-2 px-4 py-2 text-xs font-bold text-brand-text">{remaining === null ? 'Ilimitado' : `${remaining} de ${entitlement.limit} verificações restantes`}</p>
        </div>
        <label className="mt-5 block"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Texto</span>
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={7} maxLength={6000} placeholder="Cole aqui o texto (até 6.000 caracteres)." className={inputClass} />
          <span className="mt-1 block text-xs text-brand-muted">{text.length}/6.000</span>
        </label>
        <label className="mt-3 block sm:w-64"><span className="mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Nível do aluno (opcional)</span>
          <select value={target} onChange={(event) => setTarget(event.target.value)} className={`${inputClass} font-bold`}>
            <option value="">Só verificar</option>
            {LEVELS.map((value) => <option key={value} value={value}>Simplificar para {value}</option>)}
          </select>
        </label>
        {error && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700"><AlertCircle className="mt-0.5 shrink-0" size={17} />{error}</div>}
        <button type="submit" disabled={busy || remaining === 0} className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white disabled:opacity-60">
          {busy ? <RefreshCw className="animate-spin" size={17} /> : <Gauge size={17} />}{busy ? 'Verificando...' : 'Verificar nível'}
        </button>
      </form>

      {data && r && (
        <section className="rounded-4xl border border-brand-border bg-white p-5 text-slate-900 shadow-xs sm:p-7" aria-live="polite">
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid size-20 place-items-center rounded-3xl bg-tenant-primary text-3xl font-black text-white" data-testid="cefr-level">{r.estimated_level}</div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{r.summary_pt}</p>
              <p className="mt-1 text-xs text-slate-500">Confiança {CONFIDENCE[r.confidence] || r.confidence} · {data.metrics.words} palavras · {data.metrics.sentences} frases · {data.metrics.avg_words_per_sentence} palavras por frase · {data.metrics.long_words_pct}% de palavras longas</p>
              {r.target_level && <p className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-black ${r.above_target ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}`}>{r.above_target ? `Acima do ${r.target_level}: veja a versão simplificada` : `Serve para ${r.target_level}`}</p>}
            </div>
          </div>
          {r.reasons_pt.length > 0 && <ul className="mt-4 list-disc space-y-1 pl-5 text-sm">{r.reasons_pt.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
          {r.above_level.length > 0 && (<>
            <h3 className="mt-6 text-[11px] font-black uppercase tracking-[0.18em] text-tenant-primary">Trechos difíceis</h3>
            <ul className="mt-2 space-y-2 text-sm">{r.above_level.map((item, index) => <li key={index} className="rounded-2xl border border-slate-200 p-3"><p className="font-bold">“{item.excerpt}”</p><p className="mt-1 text-slate-600">{item.issue_pt}</p>{item.suggestion && <p className="mt-1 text-emerald-800">→ {item.suggestion}</p>}</li>)}</ul>
          </>)}
          {r.simplified_text && (<>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-black uppercase tracking-[0.18em] text-tenant-primary">Versão {r.target_level}</h3>
              <button type="button" onClick={() => void copySimplified()} className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-black">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copiado' : 'Copiar'}</button>
            </div>
            {r.simplified_text.split(/\n+/).map((paragraph, index) => <p key={index} className="mt-3 text-[15px] leading-7">{paragraph}</p>)}
          </>)}
          {r.glossary.length > 0 && (<>
            <h3 className="mt-6 text-[11px] font-black uppercase tracking-[0.18em] text-tenant-primary">Glossário</h3>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">{r.glossary.map((item, index) => <li key={index}><span className="font-bold">{item.term}</span> — {item.translation_pt}</li>)}</ul>
          </>)}
          <p className="mt-6 text-[11px] text-slate-400">O nível é uma estimativa da IA com base no vocabulário, na gramática e no tamanho das frases. Use como apoio, não como prova oficial.</p>
        </section>
      )}
    </div>
  );
};

export default HubCefrChecker;
