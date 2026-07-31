import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronRight,
  Clock3,
  FileText,
  LayoutDashboard,
  Library,
  Loader2,
  LogOut,
  Menu,
  PlayCircle,
  RefreshCw,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { openHubContent, trackHubEvent } from './hubService';
import type { HubBootstrap, HubContentItem, HubPlan, HubSettings } from './types';
import { HubSaasShowcase } from './HubLanding';
import HubCheckoutDialog from './HubCheckoutDialog';
import HubPersonalization from './HubPersonalization';
import HubWolfieStudio from './HubWolfieStudio';

type HubTab = 'overview' | 'library' | 'educator' | 'wolfie' | 'saas' | 'plans';

interface HubPortalProps {
  bootstrap: HubBootstrap;
  plans: HubPlan[];
  settings: HubSettings;
  content: HubContentItem[];
  userEmail: string;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
}

const BRAND_LOGO = 'https://wisewolflanguage.com.br/logo.png';

const NAV_ITEMS: Array<{ id: HubTab; label: string; icon: React.ElementType }> = [
  { id: 'overview', label: 'Início', icon: LayoutDashboard },
  { id: 'library', label: 'Biblioteca', icon: Library },
  { id: 'educator', label: 'Educador IA', icon: Sparkles },
  { id: 'wolfie', label: 'Wolfie', icon: Bot },
  { id: 'saas', label: 'SaaS Escolar', icon: Building2 },
  { id: 'plans', label: 'Planos', icon: BarChart3 },
];

const usageLabel = (used = 0, limit?: number | null) =>
  limit == null ? `${used} usados · ilimitado` : `${used} de ${limit}`;

const entitlementRemaining = (bootstrap: HubBootstrap, key: string) => {
  const entitlement = bootstrap.entitlements[key];
  if (!entitlement) return 0;
  if (entitlement.limit == null) return null;
  return Math.max(entitlement.limit - (entitlement.used || 0), 0);
};

const friendlyAccessError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('USAGE_LIMIT_REACHED')) return 'Você chegou ao limite deste recurso. Escolha um plano para continuar.';
  if (message.includes('FEATURE_NOT_INCLUDED')) return 'Este recurso não está incluído no seu plano atual.';
  if (message.includes('SUBSCRIPTION_REQUIRED')) return 'Seu teste terminou. Escolha um plano para continuar.';
  if (message.includes('CONTENT_ASSET_UNAVAILABLE')) return 'Este arquivo ainda está sendo preparado pela curadoria.';
  return 'Não foi possível abrir este conteúdo agora.';
};

const UsageCard: React.FC<{
  label: string;
  used?: number;
  limit?: number | null;
  icon: React.ElementType;
  color: string;
}> = ({ label, used = 0, limit, icon: Icon, color }) => {
  const percentage = limit == null ? 10 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className={`grid size-10 place-items-center rounded-2xl ${color}`}><Icon size={19} /></div>
        <span className="text-xs font-black text-slate-500">{usageLabel(used, limit)}</span>
      </div>
      <p className="mt-4 font-black text-slate-900">{label}</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-600" style={{ width: `${percentage}%` }} /></div>
    </div>
  );
};

