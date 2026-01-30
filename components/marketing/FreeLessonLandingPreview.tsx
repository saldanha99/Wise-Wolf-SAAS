import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { supabase } from '../../lib/supabase';
import { CheckCircle2, XCircle, Star, ChevronDown, ChevronUp, Send, User, Mail, Phone, ArrowRight } from 'lucide-react';
import confetti from 'canvas-confetti';

interface FreeLessonLandingPreviewProps {
    headline: string;
    subheadline: string;
    heroImage?: string; // We might use this as a background or specific image
    ctaText?: string;
    tenantId?: string; // Needed for CRM
    onSubmit?: (data: any) => Promise<void> | void;
}

const FreeLessonLandingPreview: React.FC<FreeLessonLandingPreviewProps> = ({
    headline,
    subheadline,
    heroImage,
    ctaText,
    tenantId,
    onSubmit
}) => {
    // defaults
    const mainHeadline = headline || "Aprenda Inglês online com aulas particulares e acelere sua fluência!";
    const mainSubheadline = subheadline || "Garanta sua fluência mais rápido com o método que já ajudou mais de 7.000 alunos.";
    const buttonText = ctaText || "Começar Agora";

    // Form State
    const [formData, setFormData] = useState({ name: '', email: '', phone: '', level: 'Iniciante', goal: 'Fluência' });
    const [loading, setLoading] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);

        try {
            if (onSubmit) {
                await onSubmit(formData);
            } else {
                // Fallback simulation
                await new Promise(resolve => setTimeout(resolve, 1000));
                console.log("Lead captured (Preview):", formData);
            }

            setSubmitted(true);
            confetti({
                particleCount: 100,
                spread: 70,
                origin: { y: 0.6 }
            });

        } catch (err) {
            console.error(err);
            alert("Erro ao enviar. Tente novamente.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="w-full h-full relative overflow-y-auto bg-white font-sans text-slate-900 scrollbar-hide">

            {/* HERO SECTION */}
            <section className="relative min-h-[600px] lg:min-h-[700px] bg-gradient-to-br from-[#002366] via-[#003399] to-[#001a4d] overflow-hidden flex items-center">
                {/* Background Accents */}
                <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
                    <div className="absolute -top-20 -left-20 w-[600px] h-[600px] bg-blue-500/20 rounded-full blur-[100px]" />
                    <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-[#D32F2F]/20 rounded-full blur-[100px]" />
                    {/* Curved Red Line Decoration */}
                    <svg className="absolute left-0 bottom-0 h-full w-1/2 opacity-30" viewBox="0 0 100 100" preserveAspectRatio="none">
                        <path d="M0 100 C 30 50 70 50 100 100 L 0 100" fill="#D32F2F" />
                    </svg>
                </div>

                <div className="container mx-auto px-6 relative z-10 grid lg:grid-cols-2 gap-12 items-center">
                    {/* Left Content */}
                    <motion.div
                        initial={{ opacity: 0, x: -50 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.8 }}
                        className="text-white space-y-6"
                    >
                        <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-1.5 rounded-full border border-white/20">
                            <span className="w-2 h-2 rounded-full bg-[#D32F2F] animate-pulse" />
                            <span className="text-xs font-bold tracking-wider uppercase">Vagas Limitadas para este mês</span>
                        </div>

                        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[1.1] tracking-tight">
                            {mainHeadline}
                        </h1>

                        <p className="text-lg sm:text-xl text-blue-100/90 leading-relaxed max-w-lg">
                            {mainSubheadline}
                        </p>

                        <div className="flex items-center gap-4 pt-4">
                            <div className="flex -space-x-3">
                                {[1, 2, 3, 4].map(i => (
                                    <div key={i} className="w-10 h-10 rounded-full border-2 border-[#002366] bg-gray-200 overflow-hidden">
                                        <img src={`https://i.pravatar.cc/100?img=${i + 10}`} alt="avatar" className="w-full h-full object-cover" />
                                    </div>
                                ))}
                            </div>
                            <div className="text-sm">
                                <div className="flex items-center text-yellow-400">
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                </div>
                                <span className="text-blue-200 font-medium">+15.000 aulas realizadas</span>
                            </div>
                        </div>
                    </motion.div>

                    {/* Right Form Card */}
                    <motion.div
                        initial={{ opacity: 0, y: 50 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.8, delay: 0.2 }}
                        className="bg-white rounded-3xl p-8 shadow-2xl relative overflow-hidden"
                    >
                        <div className="absolute top-0 left-0 w-full h-2 bg-gradient-to-r from-[#002366] to-[#D32F2F]" />

                        {!submitted ? (
                            <>
                                <div className="text-center mb-8">
                                    <h3 className="text-2xl font-black text-[#002366] mb-2">Agende sua aula grátis</h3>
                                    <p className="text-gray-500 text-sm">Preencha o formulário abaixo e entraremos em contato.</p>
                                </div>

                                <form onSubmit={handleSubmit} className="space-y-4">
                                    <div className="space-y-1">
                                        <label className="text-xs font-bold text-gray-700 uppercase ml-1">Nome Completo</label>
                                        <div className="relative">
                                            <User className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                                            <input
                                                type="text"
                                                required
                                                value={formData.name}
                                                onChange={e => setFormData({ ...formData, name: e.target.value })}
                                                className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] focus:border-[#002366] transition-all outline-none text-sm font-medium"
                                                placeholder="Seu nome aqui"
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-1">
                                        <label className="text-xs font-bold text-gray-700 uppercase ml-1">Email</label>
                                        <div className="relative">
                                            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                                            <input
                                                type="email"
                                                required
                                                value={formData.email}
                                                onChange={e => setFormData({ ...formData, email: e.target.value })}
                                                className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] focus:border-[#002366] transition-all outline-none text-sm font-medium"
                                                placeholder="seu@email.com"
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-1">
                                        <label className="text-xs font-bold text-gray-700 uppercase ml-1">WhatsApp</label>
                                        <div className="relative">
                                            <Phone className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                                            <input
                                                type="tel"
                                                required
                                                value={formData.phone}
                                                onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                                className="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] focus:border-[#002366] transition-all outline-none text-sm font-medium"
                                                placeholder="(00) 00000-0000"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-1">
                                            <label className="text-xs font-bold text-gray-700 uppercase ml-1">Nível de Inglês</label>
                                            <select
                                                value={formData.level}
                                                onChange={e => setFormData({ ...formData, level: e.target.value })}
                                                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] outline-none text-sm font-medium appearance-none"
                                            >
                                                <option value="Iniciante">Iniciante</option>
                                                <option value="Básico">Básico</option>
                                                <option value="Intermediário">Intermediário</option>
                                                <option value="Avançado">Avançado</option>
                                            </select>
                                        </div>
                                        <div className="space-y-1">
                                            <label className="text-xs font-bold text-gray-700 uppercase ml-1">Objetivo</label>
                                            <select
                                                value={formData.goal}
                                                onChange={e => setFormData({ ...formData, goal: e.target.value })}
                                                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] outline-none text-sm font-medium appearance-none"
                                            >
                                                <option value="Fluência">Fluência Geral</option>
                                                <option value="Viagem">Viagem</option>
                                                <option value="Trabalho">Trabalho</option>
                                                <option value="Exame">Toefl/IELTS</option>
                                            </select>
                                        </div>
                                    </div>

                                    <button
                                        type="submit"
                                        disabled={loading}
                                        className="w-full bg-[#D32F2F] hover:bg-[#b71c1c] text-white font-black py-4 rounded-xl shadow-lg shadow-red-500/30 transform hover:-translate-y-1 transition-all flex items-center justify-center gap-2 group"
                                    >
                                        {loading ? "Enviando..." : buttonText}
                                        {!loading && <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />}
                                    </button>

                                    <p className="text-[10px] text-center text-gray-400 mt-4">
                                        Ao enviar, você concorda com nossos termos de privacidade. Seus dados estão seguros.
                                    </p>
                                </form>
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-12 text-center animate-in fade-in zoom-in duration-500">
                                <div className="w-20 h-20 bg-green-100 rounded-full flex items-center justify-center mb-6">
                                    <CheckCircle2 size={40} className="text-green-600" />
                                </div>
                                <h3 className="text-2xl font-black text-[#002366] mb-2">Pré-agendamento realizado!</h3>
                                <p className="text-gray-600 mb-6 max-w-xs mx-auto">
                                    Para confirmar o horário com um de nossos professores, clique no botão abaixo.
                                </p>
                                <a
                                    href={`https://wa.me/5511999999999?text=Olá, acabei de me cadastrar na aula experimental! Meu nome é ${formData.name}.`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-4 rounded-xl shadow-lg shadow-green-500/30 transform hover:-translate-y-1 transition-all flex items-center justify-center gap-2 group mb-4"
                                >
                                    <Send size={18} />
                                    Confirmar no WhatsApp
                                </a>
                                <button onClick={() => setSubmitted(false)} className="text-xs font-bold text-gray-400 hover:text-gray-600">
                                    Voltar ao início
                                </button>
                            </div>
                        )}
                    </motion.div>
                </div>
            </section>

            {/* SOCIAL PROOF */}
            <section className="py-12 bg-white border-b border-gray-100">
                <div className="container mx-auto px-6">
                    <p className="text-center text-gray-400 font-bold text-sm uppercase tracking-widest mb-8">
                        Já ajudamos mais de 7.000 alunos a conquistarem a fluência
                    </p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-8 items-center justify-items-center opacity-60 grayscale hover:grayscale-0 transition-all duration-500">
                        {/* Placeholders for logos */}
                        <div className="h-8 bg-gray-200 w-32 rounded-lg" />
                        <div className="h-8 bg-gray-200 w-32 rounded-lg" />
                        <div className="h-8 bg-gray-200 w-32 rounded-lg" />
                        <div className="h-8 bg-gray-200 w-32 rounded-lg" />
                    </div>
                </div>
            </section>

            {/* COMPARISON */}
            <section className="py-24 bg-gray-50 relative overflow-hidden">
                <div className="container mx-auto px-6 relative z-10">
                    <div className="text-center max-w-3xl mx-auto mb-16">
                        <h2 className="text-3xl lg:text-4xl font-black text-[#002366] mb-4">Por que escolher o nosso método?</h2>
                        <p className="text-gray-600">Esqueça os métodos tradicionais que focam apenas em gramática. Aqui o foco é conversação.</p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
                        <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 opacity-70 scale-95">
                            <h3 className="text-xl font-bold text-gray-500 mb-6 flex items-center gap-2">
                                <XCircle className="text-red-300" /> Escola Tradicional
                            </h3>
                            <ul className="space-y-4">
                                {['Salas lotadas (10+ alunos)', 'Foco excessivo em gramática', 'Professores sem vivência', 'Contratos de fidelidade longos'].map((item, i) => (
                                    <li key={i} className="flex items-center gap-3 text-gray-500">
                                        <XCircle size={18} className="text-red-200 shrink-0" />
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        <div className="bg-white p-8 rounded-3xl shadow-xl border-2 border-[#002366] relative scale-100 transform md:-translate-y-4">
                            <div className="absolute top-0 right-0 bg-[#002366] text-white text-xs font-bold px-3 py-1 rounded-bl-xl rounded-tr-lg">
                                RECOMENDADO
                            </div>
                            <h3 className="text-xl font-bold text-[#002366] mb-6 flex items-center gap-2">
                                <CheckCircle2 className="text-green-500" /> Wise Wolf
                            </h3>
                            <ul className="space-y-4">
                                {['Aulas particulares ou grupos VIP', 'Foco 100% em conversação', 'Professores Nativos ou Fluentes', 'Sem multas absurdas', 'Plataforma Gamificada'].map((item, i) => (
                                    <li key={i} className="flex items-center gap-3 text-gray-800 font-medium">
                                        <CheckCircle2 size={18} className="text-green-500 shrink-0" />
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            </section>

            {/* STEPS METHODOLOGY */}
            <section className="py-24 bg-white">
                <div className="container mx-auto px-6">
                    <div className="grid lg:grid-cols-2 gap-16 items-center">
                        <div className="order-2 lg:order-1">
                            <div className="space-y-12">
                                {[
                                    { title: 'Plano Personalizado', text: 'Criamos um roadmap de estudos baseado no seus objetivos e interesses.' },
                                    { title: 'Imersão Total', text: 'Você fala inglês desde o primeiro dia, sem medo de errar.' },
                                    { title: 'Feedback Constante', text: 'Correção ativa e relatórios de evolução mensais.' }
                                ].map((step, i) => (
                                    <div key={i} className="flex gap-6">
                                        <div className="flex-shrink-0 w-12 h-12 rounded-2xl bg-blue-50 flex items-center justify-center text-[#002366] font-black text-xl">
                                            {i + 1}
                                        </div>
                                        <div>
                                            <h4 className="text-xl font-bold text-[#002366] mb-2">{step.title}</h4>
                                            <p className="text-gray-600 leading-relaxed">{step.text}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="order-1 lg:order-2 relative">
                            <div className="absolute inset-0 bg-blue-500 rounded-[3rem] rotate-3 opacity-10"></div>
                            <img
                                src="https://images.unsplash.com/photo-1571260899304-425eee4c7efc?q=80&w=2070&auto=format&fit=crop"
                                alt="Student Happy"
                                className="rounded-[3rem] shadow-2xl relative z-10 w-full object-cover h-[600px]"
                            />
                        </div>
                    </div>
                </div>
            </section>

            {/* TESTIMONIALS */}
            <section className="py-24 bg-[#002366] text-white overflow-hidden relative">
                <div className="absolute top-0 right-0 w-[400px] h-[400px] bg-[#D32F2F] rounded-full blur-[150px] opacity-20" />

                <div className="container mx-auto px-6 relative z-10 text-center">
                    <h2 className="text-3xl lg:text-4xl font-black mb-16">O que nossos alunos dizem</h2>

                    <div className="grid md:grid-cols-3 gap-8">
                        {[1, 2, 3].map((i) => (
                            <div key={i} className="bg-white/5 backdrop-blur-md border border-white/10 p-8 rounded-2xl text-left hover:bg-white/10 transition-colors">
                                <div className="flex gap-1 mb-4">
                                    {[1, 2, 3, 4, 5].map(s => <Star key={s} size={14} className="fill-yellow-400 text-yellow-400" />)}
                                </div>
                                <p className="text-blue-100 mb-6 italic">"A melhor decisão que tomei. Em 6 meses evoluí mais do que em 3 anos de curso tradicional."</p>
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-gray-300 overflow-hidden">
                                        <img src={`https://i.pravatar.cc/100?img=${i + 20}`} alt="User" />
                                    </div>
                                    <div>
                                        <p className="font-bold text-sm">Aluno {i}</p>
                                        <p className="text-xs text-blue-300">Nível B2</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* FAQ */}
            <section className="py-24 bg-gray-50">
                <div className="container mx-auto px-6 max-w-3xl">
                    <h2 className="text-3xl font-black text-[#002366] mb-12 text-center">Perguntas Frequentes</h2>
                    <div className="space-y-4">
                        {[
                            { q: 'A aula é realmente gratuita?', a: 'Sim! A primeira aula é 100% gratuita para você conhecer nossa metodologia.' },
                            { q: 'Preciso ter conhecimento prévio?', a: 'Não, atendemos desde o nível básico até o avançado.' },
                            { q: 'Como são as aulas?', a: 'As aulas são online e ao vivo, com foco total em conversação.' }
                        ].map((faq, i) => (
                            <details key={i} className="group bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                                <summary className="flex justify-between items-center p-6 cursor-pointer font-bold text-gray-800">
                                    {faq.q}
                                    <span className="transition-transform group-open:rotate-180 text-blue-500">
                                        <ChevronDown />
                                    </span>
                                </summary>
                                <div className="px-6 pb-6 text-gray-600 leading-relaxed">
                                    {faq.a}
                                </div>
                            </details>
                        ))}
                    </div>
                </div>
            </section>

            {/* FOOTER */}
            <footer className="bg-white border-t border-gray-100 py-12">
                <div className="container mx-auto px-6 text-center">
                    <p className="text-gray-400 text-sm">© 2026 Wise Wolf. Todos os direitos reservados.</p>
                </div>
            </footer>

        </div>
    );
};

export default FreeLessonLandingPreview;
