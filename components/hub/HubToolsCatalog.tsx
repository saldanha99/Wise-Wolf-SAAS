import React, { useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, BookOpen, Check, Copy, Eye, EyeOff, Languages, MessageSquare, PenLine, Printer, RefreshCw, Search, Sparkles, SpellCheck } from 'lucide-react';
import { HUB_TOOL_SKILL_LABEL, HUB_TOOL_SKILLS, HUB_TOOLS, type HubTool, type HubToolSkill } from '../../supabase/functions/_shared/hub-tools';
import { HUB_MATERIAL_AUDIENCE_OPTIONS, HUB_MATERIAL_NICHE_OPTIONS, HubMaterialView, materialAsText, type HubMaterialAudience, type HubMaterialKind, type HubMaterialRecord } from './HubMaterialGenerator';
import { hubAiErrorMessage, invokeHubAi } from './hubAi';
import type { HubBootstrap } from './types';

// Ferramentas de IA por habilidade (Fase 2). O catálogo é o mesmo do servidor
// (`_shared/hub-tools.ts`): aqui o professor escolhe a ferramenta e preenche um
// formulário curto; o servidor aplica o preset pelo id e cobra 1 geração.

const SKILL_ICON: Record<HubToolSkill, React.ReactNode> = {
  reading: <BookOpen size={15} />,
  vocabulary: <Languages size={15} />,
  speaking: <MessageSquare size={15} />,
  writing: <PenLine size={15} />,
  grammar: <SpellCheck size={15} />,
};
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function filterHubTools(skill: HubToolSkill | 'all', query: string): HubTool[] {
  const q = normalize(query.trim());
  return HUB_TOOLS.filter((tool) => (skill === 'all' || tool.skill === skill)
    && (!q || normalize(`${tool.name} ${tool.summary} ${HUB_TOOL_SKILL_LABEL[tool.skill]}`).includes(q)));
}

const inputClass = 'w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-hidden focus:ring-4 focus:ring-tenant-primary/10';
const labelClass = 'mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted';

