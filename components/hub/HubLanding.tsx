import React from 'react';
import {
  ArrowRight,
  BookOpen,
  Bot,
  Building2,
  Check,
  ChevronRight,
  FileText,
  Gauge,
  GraduationCap,
  Library,
  LockKeyhole,
  Play,
  ShieldCheck,
  Sparkles,
  Users,
  Workflow,
  Zap,
} from 'lucide-react';
import type { HubAudience, HubContentItem, HubPlan, HubSettings } from './types';

const BRAND_LOGO = 'https://wisewolflanguage.com.br/logo.png';
const BRAND_VIDEO = 'https://wisewolflanguage.com.br/grok-video-d537321f-f935-4b43-abb2-5446b61753dd.mp4';

interface HubLandingProps {
  plans: HubPlan[];
  settings: HubSettings;
  content: HubContentItem[];
  onAuthenticate: (mode: 'login' | 'signup', audience?: HubAudience) => void;
}

export function resolveHubVideoEmbed(url?: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'youtu.be') {
      const id = parsed.pathname.replace('/', '').slice(0, 24);
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (parsed.hostname.endsWith('youtube.com')) {
      const id = parsed.searchParams.get('v') || parsed.pathname.split('/').filter(Boolean).pop();
      return id ? `https://www.youtube-nocookie.com/embed/${id.slice(0, 24)}` : null;
    }
    if (parsed.hostname.endsWith('vimeo.com')) {
      const id = parsed.pathname.split('/').filter(Boolean).pop();
      return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

const BrandLogo: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
  <div className="flex items-center gap-3">
    <img src={BRAND_LOGO} alt="Wise Wolf" className={`${compact ? 'h-8' : 'h-10'} w-auto max-w-[145px] object-contain`} />
    <div className="h-8 w-px bg-white/15" />
    <div>
      <p className="font-[Montserrat] text-sm font-extrabold leading-none text-white">HUB</p>
      <p className="mt-1 text-[8px] font-bold uppercase tracking-[0.24em] text-blue-300">Teach · Practice · Scale</p>
    </div>
  </div>
);

const PremiumGrid: React.FC<{ subtle?: boolean }> = ({ subtle = false }) => (
  <div
    aria-hidden="true"
    className={`pointer-events-none absolute inset-0 ${subtle ? 'opacity-[0.08]' : 'opacity-[0.14]'}`}
    style={{
      backgroundImage: 'linear-gradient(rgba(255,255,255,.09) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.09) 1px, transparent 1px)',
      backgroundSize: '54px 54px',
      maskImage: 'linear-gradient(to bottom, black, transparent 88%)',
    }}
  />
);

export const HubSaasShowcase: React.FC<{
  settings: HubSettings;
  compact?: boolean;
  onCta?: () => void;
}> = ({ settings, compact = false, onCta }) => {
  const embedUrl = resolveHubVideoEmbed(settings.saas_video_url);
  const capabilities: Array<{ label: string; description: string; icon: React.ElementType }> = [
    { label: 'Operação automatizada', description: 'Agenda, contratos e matrículas.', icon: Workflow },
    { label: 'Gestão financeira', description: 'Cobrança e visão de resultados.', icon: Gauge },
    { label: 'Portal do aluno', description: 'Uma experiência que gera retenção.', icon: GraduationCap },
    { label: 'Equipe e permissões', description: 'Tudo organizado para crescer.', icon: Users },
  ];

  return (
    <section className={`${compact ? 'rounded-[2rem] p-5 sm:p-8' : 'py-24 sm:py-32'} relative overflow-hidden bg-[#070d1a] text-white`}>
      <PremiumGrid subtle />
      <div className="absolute left-1/2 top-1/2 h-[560px] w-[760px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600/15 blur-[120px]" />
      <div className={`${compact ? '' : 'mx-auto max-w-7xl px-5 sm:px-8'} relative grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center`}>
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-400/25 bg-blue-500/10 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.2em] text-blue-300">
            <Building2 size={14} /> Wise Wolf SaaS
          </div>
          <h2 className={`${compact ? 'text-3xl sm:text-4xl' : 'text-4xl sm:text-6xl'} mt-6 font-[Montserrat] font-extrabold leading-[1.04] tracking-[-0.04em]`}>
            Quando você estiver pronto, <span className="text-blue-400">a operação inteira também estará.</span>
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
            O Hub é a porta de entrada. O SaaS Wise Wolf é o próximo nível: uma plataforma completa para transformar uma operação de ensino em uma empresa organizada, automatizada e escalável.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {capabilities.map(({ label, description, icon: Icon }) => (
              <div key={label} className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4 backdrop-blur-xl">
                <Icon size={18} className="text-blue-400" />
                <p className="mt-3 text-sm font-extrabold text-white">{label}</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">{description}</p>
              </div>
            ))}
          </div>
          <a
            href={settings.saas_cta_url || '/new-saas'}
            onClick={onCta}
            className="mt-8 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-4 text-sm font-extrabold text-white shadow-[0_18px_45px_-18px_rgba(37,99,235,.9)] transition hover:-translate-y-0.5 hover:bg-blue-500"
          >
            Conhecer o SaaS Escolar <ArrowRight size={17} />
          </a>
        </div>

        <div className="relative">
          <div className="absolute -inset-5 rounded-[2.5rem] bg-gradient-to-br from-blue-600/25 to-red-500/10 blur-2xl" />
          <div className="relative overflow-hidden rounded-[2rem] border border-white/15 bg-[#0b1426] shadow-[0_35px_100px_-30px_rgba(0,0,0,.9)]">
            <div className="flex items-center gap-1.5 border-b border-white/10 px-5 py-4">
              <span className="size-2.5 rounded-full bg-red-400" />
              <span className="size-2.5 rounded-full bg-amber-400" />
              <span className="size-2.5 rounded-full bg-emerald-400" />
              <span className="ml-auto text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">Wise Wolf Operating System</span>
            </div>
            <div className="aspect-video">
              {embedUrl ? (
                <iframe
                  className="h-full w-full"
                  src={embedUrl}
                  title="Apresentação do SaaS Escolar Wise Wolf"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : (
                <div className="relative flex h-full flex-col items-center justify-center overflow-hidden p-8 text-center">
                  <video autoPlay loop muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover opacity-25">
                    <source src={BRAND_VIDEO} type="video/mp4" />
                  </video>
                  <div className="absolute inset-0 bg-gradient-to-t from-[#070d1a] via-[#070d1a]/65 to-transparent" />
                  <div className="relative grid size-20 place-items-center rounded-full border border-white/20 bg-white/10 text-white backdrop-blur-xl">
                    <Play size={28} fill="currentColor" />
                  </div>
                  <p className="relative mt-5 font-[Montserrat] text-lg font-extrabold">Sua apresentação vai transformar curiosidade em decisão.</p>
                  <p className="relative mt-2 max-w-sm text-sm text-slate-400">Quando o vídeo estiver pronto, a URL do YouTube entra aqui sem nova publicação.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

const HubLanding: React.FC<HubLandingProps> = ({ plans, settings, content, onAuthenticate }) => {
  const paidPlans = plans.filter((plan) => plan.code !== 'DISCOVERY');
  const previews = content.slice(0, 3);
  const catalogCount = content.length;

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#070d1a] font-[Inter] text-white selection:bg-blue-500 selection:text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.07] bg-[#070d1a]/80 backdrop-blur-2xl">
        <div className="mx-auto flex h-[76px] max-w-7xl items-center justify-between px-5 sm:px-8">
          <a href="/hub" aria-label="Wise Wolf Hub"><BrandLogo /></a>
          <nav className="hidden items-center gap-8 text-xs font-bold text-slate-300 lg:flex">
            <a href="#experiencia" className="transition hover:text-white">Experiência</a>
            <a href="#biblioteca" className="transition hover:text-white">Biblioteca</a>
            <a href="#saas" className="transition hover:text-white">SaaS Escolar</a>
            <a href="#planos" className="transition hover:text-white">Planos</a>
          </nav>
          <div className="flex items-center gap-2">
            <button onClick={() => onAuthenticate('login')} className="hidden rounded-xl px-4 py-2.5 text-sm font-bold text-slate-300 transition hover:bg-white/5 hover:text-white sm:block">
              Entrar
            </button>
            <button onClick={() => onAuthenticate('signup', 'EDUCATOR')} className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-extrabold text-white shadow-[0_14px_35px_-14px_rgba(37,99,235,.9)] transition hover:-translate-y-0.5 hover:bg-blue-500">
              Testar grátis
            </button>
          </div>
        </div>
      </header>

      <main>
        <section className="relative flex min-h-[94vh] items-center overflow-hidden pb-20 pt-32 sm:pt-36">
          <video autoPlay loop muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover opacity-[0.28]">
            <source src={BRAND_VIDEO} type="video/mp4" />
          </video>
          <div className="absolute inset-0 bg-[linear-gradient(100deg,#070d1a_4%,rgba(7,13,26,.96)_42%,rgba(7,13,26,.48)_100%)]" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#070d1a] via-transparent to-[#070d1a]/30" />
          <PremiumGrid />
          <div className="absolute -left-40 top-28 size-[520px] rounded-full bg-blue-600/15 blur-[120px]" />

          <div className="relative mx-auto grid w-full max-w-7xl gap-14 px-5 sm:px-8 lg:grid-cols-[1.03fr_.97fr] lg:items-center">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-400/25 bg-blue-500/10 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.22em] text-blue-300 backdrop-blur-xl">
                <Sparkles size={13} /> Ecossistema educacional premium
              </div>
              <h1 className="mt-7 font-[Montserrat] text-[3.25rem] font-extrabold leading-[0.98] tracking-[-0.055em] sm:text-7xl lg:text-[5.4rem]">
                Tudo para ensinar melhor. <span className="bg-gradient-to-r from-blue-400 via-blue-500 to-white bg-clip-text text-transparent">Tudo para crescer.</span>
              </h1>
              <p className="mt-7 max-w-2xl text-base font-light leading-8 text-slate-300 sm:text-xl sm:leading-9">
                Materiais premium, inteligência pedagógica e prática com IA — conectados ao sistema que automatiza uma escola inteira.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <button onClick={() => onAuthenticate('signup', 'EDUCATOR')} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-7 py-4 text-sm font-extrabold text-white shadow-[0_20px_50px_-18px_rgba(37,99,235,.95)] transition hover:-translate-y-0.5 hover:bg-blue-500">
                  Começar gratuitamente <ArrowRight size={18} />
                </button>
                <a href="#experiencia" className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-7 py-4 text-sm font-bold text-white backdrop-blur-xl transition hover:bg-white/10">
                  Explorar o ecossistema <ChevronRight size={18} />
                </a>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-xs font-semibold text-slate-400">
                <span className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> 7 dias grátis</span>
                <span className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Sem cartão</span>
                <span className="flex items-center gap-2"><LockKeyhole size={14} className="text-emerald-400" /> Conteúdo protegido</span>
              </div>
            </div>

            <div className="relative hidden lg:block">
              <div className="absolute -inset-10 rounded-full bg-blue-600/20 blur-[90px]" />
              <div className="relative rotate-[1.5deg] overflow-hidden rounded-[2rem] border border-white/15 bg-[#0b1426]/90 shadow-[0_45px_120px_-35px_rgba(0,0,0,.95)] backdrop-blur-2xl">
                <div className="flex items-center gap-2 border-b border-white/10 px-5 py-4">
                  <span className="size-2.5 rounded-full bg-red-400" />
                  <span className="size-2.5 rounded-full bg-amber-400" />
                  <span className="size-2.5 rounded-full bg-emerald-400" />
                  <span className="ml-auto text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">hub.wisewolf</span>
                </div>
                <div className="p-6">
                  <div className="flex items-start justify-between">
                    <div><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-400">Seu espaço de evolução</p><p className="mt-2 font-[Montserrat] text-2xl font-extrabold">Good evening, teacher.</p></div>
                    <div className="grid size-11 place-items-center rounded-xl bg-blue-600 text-lg">🐺</div>
                  </div>
                  <div className="mt-6 grid grid-cols-3 gap-3">
                    {[
                      { value: catalogCount || 27, label: 'Materiais', color: 'text-blue-400' },
                      { value: '24/7', label: 'IA disponível', color: 'text-emerald-400' },
                      { value: '1', label: 'Ecossistema', color: 'text-red-400' },
                    ].map((metric) => <div key={metric.label} className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-3"><p className={`font-[Montserrat] text-xl font-extrabold ${metric.color}`}>{metric.value}</p><p className="mt-1 text-[9px] uppercase tracking-wider text-slate-500">{metric.label}</p></div>)}
                  </div>
                  <div className="mt-4 grid grid-cols-[1.2fr_.8fr] gap-3">
                    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4">
                      <div className="flex items-center justify-between"><p className="text-xs font-bold">Preparação da semana</p><Sparkles size={15} className="text-blue-400" /></div>
                      <div className="mt-5 flex h-24 items-end gap-2">
                        {[42, 64, 52, 78, 68, 91, 84].map((height, index) => <div key={index} className="flex-1 rounded-t-sm bg-gradient-to-t from-blue-700 to-blue-400" style={{ height: `${height}%` }} />)}
                      </div>
                    </div>
                    <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 p-4">
                      <Bot size={19} />
                      <p className="mt-4 text-sm font-extrabold">Wolfie online</p>
                      <p className="mt-1 text-[10px] leading-4 text-blue-100">Prática inteligente em qualquer nível.</p>
                      <div className="mt-4 h-1.5 rounded-full bg-white/20"><div className="h-full w-3/4 rounded-full bg-white" /></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-white/[0.07] bg-white/[0.025]">
          <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-white/[0.07] px-5 sm:px-8 lg:grid-cols-4">
            {[
              { value: catalogCount || '27', label: 'materiais no catálogo' },
              { value: '7 dias', label: 'para experimentar' },
              { value: '3', label: 'experiências conectadas' },
              { value: '1', label: 'plataforma para evoluir' },
            ].map((metric) => <div key={metric.label} className="px-4 py-8 text-center"><p className="font-[Montserrat] text-2xl font-extrabold text-white sm:text-3xl">{metric.value}</p><p className="mt-2 text-[9px] font-bold uppercase tracking-[0.16em] text-slate-500">{metric.label}</p></div>)}
          </div>
        </section>

        <section id="experiencia" className="relative py-24 sm:py-32">
          <div className="absolute right-0 top-1/3 size-[520px] rounded-full bg-blue-600/[0.08] blur-[130px]" />
          <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
            <div className="max-w-3xl">
              <p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Seu ponto de partida</p>
              <h2 className="mt-5 font-[Montserrat] text-4xl font-extrabold leading-[1.05] tracking-[-0.04em] sm:text-6xl">Escolha o que resolve hoje. <span className="text-slate-500">Descubra o que transforma amanhã.</span></h2>
            </div>
            <div className="mt-14 grid gap-4 lg:grid-cols-12">
              <article className="group relative overflow-hidden rounded-[2rem] border border-white/[0.08] bg-white/[0.035] p-7 lg:col-span-5 lg:p-9">
                <div className="absolute right-0 top-0 size-56 rounded-full bg-blue-600/10 blur-3xl" />
                <div className="relative grid size-13 place-items-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-950"><Library size={23} /></div>
                <p className="relative mt-10 text-[10px] font-bold uppercase tracking-[0.2em] text-blue-400">Wise Wolf Library</p>
                <h3 className="relative mt-3 font-[Montserrat] text-3xl font-extrabold">Menos tempo procurando. Mais confiança ensinando.</h3>
                <p className="relative mt-4 max-w-lg leading-7 text-slate-400">Um acervo vivo, organizado por nível, nicho e coleção, pronto para acompanhar cada tipo de aluno.</p>
                <div className="relative mt-10 flex items-center gap-3 border-t border-white/[0.07] pt-5 text-xs font-bold text-slate-300"><ShieldCheck size={17} className="text-emerald-400" /> Licenciado e protegido por assinatura</div>
              </article>
              <article className="relative overflow-hidden rounded-[2rem] border border-white/[0.08] bg-gradient-to-br from-blue-600 to-blue-800 p-7 lg:col-span-4 lg:p-9">
                <Sparkles size={27} />
                <p className="mt-10 text-[10px] font-bold uppercase tracking-[0.2em] text-blue-100">Educador IA</p>
                <h3 className="mt-3 font-[Montserrat] text-3xl font-extrabold">Planejamento que começa com contexto.</h3>
                <p className="mt-4 leading-7 text-blue-100">Crie aulas e atividades adequadas ao nível, ao objetivo e ao momento real do aprendiz.</p>
                <div className="mt-8 rounded-2xl border border-white/15 bg-white/10 p-4 backdrop-blur-xl">
                  <div className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-white text-blue-700"><FileText size={17} /></span><div><p className="text-xs font-extrabold">Lesson plan created</p><p className="mt-1 text-[10px] text-blue-100">B1 · Business · 60 min</p></div></div>
                </div>
              </article>
              <article className="relative overflow-hidden rounded-[2rem] border border-white/[0.08] bg-white/[0.035] p-7 lg:col-span-3 lg:p-9">
                <div className="grid size-13 place-items-center rounded-2xl bg-red-500 text-white"><Bot size={24} /></div>
                <p className="mt-10 text-[10px] font-bold uppercase tracking-[0.2em] text-red-400">Wolfie</p>
                <h3 className="mt-3 font-[Montserrat] text-3xl font-extrabold">Prática que não espera a próxima aula.</h3>
                <p className="mt-4 leading-7 text-slate-400">Conversação e feedback no nível certo, sempre disponíveis.</p>
                <div className="mt-8 flex items-center gap-2 text-xs font-bold text-emerald-400"><span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_14px_#34d399]" /> Online agora</div>
              </article>
            </div>
          </div>
        </section>

        <section id="biblioteca" className="relative overflow-hidden border-y border-white/[0.07] bg-[#0a1222] py-24 sm:py-32">
          <PremiumGrid subtle />
          <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <div className="max-w-3xl">
                <p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Biblioteca Wise Wolf</p>
                <h2 className="mt-5 font-[Montserrat] text-4xl font-extrabold leading-[1.05] tracking-[-0.04em] sm:text-6xl">Conteúdo com acabamento de marca. <span className="text-slate-500">Pronto para a aula.</span></h2>
              </div>
              <button onClick={() => onAuthenticate('signup', 'EDUCATOR')} className="inline-flex items-center gap-2 text-sm font-extrabold text-blue-400 transition hover:text-blue-300">Explorar catálogo <ArrowRight size={17} /></button>
            </div>
            <div className="mt-14 grid gap-5 md:grid-cols-3">
              {(previews.length ? previews : [
                { id: 'sample-1', title: 'Business English', description: 'Comunicação profissional por situações reais.', level_tag: 'B1', niche: 'BUSINESS', content_type: 'PDF' },
                { id: 'sample-2', title: 'Conversation Missions', description: 'Roteiros práticos para aulas de conversação.', level_tag: 'A2', niche: 'CONVERSATION', content_type: 'ACTIVITY' },
                { id: 'sample-3', title: 'Global Meetings', description: 'Reuniões, apresentações e vocabulário corporativo.', level_tag: 'B2', niche: 'BUSINESS', content_type: 'PDF' },
              ] as Partial<HubContentItem>[]).map((item, index) => (
                <article key={item.id} className="group overflow-hidden rounded-[2rem] border border-white/[0.08] bg-white/[0.035] transition duration-500 hover:-translate-y-2 hover:border-blue-400/35">
                  <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-[#0d1930]">
                    <div className={`absolute inset-0 ${index === 1 ? 'bg-[radial-gradient(circle_at_30%_20%,rgba(239,68,68,.35),transparent_38%),linear-gradient(140deg,#111827,#071b36)]' : 'bg-[radial-gradient(circle_at_70%_30%,rgba(59,130,246,.4),transparent_40%),linear-gradient(140deg,#111827,#071b36)]'}`} />
                    <PremiumGrid subtle />
                    <div className="relative flex h-[72%] w-[56%] rotate-[-4deg] flex-col rounded-xl border border-white/15 bg-gradient-to-br from-white/[0.14] to-white/[0.04] p-4 shadow-2xl backdrop-blur-xl transition duration-500 group-hover:rotate-0 group-hover:scale-105">
                      <div className="h-1 w-10 rounded-full bg-red-500" />
                      <p className="mt-4 text-[8px] font-bold uppercase tracking-[0.18em] text-blue-300">Wise Wolf Material</p>
                      <p className="mt-2 font-[Montserrat] text-sm font-extrabold leading-tight text-white">{item.title}</p>
                      <BookOpen className="mt-auto text-white/70" size={22} />
                    </div>
                  </div>
                  <div className="p-6">
                    <div className="flex gap-2 text-[9px] font-extrabold uppercase tracking-[0.14em] text-blue-300">
                      <span className="rounded-full border border-blue-400/20 bg-blue-500/10 px-2.5 py-1">{item.level_tag || 'Todos'}</span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-slate-400">{item.niche || 'Geral'}</span>
                    </div>
                    <h3 className="mt-5 font-[Montserrat] text-xl font-extrabold">{item.title}</h3>
                    <p className="mt-2 min-h-12 text-sm leading-6 text-slate-400">{item.description || 'Material organizado para aplicação prática em aula.'}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <div id="saas"><HubSaasShowcase settings={settings} /></div>

        <section id="planos" className="relative border-t border-white/[0.07] py-24 sm:py-32">
          <div className="absolute left-1/2 top-1/2 size-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600/[0.08] blur-[140px]" />
          <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
            <div className="text-center">
              <p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Planos de lançamento</p>
              <h2 className="mx-auto mt-5 max-w-4xl font-[Montserrat] text-4xl font-extrabold leading-[1.05] tracking-[-0.04em] sm:text-6xl">Comece leve. <span className="text-slate-500">Evolua sem trocar de ecossistema.</span></h2>
              <p className="mx-auto mt-5 max-w-2xl leading-7 text-slate-400">Teste gratuitamente e assine apenas a experiência que já faz diferença na sua rotina.</p>
            </div>
            <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {paidPlans.map((plan) => {
                const popular = plan.metadata?.popular === true;
                return (
                  <article key={plan.id} className={`relative flex flex-col overflow-hidden rounded-[2rem] border p-7 ${popular ? 'border-blue-400/50 bg-gradient-to-b from-blue-600/25 to-white/[0.04] shadow-[0_25px_80px_-30px_rgba(37,99,235,.8)]' : 'border-white/[0.08] bg-white/[0.035]'}`}>
                    {popular && <span className="absolute right-5 top-5 rounded-full bg-blue-600 px-3 py-1 text-[9px] font-extrabold uppercase tracking-[0.16em] text-white">Mais escolhido</span>}
                    <p className="text-sm font-extrabold text-blue-300">{plan.name}</p>
                    <div className="mt-7 flex items-end gap-1"><span className="font-[Montserrat] text-5xl font-extrabold">R$ {Number(plan.price_monthly || 0).toLocaleString('pt-BR')}</span><span className="pb-1.5 text-sm text-slate-500">/mês</span></div>
                    {Number(plan.price_yearly || 0) > 0 && <p className="mt-2 text-xs font-bold text-emerald-400">R$ {Number(plan.price_yearly).toLocaleString('pt-BR')}/ano · 2 meses grátis</p>}
                    <p className="mt-5 min-h-12 text-sm leading-6 text-slate-400">{plan.description}</p>
                    <div className="my-6 h-px bg-white/[0.08]" />
                    <ul className="flex-1 space-y-3 text-sm text-slate-300">{(Array.isArray(plan.features) ? plan.features : []).map((feature) => <li key={feature} className="flex gap-3"><span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-emerald-400/10 text-emerald-400"><Check size={12} /></span>{feature}</li>)}</ul>
                    <button onClick={() => onAuthenticate('signup', plan.audience === 'LEARNER' ? 'LEARNER' : plan.audience === 'INSTITUTION' ? 'INSTITUTION' : 'EDUCATOR')} className={`mt-8 w-full rounded-xl px-5 py-4 text-sm font-extrabold transition hover:-translate-y-0.5 ${popular ? 'bg-blue-600 text-white hover:bg-blue-500' : 'border border-white/15 bg-white/[0.06] text-white hover:bg-white/10'}`}>Começar com 7 dias grátis</button>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="px-5 pb-24 sm:px-8 sm:pb-32">
          <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[2.5rem] border border-blue-400/20 bg-gradient-to-br from-blue-700 via-blue-600 to-[#122653] px-7 py-14 text-center shadow-[0_35px_100px_-35px_rgba(37,99,235,.85)] sm:px-14 sm:py-20">
            <PremiumGrid subtle />
            <div className="absolute -right-16 -top-20 size-72 rounded-full bg-red-500/20 blur-3xl" />
            <div className="relative mx-auto max-w-4xl">
              <Zap className="mx-auto" size={30} />
              <h2 className="mt-6 font-[Montserrat] text-4xl font-extrabold leading-[1.05] tracking-[-0.04em] sm:text-6xl">A próxima fase da sua jornada começa aqui.</h2>
              <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-blue-100 sm:text-lg">Entre pelo material que você precisa hoje. Fique pelo ecossistema que ajuda você a ensinar, organizar e crescer.</p>
              <button onClick={() => onAuthenticate('signup', 'EDUCATOR')} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-7 py-4 text-sm font-extrabold text-blue-800 shadow-xl transition hover:-translate-y-0.5">Criar minha conta gratuita <ArrowRight size={17} /></button>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.07] px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 text-center sm:flex-row sm:text-left">
          <BrandLogo compact />
          <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500"><ShieldCheck size={15} className="text-blue-400" /> Conteúdo, inteligência e operação em um ecossistema seguro.</div>
          <p className="text-xs text-slate-600">© {new Date().getFullYear()} Wise Wolf</p>
        </div>
      </footer>
    </div>
  );
};

export default HubLanding;
