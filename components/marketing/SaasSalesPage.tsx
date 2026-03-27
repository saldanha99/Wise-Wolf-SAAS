import React, { useState } from 'react';
import { supabase } from '../../lib/supabase';
import { CheckCircle, BarChart3, Globe, Shield, ArrowRight, Play } from 'lucide-react';
import { motion } from 'framer-motion';

const SaasSalesPage: React.FC = () => {
    const [formData, setFormData] = useState({ name: '', school_name: '', email: '', phone: '' });
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const { error } = await supabase.from('saas_leads').insert([{
                name: formData.name,
                school_name: formData.school_name,
                email: formData.email,
                phone: formData.phone,
                status: 'LEAD'
            }]);

            if (error) throw error;
            setSubmitted(true);
        } catch (error) {
            console.error('Error submitting lead', error);
            alert('Erro ao enviar. Tente novamente.');
        } finally {
            setLoading(false);
        }
    };

    if (submitted) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
                <div className="bg-white p-8 rounded-3xl shadow-xl max-w-lg text-center">
                    <div className="w-20 h-20 bg-emerald-100 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6">
                        <CheckCircle size={40} />
                    </div>
                    <h2 className="text-3xl font-black text-slate-800 mb-2">Solicitação Recebida!</h2>
                    <p className="text-slate-500 mb-8">Nossa equipe entrará em contato em breve para agendar sua demonstração personalizada.</p>
                    <button onClick={() => setSubmitted(false)} className="text-blue-600 font-bold hover:underline">
                        Voltar ao site
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen font-sans bg-white text-slate-900">
            {/* Header */}
            <header className="fixed w-full z-50 bg-white/80 backdrop-blur-md border-b border-slate-100">
                <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
                    <div className="flex items-center gap-2 font-black text-2xl tracking-tighter text-indigo-600">
                        <Shield size={32} />
                        <span>WiseWolf</span>
                    </div>
                    <nav className="hidden md:flex gap-8 font-medium text-sm text-slate-600">
                        <a href="#features" className="hover:text-indigo-600 transition">Recursos</a>
                        <a href="#benefits" className="hover:text-indigo-600 transition">Benefícios</a>
                        <a href="#pricing" className="hover:text-indigo-600 transition">Planos</a>
                    </nav>
                    <button className="bg-slate-900 text-white px-6 py-2.5 rounded-full font-bold text-sm hover:bg-slate-800 transition shadow-lg shadow-slate-900/20">
                        Login Aluno
                    </button>
                </div>
            </header>

            {/* Hero */}
            <section className="pt-32 pb-20 px-6 bg-slate-50">
                <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-12 items-center">
                    <div>
                        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold uppercase tracking-wide mb-6">
                            <span className="w-2 h-2 rounded-full bg-indigo-600 animate-pulse"></span>
                            Novo: Módulo de IA para Aulas
                        </div>
                        <h1 className="text-5xl lg:text-7xl font-black tracking-tight text-slate-900 mb-6 leading-[1.1]">
                            A Gestão da sua Escola <span className="text-indigo-600">Reinventada.</span>
                        </h1>
                        <p className="text-lg text-slate-600 mb-8 max-w-xl leading-relaxed">
                            Automatize matrículas, financeiro e pedagógico. Tenha seu próprio aplicativo White Label e escale sua escola de cursos livres.
                        </p>
                        <div className="flex flex-col sm:flex-row gap-4">
                            <a href="#demo" className="bg-indigo-600 text-white px-8 py-4 rounded-2xl font-black text-lg shadow-xl shadow-indigo-600/30 hover:scale-105 transition-transform flex items-center justify-center gap-2">
                                Agendar Demo <ArrowRight size={20} />
                            </a>
                            <button className="bg-white text-slate-700 border border-slate-200 px-8 py-4 rounded-2xl font-bold text-lg hover:bg-slate-50 transition flex items-center justify-center gap-2">
                                <Play size={20} className="fill-slate-700" /> Ver Vídeo
                            </button>
                        </div>
                        <div className="mt-8 flex items-center gap-4 text-sm font-semibold text-slate-400">
                            <div className="flex -space-x-2">
                                {[1, 2, 3, 4].map(i => <div key={i} className="w-8 h-8 rounded-full bg-slate-300 border-2 border-white"></div>)}
                            </div>
                            <span>+500 Escolas confiam</span>
                        </div>
                    </div>
                    <div className="relative">
                        <div className="absolute inset-0 bg-gradient-to-tr from-indigo-500/20 to-purple-500/20 rounded-[3rem] blur-3xl transform rotate-6"></div>
                        <img
                            src="https://images.unsplash.com/photo-1460925895917-afdab827c52f?ixlib=rb-4.0.3&auto=format&fit=crop&w=2426&q=80"
                            alt="Dashboard Preview"
                            className="relative rounded-[2.5rem] shadow-2xl border-8 border-white transform hover:-translate-y-2 transition-transform duration-500"
                        />
                    </div>
                </div>
            </section>

            {/* Features */}
            <section id="features" className="py-24 px-6 bg-white">
                <div className="max-w-7xl mx-auto">
                    <div className="text-center mb-16">
                        <h2 className="text-4xl font-black mb-4">Tudo o que você precisa</h2>
                        <p className="text-xl text-slate-500">Uma suite completa de ferramentas para modernizar sua operação.</p>
                    </div>

                    <div className="grid md:grid-cols-3 gap-8">
                        {[
                            { icon: Globe, title: 'Landing Pages Automáticas', desc: 'Crie páginas de alta conversão para seus cursos em segundos, sem programar.' },
                            { icon: BarChart3, title: 'CRM Integrado', desc: 'Funil de vendas visual para acompanhar cada lead desde o interesse até a matrícula.' },
                            { icon: Shield, title: 'Financeiro Blindado', desc: 'Emita boletos e pix automáticos, reduza a inadimplência com régua de cobrança.' }
                        ].map((feat, i) => (
                            <div key={i} className="p-8 rounded-3xl bg-slate-50 border border-slate-100 hover:shadow-lg transition-all group">
                                <div className="w-14 h-14 bg-white rounded-2xl shadow-sm text-indigo-600 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                                    <feat.icon size={28} />
                                </div>
                                <h3 className="text-xl font-bold mb-3">{feat.title}</h3>
                                <p className="text-slate-600 leading-relaxed">{feat.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* CTA / Form Section */}
            <section id="demo" className="py-24 px-6 bg-slate-900 text-white relative overflow-hidden">
                <div className="absolute top-0 right-0 w-1/2 h-full bg-gradient-to-l from-indigo-900/50 to-transparent pointer-events-none"></div>
                <div className="max-w-5xl mx-auto grid lg:grid-cols-2 gap-16 items-center relative z-10">
                    <div>
                        <h2 className="text-4xl lg:text-5xl font-black mb-6">Pronto para escalar sua escola?</h2>
                        <p className="text-lg text-slate-300 mb-8">
                            Junte-se a centenas de gestores que abandonaram as planilhas e profissionalizaram sua gestão.
                        </p>
                        <ul className="space-y-4 mb-8">
                            {['Setup Gratuito', 'Suporte Humanizado', 'Migração de Dados', '7 Dias de Garantia'].map((item, i) => (
                                <li key={i} className="flex items-center gap-3 font-bold text-emerald-400">
                                    <CheckCircle size={20} className="fill-emerald-400/20" /> {item}
                                </li>
                            ))}
                        </ul>
                    </div>
                    <div className="bg-white text-slate-900 p-8 rounded-3xl shadow-2xl">
                        <h3 className="text-2xl font-black mb-6">Solicite uma Demo VIP</h3>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Nome Completo</label>
                                <input
                                    className="w-full bg-slate-100 border-none rounded-xl p-3 font-semibold focus:ring-2 focus:ring-indigo-500"
                                    value={formData.name} onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    required
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Nome da Escola</label>
                                <input
                                    className="w-full bg-slate-100 border-none rounded-xl p-3 font-semibold focus:ring-2 focus:ring-indigo-500"
                                    value={formData.school_name} onChange={e => setFormData({ ...formData, school_name: e.target.value })}
                                    required
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-1">Email</label>
                                    <input
                                        type="email"
                                        className="w-full bg-slate-100 border-none rounded-xl p-3 font-semibold focus:ring-2 focus:ring-indigo-500"
                                        value={formData.email} onChange={e => setFormData({ ...formData, email: e.target.value })}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase text-slate-500 mb-1">WhatsApp</label>
                                    <input
                                        className="w-full bg-slate-100 border-none rounded-xl p-3 font-semibold focus:ring-2 focus:ring-indigo-500"
                                        value={formData.phone} onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                        required
                                    />
                                </div>
                            </div>
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-indigo-600 text-white font-black py-4 rounded-xl text-lg hover:bg-indigo-700 transition shadow-lg shadow-indigo-600/20 mt-4 disabled:opacity-50"
                            >
                                {loading ? 'Enviando...' : 'Agendar Demonstração'}
                            </button>
                        </form>
                    </div>
                </div>
            </section>
        </div>
    );
};

export default SaasSalesPage;