const HubToolsCatalog: React.FC<{ bootstrap: HubBootstrap; onRefresh: () => Promise<void>; onUpgrade: () => void }> = ({ bootstrap, onRefresh, onUpgrade }) => {
  const entitlement = bootstrap.entitlements['educator_ai.generate'];
  const remaining = !entitlement ? 0 : entitlement.limit == null ? null : Math.max(entitlement.limit - (entitlement.used || 0), 0);
  const [skill, setSkill] = useState<HubToolSkill | 'all'>('all');
  const [query, setQuery] = useState('');
  const [tool, setTool] = useState<HubTool | null>(null);
  const [level, setLevel] = useState('A2');
  const [niche, setNiche] = useState('GENERAL');
  const [audience, setAudience] = useState<HubMaterialAudience>('adults');
  const [topic, setTopic] = useState('');
  const [goal, setGoal] = useState('');
  const [targetWords, setTargetWords] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [count, setCount] = useState(8);
  const [bilingual, setBilingual] = useState(true);
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HubMaterialRecord | null>(null);
  const [teacher, setTeacher] = useState(true);
  const [copied, setCopied] = useState(false);
  const tools = useMemo(() => filterHubTools(skill, query), [skill, query]);

  const open = (next: HubTool) => {
    setTool(next);
    setCount(next.defaultCount);
    setError('');
    setResult(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!tool) return;
    if (topic.trim().length < 3) { setError(hubAiErrorMessage(new Error('MATERIAL_TOPIC_REQUIRED'))); return; }
    if (tool.sourceTextRequired && sourceText.trim().split(/\s+/).length < 30) { setError(hubAiErrorMessage(new Error('MATERIAL_SOURCE_TEXT_REQUIRED'))); return; }
    setBusy(true);
    setError('');
    try {
      const payload = await invokeHubAi({
        action: 'material',
        accountId: bootstrap.account.id,
        toolId: tool.id,
        kind: tool.kind,
        niche,
        level,
        audience,
        topic: topic.trim(),
        goal: goal.trim(),
        count,
        bilingual,
        extra: extra.trim(),
        ...(tool.fields.includes('targetWords') && targetWords.trim() ? { targetWords } : {}),
        ...(tool.fields.includes('sourceText') && sourceText.trim() ? { sourceText } : {}),
      });
      if (typeof payload.material_id !== 'string' || !payload.material || typeof payload.material !== 'object') throw new Error('EMPTY');
      setResult({
        id: payload.material_id,
        kind: tool.kind as HubMaterialKind,
        niche,
        level_tag: level,
        topic: String(payload.topic || topic.trim()),
        goal: goal.trim(),
        audience,
        title: String(payload.title || topic.trim()),
        created_at: String(payload.created_at || new Date().toISOString()),
        dropped_items: Number(payload.dropped || 0),
        material: payload.material as Record<string, unknown>,
      });
      setTeacher(true);
      await onRefresh();
    } catch (caught) {
      setError(hubAiErrorMessage(caught, 'Não foi possível gerar agora. Tente de novo; nada foi cobrado se deu erro.'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(materialAsText(result));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Não foi possível copiar. Selecione o texto na tela.');
    }
  };

  if (!entitlement || entitlement.limit === 0) {
    return (
      <section className="mx-auto max-w-2xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-8 text-center shadow-xs">
        <h1 className="text-2xl font-black text-brand-text">Ferramentas de IA não incluídas neste plano</h1>
        <button type="button" onClick={onUpgrade} className="mt-6 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Ver planos</button>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <style>{`@media print { body * { visibility: hidden; } #hub-material-print, #hub-material-print * { visibility: visible; } #hub-material-print { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
      {!tool ? (
        <section data-tour="hub-tools-catalog" className="rounded-4xl border border-brand-border bg-brand-surface p-5 shadow-xs sm:p-7 print:hidden">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Educador IA · Ferramentas</p>
              <h1 className="mt-1 text-2xl font-black tracking-tight text-brand-text">{HUB_TOOLS.length} ferramentas por habilidade</h1>
              <p className="mt-1 text-sm text-brand-muted">Escolha o que você precisa para a aula. Cada ferramenta tem um formulário curto e sai com gabarito para você e uma versão limpa para o aluno.</p>
            </div>
            <p className="shrink-0 rounded-2xl bg-brand-surface-2 px-4 py-2 text-xs font-bold text-brand-text">{remaining === null ? 'Gerações ilimitadas' : `${remaining} de ${entitlement.limit} gerações restantes`}</p>
          </div>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Habilidade">
              {(['all', ...HUB_TOOL_SKILLS] as Array<HubToolSkill | 'all'>).map((value) => (
                <button key={value} type="button" role="tab" aria-selected={skill === value} onClick={() => setSkill(value)}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-black ${skill === value ? 'border-tenant-primary bg-tenant-primary text-white' : 'border-brand-border bg-brand-surface-2 text-brand-text'}`}>
                  {value !== 'all' && SKILL_ICON[value]}{value === 'all' ? 'Todas' : HUB_TOOL_SKILL_LABEL[value]}
                </button>
              ))}
            </div>
            <label className="relative sm:ml-auto sm:w-64">
              <span className="sr-only">Buscar ferramenta</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted" size={15} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar ferramenta" className={`${inputClass} py-2.5 pl-9`} />
            </label>
          </div>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tools.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => open(item)} className="flex h-full w-full items-start gap-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-3.5 text-left transition hover:border-tenant-primary/60">
                  <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-xl bg-tenant-primary/10 text-tenant-primary">{SKILL_ICON[item.skill]}</span>
                  <span>
                    <span className="block text-[10px] font-black uppercase tracking-widest text-brand-muted">{HUB_TOOL_SKILL_LABEL[item.skill]}</span>
                    <span className="block text-sm font-black text-brand-text">{item.name}</span>
                    <span className="mt-0.5 block text-xs text-brand-muted">{item.summary}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {tools.length === 0 && <p className="mt-4 text-sm text-brand-muted">Nenhuma ferramenta com esse nome. Tente outra palavra.</p>}
        </section>
      ) : (
        <form onSubmit={submit} className="rounded-4xl border border-brand-border bg-brand-surface p-5 shadow-xs sm:p-7 print:hidden">
          <button type="button" onClick={() => { setTool(null); setResult(null); }} className="inline-flex items-center gap-1.5 text-xs font-black text-brand-muted"><ArrowLeft size={14} />Todas as ferramentas</button>
          <p className="mt-3 text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">{HUB_TOOL_SKILL_LABEL[tool.skill]}</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight text-brand-text">{tool.name}</h1>
          <p className="mt-1 text-sm text-brand-muted">{tool.howTo}</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-4">
            <label><span className={labelClass}>Nível CEFR</span>
              <select value={level} onChange={(event) => setLevel(event.target.value)} className={`${inputClass} font-bold`}>{LEVELS.map((value) => <option key={value}>{value}</option>)}</select>
            </label>
            <label><span className={labelClass}>Nicho</span>
              <select value={niche} onChange={(event) => setNiche(event.target.value)} className={`${inputClass} font-bold`}>{HUB_MATERIAL_NICHE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </label>
            <label><span className={labelClass}>Faixa etária</span>
              <select value={audience} onChange={(event) => setAudience(event.target.value as HubMaterialAudience)} className={`${inputClass} font-bold`}>{HUB_MATERIAL_AUDIENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
            </label>
            <label><span className={labelClass}>Itens</span>
              <input type="number" min={4} max={15} value={count} onChange={(event) => setCount(Math.min(15, Math.max(4, Number(event.target.value) || 4)))} className={`${inputClass} font-bold`} />
            </label>
            <label className="sm:col-span-4"><span className={labelClass}>Tema</span>
              <input value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={200} placeholder={tool.topicPlaceholder} className={inputClass} />
            </label>
            {tool.fields.includes('targetWords') && (
              <label className="sm:col-span-4"><span className={labelClass}>Palavras que devem aparecer (opcional)</span>
                <input value={targetWords} onChange={(event) => setTargetWords(event.target.value)} maxLength={600} placeholder="Ex.: booking, check-in, receipt, upgrade" className={inputClass} />
              </label>
            )}
            {tool.fields.includes('sourceText') && (
              <label className="sm:col-span-4"><span className={labelClass}>{tool.sourceTextRequired ? 'Seu texto em inglês' : 'Seu texto em inglês (opcional)'}</span>
                <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} maxLength={6000} rows={6} placeholder="Cole aqui o texto (até 6.000 caracteres)." className={inputClass} />
                <span className="mt-1 block text-xs text-brand-muted">{sourceText.length}/6.000 · use só texto que você pode usar em aula.</span>
              </label>
            )}
            <label className="sm:col-span-3"><span className={labelClass}>Objetivo do aluno (opcional)</span>
              <input value={goal} onChange={(event) => setGoal(event.target.value)} maxLength={200} placeholder="Ex.: intercâmbio no Canadá, reuniões em inglês" className={inputClass} />
            </label>
            <label className="flex items-end gap-3 pb-3">
              <input type="checkbox" checked={bilingual} onChange={(event) => setBilingual(event.target.checked)} className="size-5 rounded" />
              <span className="text-sm font-bold text-brand-text">Traduções em pt-BR</span>
            </label>
            <label className="sm:col-span-4"><span className={labelClass}>Instruções extras (opcional)</span>
              <input value={extra} onChange={(event) => setExtra(event.target.value)} maxLength={600} placeholder="Ex.: evitar gírias; aluno engenheiro" className={inputClass} />
            </label>
          </div>
          {error && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700"><AlertCircle className="mt-0.5 shrink-0" size={17} />{error}</div>}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy || remaining === 0} className="inline-flex items-center gap-2 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white disabled:opacity-60">
              {busy ? <RefreshCw className="animate-spin" size={17} /> : <Sparkles size={17} />}{busy ? 'Gerando (até 1 min)...' : 'Gerar'}
            </button>
            {remaining === 0 && <button type="button" onClick={onUpgrade} className="text-sm font-black text-tenant-primary">Limite atingido — ver planos</button>}
            <span className="text-xs text-brand-muted">Consome 1 geração do plano. Fica salvo em "Gerar material → Seus materiais".</span>
          </div>
        </form>
      )}

      {result && (
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2 print:hidden">
            <button type="button" onClick={() => setTeacher((value) => !value)} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text">{teacher ? <EyeOff size={15} /> : <Eye size={15} />}{teacher ? 'Ver versão do aluno' : 'Ver versão do professor (gabarito)'}</button>
            <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text"><Printer size={15} />Imprimir / salvar PDF</button>
            <button type="button" onClick={() => void copy()} className="inline-flex items-center gap-2 rounded-2xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text">{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copiado' : 'Copiar texto'}</button>
          </div>
          <HubMaterialView record={result} teacher={teacher} />
        </section>
      )}
    </div>
  );
};

export default HubToolsCatalog;
