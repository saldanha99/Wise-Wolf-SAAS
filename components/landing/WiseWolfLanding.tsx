import React, { useState, useEffect } from 'react';
import {
    ArrowRight, Check, Sparkles, Brain, Users, BarChart3, MessageSquare,
    Zap, Shield, Globe, Star, ChevronDown, GraduationCap, Building2,
    TrendingUp, Clock, Award, X, Loader2, CreditCard, Smartphone, FileText, Lock
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

const WiseWolfLanding: React.FC = () => {
    const [plans, setPlans] = useState<Plan[]>([]);
    const [yearly, setYearly] = useState(false);
    const [checkoutPlan, setCheckoutPlan] = useState<Plan | null>(null);
    const [mouseX, setMouseX] = useState(0);
    const [mouseY, setMouseY] = useState(0);

    useEffect(() => {
        loadPlans();
        const onMove = (e: MouseEvent) => { setMouseX(e.clientX); setMouseY(e.clientY); };
        window.addEventListener('mousemove', onMove);
        return () => window.removeEventListener('mousemove', onMove);
    }, []);

    const loadPlans = async () => {
        const { data } = await supabase.from('saas_plans').select('*').eq('active', true).order('price');
        setPlans((data || []) as Plan[]);
    };

    const scrollTo = (id: string) => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
    };

    return (
        <div className="min-h-screen bg-slate-950 text-white overflow-x-hidden font-sans relative">
            {/* Cursor glow */}
            <div
                className="pointer-events-none fixed w-[600px] h-[600px] rounded-full opacity-20 blur-3xl transition-transform duration-300 ease-out z-0"
                style={{
                    background: 'radial-gradient(circle, #a855f7 0%, transparent 70%)',
                    transform: `translate(${mouseX - 300}px, ${mouseY - 300}px)`,
                }}
            />

            {/* NAV */}
            <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-xl bg-slate-950/70 border-b border-white/5">
                <div className="max-w-7xl mx-auto px-4 sm:px-8 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center text-xl font-black">🐺</div>
                        <span className="text-lg font-black tracking-tight">Wise Wolf</span>
                    </div>
                    <div className="hidden md:flex items-center gap-8 text-sm text-slate-400">
                        <button onClick={() => scrollTo('features')} className="hover:text-white transition">Recursos</button>
                        <button onClick={() => scrollTo('pricing')} className="hover:text-white transition">Preços</button>
                        <button onClick={() => scrollTo('testimonials')} className="hover:text-white transition">Clientes</button>
                        <button onClick={() => scrollTo('faq')} className="hover:text-white transition">FAQ</button>
                    </div>
                    <div className="flex items-center gap-3">
                        <a href="/" className="hidden sm:inline text-sm text-slate-300 hover:text-white">Entrar</a>
                        <button onClick={() => scrollTo('pricing')} className="px-4 py-2 bg-white text-slate-950 rounded-full text-sm font-bold hover:scale-105 transition-transform">
                            Começar grátis
                        </button>
                    </div>
                </div>
            </nav>

            {/* HERO */}
            <section className="relative pt-32 pb-20 px-4 sm:px-8">
                <div className="absolute inset-0 -z-10 overflow-hidden">
                    <div className="absolute top-20 -left-20 w-[600px] h-[600px] rounded-full bg-violet-600/20 blur-[120px]" />
                    <div className="absolute top-40 right-0 w-[500px] h-[500px] rounded-full bg-pink-600/15 blur-[120px]" />
                    <div className="absolute bottom-0 left-1/2 w-[600px] h-[300px] rounded-full bg-cyan-500/10 blur-[100px]" />
                </div>

                <div className="max-w-7xl mx-auto text-center relative">
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-white/5 border border-white/10 mb-8 animate-in fade-in slide-in-from-top-4 duration-700">
                        <span className="relative flex w-2 h-2">
                            <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 animate-ping opacity-75" />
                            <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
                        </span>
                        <span className="text-xs font-medium text-slate-300">Plataforma #1 para escolas de inglês no Brasil</span>
                    </div>

                    <h1 className="text-5xl sm:text-7xl md:text-8xl font-black tracking-tighter leading-[0.9] mb-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
                        Sua escola de inglês,<br/>
                        <span className="bg-gradient-to-r from-violet-400 via-pink-400 to-cyan-400 bg-clip-text text-transparent">
                            no piloto automático.
                        </span>
                    </h1>

                    <p className="text-lg sm:text-xl text-slate-400 max-w-2xl mx-auto mb-10 leading-relaxed">
                        CRM, financeiro, agenda, IA tutora, automação no WhatsApp e contratos digitais — tudo em uma plataforma white-label desenhada para escolas que querem escalar.
                    </p>

                    <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-12">
                        <button onClick={() => scrollTo('pricing')} className="group relative px-8 py-4 bg-white text-slate-950 rounded-full text-base font-black hover:scale-105 transition-all flex items-center gap-2">
                            Começar trial grátis (14 dias)
                            <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                        </button>
                        <button onClick={() => scrollTo('features')} className="px-8 py-4 text-base font-medium text-slate-300 hover:text-white">
                            Ver como funciona
                        </button>
                    </div>

                    <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs text-slate-500">
                        <div className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Sem cartão</div>
                        <div className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Sem amarração</div>
                        <div className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> Migração assistida</div>
                        <div className="flex items-center gap-2"><Check size={14} className="text-emerald-400" /> LGPD compliant</div>
                    </div>

                    {/* Dashboard mockup */}
                    <div className="relative mt-16 max-w-5xl mx-auto">
                        <div className="absolute inset-0 bg-gradient-to-tr from-violet-500/30 to-pink-500/30 blur-3xl -z-10" />
                        <div className="rounded-2xl border border-white/10 bg-slate-900/80 backdrop-blur-xl shadow-2xl overflow-hidden">
                            <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/5 bg-slate-950/50">
                                <div className="w-3 h-3 rounded-full bg-rose-500" />
                                <div className="w-3 h-3 rounded-full bg-amber-500" />
                                <div className="w-3 h-3 rounded-full bg-emerald-500" />
                                <p className="ml-auto text-[10px] text-slate-500 font-mono">app.wisewolf.com.br</p>
                            </div>
                            <div className="p-6 grid grid-cols-12 gap-4">
                                <div className="col-span-3 space-y-3">
                                    {['Dashboard','Alunos','Professores','Financeiro','Wolfie AI'].map((it, i) => (
                                        <div key={it} className={`px-3 py-2 rounded-lg text-xs ${i===0?'bg-violet-600 text-white':'bg-white/5 text-slate-400'}`}>{it}</div>
                                    ))}
                                </div>
                                <div className="col-span-9 space-y-3">
                                    <div className="grid grid-cols-4 gap-2">
                                        {[
                                            { label:'Alunos', val:'487', color:'violet' },
                                            { label:'MRR', val:'R$184k', color:'pink' },
                                            { label:'Retenção', val:'94%', color:'cyan' },
                                            { label:'NPS', val:'72', color:'emerald' },
                                        ].map(s => (
                                            <div key={s.label} className="bg-white/5 rounded-lg p-3 border border-white/5">
                                                <p className="text-[9px] uppercase tracking-widest text-slate-500">{s.label}</p>
                                                <p className={`text-lg font-black text-${s.color}-400 mt-1`}>{s.val}</p>
                                            </div>
                                        ))}
                                    </div>
                                    <div className="bg-white/5 rounded-lg p-4 border border-white/5 h-32 flex items-end gap-1.5">
                                        {[40,55,38,62,71,58,75,82,78,90,95,85].map((h,i) => (
                                            <div key={i} className="flex-1 bg-gradient-to-t from-violet-600 to-pink-500 rounded-t" style={{height:`${h}%`}} />
                                        ))}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Social proof */}
                    <div className="mt-20">
                        <p className="text-xs text-slate-500 mb-6 uppercase tracking-widest">+800 escolas escalando com a gente</p>
                        <div className="flex flex-wrap items-center justify-center gap-x-12 gap-y-4 opacity-50">
                            {['ESCOLA A', 'WISE B', 'ENGLISH PRO', 'FLUENT CO', 'SPEAK FAST'].map(b => (
                                <span key={b} className="text-sm font-black tracking-widest text-slate-400">{b}</span>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            {/* FEATURES */}
            <section id="features" className="py-24 px-4 sm:px-8 relative">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16">
                        <p className="text-xs text-violet-400 font-bold uppercase tracking-widest mb-3">Tudo que você precisa</p>
                        <h2 className="text-4xl sm:text-6xl font-black tracking-tight mb-4">
                            Mais que um sistema.<br/>
                            <span className="text-slate-500">Uma máquina de crescer.</span>
                        </h2>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {FEATURES.map((f, i) => (
                            <FeatureCard key={f.title} {...f} delay={i * 50} />
                        ))}
                    </div>
                </div>
            </section>

            {/* RESULTS / STATS */}
            <section className="py-24 px-4 sm:px-8 relative">
                <div className="absolute inset-0 -z-10 bg-gradient-to-b from-transparent via-violet-950/20 to-transparent" />
                <div className="max-w-7xl mx-auto text-center">
                    <h2 className="text-4xl sm:text-5xl font-black tracking-tight mb-4">Resultados que falam por si</h2>
                    <p className="text-slate-400 mb-16 max-w-2xl mx-auto">Média das escolas que migraram para a Wise Wolf nos últimos 12 meses.</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
                        {[
                            { val:'3.2x', label:'mais alunos em 12 meses' },
                            { val:'-67%', label:'horas em tarefas operacionais' },
                            { val:'+R$45k', label:'em MRR ao final do 1º ano' },
                            { val:'94%', label:'de retenção média' },
                        ].map(s => (
                            <div key={s.val} className="border border-white/5 rounded-2xl p-6 bg-white/5 backdrop-blur">
                                <p className="text-4xl sm:text-5xl font-black bg-gradient-to-br from-violet-400 to-pink-400 bg-clip-text text-transparent">{s.val}</p>
                                <p className="text-xs text-slate-400 mt-3">{s.label}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* PRICING */}
            <section id="pricing" className="py-24 px-4 sm:px-8">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-xs text-violet-400 font-bold uppercase tracking-widest mb-3">Preços transparentes</p>
                        <h2 className="text-4xl sm:text-6xl font-black tracking-tight mb-4">
                            Escolha o plano que escala com você
                        </h2>
                        <p className="text-slate-400 max-w-2xl mx-auto">Comece grátis. 14 dias para testar tudo. Cancele quando quiser. Sem fidelidade.</p>

                        <div className="inline-flex items-center gap-3 mt-8 p-1 bg-white/5 rounded-full border border-white/10">
                            <button onClick={() => setYearly(false)} className={`px-5 py-2 rounded-full text-sm font-bold transition ${!yearly ? 'bg-white text-slate-950' : 'text-slate-400'}`}>
                                Mensal
                            </button>
                            <button onClick={() => setYearly(true)} className={`px-5 py-2 rounded-full text-sm font-bold transition relative ${yearly ? 'bg-white text-slate-950' : 'text-slate-400'}`}>
                                Anual
                                <span className="absolute -top-2 -right-2 text-[9px] bg-emerald-500 text-slate-950 px-1.5 py-0.5 rounded-full font-black">-15%</span>
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 max-w-5xl mx-auto">
                        {plans.map((p, i) => {
                            const popular = p.name === 'Pro';
                            const price = yearly ? p.price_yearly : p.price;
                            const monthly = yearly ? (p.price_yearly / 12) : p.price;
                            return (
                                <div key={p.id} className={`relative rounded-3xl p-6 ${popular ? 'bg-gradient-to-b from-violet-600 to-pink-600 scale-105' : 'bg-white/5 border border-white/10'}`}>
                                    {popular && (
                                        <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-1 bg-amber-400 text-slate-950 text-[10px] font-black uppercase tracking-widest rounded-full">
                                            Mais escolhido
                                        </div>
                                    )}
                                    <p className={`text-sm font-bold ${popular ? 'text-white/80' : 'text-slate-400'}`}>{p.name}</p>
                                    <p className={`text-xs mt-1 ${popular ? 'text-white/70' : 'text-slate-500'}`}>{p.description}</p>

                                    <div className="my-6">
                                        <div className="flex items-baseline gap-1">
                                            <span className={`text-xs ${popular ? 'text-white/70' : 'text-slate-400'}`}>R$</span>
                                            <span className="text-5xl font-black">{Math.round(monthly).toLocaleString('pt-BR')}</span>
                                            <span className={`text-sm ${popular ? 'text-white/70' : 'text-slate-400'}`}>/mês</span>
                                        </div>
                                        {yearly && <p className={`text-xs mt-1 ${popular ? 'text-white/70' : 'text-slate-500'}`}>R$ {price.toLocaleString('pt-BR')} cobrado anualmente</p>}
                                    </div>

                                    <button onClick={() => setCheckoutPlan(p)}
                                        className={`w-full py-3 rounded-xl text-sm font-black uppercase tracking-widest mb-6 ${popular ? 'bg-white text-violet-700 hover:bg-slate-100' : 'bg-white/10 text-white hover:bg-white/20 border border-white/20'} transition`}>
                                        Começar agora
                                    </button>

                                    <ul className="space-y-2.5 text-sm">
                                        <PlanFeature popular={popular} label={`${p.max_students.toLocaleString('pt-BR')} alunos`} />
                                        <PlanFeature popular={popular} label={`${p.max_users} usuários administrativos`} />
                                        <PlanFeature popular={popular} label={`${p.max_storage_gb}GB de armazenamento`} />
                                        {(p.features || []).map(f => (
                                            <PlanFeature key={f} popular={popular} label={f} />
                                        ))}
                                    </ul>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </section>

            {/* TESTIMONIALS */}
            <section id="testimonials" className="py-24 px-4 sm:px-8 relative">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-xs text-violet-400 font-bold uppercase tracking-widest mb-3">Eles confiam</p>
                        <h2 className="text-4xl sm:text-5xl font-black tracking-tight">O que dizem nossos diretores</h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {TESTIMONIALS.map(t => (
                            <div key={t.name} className="bg-white/5 border border-white/10 rounded-3xl p-6">
                                <div className="flex gap-1 mb-4">
                                    {[1,2,3,4,5].map(i => <Star key={i} size={14} className="fill-amber-400 text-amber-400" />)}
                                </div>
                                <p className="text-slate-300 leading-relaxed mb-6 text-sm">{t.quote}</p>
                                <div className="flex items-center gap-3">
                                    <div className={`w-10 h-10 rounded-full bg-gradient-to-br from-${t.color}-500 to-${t.color}-600 flex items-center justify-center font-black`}>
                                        {t.name.charAt(0)}
                                    </div>
                                    <div>
                                        <p className="text-sm font-bold">{t.name}</p>
                                        <p className="text-xs text-slate-400">{t.role}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* FAQ */}
            <section id="faq" className="py-24 px-4 sm:px-8">
                <div className="max-w-3xl mx-auto">
                    <div className="text-center mb-12">
                        <p className="text-xs text-violet-400 font-bold uppercase tracking-widest mb-3">Perguntas frequentes</p>
                        <h2 className="text-4xl sm:text-5xl font-black tracking-tight">Tudo que você quer saber</h2>
                    </div>
                    <div className="space-y-3">
                        {FAQS.map(f => <FaqItem key={f.q} {...f} />)}
                    </div>
                </div>
            </section>

            {/* FINAL CTA */}
            <section className="py-24 px-4 sm:px-8 relative">
                <div className="absolute inset-0 -z-10">
                    <div className="absolute inset-0 bg-gradient-to-br from-violet-900/30 via-pink-900/20 to-cyan-900/20" />
                </div>
                <div className="max-w-4xl mx-auto text-center">
                    <h2 className="text-4xl sm:text-6xl font-black tracking-tight mb-6">
                        Pronto para escalar?
                    </h2>
                    <p className="text-lg text-slate-300 mb-10 max-w-xl mx-auto">
                        Comece em 5 minutos. Sem cartão. Sem amarração. Migração assistida da sua planilha/sistema atual.
                    </p>
                    <button onClick={() => scrollTo('pricing')} className="group inline-flex items-center gap-3 px-8 py-4 bg-white text-slate-950 rounded-full text-base font-black hover:scale-105 transition">
                        Começar trial grátis
                        <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                    </button>
                </div>
            </section>

            {/* FOOTER */}
            <footer className="border-t border-white/5 py-12 px-4 sm:px-8">
                <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-500">
                    <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center">🐺</div>
                        <span className="font-black text-white">Wise Wolf</span>
                        <span className="ml-2">© 2026 · Todos os direitos reservados</span>
                    </div>
                    <div className="flex gap-6">
                        <a href="#" className="hover:text-white">Termos</a>
                        <a href="#" className="hover:text-white">Privacidade</a>
                        <a href="#" className="hover:text-white">Contato</a>
                    </div>
                </div>
            </footer>

            {/* CHECKOUT MODAL */}
            {checkoutPlan && (
                <SaasCheckout
                    plan={checkoutPlan}
                    yearly={yearly}
                    onClose={() => setCheckoutPlan(null)}
                />
            )}
        </div>
    );
};

// ─────────────────────────────────────────────────────────────
// COMPONENTES INTERNOS
// ─────────────────────────────────────────────────────────────
const FeatureCard: React.FC<any> = ({ title, desc, icon: Icon, gradient, delay }) => (
    <div className="group relative bg-white/5 border border-white/10 rounded-3xl p-6 hover:border-white/20 transition-all"
        style={{ animationDelay: `${delay}ms` }}>
        <div className={`absolute -inset-px rounded-3xl bg-gradient-to-br ${gradient} opacity-0 group-hover:opacity-20 transition-opacity blur-sm`} />
        <div className={`relative w-12 h-12 rounded-xl bg-gradient-to-br ${gradient} flex items-center justify-center mb-4`}>
            <Icon size={20} className="text-white" />
        </div>
        <h3 className="text-lg font-black mb-2 relative">{title}</h3>
        <p className="text-sm text-slate-400 leading-relaxed relative">{desc}</p>
    </div>
);

const PlanFeature: React.FC<{ label: string; popular?: boolean }> = ({ label, popular }) => (
    <li className="flex items-start gap-2">
        <Check size={16} className={popular ? 'text-white shrink-0 mt-0.5' : 'text-emerald-400 shrink-0 mt-0.5'} />
        <span className={popular ? 'text-white/90' : 'text-slate-300'}>{label}</span>
    </li>
);

const FaqItem: React.FC<{ q: string; a: string }> = ({ q, a }) => {
    const [open, setOpen] = useState(false);
    return (
        <button onClick={() => setOpen(!open)} className="w-full text-left bg-white/5 border border-white/10 rounded-2xl p-5 hover:bg-white/10 transition">
            <div className="flex items-start justify-between gap-4">
                <p className="font-bold text-white">{q}</p>
                <ChevronDown size={18} className={`text-slate-400 shrink-0 mt-1 transition-transform ${open ? 'rotate-180' : ''}`} />
            </div>
            {open && <p className="text-sm text-slate-400 mt-3 leading-relaxed">{a}</p>}
        </button>
    );
};

// ─────────────────────────────────────────────────────────────
// CONTENT
// ─────────────────────────────────────────────────────────────
const FEATURES = [
    { title: 'Wolfie AI Tutor', desc: 'Aluno conversa em inglês com IA que entende contexto, corrige na hora e adapta o nível.', icon: Brain, gradient: 'from-violet-500 to-purple-600' },
    { title: 'CRM & Funil de Vendas', desc: 'Capture leads, gere aulas experimentais, acompanhe conversão e comissione vendedores.', icon: TrendingUp, gradient: 'from-pink-500 to-rose-600' },
    { title: 'Financeiro Completo', desc: 'Asaas integrado, split por escola, inadimplência automática, comissões e fechamentos mensais.', icon: BarChart3, gradient: 'from-emerald-500 to-teal-600' },
    { title: 'Agenda Inteligente', desc: 'Bookings recorrentes, reposições, coberturas por doença, aulas experimentais — tudo num só lugar.', icon: Clock, gradient: 'from-blue-500 to-cyan-600' },
    { title: 'WhatsApp Automation', desc: 'Lembretes 60 min antes da aula, boas-vindas, cobranças, tudo automatizado via Evolution API.', icon: MessageSquare, gradient: 'from-emerald-400 to-green-600' },
    { title: 'Trilhas Didáticas', desc: 'Crie ou use trilhas prontas (Business, TOEFL). IA gera atividades. Aluno avança gamificado.', icon: GraduationCap, gradient: 'from-amber-500 to-orange-600' },
    { title: 'Multi-tenant White Label', desc: 'Cada escola com domínio próprio, marca, cores, contratos customizados. SaaS de verdade.', icon: Building2, gradient: 'from-fuchsia-500 to-pink-600' },
    { title: 'Segurança Enterprise', desc: 'RLS por tenant, LGPD compliant, audit trail completo, 2FA, criptografia at-rest.', icon: Shield, gradient: 'from-slate-500 to-slate-700' },
    { title: 'Portabilidade Total', desc: 'Exportação completa em JSON, API aberta, sem vendor lock-in. Seus dados são seus.', icon: Globe, gradient: 'from-indigo-500 to-violet-600' },
];

const TESTIMONIALS = [
    { name: 'Marcos Vinícius', role: 'Diretor · Wise Wolf SP', quote: 'Saímos de 80 para 487 alunos em 9 meses. A automação no WhatsApp sozinha já paga 4x o custo.', color: 'violet' },
    { name: 'Ana Paula', role: 'Diretora · English Pro RJ', quote: 'Antes eu passava 6h por dia em planilhas. Agora 30 minutos. O dashboard executivo é tudo.', color: 'pink' },
    { name: 'Roberto S.', role: 'Sócio · Fluent Co', quote: 'O Wolfie AI virou nosso diferencial. Os pais perguntam por isso na matrícula.', color: 'cyan' },
];

const FAQS = [
    { q: 'Preciso de cartão pra começar o trial?', a: 'Não. São 14 dias completos sem cartão, sem limite de funcionalidades. Você só paga se quiser continuar.' },
    { q: 'Posso migrar do sistema que uso hoje?', a: 'Sim. Nossa equipe migra alunos, professores, pagamentos e histórico de aulas da sua planilha/sistema atual. Sem custo extra no plano Pro/Enterprise.' },
    { q: 'Como funciona o multi-tenant?', a: 'Cada escola tem seu próprio espaço isolado: cores, logo, domínio (Pro+), contratos. Os dados de uma escola NUNCA aparecem para outra.' },
    { q: 'O Asaas cobra dos meus alunos diretamente?', a: 'Sim. A integração faz split: 90% vai pra subconta da sua escola no Asaas, 10% fica de taxa da plataforma. Você recebe direto.' },
    { q: 'E a LGPD?', a: 'Total. RLS por tenant, criptografia at-rest, audit trail completo, exportação JSON e anonimização sob demanda. Compliance 100%.' },
    { q: 'Tem fidelidade?', a: 'Não. Cancele quando quiser, exporte tudo, sem multa. Acreditamos no produto, não em amarrar cliente.' },
    { q: 'Suportam quantos alunos?', a: 'Starter até 100, Pro até 500, Enterprise ilimitado. Se sua escola for maior, fala com a gente para um plano custom.' },
];

export default WiseWolfLanding;
