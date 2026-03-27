import React, { useState } from 'react';
import { HeroScrollDemo } from './HeroScrollDemo';
import { PricingBasic } from './PricingBasic';
import { RadialOrbitalTimelineDemo } from './TimelineDemo';
import { TestimonialsDemo } from './TestimonialsDemo';
import { FeaturesGrid } from './FeaturesGrid';
import { FaqSection } from './FaqSection';
import { Button } from '@/components/ui/button';
import { ArrowRight, CheckCircle, ShieldCheck, TrendingUp, Users, X } from 'lucide-react';
import { motion } from 'framer-motion';
import { supabase } from '../../lib/supabase';

export default function SaasLandingPage() {
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [formData, setFormData] = useState({ name: '', school_name: '', email: '', phone: '', source: 'saas_hero' });
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const handleOpenModal = (source: string) => {
        setFormData(prev => ({ ...prev, source }));
        setIsModalOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            // Insert into B2B SaaS Leads table
            const { error } = await supabase.from('saas_leads').insert({
                name: formData.name,
                school_name: formData.school_name, // Capture School Name
                email: formData.email,
                phone: formData.phone,
                status: 'LEAD',
                notes: `Source: ${formData.source}`
            });

            if (error) throw error;
            setSubmitted(true);
        } catch (err: any) {
            console.error("Error submitting lead:", err);
            alert("Erro ao enviar. Tente novamente ou contate suporte.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-black text-white selection:bg-blue-500 selection:text-white overflow-x-hidden font-sans">

            {/* Sticky Translucent Navbar */}
            <nav className="fixed top-0 w-full z-50 bg-black/60 backdrop-blur-xl border-b border-white/5 supports-[backdrop-filter]:bg-black/60">
                <div className="container mx-auto px-6 py-4 flex justify-between items-center">
                    <div className="text-2xl font-black tracking-tighter flex items-center gap-2">
                        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center">
                            <span className="text-white font-bold">W</span>
                        </div>
                        WISE WOLF
                    </div>
                    <div className="hidden md:flex gap-6 items-center">
                        <a href="#features" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Funcionalidades</a>
                        <a href="#testimonials" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Depoimentos</a>
                        <a href="#pricing" className="text-sm font-medium text-zinc-400 hover:text-white transition-colors">Preços</a>
                    </div>
                    <div className="flex gap-4">
                        <Button variant="ghost" className="text-zinc-300 hover:text-white hover:bg-white/10">Login</Button>
                        <Button
                            onClick={() => handleOpenModal('nav_button')}
                            className="bg-white text-black hover:bg-blue-50 font-bold rounded-full px-6 transition-all hover:scale-105 shadow-[0_0_20px_rgba(255,255,255,0.3)]">
                            Começar Agora
                        </Button>
                    </div>
                </div>
            </nav>

            {/* HERO SECTION: Problem & Agitation focus */}
            <div className="pt-32 pb-10 px-6">
                <div className="container mx-auto text-center max-w-5xl">
                    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-900/30 border border-blue-500/30 text-blue-400 text-xs font-bold uppercase tracking-widest mb-8 animate-in fade-in slide-in-from-bottom-4 duration-1000">
                        <span className="relative flex h-2 w-2">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                        </span>
                        A Nova Era da Gestão Escolar
                    </div>

                    <h1 className="text-5xl md:text-7xl lg:text-8xl font-black tracking-tighter leading-[0.95] mb-8 bg-clip-text text-transparent bg-gradient-to-b from-white via-white to-zinc-500">
                        Gerencie sua Escola <br />
                        <span className="text-blue-600">Sem Perder o Sono</span>
                    </h1>

                    <p className="text-xl md:text-2xl text-zinc-400 max-w-3xl mx-auto leading-relaxed mb-10">
                        Pare de lutar com planilhas e cobranças manuais. O <span className="text-white font-bold">Wise Wolf</span> automatiza o financeiro, engaja alunos com gamificação e te devolve o controle total.
                    </p>

                    <div className="flex flex-col sm:flex-row justify-center gap-4 mb-20">
                        <Button
                            onClick={() => handleOpenModal('hero_primary')}
                            size="lg" className="h-16 px-10 text-xl rounded-full bg-blue-600 hover:bg-blue-500 text-white font-bold shadow-[0_0_50px_-10px_rgba(37,99,235,0.5)] hover:scale-105 transition-all w-full sm:w-auto">
                            Criar Conta Gratuita <ArrowRight className="ml-2 w-6 h-6" />
                        </Button>
                        <Button size="lg" variant="outline" className="h-16 px-10 text-xl rounded-full border-zinc-700 hover:bg-zinc-800 text-white w-full sm:w-auto">
                            Ver Demo de 2min
                        </Button>
                    </div>

                    {/* Trust Signals Mini */}
                    <div className="flex flex-wrap justify-center gap-8 items-center text-zinc-500 text-sm font-medium">
                        <div className="flex items-center gap-2">
                            <CheckCircle size={16} className="text-green-500" /> Sem cartão de crédito
                        </div>
                        <div className="flex items-center gap-2">
                            <CheckCircle size={16} className="text-green-500" /> Cancelamento a qualquer momento
                        </div>
                        <div className="flex items-center gap-2">
                            <ShieldCheck size={16} className="text-green-500" /> Dados Criptografados
                        </div>
                    </div>
                </div>
            </div>

            {/* HERO SCROLL DEMO */}
            <div className="-mt-10 md:-mt-20">
                <HeroScrollDemo />
            </div>

            {/* STATS STRIP: Dopamine hits */}
            <section className="border-y border-white/5 bg-zinc-950/50 py-12 backdrop-blur-sm">
                <div className="container mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
                    <div>
                        <div className="text-4xl md:text-5xl font-black text-white mb-2">+30%</div>
                        <div className="text-zinc-500 text-sm font-bold uppercase tracking-wider">LTV do Aluno</div>
                    </div>
                    <div>
                        <div className="text-4xl md:text-5xl font-black text-white mb-2">0%</div>
                        <div className="text-zinc-500 text-sm font-bold uppercase tracking-wider">Inadimplência</div>
                    </div>
                    <div>
                        <div className="text-4xl md:text-5xl font-black text-white mb-2">10x</div>
                        <div className="text-zinc-500 text-sm font-bold uppercase tracking-wider">Mais Rápido</div>
                    </div>
                    <div>
                        <div className="text-4xl md:text-5xl font-black text-white mb-2">24/7</div>
                        <div className="text-zinc-500 text-sm font-bold uppercase tracking-wider">Suporte</div>
                    </div>
                </div>
            </section>

            {/* FEATURES GRID: The "Solution" */}
            <div id="features">
                <FeaturesGrid />
            </div>

            {/* TIMELINE: The "Journey" */}
            <section className="py-24 relative bg-black overflow-hidden">
                <div className="absolute top-0 w-full h-px bg-gradient-to-r from-transparent via-blue-900 to-transparent" />
                <div className="container mx-auto px-6 mb-16 text-center">
                    <h2 className="text-3xl md:text-5xl font-black tracking-tight mb-6">
                        Jornada do Dono de Escola
                    </h2>
                    <p className="text-zinc-400 max-w-2xl mx-auto text-lg">
                        Deixe o operacional no piloto automático e foca no que importa: <span className="text-white font-bold">Ensinar e Vender.</span>
                    </p>
                </div>
                <div className="h-[700px] w-full relative">
                    <RadialOrbitalTimelineDemo />
                </div>
            </section>

            {/* TESTIMONIALS: Social Proof */}
            <section id="testimonials" className="py-24 bg-zinc-900/30">
                <TestimonialsDemo />
            </section>

            {/* PRICING: The "Offer" */}
            <section className="py-24 bg-black relative" id="pricing">
                {/* Glow Effect */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-blue-600/10 rounded-full blur-[120px] pointer-events-none" />

                <div className="container mx-auto px-6 text-center mb-16 relative z-10">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-bold uppercase tracking-widest mb-6">
                        Investimento Inteligente
                    </div>
                    <h2 className="text-4xl md:text-6xl font-black tracking-tighter text-white mb-6">
                        Pague-se com o primeiro aluno.
                    </h2>
                    <p className="text-zinc-400 max-w-2xl mx-auto text-lg">
                        Nossos planos custam menos que uma mensalidade. O ROI é instantâneo.
                    </p>
                </div>
                <PricingBasic />
            </section>

            {/* FAQ */}
            <FaqSection />

            {/* FINAL CTA: Scarcity/Urgency */}
            <section className="py-32 relative overflow-hidden bg-gradient-to-b from-black to-blue-950/20">
                <div className="container relative z-10 mx-auto px-6 text-center">
                    <TrendingUp size={64} className="text-blue-500 mx-auto mb-8 animate-bounce" />
                    <h2 className="text-5xl md:text-8xl font-black tracking-tighter mb-8 text-white">
                        Comece Agora.
                    </h2>
                    <p className="text-xl text-zinc-400 mb-12 max-w-lg mx-auto">
                        Não deixe para amanhã o crescimento que você pode ter hoje. Junte-se a centenas de escolas.
                    </p>
                    <div className="flex flex-col items-center gap-4">
                        <Button
                            onClick={() => handleOpenModal('footer_cta')}
                            size="lg" className="h-20 px-16 rounded-full text-2xl bg-white text-black hover:bg-zinc-200 font-black shadow-[0_0_60px_-15px_rgba(255,255,255,0.5)] hover:scale-105 transition-transform">
                            Acessar Plataforma <ArrowRight className="ml-3 w-8 h-8" />
                        </Button>
                        <p className="text-sm text-zinc-500 mt-4">
                            Setup em 2 minutos • Sem fidelidade • Comece grátis
                        </p>
                    </div>
                </div>
            </section>

            {/* CAPTURE MODAL */}
            {isModalOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 max-w-md w-full shadow-2xl relative text-white">
                        <button
                            onClick={() => setIsModalOpen(false)}
                            className="absolute top-4 right-4 text-zinc-500 hover:text-white transition-colors"
                        >
                            <X size={24} />
                        </button>

                        {!submitted ? (
                            <>
                                <div className="text-center mb-8">
                                    <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-900/50">
                                        <Users className="text-white" />
                                    </div>
                                    <h3 className="text-2xl font-black tracking-tight">Crie sua Conta</h3>
                                    <p className="text-zinc-400 text-sm mt-2">Dê o primeiro passo para transformar sua escola.</p>
                                </div>

                                <form onSubmit={handleSubmit} className="space-y-4">
                                    <div>
                                        <label className="text-xs font-bold text-zinc-500 uppercase ml-1">Nome da Escola</label>
                                        <input
                                            type="text"
                                            required
                                            value={formData.school_name}
                                            onChange={e => setFormData({ ...formData, school_name: e.target.value })}
                                            className="w-full px-4 py-3 bg-black/50 border border-zinc-800 rounded-xl focus:ring-2 focus:ring-blue-600 outline-none text-white placeholder:text-zinc-600"
                                            placeholder="Ex: Wise Wolf Academy"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-zinc-500 uppercase ml-1">Seu Nome</label>
                                        <input
                                            type="text"
                                            required
                                            value={formData.name}
                                            onChange={e => setFormData({ ...formData, name: e.target.value })}
                                            className="w-full px-4 py-3 bg-black/50 border border-zinc-800 rounded-xl focus:ring-2 focus:ring-blue-600 outline-none text-white placeholder:text-zinc-600"
                                            placeholder="Ex: Daniel Marques"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-zinc-500 uppercase ml-1">Email Corporativo</label>
                                        <input
                                            type="email"
                                            required
                                            value={formData.email}
                                            onChange={e => setFormData({ ...formData, email: e.target.value })}
                                            className="w-full px-4 py-3 bg-black/50 border border-zinc-800 rounded-xl focus:ring-2 focus:ring-blue-600 outline-none text-white placeholder:text-zinc-600"
                                            placeholder="diretoria@suaescola.com"
                                        />
                                    </div>
                                    <div>
                                        <label className="text-xs font-bold text-zinc-500 uppercase ml-1">WhatsApp</label>
                                        <input
                                            type="tel"
                                            required
                                            value={formData.phone}
                                            onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                            className="w-full px-4 py-3 bg-black/50 border border-zinc-800 rounded-xl focus:ring-2 focus:ring-blue-600 outline-none text-white placeholder:text-zinc-600"
                                            placeholder="(00) 90000-0000"
                                        />
                                    </div>

                                    <Button
                                        type="submit"
                                        disabled={loading}
                                        className="w-full h-14 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded-xl mt-4"
                                    >
                                        {loading ? 'Processando...' : 'Iniciar Teste Gratuito'}
                                    </Button>
                                    <p className="text-[10px] text-center text-zinc-500">
                                        Ao continuar, você concorda com nossos termos.
                                    </p>
                                </form>
                            </>
                        ) : (
                            <div className="text-center py-10">
                                <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-6">
                                    <CheckCircle size={40} className="text-green-500" />
                                </div>
                                <h3 className="text-2xl font-black text-white mb-2">Solicitação Recebida!</h3>
                                <p className="text-zinc-400 mb-6">
                                    Nossa equipe comercial entrará em contato em breve para liberar seu acesso.
                                </p>
                                <Button
                                    variant="outline"
                                    onClick={() => { setIsModalOpen(false); setSubmitted(false); }}
                                    className="border-zinc-700 text-white hover:bg-zinc-800"
                                >
                                    Fechar
                                </Button>
                            </div>
                        )}
                    </div>
                </div>
            )}

        </div>
    );
}
