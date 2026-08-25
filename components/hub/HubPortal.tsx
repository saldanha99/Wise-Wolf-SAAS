import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronRight,
  Clock3,
  LayoutDashboard,
  Library,
  Menu,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
  Zap,
} from 'lucide-react';
import MaterialsLibrary, { type CollectionItem, type MaterialItem } from '../MaterialsLibrary';
import ModernSidebar, { type SidebarMenuItem } from '../ModernSidebar';
import { applyTenantBranding } from '../../lib/tenant-branding';
import { supabase } from '../../lib/supabase';
import { UserRole, type Tenant, type TenantMembershipOption, type User as UserType } from '../../types';
import {
  getHubSubscriptionAccessState,
  isHubCatalogReady,
  isHubPlanAvailableToAudience,
  openHubContent,
  trackHubEvent,
} from './hubService';
import type {
  HubAccountSummary,
  HubBillingCycle,
  HubBootstrap,
  HubCheckoutIntent,
  HubContentItem,
  HubPlan,
  HubSettings,
} from './types';
import HubCheckoutDialog from './HubCheckoutDialog';
import HubPersonalization from './HubPersonalization';
import { resolveSystemAppUrl } from './hubRoutes';

const HubEducatorPlanner = React.lazy(() => import('./HubEducatorPlanner'));
const HubWolfieStudio = React.lazy(() => import('./HubWolfieStudio'));

export type HubTab = 'overview' | 'library' | 'educator' | 'wolfie' | 'saas' | 'plans';

interface HubPortalProps {
  bootstrap: HubBootstrap;
  accounts?: HubAccountSummary[];
  plans: HubPlan[];
  settings: HubSettings;
  content: HubContentItem[];
  userId: string;
  userEmail: string;
  onRefresh: () => Promise<void>;
  onLogout: () => Promise<void>;
  onSwitchAccount?: (accountId?: string) => void | Promise<void>;
  initialPlanIntent?: HubCheckoutIntent | null;
  initialTab?: HubTab;
  onPlanIntentConsumed?: () => void;
}

const BRAND_LOGO = 'https://wisewolflanguage.com.br/logo.png';

const NAV_ITEMS: Array<SidebarMenuItem & { id: HubTab }> = [
  { id: 'overview', label: 'Início', icon: LayoutDashboard, primary: true },
  { id: 'library', label: 'Biblioteca', icon: Library, primary: true },
  { id: 'educator', label: 'Educador IA', icon: Sparkles },
  { id: 'wolfie', label: 'Wolfie', icon: Bot, primary: true },
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

const HubModuleLoading = () => (
  <div role="status" className="flex min-h-80 items-center justify-center gap-3 rounded-[2.5rem] border border-brand-border bg-brand-surface text-sm font-bold text-brand-muted">
    <RefreshCw className="animate-spin text-tenant-primary" size={18} /> Preparando módulo nativo...
  </div>
);

const UsageCard: React.FC<{
  label: string;
  used?: number;
  limit?: number | null;
  icon: React.ElementType;
}> = ({ label, used = 0, limit, icon: Icon }) => {
  const percentage = limit == null ? 10 : limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="grid size-10 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><Icon size={19} /></div>
        <span className="text-xs font-black text-brand-muted">{usageLabel(used, limit)}</span>
      </div>
      <p className="mt-4 font-black text-brand-text">{label}</p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-brand-surface-2"><div className="h-full rounded-full bg-tenant-primary" style={{ width: `${percentage}%` }} /></div>
    </div>
  );
};

