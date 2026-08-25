import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Bot, Building2, Compass, Loader2, ShieldAlert } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import HubAuthDialog from './HubAuthDialog';
import HubAudienceLanding from './HubAudienceLanding';
import HubLanding from './HubLanding';
import HubLegalPage from './HubLegalPage';
import HubMarketingShell from './HubMarketingShell';
import HubPortal, { type HubTab } from './HubPortal';
import HubSolutionLanding from './HubSolutionLanding';
import {
  clearStoredHubCheckoutIntent,
  createHubCheckoutIntent,
  persistHubCheckoutIntent,
  removeHubCheckoutIntentFromUrl,
  restoreHubCheckoutIntent,
} from './hubCheckoutIntent';
import {
  claimHubTrial,
  DEFAULT_HUB_SETTINGS,
  isHubCatalogReady,
  isHubEnabled,
  loadHubAccounts,
  loadHubBootstrap,
  loadHubPublicData,
  trackHubEvent,
} from './hubService';
import type {
  HubAccountSummary,
  HubAudience,
  HubBillingCycle,
  HubBootstrap,
  HubCheckoutIntent,
  HubContentItem,
  HubPlan,
  HubSettings,
} from './types';
import { HUB_MARKETING_METADATA, HUB_NOT_FOUND_METADATA } from './hubMetadata';
import {
  hubCanonicalUrl,
  hubMarketingPath,
  resolveHubMarketingPage,
  resolveSystemAppUrl,
  type HubMarketingRoute,
} from './hubRoutes';
import { useHubHashNavigation } from './useHubHashNavigation';

type AuthDialogState = { mode: 'login' | 'signup'; audience: HubAudience } | null;

const AUDIENCE_OPTIONS: Array<{
  audience: HubAudience;
  title: string;
  description: string;
  icon: React.ElementType;
  action: 'TRIAL' | 'WOLFIE' | 'SAAS';
}> = [
  { audience: 'EDUCATOR', title: 'Sou professor', description: 'Ative a descoberta da biblioteca e do Educador IA.', icon: BookOpen, action: 'TRIAL' },
  { audience: 'LEARNER', title: 'Quero aprender', description: 'Continue para os planos individuais do Wolfie.', icon: Bot, action: 'WOLFIE' },
  { audience: 'INSTITUTION', title: 'Sou uma instituição', description: 'Solicite uma demonstração do sistema escolar.', icon: Building2, action: 'SAAS' },
];

const portalTabForMarketingPage = (
  page: HubMarketingRoute,
): HubTab => {
  if (page === 'library') return 'library';
  if (page === 'educator-ai') return 'educator';
  if (page === 'wolfie') return 'wolfie';
  if (page === 'school-os') return 'saas';
  return 'overview';
};

