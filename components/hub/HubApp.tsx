import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Bot, Building2, Loader2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import HubAuthDialog from './HubAuthDialog';
import HubLanding from './HubLanding';
import HubPortal from './HubPortal';
import {
  claimHubTrial,
  DEFAULT_HUB_SETTINGS,
  loadHubBootstrap,
  loadHubPublicData,
  trackHubEvent,
} from './hubService';
import type { HubAudience, HubBootstrap, HubContentItem, HubPlan, HubSettings } from './types';

type AuthDialogState = { mode: 'login' | 'signup'; audience: HubAudience } | null;

const AUDIENCE_OPTIONS: Array<{
  audience: HubAudience;
  title: string;
  description: string;
  icon: React.ElementType;
}> = [
  { audience: 'EDUCATOR', title: 'Sou professor', description: 'Materiais e IA para preparar aulas.', icon: BookOpen },
  { audience: 'LEARNER', title: 'Quero aprender', description: 'Prática de inglês com o Wolfie.', icon: Bot },
  { audience: 'INSTITUTION', title: 'Sou uma instituição', description: 'Recursos para equipe e caminho para o SaaS.', icon: Building2 },
];

const HubLoading: React.FC = () => (
  <div className="grid min-h-screen place-items-center bg-slate-950 text-white">
    <div className="text-center">
      <div className="mx-auto grid size-16 place-items-center rounded-3xl bg-blue-600 text-3xl shadow-2xl shadow-blue-950">🐺</div>
      <Loader2 className="mx-auto mt-6 animate-spin text-blue-300" size={24} />
      <p className="mt-3 text-sm font-bold text-slate-300">Preparando o Wise Wolf Hub...</p>
    </div>
  </div>
);

const HubApp: React.FC = () => {
  const [session, setSession] = useState<Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session']>(null);
  const [plans, setPlans] = useState<HubPlan[]>([]);
  const [settings, setSettings] = useState<HubSettings>(DEFAULT_HUB_SETTINGS);
  const [content, setContent] = useState<HubContentItem[]>([]);
  const [bootstrap, setBootstrap] = useState<HubBootstrap | null>(null);
  const [authDialog, setAuthDialog] = useState<AuthDialogState>(null);
  const [loading, setLoading] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState('');

  const refreshBootstrap = useCallback(async () => {
    setBootstrap(await loadHubBootstrap());
  }, []);

  useEffect(() => {
    let mounted = true;
    const start = async () => {
      try {
        const [{ data: authData }, publicData] = await Promise.all([
          supabase.auth.getSession(),
          loadHubPublicData(),
        ]);
        if (!mounted) return;
        setSession(authData.session);
        setPlans(publicData.plans);
        setSettings(publicData.settings);
        setContent(publicData.content);
        if (authData.session) setBootstrap(await loadHubBootstrap());
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
      if (!nextSession) setBootstrap(null);
      else window.setTimeout(() => void refreshBootstrap().catch(() => undefined), 0);
    });
    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (bootstrap?.plan?.metadata?.product_family === 'WOLFIE_STANDALONE') {
      window.location.replace('https://wolfie.wisewolflanguage.com.br/app/praticar');
    }
  }, [bootstrap?.plan?.metadata]);

  const activateTrial = async (audience: HubAudience, accountName?: string) => {
    setClaiming(true);
    setError('');
    try {
      await claimHubTrial(audience, accountName);
      await refreshBootstrap();
      await trackHubEvent('hub_trial_activated', 'hub_onboarding', { audience });
      setAuthDialog(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.includes('trial_already_claimed')) setError('Este acesso gratuito já foi utilizado. Seus dados continuam preservados; escolha um plano para retomar.');
      else if (message.includes('discovery_plan_unavailable')) setError('O plano de descoberta está temporariamente indisponível. Nossa equipe já pode revisar a configuração.');
      else setError('Não foi possível ativar seu acesso agora. Nenhuma cobrança foi criada. Tente novamente em alguns instantes.');
      throw caught;
    } finally {
      setClaiming(false);
    }
  };

  const logout = async () => {
    await supabase.auth.signOut();
    setBootstrap(null);
  };

  if (loading) return <HubLoading />;

  if (bootstrap?.plan?.metadata?.product_family === 'WOLFIE_STANDALONE') {
    return <HubLoading />;
  }

  if (session && bootstrap?.subscription) {
    return <HubPortal bootstrap={bootstrap} plans={plans} settings={settings} content={content} userEmail={session.user.email || ''} onRefresh={refreshBootstrap} onLogout={logout} />;
  }

  if (session && !bootstrap?.subscription) {
    return (
      <div className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,rgba(37,99,235,.22),transparent_40%),#070d1a] p-5 text-white">
        <section className="w-full max-w-4xl rounded-[2.5rem] border border-white/10 bg-white/[0.055] p-7 shadow-[0_40px_120px_-40px_rgba(0,0,0,.9)] backdrop-blur-2xl sm:p-12">
          <div className="mx-auto max-w-2xl text-center">
            <div className="mx-auto grid size-16 place-items-center rounded-3xl bg-blue-600 text-3xl shadow-2xl shadow-blue-950">🐺</div>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.2em] text-blue-400">Configuração protegida</p>
            <h1 className="mt-3 font-[Montserrat] text-4xl font-extrabold tracking-tight text-white">Qual experiência deve abrir as portas para você?</h1>
            <p className="mt-4 leading-7 text-slate-400">Ativaremos sete dias de descoberta sem cartão. Sua conta escolar, se existir, continua independente e intacta.</p>
          </div>
          <div className="mt-9 grid gap-4 md:grid-cols-3">
            {AUDIENCE_OPTIONS.map(({ audience, title, description, icon: Icon }) => (
              <button key={audience} disabled={claiming} onClick={() => void activateTrial(audience)} className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-left transition hover:-translate-y-1 hover:border-blue-400/50 hover:bg-white/[0.07] disabled:opacity-60">
                <div className="grid size-12 place-items-center rounded-2xl bg-blue-500/15 text-blue-400"><Icon size={22} /></div>
                <h2 className="mt-5 text-xl font-black text-white">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
              </button>
            ))}
          </div>
          {error && <p className="mt-6 rounded-2xl border border-amber-300/30 bg-amber-400/10 p-4 text-center text-sm font-bold text-amber-100">{error}</p>}
          <div className="mt-7 text-center"><button onClick={logout} className="text-sm font-black text-slate-500 hover:text-white">Sair desta conta</button></div>
        </section>
      </div>
    );
  }

  return (
    <>
      <HubLanding plans={plans} settings={settings} content={content} onAuthenticate={(mode, audience = 'EDUCATOR') => setAuthDialog({ mode, audience })} />
      {error && <div className="fixed inset-x-4 bottom-4 z-50 mx-auto max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center text-sm font-bold text-amber-900 shadow-xl">{error}</div>}
      {authDialog && <HubAuthDialog initialMode={authDialog.mode} initialAudience={authDialog.audience} onClose={() => setAuthDialog(null)} onAuthenticated={activateTrial} />}
    </>
  );
};

export default HubApp;