const HubOverview: React.FC<{
  bootstrap: HubBootstrap;
  canUseEducator: boolean;
  onNavigate: (tab: HubTab) => void;
}> = ({ bootstrap, canUseEducator, onNavigate }) => {
  const accessState = getHubSubscriptionAccessState(bootstrap.subscription);
  const hasCurrentAccess = accessState === 'ACTIVE_TRIAL' || accessState === 'ACTIVE_PAID';
  const trialEnd = bootstrap.subscription?.trial_ends_at;
  const daysLeft = accessState === 'ACTIVE_TRIAL' && trialEnd ? Math.max(1, Math.ceil((new Date(trialEnd).getTime() - Date.now()) / 86_400_000)) : null;
  const preview = bootstrap.entitlements['library.preview'];
  const ai = bootstrap.entitlements['educator_ai.generate'];
  const wolfie = bootstrap.entitlements['wolfie.turn'];
  const preferences = bootstrap.memberProfile || {};
  const displayName = bootstrap.memberProfile?.display_name || bootstrap.account.name;
  return (
    <div className="space-y-7">
      <section className="rounded-[2.25rem] border border-brand-border bg-brand-surface p-7 shadow-sm sm:p-10">
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-tenant-primary/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">
            <Zap size={12} /> {hasCurrentAccess ? 'Plano' : 'Última experiência'} {bootstrap.plan?.name || 'Wise Wolf Hub'}
          </div>
          <h1 className="mt-5 text-3xl font-black tracking-tight text-brand-text sm:text-5xl">Olá, {displayName.split(' ')[0]}. Seu próximo avanço começa pelo contexto.</h1>
          <p className="mt-4 max-w-2xl leading-7 text-brand-muted">{preferences.goal || 'Explore materiais, prepare uma aula com IA ou pratique com o Wolfie. Cada experiência aprende com suas escolhas.'}</p>
          {preferences.role && <p className="mt-3 text-xs font-black uppercase tracking-[0.14em] text-tenant-primary">Experiência calibrada para: {preferences.role}</p>}
          <div className="mt-7 flex flex-wrap gap-3">
            {hasCurrentAccess ? (
              <>
                <button onClick={() => onNavigate('library')} className="rounded-2xl bg-tenant-primary px-5 py-3 text-sm font-black text-white">Explorar biblioteca</button>
                {canUseEducator && <button onClick={() => onNavigate('educator')} className="rounded-2xl border border-brand-border bg-brand-surface-2 px-5 py-3 text-sm font-black text-brand-text">Criar com IA</button>}
                <button onClick={() => onNavigate('wolfie')} className="rounded-2xl border border-brand-border bg-brand-surface-2 px-5 py-3 text-sm font-black text-brand-text">Entrar em um universo Wolfie</button>
              </>
            ) : (
              <button onClick={() => onNavigate('plans')} className="rounded-2xl bg-tenant-primary px-5 py-3 text-sm font-black text-white">Escolher plano e retomar</button>
            )}
          </div>
        </div>
      </section>

      {accessState === 'ACTIVE_TRIAL' && (
        <div className="flex flex-col justify-between gap-4 rounded-3xl border border-amber-200 bg-amber-50 p-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-amber-100 text-amber-700"><Clock3 size={20} /></div>
            <div><p className="font-black text-amber-950">Seu teste está ativo</p><p className="text-sm text-amber-800">{daysLeft} {daysLeft === 1 ? 'dia restante' : 'dias restantes'} para experimentar o Hub.</p></div>
          </div>
          <button onClick={() => onNavigate('plans')} className="rounded-xl bg-amber-900 px-4 py-2.5 text-xs font-black text-white">Ver planos</button>
        </div>
      )}

      {(accessState === 'EXPIRED' || accessState === 'NONE') && (
        <div className="flex flex-col justify-between gap-4 rounded-3xl border border-rose-200 bg-rose-50 p-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-rose-100 text-rose-700"><Clock3 size={20} /></div>
            <div><p className="font-black text-rose-950">Seu acesso precisa de um plano</p><p className="text-sm text-rose-800">Escolha a experiência ideal para retomar materiais e inteligência imediatamente após a confirmação.</p></div>
          </div>
          <button onClick={() => onNavigate('plans')} className="rounded-xl bg-rose-900 px-4 py-2.5 text-xs font-black text-white">Escolher plano</button>
        </div>
      )}

      <div className={`grid gap-4 ${canUseEducator ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        <UsageCard label="Acessos à biblioteca" used={preview?.used} limit={preview?.limit} icon={BookOpen} />
        {canUseEducator && <UsageCard label="Gerações com IA" used={ai?.used} limit={ai?.limit} icon={Sparkles} />}
        <UsageCard label="Interações Wolfie" used={wolfie?.used} limit={wolfie?.limit} icon={Bot} />
      </div>

      <section className="grid gap-4 lg:grid-cols-3">
        {[
          { tab: 'library' as HubTab, title: 'Encontre o material certo', text: 'Use nível e nicho para chegar mais rápido ao conteúdo.', icon: Library },
          { tab: 'educator' as HubTab, title: 'Prepare uma aula', text: 'Transforme um objetivo em uma sequência prática.', icon: Sparkles },
          { tab: 'wolfie' as HubTab, title: 'Viva uma situação real', text: 'Entre no universo recomendado para seu objetivo, profissão e nível.', icon: Bot },
        ].filter(({ tab }) => tab !== 'educator' || canUseEducator).map(({ tab, title, text, icon: Icon }) => (
          <button key={tab} onClick={() => onNavigate(tab)} className="rounded-3xl border border-brand-border bg-brand-surface p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
            <Icon className="text-tenant-primary" />
            <h2 className="mt-5 text-xl font-black text-brand-text">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-brand-muted">{text}</p>
            <span className="mt-5 flex items-center gap-1 text-xs font-black text-tenant-primary">Começar <ChevronRight size={15} /></span>
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
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const openRequestEpochRef = useRef(0);
  const hasFullAccess = entitlementRemaining(bootstrap, 'library.full_access') === null;
  const remainingPreviews = entitlementRemaining(bootstrap, 'library.preview');

  useEffect(() => () => {
    openRequestEpochRef.current += 1;
  }, [bootstrap.account.id]);

  // O catálogo do Hub é o MESMO módulo da escola (`MaterialsLibrary`): busca,
  // agrupamento por pasta/nível/nicho e os cards vêm de lá, sem cópia de layout.
  // Só o que é específico do Hub fica aqui — franquia, prévia e a abertura
  // assinada. `file_url` de propósito NÃO é mapeado: no Hub o caminho do arquivo
  // nunca chega ao navegador.
  const materials = useMemo<MaterialItem[]>(() => content.map((item) => ({
    id: item.id,
    title: item.title,
    type: item.content_type,
    level_tag: item.level_tag || undefined,
    niche: item.niche,
    collection_id: item.collection_id ?? null,
    part_number: item.part_number ?? null,
  })), [content]);

  const collections = useMemo<CollectionItem[]>(() => {
    const seen = new Map<string, CollectionItem>();
    for (const item of content) {
      if (!item.collection_id || seen.has(item.collection_id)) continue;
      seen.set(item.collection_id, {
        id: item.collection_id,
        title: item.collection_name || 'Coleção',
        niche: item.niche,
        level_tag: item.level_tag || undefined,
        cover_url: item.cover_url,
      });
    }
    return [...seen.values()];
  }, [content]);

  const openMaterial = async (material: MaterialItem) => {
    const item = content.find((candidate) => candidate.id === material.id);
    if (!item) return;
    const asset = hasFullAccess ? 'FULL' : 'PREVIEW';
    if (asset === 'PREVIEW' && !item.preview_enabled) {
      setError('Este material não possui amostra. Ele fica disponível nos planos com biblioteca completa.');
      return;
    }
    const requestEpoch = ++openRequestEpochRef.current;
    setOpeningId(item.id);
    setError('');
    try {
      const { signedUrl } = await openHubContent(bootstrap.account.id, item.id, asset);
      if (requestEpoch !== openRequestEpochRef.current) return;
      window.open(signedUrl, '_blank', 'noopener,noreferrer');
      await onRefresh();
    } catch (caught) {
      if (requestEpoch !== openRequestEpochRef.current) return;
      setError(friendlyAccessError(caught));
    } finally {
      if (requestEpoch === openRequestEpochRef.current) setOpeningId(null);
    }
  };

  return (
    <div>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.18em] text-tenant-primary">Acervo licenciado</p>
          <h1 className="mt-2 text-3xl font-black tracking-tight text-brand-text sm:text-4xl">Biblioteca Wise Wolf</h1>
          <p className="mt-2 text-brand-muted">{hasFullAccess ? 'Seu plano libera o acervo completo.' : `${remainingPreviews ?? 0} prévias disponíveis no seu teste.`}</p>
        </div>
        {!hasFullAccess && <button onClick={onUpgrade} className="rounded-2xl bg-tenant-primary px-5 py-3 text-sm font-black text-white">Liberar biblioteca completa</button>}
      </div>
      {error && <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold text-amber-900"><span>{error}</span><button onClick={onUpgrade} className="shrink-0 text-tenant-primary">Ver planos</button></div>}
      {openingId && <p className="mt-4 text-sm font-bold text-brand-muted">Liberando acesso ao material...</p>}
      <div className="mt-7">
        <MaterialsLibrary
          materials={materials}
          collections={collections.length > 0 ? collections : undefined}
          onOpenMaterial={openMaterial}
          emptyText="Os materiais só são publicados depois da validação de autoria e licença. O catálogo aparece aqui automaticamente."
        />
      </div>
    </div>
  );
};

const HubPlans: React.FC<{
  plans: HubPlan[];
  settings: HubSettings;
  accountId: string;
  accountAudience: HubBootstrap['account']['audience'];
  activePlan?: string;
  activeBillingCycle?: HubBillingCycle | null;
  isManager: boolean;
  accountName: string;
  email: string;
  initialPlanIntent?: HubCheckoutIntent | null;
  onPlanIntentConsumed?: () => void;
  catalogReady: boolean;
}> = ({ plans, settings, accountId, accountAudience, activePlan, activeBillingCycle, isManager, accountName, email, initialPlanIntent, onPlanIntentConsumed, catalogReady }) => {
  const paidPlans = useMemo(() => plans.filter((plan) => plan.code !== 'DISCOVERY' && isHubPlanAvailableToAudience(plan, accountAudience)), [accountAudience, plans]);
  const [checkoutSelection, setCheckoutSelection] = useState<{ plan: HubPlan; billingCycle?: HubBillingCycle } | null>(null);
  const processedIntentRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPlanIntent) return;
    const intentKey = `${initialPlanIntent.planCode}:${initialPlanIntent.billingCycle}:${initialPlanIntent.expiresAt}`;
    if (processedIntentRef.current === intentKey) return;
    const intendedPlan = paidPlans.find((plan) => plan.code === initialPlanIntent.planCode);
    if (!intendedPlan || intendedPlan.audience === 'INSTITUTION' || intendedPlan.metadata?.sales_assisted === true) {
      processedIntentRef.current = intentKey;
      onPlanIntentConsumed?.();
      return;
    }
    if (!isManager) return;
    processedIntentRef.current = intentKey;
    const intendedPrice = Number(initialPlanIntent.billingCycle === 'YEARLY' ? intendedPlan.price_yearly : intendedPlan.price_monthly);
    onPlanIntentConsumed?.();
    if (!catalogReady || intendedPrice <= 0 || (intendedPlan.code === activePlan && initialPlanIntent.billingCycle === activeBillingCycle)) return;
    void trackHubEvent('plan_interest', 'hub_marketing_intent', {
      planCode: intendedPlan.code,
      billingCycle: initialPlanIntent.billingCycle,
    }, accountId);
    setCheckoutSelection({ plan: intendedPlan, billingCycle: initialPlanIntent.billingCycle });
  }, [accountId, activeBillingCycle, activePlan, catalogReady, initialPlanIntent, isManager, onPlanIntentConsumed, paidPlans]);
  useEffect(() => {
    if (!catalogReady) setCheckoutSelection(null);
  }, [catalogReady]);
  const choose = async (plan: HubPlan) => {
    if (!isManager) return;
    const salesAssisted = plan.audience === 'INSTITUTION' || plan.metadata?.sales_assisted === true;
    if (!catalogReady && !salesAssisted) return;
    await trackHubEvent('plan_interest', 'hub_plans', { planCode: plan.code }, accountId);
    if (salesAssisted) {
      const fallbackPath = `/new-saas?hub_plan=${encodeURIComponent(plan.code)}`;
      if (settings.support_url) window.open(resolveSystemAppUrl(settings.support_url, fallbackPath), '_blank', 'noopener,noreferrer');
      else window.location.href = resolveSystemAppUrl(fallbackPath);
      return;
    }
    setCheckoutSelection({ plan });
  };
  return (
    <div>
      <div className="text-center">
        <p className="text-xs font-black uppercase tracking-[0.18em] text-tenant-primary">Planos</p>
        <h1 className="mt-2 text-4xl font-black tracking-tight text-brand-text">Cresça no seu ritmo</h1>
        <p className="mx-auto mt-3 max-w-2xl text-brand-muted">Comece com uma ferramenta e evolua para a operação escolar completa sem trocar de ecossistema.</p>
      </div>
      {!isManager && <p className="mx-auto mt-6 max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-sm font-bold leading-6 text-amber-900">Somente o responsável ou um administrador pode contratar ou trocar o plano. Fale com o responsável desta conta para continuar.</p>}
      {!catalogReady && <p role="status" className="mx-auto mt-6 max-w-2xl rounded-2xl border border-sky-200 bg-sky-50 p-4 text-center text-sm font-bold leading-6 text-sky-950 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-100"><span className="block font-black">Catálogo em curadoria · abertura em breve</span>O teste gratuito e as assinaturas do Hub Core permanecem fechados até a publicação do acervo validado. Wolfie e School OS continuam disponíveis normalmente.</p>}
      <div className="mt-9 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {paidPlans.map((plan) => {
          const salesAssisted = plan.audience === 'INSTITUTION' || plan.metadata?.sales_assisted === true;
          const monthlyPrice = Number(plan.price_monthly || 0);
          const yearlyPrice = Number(plan.price_yearly || 0);
          const yearlySavings = Math.max((monthlyPrice * 12) - yearlyPrice, 0);
          const isCurrentPlan = plan.code === activePlan;
          const alternativeCycleAvailable = isCurrentPlan && (
            (activeBillingCycle === 'MONTHLY' && Number(plan.price_yearly || 0) > 0) ||
            (activeBillingCycle === 'YEARLY' && Number(plan.price_monthly || 0) > 0)
          );
          const checkoutUnavailable = (!catalogReady && !salesAssisted) || (isCurrentPlan && !alternativeCycleAvailable);
          return (
            <article key={plan.id} className={`rounded-[2rem] border bg-brand-surface p-6 text-brand-text ${isCurrentPlan ? 'border-emerald-500 ring-4 ring-emerald-500/10' : plan.metadata?.popular === true ? 'border-tenant-primary shadow-xl shadow-tenant-primary/10' : 'border-brand-border'}`}>
              <div className="flex items-center justify-between">
                <p className="font-black text-tenant-primary">{plan.name}</p>
                {isCurrentPlan && <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-black text-emerald-700">ATUAL</span>}
              </div>
              {salesAssisted ? <p className="mt-4 text-3xl font-black">Sob medida</p> : <div className="mt-4"><span className="text-4xl font-black">R$ {monthlyPrice.toLocaleString('pt-BR')}</span><span className="text-sm text-brand-muted">/mês</span></div>}
              {!salesAssisted && yearlyPrice > 0 && <p className="mt-1 text-xs font-bold text-emerald-700">R$ {yearlyPrice.toLocaleString('pt-BR')}/ano{yearlySavings > 0 ? ` · economia de R$ ${yearlySavings.toLocaleString('pt-BR')}` : ''}</p>}
              <p className="mt-3 min-h-12 text-sm leading-6 text-brand-muted">{plan.description}</p>
              <ul className="mt-5 space-y-3 text-sm">{(plan.features || []).map((feature) => <li key={feature} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-emerald-600" />{feature}</li>)}</ul>
              <button onClick={() => choose(plan)} disabled={!isManager || checkoutUnavailable} className="mt-6 w-full rounded-2xl bg-tenant-primary px-4 py-3.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-brand-surface-2 disabled:text-brand-muted">
                {!isManager ? 'Fale com o responsável da conta' : !catalogReady && !salesAssisted ? 'Abertura em breve' : salesAssisted ? 'Falar com especialista' : isCurrentPlan ? alternativeCycleAvailable ? 'Alterar ciclo' : 'Plano atual' : activePlan ? 'Trocar para este plano' : 'Assinar com Asaas'}
              </button>
            </article>
          );
        })}
      </div>
      {checkoutSelection && (
        <HubCheckoutDialog
          plan={checkoutSelection.plan}
          accountId={accountId}
          accountName={accountName}
          email={email}
          isCurrentPlan={checkoutSelection.plan.code === activePlan}
          replacingSubscription={Boolean(activePlan)}
          currentBillingCycle={checkoutSelection.plan.code === activePlan ? activeBillingCycle : null}
          initialBillingCycle={checkoutSelection.billingCycle}
          onClose={() => setCheckoutSelection(null)}
        />
      )}
    </div>
  );
};

const HubSubscriptionCancellation: React.FC<{
  bootstrap: HubBootstrap;
  onRefresh: () => Promise<void>;
}> = ({ bootstrap, onRefresh }) => {
  const subscription = bootstrap.subscription;
  const subscriptionMetadata = subscription && typeof (subscription as { metadata?: unknown }).metadata === 'object'
    ? (subscription as { metadata?: Record<string, unknown> }).metadata || {}
    : {};
  const canManage = bootstrap.isManager === true
    && ['OWNER', 'ADMIN'].includes(bootstrap.membership.membership_role);
  const isHubCore = subscription?.product_family === 'HUB_CORE'
    || bootstrap.plan?.product_family === 'HUB_CORE';
  const hasPaidAccess = getHubSubscriptionAccessState(subscription) === 'ACTIVE_PAID';
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [scheduledResult, setScheduledResult] = useState<{ accessEndsAt?: string | null } | null>(null);
  const scheduled = subscriptionMetadata.cancelAtPeriodEnd === true || scheduledResult != null;
  const accessEndsAt = scheduledResult?.accessEndsAt
    || (typeof subscriptionMetadata.accessEndsAt === 'string' ? subscriptionMetadata.accessEndsAt : null)
    || subscription?.current_period_ends_at
    || null;
  const formattedEnd = accessEndsAt
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date(accessEndsAt))
    : 'o fim do período já pago';

  if (!canManage || !isHubCore || !hasPaidAccess) return null;

  const submitCancellation = async () => {
    if (confirmation.trim().toUpperCase() !== 'CANCELAR' || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('cancel-hub-subscription', {
        body: { accountId: bootstrap.account.id, confirmation: 'CANCELAR' },
      });
      const code = data?.code || data?.error || invokeError?.message;
      if (invokeError || data?.success !== true) throw new Error(code || 'HUB_CANCELLATION_FAILED');
      setScheduledResult({ accessEndsAt: data.accessEndsAt || subscription?.current_period_ends_at });
      setConfirming(false);
      setConfirmation('');
      try {
        await onRefresh();
      } catch {}
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes('HUB_MANAGER_REQUIRED')) setError('Somente o responsável ou um administrador pode cancelar a renovação.');
      else if (message.includes('RECONCILIATION') || message.includes('PROVIDER')) setError('A cobrança precisa de uma conferência segura antes do cancelamento. Nenhuma data de acesso foi alterada.');
      else setError('Não foi possível cancelar a renovação agora. Seu acesso e sua cobrança permanecem sem alteração.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mt-8 rounded-[2rem] border border-brand-border bg-brand-surface p-6 text-brand-text shadow-sm sm:p-8" aria-labelledby="hub-subscription-management-title">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><ShieldCheck size={20} /></div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Gestão da assinatura</p>
            <h2 id="hub-subscription-management-title" className="mt-1 text-xl font-black">{scheduled ? 'Renovação cancelada' : 'Renovação automática ativa'}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-brand-muted">{scheduled ? `Seu acesso continua normalmente até ${formattedEnd}. Depois disso, você poderá contratar uma nova assinatura.` : `Ao cancelar, nenhuma nova cobrança será agendada e seu acesso continuará até ${formattedEnd}.`}</p>
          </div>
        </div>
        {!scheduled && <button type="button" onClick={() => { setConfirming(true); setError(''); }} className="shrink-0 rounded-2xl border border-rose-300 px-5 py-3 text-sm font-black text-rose-700 transition hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40">Cancelar renovação</button>}
      </div>
      {error && <p role="alert" className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold text-rose-900 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-100">{error}</p>}
      {confirming && (
        <div role="dialog" aria-modal="true" aria-labelledby="hub-cancellation-title" className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-[2rem] border border-brand-border bg-brand-surface p-6 shadow-2xl sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-[10px] font-black uppercase tracking-[0.18em] text-rose-600">Confirmação final</p><h2 id="hub-cancellation-title" className="mt-2 text-2xl font-black text-brand-text">Cancelar somente a renovação?</h2></div>
              <button type="button" onClick={() => { setConfirming(false); setConfirmation(''); }} className="grid size-10 place-items-center rounded-xl bg-brand-surface-2 text-brand-muted" aria-label="Fechar confirmação"><X size={18} /></button>
            </div>
            <p className="mt-4 text-sm leading-6 text-brand-muted">A recorrência no Asaas será encerrada primeiro. Seu acesso continuará até <strong className="text-brand-text">{formattedEnd}</strong>, sem apagar histórico ou materiais.</p>
            <label htmlFor="hub-cancellation-confirmation" className="mt-6 block text-sm font-black text-brand-text">Digite CANCELAR para confirmar</label>
            <input id="hub-cancellation-confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" className="mt-2 w-full rounded-2xl border border-brand-border bg-brand-surface-2 px-4 py-3 font-bold uppercase text-brand-text outline-none focus:border-tenant-primary" />
            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => { setConfirming(false); setConfirmation(''); }} className="rounded-2xl border border-brand-border px-5 py-3 text-sm font-black text-brand-text">Manter assinatura</button>
              <button type="button" onClick={() => void submitCancellation()} disabled={confirmation.trim().toUpperCase() !== 'CANCELAR' || submitting} className="rounded-2xl bg-rose-600 px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40">{submitting ? 'Cancelando com segurança...' : 'Confirmar cancelamento'}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};

const HubAccessRequired: React.FC<{ onChoosePlan: () => void }> = ({ onChoosePlan }) => (
  <section className="mx-auto max-w-2xl rounded-[2rem] border border-rose-200 bg-brand-surface p-8 text-center shadow-sm sm:p-12 dark:border-rose-900">
    <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-rose-100 text-rose-700"><Clock3 size={24} /></div>
    <p className="mt-5 text-xs font-black uppercase tracking-[0.18em] text-rose-600">Acesso pausado</p>
    <h1 className="mt-3 text-3xl font-black tracking-tight text-brand-text">Escolha um plano para continuar</h1>
    <p className="mx-auto mt-3 max-w-lg leading-7 text-brand-muted">Seu histórico e suas preferências permanecem preservados. Os recursos voltam assim que o pagamento for confirmado.</p>
    <button onClick={onChoosePlan} className="mt-7 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Ver planos disponíveis</button>
  </section>
);

const HubSchoolSystemAccess: React.FC<{
  bootstrap: HubBootstrap;
  settings: HubSettings;
}> = ({ bootstrap, settings }) => {
  const destination = resolveSystemAppUrl(
    settings.saas_cta_url,
    `/new-saas?hub_account=${encodeURIComponent(bootstrap.account.id)}`,
  );
  return (
    <section className="mx-auto max-w-4xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-7 shadow-xl sm:p-10">
      <div className="grid gap-8 lg:grid-cols-[1fr_300px] lg:items-center">
        <div>
          <div className="grid size-14 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><Building2 size={26} /></div>
          <p className="mt-6 text-[10px] font-black uppercase tracking-[0.18em] text-tenant-primary">Wise Wolf School OS</p>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-brand-text sm:text-4xl">A operação escolar abre em um tenant próprio.</h1>
          <p className="mt-4 max-w-2xl leading-7 text-brand-muted">O Hub não simula telas administrativas. Quando uma escola é provisionada, ela recebe o mesmo sistema nativo com banco, equipe, credenciais, branding e políticas de acesso isolados.</p>
          <a
            href={destination}
            onClick={() => void trackHubEvent('saas_cta_click', 'hub_portal', {}, bootstrap.account.id)}
            className="mt-7 inline-flex rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white"
          >
            Configurar ambiente escolar
          </a>
        </div>
        <div className="rounded-3xl border border-brand-border bg-brand-surface-2 p-6">
          <p className="text-xs font-black uppercase tracking-widest text-brand-muted">Separação garantida</p>
          <ul className="mt-5 space-y-4 text-sm font-bold text-brand-text">
            {['Dados da escola', 'Usuários e permissões', 'Credenciais e integrações', 'Identidade visual'].map((item) => (
              <li key={item} className="flex items-center gap-3"><Check size={17} className="shrink-0 text-emerald-500" />{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
};

const HubPortal: React.FC<HubPortalProps> = ({ bootstrap, accounts = [], plans, settings, content, userId, userEmail, onRefresh, onLogout, onSwitchAccount, initialPlanIntent, initialTab = 'overview', onPlanIntentConsumed }) => {
  const accessState = getHubSubscriptionAccessState(bootstrap.subscription);
  const hasCurrentAccess = accessState === 'ACTIVE_TRIAL' || accessState === 'ACTIVE_PAID';
  const [tab, setTab] = useState<HubTab>(() => initialPlanIntent ? 'plans' : hasCurrentAccess ? initialTab : 'plans');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (
    (localStorage.getItem('theme') as 'light' | 'dark')
    || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  ));
  const [personalizing, setPersonalizing] = useState(
    hasCurrentAccess
    && !bootstrap.memberProfile?.onboarding_completed,
  );
  const mainScrollRef = useRef<HTMLElement>(null);
  const activePaidPlan = accessState === 'ACTIVE_PAID' ? bootstrap.plan?.code : undefined;
  const activeBillingCycle = accessState === 'ACTIVE_PAID'
    ? (bootstrap.subscription as (HubBootstrap['subscription'] & { billing_cycle?: HubBillingCycle | null }))?.billing_cycle
    : null;
  const canUseEducator = bootstrap.memberProfile?.subjectRole === 'EDUCATOR';
  const personalizationAudience = bootstrap.membership.membership_role === 'MEMBER'
    ? bootstrap.memberProfile?.subjectRole || 'LEARNER'
    : bootstrap.account.audience;
  const visibleNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => item.id !== 'educator' || canUseEducator),
    [canUseEducator],
  );
  const hubTenant = useMemo<Tenant>(() => ({
    id: bootstrap.account.id,
    name: bootstrap.account.name,
    domain: 'hub.wisewolflanguage.com.br',
    branding: {
      logoUrl: BRAND_LOGO,
      faviconUrl: '',
      primaryColor: '#002366',
      secondaryColor: '#D32F2F',
    },
    studentLimit: 0,
    teacherLimit: 0,
  }), [bootstrap.account.id, bootstrap.account.name]);
  const hubUser = useMemo<UserType>(() => ({
    id: userId,
    tenantId: bootstrap.account.id,
    name: bootstrap.memberProfile?.display_name || bootstrap.account.name,
    email: userEmail,
    role: bootstrap.memberProfile?.subjectRole === 'LEARNER'
      ? UserRole.STUDENT
      : bootstrap.memberProfile?.subjectRole === 'EDUCATOR'
        ? UserRole.TEACHER
        : UserRole.NON_STUDENT,
  }), [bootstrap.account.id, bootstrap.account.name, bootstrap.memberProfile?.display_name, bootstrap.memberProfile?.subjectRole, userEmail, userId]);
  const hubTenantMemberships = useMemo<TenantMembershipOption[]>(() => accounts.map((account) => ({
    tenant_id: account.id,
    tenant_name: account.name,
    role: account.membership_role === 'MEMBER' ? UserRole.NON_STUDENT : UserRole.SCHOOL_ADMIN,
    is_primary: account.membership_role === 'OWNER',
    is_active: account.id === bootstrap.account.id,
  })), [accounts, bootstrap.account.id]);
  const navigate = (next: HubTab) => {
    setTab(next);
    setSidebarOpen(false);
    if (typeof mainScrollRef.current?.scrollTo === 'function') {
      mainScrollRef.current.scrollTo({ top: 0 });
    } else if (mainScrollRef.current) {
      mainScrollRef.current.scrollTop = 0;
    }
  };
  useEffect(() => {
    applyTenantBranding(hubTenant.branding.primaryColor, hubTenant.branding.secondaryColor);
  }, [hubTenant]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);
  useEffect(() => {
    if (initialPlanIntent) setTab('plans');
  }, [initialPlanIntent]);
  useEffect(() => {
    if (!initialPlanIntent && hasCurrentAccess) setTab(initialTab);
  }, [hasCurrentAccess, initialPlanIntent, initialTab]);
  useEffect(() => {
    if (tab === 'educator' && !canUseEducator) setTab('overview');
  }, [canUseEducator, tab]);
  const render = () => {
    if (!hasCurrentAccess && ['library', 'educator', 'wolfie'].includes(tab)) return <HubAccessRequired onChoosePlan={() => navigate('plans')} />;
    if (tab === 'educator' && !canUseEducator) return <HubAccessRequired onChoosePlan={() => navigate('overview')} />;
    if (tab === 'library') return <HubLibrary bootstrap={bootstrap} content={content} onRefresh={onRefresh} onUpgrade={() => navigate('plans')} />;
    if (tab === 'educator') return <React.Suspense fallback={<HubModuleLoading />}><HubEducatorPlanner bootstrap={bootstrap} userEmail={userEmail} onRefresh={onRefresh} onUpgrade={() => navigate('plans')} /></React.Suspense>;
    if (tab === 'wolfie') return <React.Suspense fallback={<HubModuleLoading />}><HubWolfieStudio bootstrap={bootstrap} onRefresh={onRefresh} onUpgrade={() => navigate('plans')} /></React.Suspense>;
    if (tab === 'saas') return <HubSchoolSystemAccess bootstrap={bootstrap} settings={settings} />;
    if (tab === 'plans') return <><HubPlans plans={plans} settings={settings} accountId={bootstrap.account.id} accountAudience={bootstrap.account.audience} activePlan={activePaidPlan} activeBillingCycle={activeBillingCycle} isManager={bootstrap.isManager === true} accountName={bootstrap.account.name} email={userEmail} initialPlanIntent={initialPlanIntent} onPlanIntentConsumed={onPlanIntentConsumed} catalogReady={isHubCatalogReady(settings, content)} /><HubSubscriptionCancellation bootstrap={bootstrap} onRefresh={onRefresh} /></>;
    return <HubOverview bootstrap={bootstrap} canUseEducator={canUseEducator} onNavigate={navigate} />;
  };
  return (
    <div className={`app-shell flex h-dvh max-h-dvh w-full overflow-hidden ${theme === 'dark' ? 'dark' : ''}`}>
      <div className="flex h-full min-h-0 w-full overflow-hidden bg-slate-50 font-sans text-slate-900 dark:bg-slate-950 dark:text-slate-100">
        <ModernSidebar
          tenant={hubTenant}
          user={hubUser}
          activeTab={tab}
          setActiveTab={(next) => {
            if (next === 'profile') {
              setPersonalizing(true);
              setSidebarOpen(false);
              return;
            }
            if (visibleNavItems.some((item) => item.id === next)) navigate(next as HubTab);
          }}
          pendingLessonsCount={0}
          onLogout={() => void onLogout()}
          isOpen={sidebarOpen}
          setIsOpen={setSidebarOpen}
          isCollapsed={sidebarCollapsed}
          setIsCollapsed={setSidebarCollapsed}
          theme={theme}
          toggleTheme={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
          tenantMemberships={hubTenantMemberships}
          onTenantSwitch={onSwitchAccount ? async (accountId) => { await onSwitchAccount(accountId); } : undefined}
          menuItemsOverride={visibleNavItems}
          contextLabel={bootstrap.plan?.name || 'Conta Hub'}
          mobilePrimaryNavigation
        />
        <main ref={mainScrollRef} tabIndex={-1} aria-label="Conteúdo principal" className="app-main-scroll flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-clip outline-none">
          <header className="sticky top-0 z-40 w-full border-b border-gray-200 bg-white/80 backdrop-blur-md dark:border-gray-800 dark:bg-slate-900/80">
            <div className="flex h-16 items-center justify-between px-3 sm:px-6">
          <div className="flex items-center gap-3">
                <button type="button" onClick={() => setSidebarOpen(true)} className="p-2 text-gray-600 dark:text-gray-400 lg:hidden" aria-label="Abrir menu" aria-controls="app-primary-navigation" aria-expanded={sidebarOpen}><Menu size={22} /></button>
                <div className="min-w-0"><p className="max-w-[48vw] truncate text-[10px] font-black uppercase tracking-[0.16em] text-tenant-primary sm:max-w-none">{bootstrap.account.name}</p><p className="text-sm font-black text-brand-text">{visibleNavItems.find((item) => item.id === tab)?.label}</p></div>
          </div>
          <div className="flex items-center gap-2">
                <button onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')} className="grid size-10 place-items-center rounded-xl bg-brand-surface-2 text-brand-muted" aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button>
                <button onClick={() => void onRefresh()} className="grid size-10 place-items-center rounded-xl bg-brand-surface-2 text-brand-muted" aria-label="Atualizar"><RefreshCw size={16} /></button>
                {onSwitchAccount && <button onClick={() => void onSwitchAccount()} className="hidden rounded-xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text sm:block">Trocar ambiente</button>}
                <a href={resolveSystemAppUrl('/')} className="hidden rounded-xl border border-brand-border bg-brand-surface px-4 py-2.5 text-xs font-black text-brand-text sm:block">Sistema escolar</a>
              </div>
            </div>
          </header>
          <div className="mx-auto w-full max-w-7xl p-4 pb-24 sm:p-7 lg:p-9 lg:pb-9">{render()}</div>
        </main>
      </div>
      {personalizing && <HubPersonalization accountId={bootstrap.account.id} accountName={bootstrap.memberProfile?.display_name || bootstrap.account.name} audience={personalizationAudience} initial={bootstrap.memberProfile} onClose={bootstrap.memberProfile?.onboarding_completed ? () => setPersonalizing(false) : undefined} onComplete={async () => { await onRefresh(); setPersonalizing(false); }} />}
    </div>
  );
};

export default HubPortal;
