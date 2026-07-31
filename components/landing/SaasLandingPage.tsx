import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  Bot,
  CalendarDays,
  Check,
  CheckCircle,
  ChevronRight,
  CircleDollarSign,
  FileSignature,
  GraduationCap,
  LayoutDashboard,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Play,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  UserRoundCheck,
  Users,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import SaasCheckout from './SaasCheckout';

const BRAND_LOGO = 'https://wisewolflanguage.com.br/logo.png';
const BRAND_VIDEO = 'https://wisewolflanguage.com.br/grok-video-d537321f-f935-4b43-abb2-5446b61753dd.mp4';

const PremiumGrid: React.FC<{ opacity?: string }> = ({ opacity = 'opacity-[0.12]' }) => (
  <div
    aria-hidden="true"
    className={`pointer-events-none absolute inset-0 ${opacity}`}
    style={{
      backgroundImage: 'linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px)',
      backgroundSize: '56px 56px',
      maskImage: 'linear-gradient(to bottom, black, transparent 92%)',
    }}
  />
);

const BrandLogo: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
  <div className="flex items-center gap-3">
    <img src={BRAND_LOGO} alt="Wise Wolf" className={`${compact ? 'h-8' : 'h-8 sm:h-10'} w-auto max-w-[118px] object-contain sm:max-w-[145px]`} />
    <div className="hidden h-8 w-px bg-white/15 sm:block" />
    <div className="hidden sm:block">
      <p className="font-[Montserrat] text-xs font-extrabold leading-none text-white">SaaS</p>
      <p className="mt-1 text-[8px] font-bold uppercase tracking-[0.22em] text-blue-300">School operating system</p>
    </div>
  </div>
);

const planPresentation: Record<string, {
  description: string;
  features: string[];
  popular?: boolean;
}> = {
  Starter: {
    description: 'Para professores e operações que estão organizando o crescimento.',
    features: ['Até 100 alunos', 'Até 5 professores', 'Gestão financeira', 'Agenda e contratos', 'Portal do aluno'],
  },
  Pro: {
    description: 'A operação completa para escolas que querem escala e automação.',
    features: ['Até 500 alunos', 'Até 25 professores', 'CRM e automações', 'Módulo pedagógico completo', 'Suporte prioritário'],
    popular: true,
  },
  Enterprise: {
    description: 'Estrutura avançada para redes, franquias e operações maiores.',
    features: ['Alunos e professores em grande escala', 'White label', '70 GB de armazenamento', 'API de integração', 'Gerente de conta dedicado'],
  },
};

type PublicSaasPlan = {
  id: string;
  name: string;
  description?: string | null;
  price: number | string;
  price_yearly?: number | string | null;
  max_students?: number | null;
  max_teachers?: number | null;
  features?: unknown;
};

const faqs = [
  {
    question: 'A plataforma serve para professores autônomos?',
    answer: 'Sim. O plano Starter organiza a operação desde os primeiros alunos e permite evoluir para uma estrutura completa sem trocar de sistema.',
  },
  {
    question: 'Consigo migrar os dados da minha escola?',
    answer: 'Sim. O processo de implantação pode incluir importação assistida de alunos, professores e informações operacionais conforme o plano contratado.',
  },
  {
    question: 'O financeiro se conecta às cobranças?',
    answer: 'Sim. A Wise Wolf integra gestão financeira, cobranças e acompanhamento de pagamentos para reduzir tarefas manuais e centralizar a visão da escola.',
  },
  {
    question: 'Minha equipe terá acessos diferentes?',
    answer: 'Sim. Direção, coordenação, professores, vendedores e alunos entram em experiências próprias, com permissões adequadas a cada papel.',
  },
  {
    question: 'Posso conhecer o sistema antes de contratar?',
    answer: 'Sim. Envie seus dados para solicitar uma demonstração e entender como a plataforma se encaixa na operação atual da sua escola.',
  },
];