const syncMetaTag = (
  attribute: 'name' | 'property',
  key: string,
  content: string,
): (() => void) => {
  const existing = document.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  const element = existing ?? document.createElement('meta');
  const previousContent = existing?.content ?? null;
  if (!existing) {
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.content = content;
  return () => {
    if (existing) element.content = previousContent ?? '';
    else element.remove();
  };
};

const HubLoading: React.FC = () => (
  <div className="grid min-h-screen place-items-center bg-brand-bg text-brand-text" role="status" aria-live="polite">
    <div className="text-center">
      <div className="mx-auto grid size-16 place-items-center rounded-3xl bg-tenant-primary text-3xl shadow-lg shadow-tenant-primary/20">🐺</div>
      <Loader2 className="mx-auto mt-6 animate-spin text-tenant-primary" size={24} />
      <p className="mt-3 text-sm font-bold text-brand-muted">Preparando o Wise Wolf Hub...</p>
    </div>
  </div>
);

const HubNotFound: React.FC = () => {
  const hubHome = hubMarketingPath('overview');
  return (
    <HubMarketingShell
      onLogin={() => { window.location.href = resolveSystemAppUrl('/login'); }}
      onPrimary={() => { window.location.href = hubHome; }}
      primaryLabel="Voltar ao Hub"
      pageLabel="Erro 404"
    >
      <section className="grid min-h-[72vh] place-items-center px-5 py-24 text-center">
        <div className="max-w-3xl">
          <div className="mx-auto grid size-16 place-items-center rounded-3xl border border-blue-500/20 bg-blue-500/10 text-blue-500">
            <Compass size={28} aria-hidden="true" />
          </div>
          <p className="mt-7 text-xs font-black uppercase tracking-[0.22em] text-blue-500">Erro 404</p>
          <h1 className="mt-4 font-[Montserrat] text-4xl font-extrabold tracking-tight sm:text-6xl">Esta página saiu da trilha.</h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-slate-500 dark:text-slate-400">O endereço não existe ou mudou. Volte ao Hub para encontrar a solução certa para professores e escolas de inglês.</p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <a href={hubHome} className="hub-button hub-button--primary"><ArrowLeft size={17} />Ir para o Wise Wolf Hub</a>
            <a href={hubMarketingPath('teachers')} className="hub-button hub-button--secondary">Soluções para professores</a>
            <a href={hubMarketingPath('schools')} className="hub-button hub-button--secondary">Soluções para escolas</a>
          </div>
        </div>
      </section>
    </HubMarketingShell>
  );
};

const HubUnavailable: React.FC<{ settings: HubSettings; restricted?: boolean; onSwitchAccount?: () => void }> = ({ settings, restricted = false, onSwitchAccount }) => (
  <div className="grid min-h-screen place-items-center bg-brand-bg p-5 text-brand-text">
    <section className="w-full max-w-2xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-8 text-center shadow-xl sm:p-12">
      <div className="mx-auto grid size-16 place-items-center rounded-3xl bg-tenant-primary/10 text-tenant-primary"><ShieldAlert size={28} /></div>
      <p className="mt-6 text-xs font-black uppercase tracking-[0.2em] text-tenant-primary">{settings.brand_name || 'Wise Wolf Hub'}</p>
      <h1 className="mt-3 text-4xl font-extrabold tracking-tight">{restricted ? 'Esta conta não está disponível' : 'Estamos preparando a próxima experiência'}</h1>
      <p className="mx-auto mt-4 max-w-xl leading-7 text-brand-muted">{restricted ? 'O acesso e novas cobranças estão pausados. Fale com o suporte para revisar a situação da conta.' : 'O Hub está temporariamente em curadoria. Nenhum teste ou checkout pode ser iniciado enquanto esta página estiver ativa.'}</p>
      {onSwitchAccount && <button onClick={onSwitchAccount} className="mt-7 rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Escolher outro ambiente</button>}
      {settings.support_url && <a href={resolveSystemAppUrl(settings.support_url, '/')} target="_blank" rel="noreferrer" className="mt-7 inline-flex rounded-2xl bg-tenant-primary px-6 py-3.5 text-sm font-black text-white">Falar com o suporte</a>}
    </section>
  </div>
);

const HubAccountChooser: React.FC<{
  accounts: HubAccountSummary[];
  onSelect: (accountId: string) => Promise<void>;
  onLogout: () => Promise<void>;
}> = ({ accounts, onSelect, onLogout }) => (
  <div className="grid min-h-screen place-items-center bg-brand-bg p-5 text-brand-text">
    <section className="w-full max-w-3xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-7 shadow-xl sm:p-12">
      <div className="mx-auto max-w-2xl text-center">
        <div className="mx-auto grid size-16 place-items-center rounded-3xl bg-tenant-primary text-3xl shadow-lg shadow-tenant-primary/20">🐺</div>
        <p className="mt-6 text-xs font-black uppercase tracking-[0.2em] text-tenant-primary">Ambiente protegido</p>
        <h1 className="mt-3 text-4xl font-extrabold tracking-tight">Em qual conta você quer entrar?</h1>
        <p className="mt-4 leading-7 text-brand-muted">Cada ambiente mantém assinatura, uso e dados separados. Você poderá alternar depois.</p>
      </div>
      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {accounts.map((account) => {
          const Icon = account.account_type === 'ORGANIZATION' ? Building2 : account.audience === 'LEARNER' ? Bot : BookOpen;
          return (
            <button key={account.id} onClick={() => void onSelect(account.id)} className="rounded-3xl border border-brand-border bg-brand-surface-2 p-5 text-left transition hover:-translate-y-0.5 hover:border-tenant-primary/50 hover:shadow-md">
              <div className="flex items-start justify-between gap-3">
                <div className="grid size-11 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><Icon size={20} /></div>
                <span className={`rounded-full px-2.5 py-1 text-[9px] font-black uppercase ${account.status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-red-500/10 text-red-700 dark:text-red-300'}`}>{account.status === 'ACTIVE' ? 'Ativa' : 'Pausada'}</span>
              </div>
              <h2 className="mt-4 text-lg font-black">{account.name}</h2>
              <p className="mt-1 text-xs text-brand-muted">{account.account_type === 'ORGANIZATION' ? 'Instituição' : 'Conta pessoal'} · {account.membership_role === 'OWNER' ? 'Responsável' : account.membership_role === 'ADMIN' ? 'Administrador' : 'Membro'}</p>
            </button>
          );
        })}
      </div>
      <div className="mt-7 text-center"><button onClick={() => void onLogout()} className="text-sm font-black text-brand-muted hover:text-brand-text">Sair desta conta</button></div>
    </section>
  </div>
);

const HubApp: React.FC = () => {
  const marketingPage = resolveHubMarketingPage();
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']>(null);
  const [plans, setPlans] = useState<HubPlan[]>([]);
  const [settings, setSettings] = useState<HubSettings>(DEFAULT_HUB_SETTINGS);
  const [content, setContent] = useState<HubContentItem[]>([]);
  const [bootstrap, setBootstrap] = useState<HubBootstrap | null>(null);
  const [accounts, setAccounts] = useState<HubAccountSummary[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [authDialog, setAuthDialog] = useState<AuthDialogState>(null);
  const [loading, setLoading] = useState(true);
  const [accountLoading, setAccountLoading] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState('');
  const [planIntent, setPlanIntent] = useState<HubCheckoutIntent | null>(() => {
    try {
      return restoreHubCheckoutIntent(window.location.href, window.localStorage);
    } catch {
      return null;
    }
  });
  const hubEnabledRef = useRef(true);
  const hubAvailabilityLoadedRef = useRef(false);
  const selectedAccountIdRef = useRef<string | null>(null);
  const accountLoadEpochRef = useRef(0);

  useEffect(() => {
    try {
      if (planIntent) persistHubCheckoutIntent(window.localStorage, planIntent);
    } catch {}
  }, [planIntent]);

  const loadAccountContext = useCallback(async (userId: string, preferredAccountId?: string | null) => {
    const loadEpoch = ++accountLoadEpochRef.current;
    const nextAccounts = await loadHubAccounts();
    if (loadEpoch !== accountLoadEpochRef.current) return;
    const availableIds = new Set(nextAccounts.map((account) => account.id));
    let rememberedAccountId: string | null = null;
    try {
      rememberedAccountId = window.localStorage.getItem(`wise-wolf-hub-account:${userId}`);
    } catch {}
    const nextAccountId = preferredAccountId && availableIds.has(preferredAccountId)
      ? preferredAccountId
      : rememberedAccountId && availableIds.has(rememberedAccountId)
        ? rememberedAccountId
        : nextAccounts.length === 1 ? nextAccounts[0].id : null;

    setAccounts(nextAccounts);
    setSelectedAccountId(nextAccountId);
    selectedAccountIdRef.current = nextAccountId;
    if (!nextAccountId) {
      setBootstrap(null);
      return;
    }
    try {
      window.localStorage.setItem(`wise-wolf-hub-account:${userId}`, nextAccountId);
    } catch {}
    const nextBootstrap = await loadHubBootstrap(nextAccountId);
    if (
      loadEpoch !== accountLoadEpochRef.current
      || selectedAccountIdRef.current !== nextAccountId
    ) return;
    setBootstrap(nextBootstrap);
  }, []);

  const refreshBootstrap = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      setBootstrap(null);
      setAccounts([]);
      return;
    }
    await loadAccountContext(data.session.user.id, selectedAccountIdRef.current);
  }, [loadAccountContext]);

  useEffect(() => {
    const metadata = marketingPage ? HUB_MARKETING_METADATA[marketingPage] : HUB_NOT_FOUND_METADATA;
    const previousTitle = document.title;
    const existingCanonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const canonical = existingCanonical ?? document.createElement('link');
    const previousCanonical = existingCanonical?.href ?? null;
    if (!existingCanonical) {
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    const canonicalUrl = marketingPage
      ? hubCanonicalUrl(marketingPage)
      : new URL(window.location.pathname, window.location.origin).toString();
    const restoreMeta = [
      syncMetaTag('name', 'description', metadata.description),
      syncMetaTag('name', 'robots', marketingPage ? 'index, follow' : 'noindex, nofollow'),
      syncMetaTag('name', 'theme-color', '#070d1a'),
      syncMetaTag('property', 'og:type', 'website'),
      syncMetaTag('property', 'og:url', canonicalUrl),
      syncMetaTag('property', 'og:title', metadata.title),
      syncMetaTag('property', 'og:description', metadata.description),
      syncMetaTag('property', 'og:site_name', 'Wise Wolf Hub'),
      syncMetaTag('name', 'twitter:card', 'summary_large_image'),
      syncMetaTag('name', 'twitter:title', metadata.title),
      syncMetaTag('name', 'twitter:description', metadata.description),
    ];
    if (marketingPage) {
      const marketingMetadata = HUB_MARKETING_METADATA[marketingPage];
      const socialImageUrl = new URL(marketingMetadata.imagePath, `${new URL(canonicalUrl).origin}/`).toString();
      restoreMeta.push(
        syncMetaTag('property', 'og:image', socialImageUrl),
        syncMetaTag('property', 'og:image:alt', marketingMetadata.imageAlt),
        syncMetaTag('name', 'twitter:image', socialImageUrl),
      );
    }
    document.title = metadata.title;
    canonical.href = canonicalUrl;
    return () => {
      document.title = previousTitle;
      restoreMeta.forEach((restore) => restore());
      if (existingCanonical) canonical.href = previousCanonical ?? '';
      else canonical.remove();
    };
  }, [marketingPage]);

  useEffect(() => {
    if (!marketingPage) return undefined;
    let mounted = true;
    const start = async () => {
      try {
        const [{ data: authData }, publicData] = await Promise.all([
          supabase.auth.getSession(),
          loadHubPublicData(),
        ]);
        if (!mounted) return;
        const enabled = isHubEnabled(publicData.settings);
        hubEnabledRef.current = enabled;
        hubAvailabilityLoadedRef.current = true;
        setSession(authData.session);
        setPlans(publicData.plans);
        setSettings(publicData.settings);
        setContent(publicData.content);
        if (authData.session && enabled) await loadAccountContext(authData.session.user.id);
      } catch (caught) {
        if (!mounted) return;
        console.error('Wise Wolf Hub startup failed', caught);
        setError('O Hub ainda não está disponível neste ambiente. A base de produção precisa ser publicada na VPS.');
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void start();
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      if (!nextSession) {
        accountLoadEpochRef.current += 1;
        setBootstrap(null);
        setAccounts([]);
        setSelectedAccountId(null);
        selectedAccountIdRef.current = null;
      } else if (hubAvailabilityLoadedRef.current && hubEnabledRef.current) {
        window.setTimeout(() => {
          setAccountLoading(true);
          void loadAccountContext(nextSession.user.id)
            .catch(() => undefined)
            .finally(() => setAccountLoading(false));
        }, 0);
      } else {
        setBootstrap(null);
      }
    });
    return () => {
      mounted = false;
      accountLoadEpochRef.current += 1;
      listener.subscription.unsubscribe();
    };
  }, [loadAccountContext, marketingPage]);

  useEffect(() => {
    if (bootstrap?.plan?.product_family === 'WOLFIE_STANDALONE') {
      window.location.replace('https://wolfie.wisewolflanguage.com.br/app/praticar');
    }
  }, [bootstrap?.plan?.product_family]);

  useHubHashNavigation(
    Boolean(marketingPage) && !loading && !accountLoading && !session && isHubEnabled(settings),
    marketingPage,
  );

  const activateTrial = async (audience: HubAudience, accountName?: string) => {
    setClaiming(true);
    setError('');
    try {
      if (audience !== 'EDUCATOR') throw new Error('HUB_DISCOVERY_EDUCATOR_ONLY');
      const { data: authData } = await supabase.auth.getSession();
      const activeSession = authData.session;
      if (!activeSession) throw new Error('AUTHENTICATION_REQUIRED');
      setSession(activeSession);

      const existingAccounts = await loadHubAccounts();
      if (existingAccounts.length > 0) {
        await loadAccountContext(activeSession.user.id, selectedAccountIdRef.current);
        setAuthDialog(null);
        return;
      }

      if (!isHubCatalogReady(settings, content)) {
        throw new Error('HUB_CATALOG_NOT_READY');
      }

      const claimed = await claimHubTrial(audience, accountName);
      await loadAccountContext(activeSession.user.id, claimed.accountId);
      await trackHubEvent('hub_trial_activated', 'hub_onboarding', { audience }, claimed.accountId);
      setAuthDialog(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes('HUB_CATALOG_NOT_READY')) setError('Catálogo em curadoria · abertura em breve. O teste gratuito e as assinaturas do Hub serão liberados quando o acervo validado estiver disponível.');
      else if (message.includes('trial_already_claimed')) setError('Este acesso gratuito já foi utilizado. Seus dados continuam preservados; escolha um plano para retomar.');
      else if (message.includes('discovery_plan_unavailable')) setError('O plano de descoberta está temporariamente indisponível. Nossa equipe já pode revisar a configuração.');
      else setError('Não foi possível ativar seu acesso agora. Nenhuma cobrança foi criada. Tente novamente em alguns instantes.');
      throw caught;
    } finally {
      setClaiming(false);
    }
  };

  const selectAccount = async (accountId: string) => {
    if (!session) return;
    setAccountLoading(true);
    setError('');
    try {
      await loadAccountContext(session.user.id, accountId);
    } catch (caught) {
      console.error('Wise Wolf Hub account selection failed', caught);
      setError('Não foi possível abrir este ambiente agora. Tente novamente.');
    } finally {
      setAccountLoading(false);
    }
  };

  const chooseAnotherAccount = () => {
    accountLoadEpochRef.current += 1;
    setBootstrap(null);
    setSelectedAccountId(null);
    selectedAccountIdRef.current = null;
  };

  const logout = async () => {
    accountLoadEpochRef.current += 1;
    await supabase.auth.signOut();
    setBootstrap(null);
    setAccounts([]);
    setSelectedAccountId(null);
    selectedAccountIdRef.current = null;
  };

  const rememberPlanIntent = useCallback((planCode: string, billingCycle: HubBillingCycle) => {
    const intent = createHubCheckoutIntent(planCode, billingCycle);
    if (!intent) return;
    try {
      persistHubCheckoutIntent(window.localStorage, intent);
    } catch {}
    setPlanIntent(intent);
  }, []);

  const consumePlanIntent = useCallback(() => {
    try {
      clearStoredHubCheckoutIntent(window.localStorage, window.sessionStorage);
      const currentUrl = window.location.href;
      const cleanedUrl = removeHubCheckoutIntentFromUrl(currentUrl);
      if (cleanedUrl !== currentUrl) window.history.replaceState(window.history.state, '', cleanedUrl);
    } catch {}
    setPlanIntent(null);
  }, []);

  if (!marketingPage) return <HubNotFound />;

  if (marketingPage === 'terms' || marketingPage === 'privacy') {
    return <HubLegalPage page={marketingPage} />;
  }

  if (loading || accountLoading) return <HubLoading />;

  if (!isHubEnabled(settings)) return <HubUnavailable settings={settings} />;

  if (bootstrap?.plan?.product_family === 'WOLFIE_STANDALONE') {
    return <HubLoading />;
  }

  if (session && bootstrap && bootstrap.account.status !== 'ACTIVE') {
    return <HubUnavailable settings={settings} restricted onSwitchAccount={accounts.length > 1 ? chooseAnotherAccount : undefined} />;
  }

  if (session && bootstrap) {
    return <HubPortal key={bootstrap.account.id} bootstrap={bootstrap} accounts={accounts} plans={plans} settings={settings} content={content} userId={session.user.id} userEmail={session.user.email || ''} onRefresh={refreshBootstrap} onLogout={logout} onSwitchAccount={accounts.length > 1 ? async (accountId) => { if (accountId) await selectAccount(accountId); else chooseAnotherAccount(); } : undefined} initialPlanIntent={planIntent} initialTab={portalTabForMarketingPage(marketingPage)} onPlanIntentConsumed={consumePlanIntent} />;
  }

  if (session && !bootstrap) {
    if (accounts.length > 1 || (accounts.length === 1 && !selectedAccountId)) {
      return <HubAccountChooser accounts={accounts} onSelect={selectAccount} onLogout={logout} />;
    }
    return (
      <div className="grid min-h-screen place-items-center bg-brand-bg p-5 text-brand-text">
        <section className="w-full max-w-4xl rounded-[2.5rem] border border-brand-border bg-brand-surface p-7 shadow-xl sm:p-12">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mx-auto grid size-16 place-items-center rounded-3xl bg-tenant-primary text-3xl shadow-lg shadow-tenant-primary/20">🐺</div>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.2em] text-tenant-primary">Configuração protegida</p>
            <h1 className="mt-3 text-4xl font-extrabold tracking-tight">Qual experiência deve abrir as portas para você?</h1>
            <p className="mt-4 leading-7 text-brand-muted">O acesso de descoberta sem cartão é exclusivo para educadores. A prática individual e o sistema escolar continuam em ambientes próprios, sem misturar contas.</p>
          </div>
          <div className="mt-9 grid gap-4 md:grid-cols-3">
            {AUDIENCE_OPTIONS.map(({ audience, title, description, icon: Icon, action }) => (
              <button key={audience} disabled={claiming && action === 'TRIAL'} onClick={() => {
                if (action === 'TRIAL') void activateTrial(audience);
                else if (action === 'WOLFIE') window.location.href = 'https://wolfie.wisewolflanguage.com.br/planos';
                else window.location.href = resolveSystemAppUrl(settings.saas_cta_url, '/new-saas');
              }} className="rounded-3xl border border-brand-border bg-brand-surface-2 p-6 text-left transition hover:-translate-y-1 hover:border-tenant-primary/50 hover:shadow-md disabled:opacity-60">
                <div className="grid size-12 place-items-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><Icon size={22} /></div>
                <h2 className="mt-5 text-xl font-black text-brand-text">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-brand-muted">{description}</p>
              </button>
            ))}
          </div>
          {error && <p className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-sm font-bold text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{error}</p>}
          <div className="mt-7 text-center"><button onClick={logout} className="text-sm font-black text-brand-muted hover:text-brand-text">Sair desta conta</button></div>
        </section>
      </div>
    );
  }

  return (
    <>
      {marketingPage === 'overview' ? (
        <HubLanding plans={plans} settings={settings} content={content} catalogReady={isHubCatalogReady(settings, content)} onAuthenticate={(mode, audience = 'EDUCATOR') => setAuthDialog({ mode, audience })} onPlanSelect={rememberPlanIntent} />
      ) : marketingPage === 'teachers' || marketingPage === 'schools' ? (
        <HubAudienceLanding audience={marketingPage} plans={plans} settings={settings} catalogReady={isHubCatalogReady(settings, content)} onAuthenticate={(mode, audience = 'EDUCATOR') => setAuthDialog({ mode, audience })} onPlanSelect={rememberPlanIntent} />
      ) : (
        <HubSolutionLanding page={marketingPage} plans={plans} settings={settings} catalogReady={isHubCatalogReady(settings, content)} onAuthenticate={(mode, audience = 'EDUCATOR') => setAuthDialog({ mode, audience })} onPlanSelect={rememberPlanIntent} />
      )}
      {error && <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-sm font-bold text-amber-900 shadow-xl">{error}</div>}
      {authDialog && <HubAuthDialog initialMode={authDialog.mode} initialAudience={authDialog.audience} checkoutIntent={planIntent} onClose={() => setAuthDialog(null)} onAuthenticated={activateTrial} />}
    </>
  );
};

export default HubApp;
