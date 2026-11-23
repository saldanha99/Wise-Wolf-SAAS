import React, { useState } from 'react';
import { AlertCircle, Check, Copy, Eye, EyeOff, FileText, Image as ImageIcon, Link2, Printer, RefreshCw, Wand2 } from 'lucide-react';
import { HUB_MATERIAL_AUDIENCE_OPTIONS, HubMaterialView, materialAsText, type HubMaterialAudience, type HubMaterialKind, type HubMaterialRecord } from './HubMaterialGenerator';
import { hubAiErrorMessage, invokeHubAi } from './hubAi';
import type { HubBootstrap } from './types';

// Adaptação de material autêntico (Fase 2): texto colado, link de uma página ou
// print. O servidor busca o link com proteção, lê o print com a IA (a imagem
// não é guardada) e devolve o texto no nível do aluno com uma atividade.
// Cota própria: `educator_ai.adapt`.

type SourceType = 'text' | 'url' | 'image';
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const ACTIVITIES: Array<{ value: HubMaterialKind; label: string }> = [
  { value: 'reading', label: 'Leitura adaptada com perguntas e estratégias' },
  { value: 'true_false', label: 'Verdadeiro ou falso' },
  { value: 'gap_fill', label: 'Lacunas com banco de palavras' },
  { value: 'text_questions', label: 'Perguntas sobre o texto original' },
];
const MAX_SIDE = 1600;

// Reduz o print no navegador (no máximo 1600 px, JPEG): menos dados e menos custo.
export async function shrinkImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('IMAGE_INVALID');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

const inputClass = 'w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm text-brand-text outline-hidden focus:ring-4 focus:ring-tenant-primary/10';
const labelClass = 'mb-2 block text-[10px] font-black uppercase tracking-widest text-brand-muted';

