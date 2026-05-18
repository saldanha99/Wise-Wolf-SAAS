import React, { useState, useEffect } from 'react';
import {
    ArrowRight, Check, Brain, Users, BarChart3, MessageSquare,
    Shield, Globe, Star, ChevronDown, GraduationCap, Building2,
    TrendingUp, Clock, Award
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import SaasCheckout from './SaasCheckout';

interface Plan {
    id: string;
    name: string;
    description: string;
    price: number;
    price_yearly: number;
    max_students: number;
    max_users: number;
    max_storage_gb: number;
    features: string[];
}

const LOGO_URL = 'https://wisewolflanguage.com.br/logo.png';
const VIDEO_URL = 'https://wisewolflanguage.com.br/grok-video-d537321f-f935-4b43-abb2-5446b61753dd.mp4';
const TEACHER_IMG = 'https://wisewolflanguage.com.br/images/teacher-online.jpg';
const CORP_LOGOS = [
    'https://wisewolflanguage.com.br/logos/ambev.png',
    'https://wisewolflanguage.com.br/logos/petrobras.png',
    'https://wisewolflanguage.com.br/logos/embraer.png',
    'https://wisewolflanguage.com.br/logos/lilly.png',
    'https://wisewolflanguage.com.br/logos/novo-nordisk.png',
    'https://wisewolflanguage.com.br/logos/tupy.png',
];

const WiseWolfLanding: React.FC = () => {
    const [plans, setPlans] = useState<Plan[]>([]);
    const [yearly, setYearly] = useState(false);
    const [checkoutPlan, setCheckoutPlan] = useState<Plan | null>(null);
    const [navScrolled, setNavScrolled] = useState(false);

    useEffect(() => {
        loadPlans();
        // Fonts
        if (!document.querySelector('link[data-ww-fonts]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.dataset.wwFonts = 'true';
            link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=Montserrat:wght@500;700;800&display=swap';
            document.head.appendChild(link);
        }
        const onScroll = () => setNavScrolled(window.scrollY > 20);
        window.addEventListener('scroll', onScroll);
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    const loadPlans = async () => {
        const { data } = await supabase.from('saas_plans').select('*').eq('active', true).order('price');
        setPlans((data || []) as Plan[]);
    };

    const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });

    return (
        <div style={{ background: '#070d1a', fontFamily: 'Inter, sans-serif', color: '#f8fafc' }} className="min-h-screen overflow-x-hidden">

            {/* NAV */}
            <nav className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${navScrolled ? 'glass-strong py-3' : 'py-5'}`}>
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-between">
                    <a href="#" className="flex items-center gap-3">
                        <img src={LOGO_URL} alt="Wise Wolf" className="h-9 w-9 rounded-lg" />
                        <div>
                            <p className="text-base font-bold text-white tracking-tight" style={{ fontFamily: 'Montserrat' }}>Wise Wolf</p>
                            <p className="text-[9px] text-blue-300/70 uppercase tracking-widest">SaaS para escolas</p>
                        </div>
                    </a>
                    <div className="hidden md:flex items-center gap-8 text-sm text-slate-300">
                        <button onClick={() => scrollTo('features')} className="hover:text-white transition">Plataforma</button>
                        <button onClick={() => scrollTo('pricing')} className="hover:text-white transition">Planos</button>
                        <button onClick={() => scrollTo('testimonials')} className="hover:text-white transition">Casos</button>
                        <button onClick={() => scrollTo('faq')} className="hover:text-white transition">FAQ</button>
                    </div>
                    <div className="flex items-center gap-3">
                        <a href="/" className="hidden sm:inline text-sm text-slate-300 hover:text-white">Entrar</a>
                        <button onClick={() => scrollTo('pricing')}
                            className="px-5 py-2.5 rounded-xl text-white font-semibold text-sm transition shadow-lg"
                            style={{ background: '#2563eb' }}
                            onMouseOver={e => (e.currentTarget.style.background = '#1d4ed8')}
                            onMouseOut={e => (e.currentTarget.style.background = '#2563eb')}>
                            Trial grátis
                        </button>
                    </div>
                </div>
            </nav>

            {/* HERO */}
            <section className="relative w-full min-h-[95vh] flex items-center pt-24 pb-12 overflow-hidden">
                {/* Vídeo bg */}
                <div className="absolute inset-0 z-0">
                    <video autoPlay loop muted playsInline preload="metadata" className="w-full h-full object-cover opacity-40">
                        <source src={VIDEO_URL} type="video/mp4" />
                    </video>
                    <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(7,13,26,0.97) 0%, rgba(7,13,26,0.85) 50%, rgba(7,13,26,0.35) 100%)' }} />
                </div>

                <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 w-full">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-20 items-center">
                        {/* LEFT: Copy */}
                        <div>
                            <div className="glass inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-blue-200 text-xs font-medium mb-6 uppercase tracking-wider">
                                <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                                Plataforma white-label para escolas de inglês
                            </div>

                            <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white tracking-tight leading-[1.1] mb-6 drop-shadow-2xl" style={{ fontFamily: 'Montserrat' }}>
                                Sua escola de inglês,<br />
                                <span className="text-transparent bg-clip-text font-extrabold" style={{ backgroundImage: 'linear-gradient(to right, #3b82f6, #2563eb, #ffffff)' }}>
                                    no piloto automático.
                                </span>
                            </h1>

                            <p className="mt-4 text-base md:text-lg text-slate-300 font-light leading-relaxed max-w-xl drop-shadow-lg mb-8">
                                CRM, financeiro, agenda inteligente, IA tutora, automação WhatsApp e contratos digitais — em uma plataforma desenhada para
                                <strong className="text-white font-semibold"> escolas que querem escalar de verdade.</strong>
                            </p>

                            <div className="flex flex-col sm:flex-row gap-3 mb-12">
                                <button onClick={() => scrollTo('pricing')}
                                    className="px-8 py-4 rounded-xl text-white font-semibold text-base flex items-center justify-center gap-2 shadow-2xl transition group"
                                    style={{ background: '#2563eb' }}
                                    onMouseOver={e => (e.currentTarget.style.background = '#1d4ed8')}
                                    onMouseOut={e => (e.currentTarget.style.background = '#2563eb')}>
                                    Começar trial gratuito (14 dias)
                                    <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                                </button>
                                <button onClick={() => scrollTo('features')} className="glass-button px-8 py-4 text-white font-medium text-base rounded-xl">
                                    Ver como funciona
                                </button>
                            </div>

                            <div className="grid grid-cols-3 gap-4 max-w-lg">
                                {[
                                    { val: '800+', label: 'Escolas' },
                                    { val: '94%', label: 'Retenção' },
                                    { val: '3.2x', label: 'Crescimento' },
                                ].map(s => (
                                    <div key={s.label} className="glass-card rounded-xl py-3 px-3 text-center border-l-2" style={{ borderLeftColor: '#2563eb' }}>
                                        <p className="text-xl font-bold text-white" style={{ fontFamily: 'Montserrat' }}>{s.val}</p>
                                        <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-wider font-light">{s.label}</p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* RIGHT: Dashboard mockup */}
                        <div className="relative">
                            <div className="absolute -inset-4 rounded-2xl opacity-30 blur-2xl" style={{ background: 'linear-gradient(135deg, #2563eb40, #3b82f640)' }} />
                            <div className="glass-strong rounded-2xl overflow-hidden relative">
                                <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/10">
                                    <div className="w-3 h-3 rounded-full bg-rose-500" />
                                    <div className="w-3 h-3 rounded-full bg-amber-500" />
                                    <div className="w-3 h-3 rounded-full bg-emerald-500" />
                                    <p className="ml-auto text-[10px] text-slate-400 font-mono">app.wisewolflanguage.com.br</p>
                                </div>
                                <div className="p-5 space-y-3">
                                    <div className="grid grid-cols-4 gap-2">
                                        {[
                                            { l: 'Alunos', v: '487', color: '#3b82f6' },
                                            { l: 'MRR', v: 'R$184k', color: '#10b981' },
                                            { l: 'Retenção', v: '94%', color: '#06b6d4' },
                                            { l: 'NPS', v: '72', color: '#f59e0b' },
                                        ].map(s => (
                                            <div key={s.l} className="glass-card rounded-lg p-2.5">
                                                <p className="text-[9px] uppercase tracking-widest text-slate-500">{s.l}</p>
                                                <p className="text-lg font-bold mt-1" style={{ color: s.color, fontFamily: 'Montserrat' }}>{s.v}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="glass-card rounded-lg p-4 h-32 flex items-end gap-1.5">
                                        {[40, 55, 38, 62, 71, 58, 75, 82, 78, 90, 95, 85].map((h, i) => (
                                            <div key={i} className="flex-1 rounded-t" style={{ height: `${h}%`, background: `linear-gradient(to top, #2563eb, #3b82f6)` }} />
                                        ))}
                                    </div>
                                    <div className="glass-card rounded-lg p-3 flex items-center gap-3">
                                        <img src={TEACHER_IMG} alt="Professor" className="w-10 h-10 rounded-full object-cover" />
                                        <div className="flex-1">
                                            <p className="text-xs font-bold text-white">Professor John</p>
                                            <p className="text-[10px] text-slate-400">12 alunos · R$ 4.250 este mês</p>
                                        </div>
                                        <span className="text-[10px] font-bold px-2 py-1 rounded-full" style={{ background: '#10b98120', color: '#10b981' }}>+18%</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Trust bar */}
                    <div className="mt-20">
                        <p className="text-xs text-slate-500 mb-6 uppercase tracking-widest text-center">Escolas que escalaram com a Wise Wolf</p>
                        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-6 opacity-70">
                            {CORP_LOGOS.map((src, i) => (
                                <img key={i} src={src} alt="logo" className="h-7 opacity-60 hover:opacity-100 transition grayscale hover:grayscale-0" />
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {/* FEATURES */}
            <section id="features" className="py-24 px-4 sm:px-6 lg:px-8 relative">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16">
                        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#3b82f6' }}>Tudo que você precisa</p>
                        <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-4 text-white" style={{ fontFamily: 'Montserrat' }}>
                            Mais que um sistema.<br />
                            <span className="text-slate-500">Uma máquina de crescer.</span>
                        </h2>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {FEATURES.map(f => <FeatureCard key={f.title} {...f} />)}
                    </div>
                </div>
            </section>

            {/* RESULTS */}
            <section className="py-24 px-4 sm:px-6 lg:px-8 relative">
                <div className="absolute inset-0 -z-10" style={{ background: 'linear-gradient(180deg, transparent, rgba(37,99,235,0.08), transparent)' }} />
                <div className="max-w-7xl mx-auto text-center">
                    <h2 className="text-3xl sm:text-5xl font-bold tracking-tight mb-4 text-white" style={{ fontFamily: 'Montserrat' }}>Resultados que falam por si</h2>
                    <p className="text-slate-400 mb-16 max-w-2xl mx-auto">Média das escolas que migraram para a Wise Wolf nos últimos 12 meses.</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                        {[
                            { val: '3.2x', label: 'mais alunos em 12 meses' },
                            { val: '-67%', label: 'horas em tarefas operacionais' },
                            { val: '+R$45k', label: 'em MRR ao final do 1º ano' },
                            { val: '94%', label: 'de retenção média' },
                        ].map(s => (
                            <div key={s.val} className="glass-card rounded-2xl p-6">
                                <p className="text-4xl sm:text-5xl font-bold bg-clip-text text-transparent" style={{ fontFamily: 'Montserrat', backgroundImage: 'linear-gradient(135deg, #3b82f6, #ffffff)' }}>{s.val}</p>
                                <p className="text-xs text-slate-400 mt-3">{s.label}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* PRICING */}
            <section id="pricing" className="py-24 px-4 sm:px-6 lg:px-8">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#3b82f6' }}>Preços transparentes</p>
                        <h2 className="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-4 text-white" style={{ fontFamily: 'Montserrat' }}>
                            Escolha o plano que escala com você
                        </h2>
                        <p className="text-slate-400 max-w-2xl mx-auto">Comece grátis. 14 dias para testar tudo. Cancele quando quiser.</p>

                        <div className="inline-flex items-center gap-3 mt-8 p-1 glass rounded-full">
                            <button onClick={() => setYearly(false)} className={`px-5 py-2 rounded-full text-sm font-semibold transition ${!yearly ? 'bg-white text-slate-900' : 'text-slate-400'}`}>
                                Mensal
                            </button>
                            <button onClick={() => setYearly(true)} className={`px-5 py-2 rounded-full text-sm font-semibold transition relative ${yearly ? 'bg-white text-slate-900' : 'text-slate-400'}`}>
                                Anual
                                <span className="absolute -top-2 -right-2 text-[9px] bg-emerald-500 text-slate-950 px-1.5 py-0.5 rounded-full font-black">-15%</span>
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
                        {plans.map(p => {
                            const popular = p.name === 'Pro';
                            const price = yearly ? p.price_yearly : p.price;
                            const monthly = yearly ? (p.price_yearly / 12) : p.price;
                            return (
                                <div key={p.id} className={`relative rounded-3xl p-6 transition ${popular ? 'lg:scale-105 shadow-2xl' : 'glass-card'}`}
                                    style={popular ? { background: 'linear-gradient(135deg, #2563eb, #1d4ed8)' } : undefined}>
                                    {popular && (
                                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-amber-400 text-slate-900 text-[10px] font-bold uppercase tracking-widest rounded-full">
                                            Mais escolhido
                                        </div>
                                    )}
                                    <p className={`text-sm font-bold ${popular ? 'text-white/90' : 'text-slate-300'}`}>{p.name}</p>
                                    <p className={`text-xs mt-1 ${popular ? 'text-white/70' : 'text-slate-500'}`}>{p.description}</p>

                                    <div className="my-6">
                                        <div className="flex items-baseline gap-1">
                                            <span className={`text-xs ${popular ? 'text-white/70' : 'text-slate-400'}`}>R$</span>
                                            <span className="text-5xl font-bold text-white" style={{ fontFamily: 'Montserrat' }}>{Math.round(monthly).toLocaleString('pt-BR')}</span>
                                            <span className={`text-sm ${popular ? 'text-white/70' : 'text-slate-400'}`}>/mês</span>
                                        </div>
                                        {yearly && <p className={`text-xs mt-1 ${popular ? 'text-white/70' : 'text-slate-500'}`}>R$ {price.toLocaleString('pt-BR')} cobrado anualmente</p>}
                                    </div>

                                    <button onClick={() => setCheckoutPlan(p)}
                                        className={`w-full py-3 rounded-xl text-sm font-bold uppercase tracking-widest mb-6 transition ${popular ? 'bg-white text-blue-700 hover:bg-slate-100' : 'glass-button text-white'}`}>
                                        Começar agora
                                    </button>

                                    <ul className="space-y-2.5 text-sm">
                                        <PlanFeature popular={popular} label={`${p.max_students.toLocaleString('pt-BR')} alunos`} />
                                        <PlanFeature popular={popular} label={`${p.max_users} usuários administrativos`} />
                                        <PlanFeature popular={popular} label={`${p.max_storage_gb}GB de armazenamento`} />
                                        {(p.features || []).map(f => <PlanFeature key={f} popular={popular} label={f} />)}
                                    </ul>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </section>

            {/* TESTIMONIALS */}
            <section id="testimonials" className="py-24 px-4 sm:px-6 lg:px-8 relative">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#3b82f6' }}>Eles confiam</p>
                        <h2 className="text-4xl sm:text-5xl font-bold tracking-tight text-white" style={{ fontFamily: 'Montserrat' }}>O que dizem nossos diretores</h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {TESTIMONIALS.map(t => (
                            <div key={t.name} className="glass-card rounded-3xl p-6">
                                <div className="flex gap-1 mb-4">
                                    {[1, 2, 3, 4, 5].map(i => <Star key={i} size={14} className="fill-amber-400 text-amber-400" />)}
                                </div>
                                <p className="text-slate-300 leading-relaxed mb-6 text-sm">{t.quote}</p>
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full flex items-center justify-center font-bold text-white" style={{ background: 'linear-gradient(135deg, #2563eb, #3b82f6)' }}>
                                        {t.name.charAt(0)}
                                    </div>
                                    <div>
                                        <p className="text-sm font-bold text-white">{t.name}</p>
                                        <p className="text-xs text-slate-400">{t.role}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* FAQ */}
            <section id="faq" className="py-24 px-4 sm:px-6 lg:px-8">
                <div className="max-w-3xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: '#3b82f6' }}>Perguntas frequentes</p>
                        <h2 className="text-4xl sm:text-5xl font-bold tracking-tight text-white" style={{ fontFamily: 'Montserrat' }}>Tudo que você quer saber</h2>
                    </div>
                    <div className="space-y-3">
                        {FAQS.map(f => <FaqItem key={f.q} {...f} />)}
                    </div>
                </div>
            </section>

            {/* FINAL CTA */}
            <section className="py-24 px-4 sm:px-6 lg:px-8 relative">
                <div className="absolute inset-0 -z-10" style={{ background: 'linear-gradient(135deg, rgba(37,99,235,0.25), rgba(59,130,246,0.15))' }} />
                <div className="max-w-4xl mx-auto text-center">
                    <h2 className="text-4xl sm:text-6xl font-bold tracking-tight mb-6 text-white" style={{ fontFamily: 'Montserrat' }}>
                        Pronto para escalar?
                    </h2>
                    <p className="text-lg text-slate-300 mb-10 max-w-xl mx-auto">
                        Comece em 5 minutos. Sem cartão. Sem amarração. Migração assistida.
                    </p>
                    <button onClick={() => scrollTo('pricing')}
                        className="group inline-flex items-center gap-3 px-8 py-4 rounded-xl text-white font-bold text-base shadow-2xl transition"
                        style={{ background: '#2563eb' }}
                        onMouseOver={e => (e.currentTarget.style.background = '#1d4ed8')}
                        onMouseOut={e => (e.currentTarget.style.background = '#2563eb')}>
                        Começar trial grátis
                        <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                    </button>
                </div>
            </section>

            {/* FOOTER */}
            <footer className="border-t border-white/5 py-12 px-4 sm:px-6 lg:px-8">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-500">
                    <div className="flex items-center gap-3">
                        <img src={LOGO_URL} alt="Wise Wolf" className="h-7 w-7 rounded" />
                        <span className="font-bold text-white" style={{ fontFamily: 'Montserrat' }}>Wise Wolf</span>
                        <span>© 2026 · Todos os direitos reservados</span>
                    </div>
                    <div className="flex gap-6">
                        <a href="https://wisewolflanguage.com.br" className="hover:text-white">Site institucional</a>
                        <a href="#" className="hover:text-white">Termos</a>
                        <a href="#" className="hover:text-white">Privacidade</a>
                    </div>
                </div>
            </footer>

            {checkoutPlan && <SaasCheckout plan={checkoutPlan} yearly={yearly} onClose={() => setCheckoutPlan(null)} />}
        </div>
    );
};

const FeatureCard: React.FC<any> = ({ title, desc, icon: Icon }) => (
    <div className="group glass-card rounded-3xl p-6 cursor-default">
        <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-transform group-hover:scale-110"
            style={{ background: 'linear-gradient(135deg, #2563eb, #3b82f6)' }}>
            <Icon size={20} className="text-white" />
        </div>
        <h3 className="text-lg font-bold mb-2 text-white" style={{ fontFamily: 'Montserrat' }}>{title}</h3>
        <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
    </div>
);

const PlanFeature: React.FC<{ label: string; popular?: boolean }> = ({ label, popular }) => (
    <li className="flex items-start gap-2">
        <Check size={16} className={popular ? 'text-white shrink-0 mt-0.5' : 'text-blue-400 shrink-0 mt-0.5'} />
        <span className={popular ? 'text-white/90' : 'text-slate-300'}>{label}</span>
    </li>
);

const FaqItem: React.FC<{ q: string; a: string }> = ({ q, a }) => {
    const [open, setOpen] = useState(false);
    return (
        <button onClick={() => setOpen(!open)} className="w-full text-left glass-card rounded-2xl p-5">
            <div className="flex items-start justify-between gap-4">
                <p className="font-semibold text-white">{q}</p>
                <ChevronDown size={18} className={`text-slate-400 shrink-0 mt-1 transition-transform ${open ? 'rotate-180' : ''}`} />
            </div>
            {open && <p className="text-sm text-slate-400 mt-3 leading-relaxed">{a}</p>}
        </button>
    );
};

const FEATURES = [
    { title: 'Wolfie AI Tutor', desc: 'Aluno conversa em inglês com IA que entende contexto, corrige na hora e adapta o nível.', icon: Brain },
    { title: 'CRM & Funil de Vendas', desc: 'Capture leads, gere aulas experimentais, acompanhe conversão e comissione vendedores.', icon: TrendingUp },
    { title: 'Financeiro Completo', desc: 'Asaas integrado, split por escola, inadimplência automática, comissões e fechamentos mensais.', icon: BarChart3 },
    { title: 'Agenda Inteligente', desc: 'Bookings recorrentes, reposições, coberturas por doença, aulas experimentais — tudo num só lugar.', icon: Clock },
    { title: 'WhatsApp Automation', desc: 'Lembretes 60 min antes da aula, boas-vindas, cobranças, tudo automatizado via Evolution API.', icon: MessageSquare },
    { title: 'Trilhas Didáticas', desc: 'Crie ou use trilhas prontas (Business, TOEFL). IA gera atividades. Aluno avança gamificado.', icon: GraduationCap },
    { title: 'Multi-tenant White Label', desc: 'Cada escola com domínio próprio, marca, cores, contratos customizados. SaaS de verdade.', icon: Building2 },
    { title: 'Segurança Enterprise', desc: 'RLS por tenant, LGPD compliant, audit trail completo, 2FA, criptografia at-rest.', icon: Shield },
    { title: 'Portabilidade Total', desc: 'Exportação completa em JSON, API aberta, sem vendor lock-in. Seus dados são seus.', icon: Globe },
];

const TESTIMONIALS = [
    { name: 'Marcos Vinícius', role: 'Diretor · Wise Wolf SP', quote: 'Saímos de 80 para 487 alunos em 9 meses. A automação no WhatsApp sozinha já paga 4x o custo.' },
    { name: 'Ana Paula', role: 'Diretora · English Pro RJ', quote: 'Antes eu passava 6h por dia em planilhas. Agora 30 minutos. O dashboard executivo é tudo.' },
    { name: 'Roberto S.', role: 'Sócio · Fluent Co', quote: 'O Wolfie AI virou nosso diferencial. Os pais perguntam por isso na matrícula.' },
];

const FAQS = [
    { q: 'Preciso de cartão pra começar o trial?', a: 'Não. 14 dias completos sem cartão, sem limite de funcionalidades. Você só paga se quiser continuar.' },
    { q: 'Posso migrar do sistema que uso hoje?', a: 'Sim. Nossa equipe migra alunos, professores, pagamentos e histórico da sua planilha/sistema atual. Sem custo extra nos planos Pro/Enterprise.' },
    { q: 'Como funciona o multi-tenant?', a: 'Cada escola tem seu espaço isolado: cores, logo, domínio (Pro+), contratos. Os dados de uma escola NUNCA aparecem para outra.' },
    { q: 'O Asaas cobra dos meus alunos diretamente?', a: 'Sim. A integração faz split: 90% vai pra subconta da sua escola no Asaas, 10% fica de taxa da plataforma. Você recebe direto.' },
    { q: 'E a LGPD?', a: 'Total. RLS por tenant, criptografia at-rest, audit trail completo, exportação JSON e anonimização sob demanda.' },
    { q: 'Tem fidelidade?', a: 'Não. Cancele quando quiser, exporte tudo, sem multa.' },
    { q: 'Suportam quantos alunos?', a: 'Starter até 100, Pro até 500, Enterprise ilimitado. Se sua escola for maior, fala com a gente para um plano custom.' },
];

export default WiseWolfLanding;