export default function SaasLandingPage() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formData, setFormData] = useState({ name: '', school_name: '', email: '', phone: '', source: 'saas_hero' });
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [availablePlans, setAvailablePlans] = useState<PublicSaasPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [yearlyBilling, setYearlyBilling] = useState(false);
  const [checkoutPlan, setCheckoutPlan] = useState<PublicSaasPlan | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadPlans = async () => {
      const { data, error } = await supabase
        .from('saas_plans')
        .select('id,name,description,price,price_yearly,max_students,max_teachers,features')
        .eq('active', true)
        .eq('plan_type', 'school')
        .order('price', { ascending: true });
      if (!mounted) return;
      if (error) {
        console.error('Public SaaS plans failed to load', { code: error.code });
        setAvailablePlans([]);
      } else {
        setAvailablePlans((data || []) as PublicSaasPlan[]);
      }
      setPlansLoading(false);
    };
    void loadPlans();
    return () => { mounted = false; };
  }, []);

  const handleOpenModal = (source: string) => {
    setFormData((previous) => ({ ...previous, source }));
    setSubmitted(false);
    setIsModalOpen(true);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      const { error } = await supabase.from('saas_leads').insert({
        name: formData.name.trim(),
        school_name: formData.school_name.trim(),
        email: formData.email.trim().toLowerCase(),
        phone: formData.phone.trim(),
        status: 'LEAD',
        notes: `Source: ${formData.source}`,
      });
      if (error) throw error;
      setSubmitted(true);
    } catch (error) {
      console.error('SaaS lead submission failed', error);
      alert('Não foi possível enviar agora. Tente novamente em alguns instantes.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen overflow-x-hidden bg-[#070d1a] font-[Inter] text-white selection:bg-blue-500 selection:text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.07] bg-[#070d1a]/80 backdrop-blur-2xl">
        <div className="mx-auto flex h-[76px] max-w-7xl items-center justify-between px-5 sm:px-8">
          <a href="/new-saas" aria-label="Wise Wolf SaaS"><BrandLogo /></a>
          <nav className="hidden items-center gap-8 text-xs font-bold text-slate-300 lg:flex">
            <a href="#plataforma" className="transition hover:text-white">Plataforma</a>
            <a href="#operacao" className="transition hover:text-white">Como funciona</a>
            <a href="#planos" className="transition hover:text-white">Planos</a>
            <a href="#faq" className="transition hover:text-white">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <a href="/" className="hidden rounded-xl px-4 py-2.5 text-sm font-bold text-slate-300 transition hover:bg-white/5 hover:text-white sm:block">Entrar</a>
            <button onClick={() => handleOpenModal('nav_demo')} className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-extrabold text-white shadow-[0_14px_35px_-14px_rgba(37,99,235,.9)] transition hover:-translate-y-0.5 hover:bg-blue-500"><span className="sm:hidden">Ver demo</span><span className="hidden sm:inline">Solicitar demonstração</span></button>
          </div>
        </div>
      </header>

      <main>
        <section className="relative flex min-h-[94vh] items-center overflow-hidden pb-20 pt-32 sm:pt-36">
          <video autoPlay loop muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover opacity-[0.24]">
            <source src={BRAND_VIDEO} type="video/mp4" />
          </video>
          <div className="absolute inset-0 bg-[linear-gradient(100deg,#070d1a_4%,rgba(7,13,26,.97)_44%,rgba(7,13,26,.5)_100%)]" />
          <div className="absolute inset-0 bg-gradient-to-t from-[#070d1a] via-transparent to-[#070d1a]/30" />
          <PremiumGrid />
          <div className="absolute -left-40 top-28 size-[520px] rounded-full bg-blue-600/15 blur-[120px]" />

          <div className="relative mx-auto grid w-full max-w-7xl gap-14 px-5 sm:px-8 lg:grid-cols-[1.02fr_.98fr] lg:items-center">
            <div className="max-w-3xl">
              <div className="inline-flex items-center gap-2 rounded-full border border-blue-400/25 bg-blue-500/10 px-4 py-2 text-[10px] font-extrabold uppercase tracking-[0.22em] text-blue-300 backdrop-blur-xl">
                <span className="relative flex size-2"><span className="absolute inline-flex size-full animate-ping rounded-full bg-blue-400 opacity-60" /><span className="relative inline-flex size-2 rounded-full bg-blue-400" /></span>
                Gestão escolar em uma nova categoria
              </div>
              <h1 className="mt-7 font-[Montserrat] text-[3.2rem] font-extrabold leading-[0.98] tracking-[-0.055em] sm:text-7xl lg:text-[5.25rem]">
                Sua escola no <span className="bg-gradient-to-r from-blue-400 via-blue-500 to-white bg-clip-text text-transparent">piloto automático.</span>
              </h1>
              <p className="mt-7 max-w-2xl text-base font-light leading-8 text-slate-300 sm:text-xl sm:leading-9">
                CRM, matrículas, agenda, financeiro, professores, alunos, contratos, WhatsApp e inteligência pedagógica operando como um único sistema.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <button onClick={() => handleOpenModal('hero_demo')} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-7 py-4 text-sm font-extrabold text-white shadow-[0_20px_50px_-18px_rgba(37,99,235,.95)] transition hover:-translate-y-0.5 hover:bg-blue-500">Quero ver na minha escola <ArrowRight size={18} /></button>
                <a href="#plataforma" className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.06] px-7 py-4 text-sm font-bold text-white backdrop-blur-xl transition hover:bg-white/10"><Play size={17} /> Explorar a plataforma</a>
              </div>
              <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-xs font-semibold text-slate-400">
                <span className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Demonstração personalizada</span>
                <span className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Implantação assistida</span>
                <span className="flex items-center gap-2"><LockKeyhole size={14} className="text-emerald-400" /> Dados protegidos</span>
              </div>
            </div>

            <div className="relative hidden lg:block">
              <div className="absolute -inset-10 rounded-full bg-blue-600/20 blur-[90px]" />
              <div className="relative rotate-[1.5deg] overflow-hidden rounded-[2rem] border border-white/15 bg-[#0b1426]/95 shadow-[0_45px_120px_-35px_rgba(0,0,0,.95)] backdrop-blur-2xl">
                <div className="flex items-center gap-2 border-b border-white/10 px-5 py-4">
                  <span className="size-2.5 rounded-full bg-red-400" /><span className="size-2.5 rounded-full bg-amber-400" /><span className="size-2.5 rounded-full bg-emerald-400" />
                  <span className="ml-auto text-[9px] font-bold uppercase tracking-[0.18em] text-slate-500">Wise Wolf · Command center</span>
                </div>
                <div className="grid grid-cols-[74px_1fr]">
                  <div className="border-r border-white/[0.07] p-3">
                    <div className="grid size-10 place-items-center rounded-xl bg-blue-600 text-lg">W</div>
                    <div className="mt-5 space-y-2">{[LayoutDashboard, Users, CalendarDays, CircleDollarSign, BarChart3].map((Icon, index) => <div key={index} className={`grid size-10 place-items-center rounded-xl ${index === 0 ? 'bg-blue-600 text-white' : 'text-slate-500'}`}><Icon size={16} /></div>)}</div>
                  </div>
                  <div className="p-5">
                    <div className="flex items-start justify-between"><div><p className="text-[9px] font-bold uppercase tracking-[0.18em] text-blue-400">Visão operacional 360°</p><p className="mt-2 font-[Montserrat] text-2xl font-extrabold">Sua escola, agora.</p></div><div className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-1.5 text-[9px] font-bold uppercase tracking-wider text-emerald-400">Sistema online</div></div>
                    <div className="mt-6 grid grid-cols-3 gap-3">
                      {[{ label: 'Matrículas', value: 'CRM', color: 'text-blue-400' }, { label: 'Financeiro', value: 'Asaas', color: 'text-emerald-400' }, { label: 'Pedagógico', value: 'IA', color: 'text-red-400' }].map((item) => <div key={item.label} className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-3"><p className={`font-[Montserrat] text-lg font-extrabold ${item.color}`}>{item.value}</p><p className="mt-1 text-[8px] uppercase tracking-wider text-slate-500">{item.label}</p></div>)}
                    </div>
                    <div className="mt-4 grid grid-cols-[1.2fr_.8fr] gap-3">
                      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.035] p-4"><div className="flex items-center justify-between"><p className="text-xs font-bold">Fluxo da operação</p><TrendingUp size={15} className="text-blue-400" /></div><div className="mt-5 flex h-24 items-end gap-2">{[42, 58, 51, 74, 68, 88, 82, 94].map((height, index) => <div key={index} className="flex-1 rounded-t-sm bg-gradient-to-t from-blue-700 to-blue-400" style={{ height: `${height}%` }} />)}</div></div>
                      <div className="rounded-2xl bg-gradient-to-br from-blue-600 to-blue-800 p-4"><Bot size={19} /><p className="mt-4 text-sm font-extrabold">IA integrada</p><p className="mt-1 text-[10px] leading-4 text-blue-100">Decisões e experiências mais inteligentes.</p><div className="mt-4 h-1.5 rounded-full bg-white/20"><div className="h-full w-4/5 rounded-full bg-white" /></div></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-white/[0.07] bg-white/[0.025]">
          <div className="mx-auto grid max-w-7xl grid-cols-2 divide-x divide-y divide-white/[0.07] px-5 sm:px-8 lg:grid-cols-4 lg:divide-y-0">
            {[
              { icon: UserRoundCheck, title: 'CRM + Matrículas', text: 'Do interesse ao contrato' },
              { icon: CircleDollarSign, title: 'Financeiro + Cobranças', text: 'Visão e automação' },
              { icon: Sparkles, title: 'Pedagógico + IA', text: 'Qualidade em escala' },
              { icon: GraduationCap, title: 'Portal + Experiência', text: 'Aluno mais conectado' },
            ].map(({ icon: Icon, title, text }) => <div key={title} className="flex items-center gap-3 px-4 py-7"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-blue-500/10 text-blue-400"><Icon size={18} /></div><div><p className="text-xs font-extrabold text-white">{title}</p><p className="mt-1 text-[9px] uppercase tracking-wider text-slate-500">{text}</p></div></div>)}
          </div>
        </section>

        <section id="plataforma" className="relative py-24 sm:py-32">
          <div className="absolute right-0 top-1/3 size-[560px] rounded-full bg-blue-600/[0.08] blur-[140px]" />
          <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
            <div className="max-w-4xl">
              <p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Uma plataforma, toda a operação</p>
              <h2 className="mt-5 font-[Montserrat] text-4xl font-extrabold leading-[1.04] tracking-[-0.045em] sm:text-6xl">O sistema trabalha nos bastidores. <span className="text-slate-500">Você lidera na frente.</span></h2>
              <p className="mt-6 max-w-2xl text-base leading-8 text-slate-400 sm:text-lg">Cada módulo conversa com o próximo para eliminar retrabalho, falta de informação e decisões atrasadas.</p>
            </div>
            <div className="mt-14 grid gap-4 lg:grid-cols-12">
              {[
                { icon: UserRoundCheck, eyebrow: 'Comercial', title: 'CRM que acompanha cada oportunidade.', text: 'Leads, contatos, ofertas e matrículas organizados em um fluxo único.', className: 'lg:col-span-5', accent: 'blue' },
                { icon: CircleDollarSign, eyebrow: 'Financeiro', title: 'Cobranças sem depender de planilhas.', text: 'Faturas, pagamentos e visão financeira conectados à operação.', className: 'lg:col-span-4', accent: 'emerald' },
                { icon: MessageCircle, eyebrow: 'Automação', title: 'WhatsApp no momento certo.', text: 'Comunicação operacional acionada por eventos reais do sistema.', className: 'lg:col-span-3', accent: 'red' },
                { icon: CalendarDays, eyebrow: 'Acadêmico', title: 'Agenda, aulas e professores em sintonia.', text: 'Disponibilidade, turmas, reposições e acompanhamento sem ruído.', className: 'lg:col-span-4', accent: 'blue' },
                { icon: Sparkles, eyebrow: 'Inteligência', title: 'IA conectada ao contexto pedagógico.', text: 'Planejamento, atividades, insights e prática com o Wolfie.', className: 'lg:col-span-4', accent: 'red' },
                { icon: LayoutDashboard, eyebrow: 'Direção', title: 'Uma visão executiva para decidir melhor.', text: 'Indicadores importantes reunidos em um painel de operação.', className: 'lg:col-span-4', accent: 'emerald' },
              ].map(({ icon: Icon, eyebrow, title, text, className, accent }) => (
                <article key={title} className={`${className} group relative overflow-hidden rounded-[2rem] border border-white/[0.08] bg-white/[0.035] p-7 transition duration-500 hover:-translate-y-1 hover:border-blue-400/30 lg:p-8`}>
                  <div className={`grid size-13 place-items-center rounded-2xl ${accent === 'emerald' ? 'bg-emerald-500/15 text-emerald-400' : accent === 'red' ? 'bg-red-500/15 text-red-400' : 'bg-blue-500/15 text-blue-400'}`}><Icon size={23} /></div>
                  <p className="mt-10 text-[9px] font-extrabold uppercase tracking-[0.2em] text-blue-400">{eyebrow}</p>
                  <h3 className="mt-3 font-[Montserrat] text-2xl font-extrabold leading-tight">{title}</h3>
                  <p className="mt-4 leading-7 text-slate-400">{text}</p>
                  <div className="absolute -bottom-20 -right-20 size-48 rounded-full bg-blue-600/[0.08] blur-3xl transition group-hover:bg-blue-600/[0.16]" />
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="operacao" className="relative overflow-hidden border-y border-white/[0.07] bg-[#0a1222] py-24 sm:py-32">
          <PremiumGrid opacity="opacity-[0.07]" />
          <div className="relative mx-auto grid max-w-7xl gap-14 px-5 sm:px-8 lg:grid-cols-[.88fr_1.12fr] lg:items-center">
            <div>
              <p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Operação conectada</p>
              <h2 className="mt-5 font-[Montserrat] text-4xl font-extrabold leading-[1.04] tracking-[-0.045em] sm:text-6xl">Do primeiro contato à renovação.</h2>
              <p className="mt-6 text-base leading-8 text-slate-400 sm:text-lg">A Wise Wolf acompanha toda a jornada e mantém cada área trabalhando com a mesma informação.</p>
              <button onClick={() => handleOpenModal('workflow_demo')} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-blue-600 px-6 py-4 text-sm font-extrabold shadow-[0_18px_45px_-18px_rgba(37,99,235,.9)] transition hover:-translate-y-0.5 hover:bg-blue-500">Ver aplicado à minha operação <ArrowRight size={17} /></button>
            </div>
            <div className="relative">
              <div className="absolute left-6 top-10 h-[calc(100%-5rem)] w-px bg-gradient-to-b from-blue-500 via-blue-500/40 to-transparent sm:left-8" />
              <div className="space-y-4">
                {[
                  { number: '01', title: 'Atrair e organizar oportunidades', text: 'CRM e formulários capturam o interesse com origem e contexto.', icon: Users },
                  { number: '02', title: 'Converter e formalizar a matrícula', text: 'Oferta, contrato e pagamento avançam dentro do mesmo fluxo.', icon: FileSignature },
                  { number: '03', title: 'Operar aulas e relacionamento', text: 'Agenda, equipe, materiais e comunicação permanecem conectados.', icon: Workflow },
                  { number: '04', title: 'Acompanhar, reter e crescer', text: 'A direção enxerga a operação e age antes que o problema apareça.', icon: TrendingUp },
                ].map(({ number, title, text, icon: Icon }) => (
                  <div key={number} className="relative flex gap-5 rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 backdrop-blur-xl sm:gap-6 sm:p-6">
                    <div className="relative z-10 grid size-12 shrink-0 place-items-center rounded-xl bg-blue-600 font-[Montserrat] text-xs font-extrabold shadow-xl shadow-blue-950 sm:size-16"><Icon size={20} /><span className="sr-only">Passo {number}</span></div>
                    <div><p className="text-[9px] font-extrabold uppercase tracking-[0.2em] text-blue-400">Passo {number}</p><h3 className="mt-2 font-[Montserrat] text-xl font-extrabold">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-400">{text}</p></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="relative py-24 sm:py-32">
          <div className="mx-auto max-w-7xl px-5 sm:px-8">
            <div className="grid gap-12 lg:grid-cols-[1.05fr_.95fr] lg:items-center">
              <div className="relative">
                <div className="absolute -inset-5 rounded-[2.5rem] bg-gradient-to-br from-blue-600/25 to-red-500/10 blur-2xl" />
                <div className="relative aspect-video overflow-hidden rounded-[2rem] border border-white/15 bg-[#0b1426] shadow-[0_35px_100px_-30px_rgba(0,0,0,.9)]">
                  <video autoPlay loop muted playsInline preload="metadata" className="absolute inset-0 h-full w-full object-cover opacity-35"><source src={BRAND_VIDEO} type="video/mp4" /></video>
                  <div className="absolute inset-0 bg-gradient-to-t from-[#070d1a] via-[#070d1a]/55 to-transparent" />
                  <div className="absolute inset-x-0 bottom-0 p-7 sm:p-9"><div className="grid size-14 place-items-center rounded-full border border-white/20 bg-white/10 backdrop-blur-xl"><Play size={20} fill="currentColor" /></div><p className="mt-5 font-[Montserrat] text-2xl font-extrabold">Tecnologia com operação real por trás.</p><p className="mt-2 text-sm text-slate-400">Criada para o cotidiano de uma escola de idiomas.</p></div>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Experiência Wise Wolf</p>
                <h2 className="mt-5 font-[Montserrat] text-4xl font-extrabold leading-[1.04] tracking-[-0.045em] sm:text-6xl">Software sofisticado. <span className="text-slate-500">Uso simples.</span></h2>
                <p className="mt-6 text-base leading-8 text-slate-400 sm:text-lg">Cada perfil encontra apenas o que precisa: direção, coordenação, professores, comercial e alunos operam no mesmo ecossistema sem enfrentar a mesma complexidade.</p>
                <div className="mt-8 grid gap-3 sm:grid-cols-2">{['Implantação guiada', 'Permissões por função', 'Ambiente responsivo', 'Evolução contínua'].map((item) => <div key={item} className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.035] p-4 text-sm font-bold text-slate-300"><span className="grid size-6 place-items-center rounded-full bg-emerald-400/10 text-emerald-400"><Check size={13} /></span>{item}</div>)}</div>
              </div>
            </div>
          </div>
        </section>

        <section id="planos" className="relative overflow-hidden border-y border-white/[0.07] bg-[#0a1222] py-24 sm:py-32">
          <div className="absolute left-1/2 top-1/2 size-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-blue-600/[0.08] blur-[140px]" />
          <div className="relative mx-auto max-w-7xl px-5 sm:px-8">
            <div className="text-center"><p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Investimento claro</p><h2 className="mx-auto mt-5 max-w-4xl font-[Montserrat] text-4xl font-extrabold leading-[1.04] tracking-[-0.045em] sm:text-6xl">Um plano para cada fase da sua escola.</h2><p className="mx-auto mt-5 max-w-2xl leading-7 text-slate-400">Comece com a estrutura necessária agora e evolua conforme a operação pedir.</p>
              <div className="mx-auto mt-8 inline-flex rounded-2xl border border-white/10 bg-black/20 p-1.5" role="group" aria-label="Ciclo de cobrança">
                <button type="button" onClick={() => setYearlyBilling(false)} className={`rounded-xl px-5 py-2.5 text-xs font-extrabold transition ${!yearlyBilling ? 'bg-white text-slate-950 shadow-xl' : 'text-slate-400 hover:text-white'}`}>Mensal</button>
                <button type="button" onClick={() => setYearlyBilling(true)} className={`rounded-xl px-5 py-2.5 text-xs font-extrabold transition ${yearlyBilling ? 'bg-white text-slate-950 shadow-xl' : 'text-slate-400 hover:text-white'}`}>Anual <span className="ml-1 text-emerald-500">economize</span></button>
              </div>
            </div>
            <div className="mt-14 grid gap-5 lg:grid-cols-3">
              {plansLoading && [0, 1, 2].map((slot) => (
                <div key={slot} className="h-[510px] animate-pulse rounded-[2rem] border border-white/[0.08] bg-white/[0.035]" />
              ))}
              {!plansLoading && availablePlans.map((plan) => {
                const presentation: {
                  description: string;
                  features: string[];
                  popular?: boolean;
                } = planPresentation[plan.name] || {
                  description: plan.description || 'Estrutura completa para organizar e escalar sua operação.',
                  features: Array.isArray(plan.features)
                    ? plan.features.filter((feature): feature is string => typeof feature === 'string').slice(0, 5)
                    : [],
                  popular: false,
                };
                const monthlyPrice = Number(plan.price);
                const yearlyPrice = Number(plan.price_yearly || monthlyPrice * 12);
                const displayPrice = yearlyBilling
                  ? Math.round(yearlyPrice / 12)
                  : monthlyPrice;
                return (
                  <article key={plan.id} className={`relative flex flex-col overflow-hidden rounded-[2rem] border p-7 ${presentation.popular ? 'border-blue-400/50 bg-gradient-to-b from-blue-600/25 to-white/[0.04] shadow-[0_25px_80px_-30px_rgba(37,99,235,.8)]' : 'border-white/[0.08] bg-white/[0.035]'}`}>
                    {presentation.popular && <span className="absolute right-5 top-5 rounded-full bg-blue-600 px-3 py-1 text-[9px] font-extrabold uppercase tracking-[0.16em]">Mais escolhido</span>}
                    <p className="text-sm font-extrabold text-blue-300">{plan.name}</p>
                    <div className="mt-7 flex items-end gap-1"><span className="font-[Montserrat] text-5xl font-extrabold">R$ {displayPrice.toLocaleString('pt-BR')}</span><span className="pb-1.5 text-sm text-slate-500">/mês</span></div>
                    <p className="mt-2 text-xs font-bold text-emerald-400">{yearlyBilling ? `R$ ${yearlyPrice.toLocaleString('pt-BR')} cobrados por ano` : 'Cobrança mensal · cancele quando precisar'}</p>
                    <p className="mt-5 min-h-14 text-sm leading-6 text-slate-400">{plan.description || presentation.description}</p>
                    <div className="my-6 h-px bg-white/[0.08]" />
                    <ul className="flex-1 space-y-3 text-sm text-slate-300">{presentation.features.map((feature) => <li key={feature} className="flex gap-3"><span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-emerald-400/10 text-emerald-400"><Check size={12} /></span>{feature}</li>)}</ul>
                    <button onClick={() => setCheckoutPlan(plan)} className={`mt-8 w-full rounded-xl px-5 py-4 text-sm font-extrabold transition hover:-translate-y-0.5 ${presentation.popular ? 'bg-blue-600 hover:bg-blue-500' : 'border border-white/15 bg-white/[0.06] hover:bg-white/10'}`}>Começar agora</button>
                    <button onClick={() => handleOpenModal(`pricing_${plan.name.toLowerCase()}_demo`)} className="mt-3 text-xs font-bold text-slate-500 transition hover:text-white">Prefiro ver uma demonstração</button>
                  </article>
                );
              })}
              {!plansLoading && availablePlans.length === 0 && (
                <div className="col-span-full rounded-[2rem] border border-white/10 bg-white/[0.035] p-10 text-center">
                  <p className="font-[Montserrat] text-2xl font-extrabold">Planos em atualização</p>
                  <p className="mt-3 text-sm text-slate-400">Fale com nossa equipe para receber a condição ideal para sua escola.</p>
                  <button onClick={() => handleOpenModal('pricing_fallback')} className="mt-6 rounded-xl bg-blue-600 px-6 py-3.5 text-sm font-extrabold hover:bg-blue-500">Solicitar demonstração</button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section id="faq" className="py-24 sm:py-32">
          <div className="mx-auto grid max-w-7xl gap-12 px-5 sm:px-8 lg:grid-cols-[.75fr_1.25fr]">
            <div><p className="text-[10px] font-extrabold uppercase tracking-[0.24em] text-blue-400">Perguntas frequentes</p><h2 className="mt-5 font-[Montserrat] text-4xl font-extrabold leading-[1.04] tracking-[-0.045em] sm:text-5xl">O que você precisa saber antes de avançar.</h2><p className="mt-5 leading-7 text-slate-400">Ainda ficou alguma dúvida? Solicite uma demonstração e fale com nossa equipe.</p></div>
            <div className="space-y-3">{faqs.map((faq) => <details key={faq.question} className="group rounded-2xl border border-white/[0.08] bg-white/[0.035] p-5 open:border-blue-400/25 open:bg-white/[0.055]"><summary className="flex cursor-pointer list-none items-center justify-between gap-5 font-[Montserrat] font-extrabold"><span>{faq.question}</span><span className="grid size-8 shrink-0 place-items-center rounded-full bg-white/[0.06] text-blue-400 transition group-open:rotate-90"><ChevronRight size={16} /></span></summary><p className="mt-4 max-w-2xl pr-10 text-sm leading-7 text-slate-400">{faq.answer}</p></details>)}</div>
          </div>
        </section>

        <section className="px-5 pb-24 sm:px-8 sm:pb-32">
          <div className="relative mx-auto max-w-7xl overflow-hidden rounded-[2.5rem] border border-blue-400/20 bg-gradient-to-br from-blue-700 via-blue-600 to-[#122653] px-7 py-14 text-center shadow-[0_35px_100px_-35px_rgba(37,99,235,.85)] sm:px-14 sm:py-20">
            <PremiumGrid opacity="opacity-[0.08]" />
            <div className="absolute -right-16 -top-20 size-72 rounded-full bg-red-500/20 blur-3xl" />
            <div className="relative mx-auto max-w-4xl"><Zap className="mx-auto" size={30} /><h2 className="mt-6 font-[Montserrat] text-4xl font-extrabold leading-[1.04] tracking-[-0.045em] sm:text-6xl">Sua escola não precisa crescer no improviso.</h2><p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-blue-100 sm:text-lg">Veja como a Wise Wolf pode assumir o trabalho operacional e devolver à sua equipe tempo para ensinar, vender e liderar.</p><button onClick={() => handleOpenModal('final_demo')} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-7 py-4 text-sm font-extrabold text-blue-800 shadow-xl transition hover:-translate-y-0.5">Solicitar minha demonstração <ArrowRight size={17} /></button></div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.07] px-5 py-10 sm:px-8">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 text-center sm:flex-row sm:text-left"><BrandLogo compact /><div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500"><ShieldCheck size={15} className="text-blue-400" /> Operação, inteligência e experiência em um só sistema.</div><p className="text-xs text-slate-600">© {new Date().getFullYear()} Wise Wolf</p></div>
      </footer>

      {isModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-[#020611]/90 p-0 backdrop-blur-xl sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-labelledby="saas-lead-title">
          <div className="max-h-[96dvh] w-full max-w-lg overflow-y-auto rounded-t-[2rem] border border-white/10 bg-[#0b1426] p-6 text-white shadow-[0_40px_120px_-35px_rgba(0,0,0,.95)] sm:rounded-[2rem] sm:p-8">
            <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] font-black uppercase tracking-[0.22em] text-blue-400">Wise Wolf SaaS · Demonstração</p><h2 id="saas-lead-title" className="mt-2 font-[Montserrat] text-3xl font-extrabold tracking-tight">{submitted ? 'Recebemos sua solicitação' : 'Vamos entender sua escola'}</h2></div><button onClick={() => setIsModalOpen(false)} className="grid size-10 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Fechar"><X size={18} /></button></div>
            {submitted ? (
              <div className="py-10 text-center"><div className="mx-auto grid size-20 place-items-center rounded-full border border-emerald-400/20 bg-emerald-400/10"><CheckCircle size={36} className="text-emerald-400" /></div><p className="mx-auto mt-6 max-w-sm leading-7 text-slate-300">Nossa equipe recebeu seus dados e entrará em contato para apresentar a plataforma aplicada à realidade da sua operação.</p><button onClick={() => setIsModalOpen(false)} className="mt-7 rounded-xl bg-blue-600 px-6 py-3.5 text-sm font-extrabold shadow-lg shadow-blue-950">Entendi</button></div>
            ) : (
              <form onSubmit={handleSubmit} className="mt-7 space-y-4">
                <label className="block"><span className="mb-2 block text-xs font-black text-slate-300">Nome da escola</span><input value={formData.school_name} onChange={(event) => setFormData({ ...formData, school_name: event.target.value })} required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="Nome da sua escola ou operação" /></label>
                <label className="block"><span className="mb-2 block text-xs font-black text-slate-300">Seu nome</span><input value={formData.name} onChange={(event) => setFormData({ ...formData, name: event.target.value })} autoComplete="name" required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="Como devemos chamar você?" /></label>
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block"><span className="mb-2 block text-xs font-black text-slate-300">E-mail</span><input type="email" value={formData.email} onChange={(event) => setFormData({ ...formData, email: event.target.value })} autoComplete="email" required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="voce@escola.com" /></label>
                  <label className="block"><span className="mb-2 block text-xs font-black text-slate-300">WhatsApp</span><input type="tel" value={formData.phone} onChange={(event) => setFormData({ ...formData, phone: event.target.value })} autoComplete="tel" required className="w-full rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3.5 text-white outline-none placeholder:text-slate-600 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10" placeholder="(00) 90000-0000" /></label>
                </div>
                <button type="submit" disabled={loading} className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-4 text-sm font-extrabold text-white shadow-[0_18px_45px_-18px_rgba(37,99,235,.9)] hover:bg-blue-500 disabled:opacity-60">{loading ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}{loading ? 'Enviando...' : 'Solicitar demonstração'}</button>
                <p className="text-center text-[10px] leading-5 text-slate-500">Usaremos seus dados apenas para atender esta solicitação comercial.</p>
              </form>
            )}
          </div>
        </div>
      )}
      {checkoutPlan && (
        <SaasCheckout
          plan={checkoutPlan}
          yearly={yearlyBilling}
          onClose={() => setCheckoutPlan(null)}
        />
      )}
    </div>
  );
}