const HubOverview: React.FC<{ bootstrap: HubBootstrap; onNavigate: (tab: HubTab) => void }> = ({ bootstrap, onNavigate }) => {
  const trialEnd = bootstrap.subscription?.trial_ends_at;
  const daysLeft = trialEnd ? Math.max(0, Math.ceil((new Date(trialEnd).getTime() - Date.now()) / 86_400_000)) : null;
  const preview = bootstrap.entitlements['library.preview'];
  const ai = bootstrap.entitlements['educator_ai.generate'];
  const wolfie = bootstrap.entitlements['wolfie.turn'];
  const preferences = bootstrap.account.metadata || {};
  return (
    <div className="space-y-7">
      <section className="relative overflow-hidden rounded-[2.25rem] bg-gradient-to-br from-[#070d1a] via-[#102a5a] to-blue-700 p-7 text-white shadow-2xl sm:p-10">
        <div className="absolute -right-24 -top-24 size-72 rounded-full bg-blue-300/20 blur-3xl" />
        <div className="relative max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em]">
            <Zap size={12} /> Plano {bootstrap.plan?.name || 'Wise Wolf Hub'}
          </div>
          <h1 className="mt-5 font-[Montserrat] text-3xl font-extrabold tracking-tight sm:text-5xl">Olá, {bootstrap.account.name.split(' ')[0]}. Seu próximo avanço começa pelo contexto.</h1>
          <p className="mt-4 max-w-2xl leading-7 text-blue-100">{preferences.goal || 'Explore materiais, prepare uma aula com IA ou pratique com o Wolfie. Cada experiência aprende com suas escolhas.'}</p>
          {preferences.role && <p className="mt-3 text-xs font-black uppercase tracking-[0.14em] text-blue-300">Experiência calibrada para: {preferences.role}</p>}
          <div className="mt-7 flex flex-wrap gap-3">
            <button onClick={() => onNavigate('library')} className="rounded-2xl bg-white px-5 py-3 text-sm font-black text-slate-950">Explorar biblioteca</button>
            <button onClick={() => onNavigate('educator')} className="rounded-2xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-black text-white">Criar com IA</button>
            <button onClick={() => onNavigate('wolfie')} className="rounded-2xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-black text-white">Entrar em um universo Wolfie</button>
          </div>
        </div>
      </section>

      {bootstrap.subscription?.status === 'TRIALING' && (
        <div className="flex flex-col justify-between gap-4 rounded-3xl border border-amber-200 bg-amber-50 p-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-amber-100 text-amber-700"><Clock3 size={20} /></div>
            <div><p className="font-black text-amber-950">Seu teste está ativo</p><p className="text-sm text-amber-800">{daysLeft} {daysLeft === 1 ? 'dia restante' : 'dias restantes'} para experimentar o Hub.</p></div>
          </div>
          <button onClick={() => onNavigate('plans')} className="rounded-xl bg-amber-900 px-4 py-2.5 text-xs font-black text-white">Ver planos</button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <UsageCard label="Acessos à biblioteca" used={preview?.used} limit={preview?.limit} icon={BookOpen} color="bg-amber-100 text-amber-700" />
        <UsageCard label="Gerações com IA" used={ai?.used} limit={ai?.limit} icon={Sparkles} color="bg-violet-100 text-violet-700" />
        <UsageCard label="Interações Wolfie" used={wolfie?.used} limit={wolfie?.limit} icon={Bot} color="bg-sky-100 text-sky-700" />
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        {[
          { tab: 'library' as HubTab, title: 'Encontre o material certo', text: 'Use nível e nicho para chegar mais rápido ao conteúdo.', icon: Library },
          { tab: 'educator' as HubTab, title: 'Prepare uma aula', text: 'Transforme um objetivo em uma sequência prática.', icon: Sparkles },
          { tab: 'wolfie' as HubTab, title: 'Viva uma situação real', text: 'Entre no universo recomendado para seu objetivo, profissão e nível.', icon: Bot },
        ].map(({ tab, title, text, icon: Icon }) => (
          <button key={tab} onClick={() => onNavigate(tab)} className="rounded-3xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
            <Icon className="text-violet-700" />
            <h2 className="mt-5 text-xl font-black">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">{text}</p>
            <span className="mt-5 flex items-center gap-1 text-xs font-black text-violet-700">Começar <ChevronRight size={15} /></span>
          </button>
        ))}
      </section>
    </div>
  );
};

const HubLibrary: React.FC<{
  bootstrap: HubBootstrap;
  content: HubContentItem[];
  onRefresh: () => Promise<void>;
  onUpgrade: () => void;
}> = ({ bootstrap, content, onRefresh, onUpgrade }) => {
  const [search, setSearch] = useState('');
  const [level, setLevel] = useState('ALL');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const hasFullAccess = entitlementRemaining(bootstrap, 'library.full_access') === null;
  const remainingPreviews = entitlementRemaining(bootstrap, 'library.preview');
  const filtered = useMemo(() => content.filter((item) => {
    const query = search.trim().toLocaleLowerCase('pt-BR');
    return (!query || `${item.title} ${item.description || ''} ${item.niche}`.toLocaleLowerCase('pt-BR').includes(query))
      && (level === 'ALL' || item.level_tag === level);
  }), [content, level, search]);

  const open = async (item: HubContentItem) => {
    const asset = hasFullAccess ? 'FULL' : 'PREVIEW';
    if (asset === 'PREVIEW' && !item.preview_enabled) {
      setError('Este material não possui amostra. Ele fica disponível nos planos com biblioteca completa.');
      return;
    }
    setOpeningId(item.id);
    setError('');
    try {
      const { signedUrl } = await openHubContent(item.id, asset);
      window.open(signedUrl, '_blank', 'noopener,noreferrer');
      await onRefresh();
    } catch (caught) {
      setError(friendlyAccessError(caught));
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <div>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div><p className="text-xs font-black uppercase tracking-[0.18em] text-violet-600">Acervo licenciado</p><h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">Biblioteca Wise Wolf</h1><p className="mt-2 text-slate-600">{hasFullAccess ? 'Seu plano libera o acervo completo.' : `${remainingPreviews ?? 0} prévias disponíveis no seu teste.`}</p></div>
        {!hasFullAccess && <button onClick={onUpgrade} className="rounded-2xl bg-slate-950 px-5 py-3 text-sm font-black text-white">Liberar biblioteca completa</button>}
      </div>
      <div className="mt-7 flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white p-4 sm:flex-row">
        <input value={search} onChange={(event) => setSearch(event.target.value)} className="min-w-0 flex-1 rounded-2xl bg-slate-100 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-violet-500" placeholder="Buscar por título, tema ou nicho..." />
        <select value={level} onChange={(event) => setLevel(event.target.value)} className="rounded-2xl bg-slate-100 px-4 py-3 text-sm font-bold outline-none"><option value="ALL">Todos os níveis</option>{['A1','A2','B1','B2','C1','C2'].map((item) => <option key={item}>{item}</option>)}</select>
      </div>
      {error && <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900"><span>{error}</span><button onClick={onUpgrade} className="shrink-0 text-violet-700">Ver planos</button></div>}
      {filtered.length === 0 ? (
        <div className="mt-7 rounded-[2rem] border-2 border-dashed border-slate-200 bg-white py-16 text-center"><Library className="mx-auto text-slate-300" size={42} /><h2 className="mt-4 font-black">A curadoria inicial está sendo preparada</h2><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">Os materiais só serão publicados depois da validação de autoria e licença. O catálogo aparecerá aqui automaticamente.</p></div>
      ) : (
        <div className="mt-7 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item) => (
            <article key={item.id} className="overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-sm">
              <div className="flex aspect-[16/9] items-center justify-center bg-gradient-to-br from-slate-900 via-violet-950 to-violet-700 text-white">{item.cover_url ? <img src={item.cover_url} alt="" className="h-full w-full object-cover" /> : <FileText size={44} />}</div>
              <div className="p-5"><div className="flex gap-2 text-[10px] font-black uppercase"><span className="rounded-full bg-violet-50 px-2.5 py-1 text-violet-700">{item.level_tag || 'Todos'}</span><span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-600">{item.niche}</span></div><h2 className="mt-4 text-xl font-black">{item.title}</h2><p className="mt-2 line-clamp-3 text-sm leading-6 text-slate-600">{item.description}</p><button disabled={openingId === item.id} onClick={() => open(item)} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-black text-white disabled:opacity-60">{openingId === item.id ? <Loader2 size={17} className="animate-spin" /> : <PlayCircle size={17} />}{hasFullAccess ? 'Abrir material' : 'Ver prévia'}</button></div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
};

const HubEducatorAI: React.FC<{ bootstrap: HubBootstrap; onRefresh: () => Promise<void>; onUpgrade: () => void }> = ({ bootstrap, onRefresh, onUpgrade }) => {
  const preferences = bootstrap.account.metadata || {};
  const [level, setLevel] = useState(preferences.level || 'B1');
  const [duration, setDuration] = useState('50');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const entitlement = bootstrap.entitlements['educator_ai.generate'];

  const generate = async () => {
    if (objective.trim().length < 10) return setError('Descreva o objetivo da aula com um pouco mais de detalhe.');
    setLoading(true); setError(''); setResult(null);
    const prompt = `Crie um plano de aula de inglês autoral e aplicável. Perfil do educador/instituição: ${preferences.role || 'não informado'}. Direção pedagógica: ${preferences.goal || 'não informada'}. Temas de interesse: ${preferences.interests || 'não informados'}. Nível CEFR: ${level}. Duração: ${duration} minutos. Objetivo específico desta aula: ${objective}. Contexto adicional: ${context || 'não informado'}. Responda no JSON exato: {"title":"", "objectives":[""], "warmup":{"minutes":5,"instructions":""}, "main_activity":{"minutes":25,"instructions":""}, "practice":{"minutes":15,"instructions":""}, "homework":"", "materials_needed":[""]}. Evite atividades genéricas: conecte cada etapa ao objetivo e ao contexto. Todo o texto explicativo deve estar em português do Brasil e as falas/atividades para o aluno em inglês adequado ao nível.`;
    try {
      const { data, error: functionError } = await supabase.functions.invoke('pedagogical-content', { body: { hubMode: true, prompt, requestKey: crypto.randomUUID() } });
      if (functionError) throw functionError;
      if (data?.error) throw new Error(data.code || data.error);
      setResult(data.result as Record<string, unknown>);
      await onRefresh();
    } catch (caught) { setError(friendlyAccessError(caught)); }
    finally { setLoading(false); }
  };

  return (
    <div className="grid gap-7 xl:grid-cols-[380px_1fr]">
      <div><p className="text-xs font-black uppercase tracking-[0.18em] text-violet-600">Wise Wolf Teaching Studio</p><h1 className="mt-2 text-3xl font-black tracking-tight">Planejamento com intenção pedagógica</h1><p className="mt-3 leading-7 text-slate-600">O plano nasce do resultado esperado, do nível e do contexto que você definiu para sua prática.</p><div className="mt-6 rounded-3xl border border-slate-200 bg-white p-5"><p className="text-xs font-black text-slate-500">SEU CONTEXTO</p><p className="mt-2 text-sm font-black text-slate-900">{preferences.role || 'Personalize seu perfil para recomendações mais precisas'}</p><p className="mt-2 text-xs leading-5 text-slate-500">{preferences.goal}</p></div><div className="mt-4 rounded-3xl border border-slate-200 bg-white p-5"><p className="text-xs font-black text-slate-500">CRÉDITOS DE CRIAÇÃO</p><p className="mt-2 text-2xl font-black">{usageLabel(entitlement?.used || 0, entitlement?.limit)}</p><button onClick={onUpgrade} className="mt-4 text-sm font-black text-violet-700">Aumentar limite <ArrowRight size={14} className="inline" /></button></div></div>
      <div className="rounded-[2rem] border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
        <div className="grid gap-4 sm:grid-cols-2"><label><span className="mb-2 block text-xs font-black">Nível</span><select value={level} onChange={(event) => setLevel(event.target.value)} className="w-full rounded-2xl bg-slate-100 px-4 py-3.5 outline-none">{['A1','A2','B1','B2','C1','C2'].map((item) => <option key={item}>{item}</option>)}</select></label><label><span className="mb-2 block text-xs font-black">Duração</span><select value={duration} onChange={(event) => setDuration(event.target.value)} className="w-full rounded-2xl bg-slate-100 px-4 py-3.5 outline-none">{['30','45','50','60','90'].map((item) => <option key={item} value={item}>{item} minutos</option>)}</select></label></div>
        <label className="mt-4 block"><span className="mb-2 block text-xs font-black">Objetivo da aula</span><textarea value={objective} onChange={(event) => setObjective(event.target.value)} className="min-h-28 w-full rounded-2xl bg-slate-100 px-4 py-3.5 outline-none focus:ring-2 focus:ring-violet-500" placeholder="Ex.: preparar um profissional B1 para apresentar resultados mensais em inglês..." /></label>
        <label className="mt-4 block"><span className="mb-2 block text-xs font-black">Contexto opcional</span><textarea value={context} onChange={(event) => setContext(event.target.value)} className="min-h-20 w-full rounded-2xl bg-slate-100 px-4 py-3.5 outline-none focus:ring-2 focus:ring-violet-500" placeholder="Interesses, profissão, dificuldade ou material que pretende usar..." /></label>
        {error && <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-700">{error}</p>}
        <button onClick={generate} disabled={loading} className="mt-5 flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-5 py-4 text-sm font-black text-white shadow-lg shadow-violet-100 disabled:opacity-60">{loading ? <Loader2 className="animate-spin" size={18} /> : <Sparkles size={18} />}{loading ? 'Criando plano...' : 'Gerar plano de aula'}</button>
        {result && <div className="mt-7 overflow-hidden rounded-3xl border border-violet-200 bg-violet-50/40"><div className="flex items-start justify-between gap-4 border-b border-violet-100 bg-white p-5"><div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-600">Plano Wise Wolf · {level} · {duration} min</p><h2 className="mt-2 text-2xl font-black text-violet-950">{String(result.title || 'Plano de aula personalizado')}</h2></div><button onClick={() => navigator.clipboard.writeText(JSON.stringify(result, null, 2))} className="shrink-0 rounded-xl bg-violet-100 px-3 py-2 text-xs font-black text-violet-700">Copiar plano</button></div><div className="space-y-5 p-5">{Array.isArray(result.objectives) && <div><p className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">Resultados esperados</p><ul className="mt-3 space-y-2">{result.objectives.map((item, index) => <li key={index} className="flex gap-2 text-sm leading-6 text-slate-700"><Check size={16} className="mt-1 shrink-0 text-emerald-600" />{String(item)}</li>)}</ul></div>}<div className="grid gap-3 md:grid-cols-3">{(['warmup','main_activity','practice'] as const).map((key) => { const section = result[key] && typeof result[key] === 'object' ? result[key] as Record<string, unknown> : {}; const labels = { warmup: 'Aquecimento', main_activity: 'Experiência central', practice: 'Prática guiada' }; return <article key={key} className="rounded-2xl border border-violet-100 bg-white p-4"><div className="flex items-center justify-between"><p className="text-xs font-black text-violet-800">{labels[key]}</p><span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-600">{String(section.minutes || '—')} min</span></div><p className="mt-3 text-sm leading-6 text-slate-600">{String(section.instructions || '')}</p></article>; })}</div>{result.homework && <div className="rounded-2xl bg-slate-950 p-5 text-white"><p className="text-xs font-black uppercase tracking-[0.14em] text-violet-300">Continuidade fora da aula</p><p className="mt-2 text-sm leading-6 text-slate-200">{String(result.homework)}</p></div>}{Array.isArray(result.materials_needed) && <p className="text-xs leading-6 text-slate-500"><strong>Materiais:</strong> {result.materials_needed.map(String).join(' · ')}</p>}</div></div>}
      </div>
    </div>
  );
};

const HubPlans: React.FC<{ plans: HubPlan[]; settings: HubSettings; currentPlan?: string; accountName: string; email: string }> = ({ plans, settings, currentPlan, accountName, email }) => {
  const paidPlans = plans.filter((plan) => plan.code !== 'DISCOVERY');
  const [checkoutPlan, setCheckoutPlan] = useState<HubPlan | null>(null);
  const choose = async (plan: HubPlan) => {
    await trackHubEvent('plan_interest', 'hub_plans', { planCode: plan.code });
    if (plan.metadata?.sales_assisted === true) {
      if (settings.support_url) window.open(settings.support_url, '_blank', 'noopener,noreferrer');
      else window.location.href = `/new-saas?hub_plan=${encodeURIComponent(plan.code)}`;
      return;
    }
    setCheckoutPlan(plan);
  };
  return <div><div className="text-center"><p className="text-xs font-black uppercase tracking-[0.18em] text-violet-600">Planos</p><h1 className="mt-2 text-4xl font-black tracking-tight">Cresça no seu ritmo</h1><p className="mx-auto mt-3 max-w-2xl text-slate-600">Comece com uma ferramenta e evolua para a operação escolar completa sem trocar de ecossistema.</p></div><div className="mt-9 grid gap-5 md:grid-cols-2 xl:grid-cols-3">{paidPlans.map((plan) => <article key={plan.id} className={`rounded-[2rem] border bg-white p-6 ${plan.code === currentPlan ? 'border-emerald-500 ring-4 ring-emerald-50' : plan.metadata?.popular === true ? 'border-violet-500 shadow-xl shadow-violet-100' : 'border-slate-200'}`}><div className="flex items-center justify-between"><p className="font-black text-violet-700">{plan.name}</p>{plan.code === currentPlan && <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-black text-emerald-700">ATUAL</span>}</div><div className="mt-4"><span className="text-4xl font-black">R$ {Number(plan.price_monthly || 0).toLocaleString('pt-BR')}</span><span className="text-sm text-slate-500">/mês</span></div>{Number(plan.price_yearly || 0) > 0 && <p className="mt-1 text-xs font-bold text-emerald-700">R$ {Number(plan.price_yearly).toLocaleString('pt-BR')}/ano · 2 meses grátis</p>}<p className="mt-3 min-h-12 text-sm leading-6 text-slate-600">{plan.description}</p><ul className="mt-5 space-y-3 text-sm">{(plan.features || []).map((feature) => <li key={feature} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-emerald-600" />{feature}</li>)}</ul><button onClick={() => choose(plan)} disabled={plan.code === currentPlan} className="mt-6 w-full rounded-2xl bg-slate-950 px-4 py-3.5 text-sm font-black text-white disabled:bg-emerald-600">{plan.code === currentPlan ? 'Plano atual' : plan.metadata?.sales_assisted === true ? 'Falar com especialista' : 'Assinar com Asaas'}</button></article>)}</div>{checkoutPlan && <HubCheckoutDialog plan={checkoutPlan} accountName={accountName} email={email} onClose={() => setCheckoutPlan(null)} />}</div>;
};

const HubPortal: React.FC<HubPortalProps> = ({ bootstrap, plans, settings, content, userEmail, onRefresh, onLogout }) => {
  const [tab, setTab] = useState<HubTab>('overview');
  const [mobileNav, setMobileNav] = useState(false);
  const [personalizing, setPersonalizing] = useState(!bootstrap.account.metadata?.onboarding_completed);
  const navigate = (next: HubTab) => { setTab(next); setMobileNav(false); window.scrollTo({ top: 0 }); };
  const render = () => {
    if (tab === 'library') return <HubLibrary bootstrap={bootstrap} content={content} onRefresh={onRefresh} onUpgrade={() => navigate('plans')} />;
    if (tab === 'educator') return <HubEducatorAI bootstrap={bootstrap} onRefresh={onRefresh} onUpgrade={() => navigate('plans')} />;
    if (tab === 'wolfie') return <HubWolfieStudio bootstrap={bootstrap} onRefresh={onRefresh} onUpgrade={() => navigate('plans')} />;
    if (tab === 'saas') return <HubSaasShowcase compact settings={settings} onCta={() => void trackHubEvent('saas_cta_click', 'hub_portal')} />;
    if (tab === 'plans') return <HubPlans plans={plans} settings={settings} currentPlan={bootstrap.plan?.code} accountName={bootstrap.account.name} email={userEmail} />;
    return <HubOverview bootstrap={bootstrap} onNavigate={navigate} />;
  };
  return (
    <div className="min-h-screen bg-[#eef3fb] font-[Inter] text-slate-950">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-white/10 bg-[#070d1a] p-4 text-white shadow-2xl lg:flex">
        <a href="/hub" className="flex items-center gap-3 px-2 py-3">
          <img src={BRAND_LOGO} alt="Wise Wolf" className="h-9 w-auto max-w-[130px] object-contain" />
          <div className="h-8 w-px bg-white/15" />
          <div><p className="font-[Montserrat] text-xs font-extrabold">HUB</p><p className="mt-1 text-[8px] font-black uppercase tracking-[0.2em] text-blue-400">Ecossistema</p></div>
        </a>
        <nav className="mt-7 space-y-1">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => navigate(id)} className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-black transition ${tab === id ? 'bg-blue-600 text-white shadow-lg shadow-blue-950' : 'text-slate-400 hover:bg-white/[0.06] hover:text-white'}`}>
              <Icon size={18} />{label}
            </button>
          ))}
        </nav>
        <div className="mt-auto rounded-2xl border border-white/[0.07] bg-white/[0.045] p-4">
          <p className="truncate text-xs font-black text-white">{bootstrap.account.name}</p>
          <p className="mt-1 truncate text-[10px] text-slate-500">{userEmail}</p>
          <button onClick={() => setPersonalizing(true)} className="mt-3 text-xs font-black text-blue-400">Personalizar experiência</button>
          <button onClick={onLogout} className="mt-3 flex items-center gap-2 text-xs font-black text-red-400"><LogOut size={14} /> Sair</button>
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-17 items-center justify-between border-b border-slate-200/80 bg-white/85 px-4 backdrop-blur-2xl sm:px-7">
          <div className="flex items-center gap-3">
            <button onClick={() => setMobileNav(true)} className="grid size-10 place-items-center rounded-xl bg-[#070d1a] text-white lg:hidden" aria-label="Abrir menu"><Menu size={19} /></button>
            <div><p className="text-[10px] font-black uppercase tracking-[0.16em] text-blue-600">{bootstrap.plan?.name || 'Hub'}</p><p className="text-sm font-black">{NAV_ITEMS.find((item) => item.id === tab)?.label}</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void onRefresh()} className="grid size-10 place-items-center rounded-xl bg-slate-100 text-slate-600" aria-label="Atualizar"><RefreshCw size={16} /></button>
            <a href="/" className="hidden rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-black text-slate-700 sm:block">Sistema escolar</a>
          </div>
        </header>
        <main className="mx-auto max-w-7xl p-4 sm:p-7 lg:p-9">{render()}</main>
      </div>
      {mobileNav && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm lg:hidden">
          <div className="h-full w-[85%] max-w-xs bg-[#070d1a] p-4 text-white shadow-2xl">
            <div className="flex items-center justify-between px-2 py-3"><img src={BRAND_LOGO} alt="Wise Wolf" className="h-9 w-auto max-w-[135px] object-contain" /><button onClick={() => setMobileNav(false)} className="grid size-9 place-items-center rounded-full bg-white/10"><X size={17} /></button></div>
            <nav className="mt-5 space-y-1">{NAV_ITEMS.map(({ id, label, icon: Icon }) => <button key={id} onClick={() => navigate(id)} className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-black ${tab === id ? 'bg-blue-600 text-white' : 'text-slate-400'}`}><Icon size={18} />{label}</button>)}</nav>
            <button onClick={onLogout} className="mt-8 flex items-center gap-2 px-4 text-sm font-black text-red-400"><LogOut size={16} />Sair</button>
          </div>
        </div>
      )}
      {personalizing && <HubPersonalization accountId={bootstrap.account.id} accountName={bootstrap.account.name} audience={bootstrap.account.audience} initial={bootstrap.account.metadata} onComplete={async () => { await onRefresh(); setPersonalizing(false); }} />}
    </div>
  );
};

export default HubPortal;