const HubAuthenticAdapter: React.FC<{ bootstrap: HubBootstrap; onRefresh: () => Promise<void>; onUpgrade: () => void }> = ({ bootstrap, onRefresh, onUpgrade }) => {
  const entitlement = bootstrap.entitlements['educator_ai.adapt'];
  const remaining = !entitlement ? 0 : entitlement.limit == null ? null : Math.max(entitlement.limit - (entitlement.used || 0), 0);
  const [sourceType, setSourceType] = useState<SourceType>('text');
  const [sourceText, setSourceText] = useState('');
  const [url, setUrl] = useState('');
  const [image, setImage] = useState('');
  const [imageName, setImageName] = useState('');
  const [kind, setKind] = useState<HubMaterialKind>('reading');
  const [level, setLevel] = useState('A2');
  const [audience, setAudience] = useState<HubMaterialAudience>('adults');
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<HubMaterialRecord | null>(null);
  const [teacher, setTeacher] = useState(true);
  const [copied, setCopied] = useState(false);

  const pickImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { setError(hubAiErrorMessage(new Error('IMAGE_INVALID'))); return; }
    try {
      setImage(await shrinkImage(file));
      setImageName(file.name);
      setError('');
    } catch {
      setError(hubAiErrorMessage(new Error('IMAGE_INVALID')));
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sourceType === 'text' && sourceText.trim().split(/\s+/).length < 30) { setError(hubAiErrorMessage(new Error('MATERIAL_SOURCE_TEXT_REQUIRED'))); return; }
    if (sourceType === 'url' && !/^https?:\/\//i.test(url.trim())) { setError(hubAiErrorMessage(new Error('URL_INVALID'))); return; }
    if (sourceType === 'image' && !image) { setError('Escolha a imagem do print.'); return; }
    setBusy(true);
    setError('');
    try {
      const payload = await invokeHubAi({
        action: 'adapt_authentic',
        accountId: bootstrap.account.id,
        sourceType,
        ...(sourceType === 'text' ? { sourceText } : sourceType === 'url' ? { url: url.trim() } : { image }),
        kind,
        level,
        audience,
        count: 6,
        ...(topic.trim().length >= 3 ? { topic: topic.trim() } : {}),
      });
      if (typeof payload.material_id !== 'string' || !payload.material || typeof payload.material !== 'object') throw new Error('EMPTY');
      setResult({
        id: payload.material_id,
        kind: String(payload.kind || kind) as HubMaterialKind,
        niche: String(payload.niche || 'GENERAL'),
        level_tag: level,
        topic: String(payload.topic || ''),
        audience,
        title: String(payload.title || 'Material adaptado'),
        created_at: String(payload.created_at || new Date().toISOString()),
        dropped_items: Number(payload.dropped || 0),
        material: payload.material as Record<string, unknown>,
      });
      setTeacher(true);
      await onRefresh();
    } catch (caught) {
      setError(hubAiErrorMessage(caught));
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
      setError('Não foi possível copiar.');
    }
  };

  if (!entitlement || entitlement.limit === 0) {
    return (
      <section className="mx-auto max-w-2xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-8 text-center shadow-xs">
        <h1 className="text-2xl font-black text-brand-text">Adaptação de material não incluída neste plano</h1>
        <button type="button" onClick={onUpgrade} className="mt-6 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Ver planos</button>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <style>{`@media print { body * { visibility: hidden; } #hub-material-print, #hub-material-print * { visibility: visible; } #hub-material-print { position: absolute; left: 0; top: 0; width: 100%; } }`}</style>
      <form onSubmit={submit} data-tour="hub-authentic-adapter" className="rounded-4xl border border-brand-border bg-brand-surface p-5 shadow-xs sm:p-7 print:hidden">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Educador IA · Adaptar material</p>
            <h1 className="mt-1 text-2xl font-black tracking-tight text-brand-text">Notícia, post ou página no nível do aluno</h1>
            <p className="mt-1 text-sm text-brand-muted">Cole o texto, mande o link ou um print. O texto volta no nível escolhido, com a atividade e a fonte citada.</p>
          </div>
          <p className="shrink-0 rounded-2xl bg-brand-surface-2 px-4 py-2 text-xs font-bold text-brand-text">{remaining === null ? 'Ilimitado' : `${remaining} de ${entitlement.limit} adaptações restantes`}</p>
        </div>
        <div className="mt-5 inline-flex rounded-2xl border border-brand-border bg-brand-surface-2 p-1" role="tablist" aria-label="De onde vem o material">
          {([['text', 'Texto', <FileText key="t" size={14} />], ['url', 'Link', <Link2 key="l" size={14} />], ['image', 'Print', <ImageIcon key="i" size={14} />]] as Array<[SourceType, string, React.ReactNode]>).map(([value, label, icon]) => (
            <button key={value} type="button" role="tab" aria-selected={sourceType === value} onClick={() => setSourceType(value)} className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-black ${sourceType === value ? 'bg-tenant-primary text-white' : 'text-brand-muted'}`}>{icon}{label}</button>
          ))}
        </div>
        <div className="mt-4">
          {sourceType === 'text' && <textarea value={sourceText} onChange={(event) => setSourceText(event.target.value)} rows={7} maxLength={6000} placeholder="Cole o texto em inglês (até 6.000 caracteres)." aria-label="Texto em inglês" className={inputClass} />}
          {sourceType === 'url' && <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" inputMode="url" placeholder="https://..." aria-label="Link da página" className={inputClass} />}
          {sourceType === 'image' && (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-brand-border bg-brand-surface-2 p-6 text-center text-sm text-brand-muted">
              <ImageIcon size={22} />
              {imageName ? <span className="font-bold text-brand-text">{imageName}</span> : <span>Toque para escolher o print (JPG, PNG ou WebP)</span>}
              <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => void pickImage(event)} className="sr-only" />
            </label>
          )}
          <p className="mt-1 text-xs text-brand-muted">Use material que você pode usar em aula. A fonte vai citada no material; o print não fica guardado.</p>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <label className="sm:col-span-2"><span className={labelClass}>Atividade</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as HubMaterialKind)} className={`${inputClass} font-bold`}>{ACTIVITIES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          </label>
          <label><span className={labelClass}>Nível CEFR</span>
            <select value={level} onChange={(event) => setLevel(event.target.value)} className={`${inputClass} font-bold`}>{LEVELS.map((value) => <option key={value}>{value}</option>)}</select>
          </label>
          <label><span className={labelClass}>Faixa etária</span>
            <select value={audience} onChange={(event) => setAudience(event.target.value as HubMaterialAudience)} className={`${inputClass} font-bold`}>{HUB_MATERIAL_AUDIENCE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          </label>
          <label className="sm:col-span-4"><span className={labelClass}>Tema (opcional)</span>
            <input value={topic} onChange={(event) => setTopic(event.target.value)} maxLength={200} placeholder="Se vazio, usamos o título da página" className={inputClass} />
          </label>
        </div>
        {error && <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700"><AlertCircle className="mt-0.5 shrink-0" size={17} />{error}</div>}
        <button type="submit" disabled={busy || remaining === 0} className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white disabled:opacity-60">
          {busy ? <RefreshCw className="animate-spin" size={17} /> : <Wand2 size={17} />}{busy ? 'Adaptando (até 1 min)...' : 'Adaptar'}
        </button>
      </form>

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

export default HubAuthenticAdapter;
