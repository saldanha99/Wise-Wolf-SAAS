import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, XCircle, Star, ChevronDown, CheckCircle2, ArrowRight } from 'lucide-react';

interface Plan {
    name: string;
    price: string;
    features: string[];
}

interface PremiumLandingPreviewProps {
    headline: string;
    subheadline: string;
    heroImage?: string;
    ctaText?: string;
    plans?: Plan[];
    onSubmit?: (data: any) => Promise<void> | void;
}

const PremiumLandingPreview: React.FC<PremiumLandingPreviewProps> = ({
    headline,
    subheadline,
    heroImage,
    ctaText,
    plans = [],
    onSubmit
}) => {
    // Lead Capture State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedInterest, setSelectedInterest] = useState('');
    const [formData, setFormData] = useState({ name: '', email: '', phone: '' });
    const [submitting, setSubmitting] = useState(false);

    const handleOpenModal = (interest: string) => {
        setSelectedInterest(interest);
        setIsModalOpen(true);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            if (onSubmit) {
                await onSubmit({ ...formData, notes: `Interesse: ${selectedInterest}` });
            }
            setIsModalOpen(false);
            setFormData({ name: '', email: '', phone: '' });
            alert("Recebemos seu contato! Em breve um consultor falará com você.");
        } catch (error) {
            console.error("Error submitting", error);
        } finally {
            setSubmitting(false);
        }
    };
    // Defaults
    const mainHeadline = headline || "Sua Escola de Inglês Premium";
    const mainSubheadline = subheadline || "Metodologia exclusiva para você dominar o idioma com professores nativos e foco total em conversação.";
    const buttonText = ctaText || "Ver Planos e Preços";
    const bgImage = heroImage || "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?q=80&w=2071&auto=format&fit=crop";

    const scrollToPlans = () => {
        document.getElementById('plans-section')?.scrollIntoView({ behavior: 'smooth' });
    };

    return (
        <div className="w-full h-full relative overflow-y-auto bg-white font-sans text-slate-900 scrollbar-hide">

            {/* HERO SECTION */}
            <section className="relative min-h-[600px] lg:min-h-[700px] bg-gradient-to-br from-[#002366] via-[#003399] to-[#001a4d] overflow-hidden flex items-center">
                {/* Background Accents - Consistent with FreeLesson */}
                <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0">
                    <div className="absolute -top-20 -left-20 w-[600px] h-[600px] bg-blue-500/20 rounded-full blur-[100px]" />
                    <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-[#D32F2F]/20 rounded-full blur-[100px]" />
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
                        className="text-white space-y-8"
                    >
                        <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm px-4 py-1.5 rounded-full border border-white/20">
                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-xs font-bold tracking-wider uppercase">Matrículas Abertas</span>
                        </div>

                        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[1.1] tracking-tight">
                            {mainHeadline}
                        </h1>

                        <p className="text-lg sm:text-xl text-blue-100/90 leading-relaxed max-w-lg shadow-black drop-shadow-sm">
                            {mainSubheadline}
                        </p>

                        <div className="flex flex-col sm:flex-row gap-4 pt-2">
                            <button
                                onClick={() => handleOpenModal('Botão Hero Principal')}
                                className="bg-[#D32F2F] hover:bg-[#b71c1c] text-white font-black py-4 px-8 rounded-xl shadow-lg shadow-red-500/30 transform hover:-translate-y-1 transition-all flex items-center justify-center gap-2 group text-lg"
                            >
                                {buttonText}
                                <ArrowRight size={20} className="group-hover:translate-x-1 transition-transform" />
                            </button>
                            <button
                                onClick={() => handleOpenModal('Falar com Consultor (Hero)')}
                                className="bg-white/10 hover:bg-white/20 text-white font-bold py-4 px-8 rounded-xl backdrop-blur-sm border border-white/20 transition-all flex items-center justify-center text-lg"
                            >
                                Falar com Consultor
                            </button>
                        </div>

                        <div className="flex items-center gap-4 text-sm text-blue-200">
                            <div className="flex -space-x-2">
                                {[1, 2, 3].map(i => (
                                    <div key={i} className="w-8 h-8 rounded-full border-2 border-[#002366] bg-gray-200 overflow-hidden">
                                        <img src={`https://i.pravatar.cc/100?img=${i + 25}`} alt="avatar" className="w-full h-full object-cover" />
                                    </div>
                                ))}
                            </div>
                            <span>Junte-se a +15k alunos satisfeitos</span>
                        </div>
                    </motion.div>

                    {/* Right Image Card (Glassmorphism) */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.8, delay: 0.2 }}
                        className="relative"
                    >
                        <div className="absolute inset-0 bg-gradient-to-tr from-blue-600 to-purple-600 rounded-[2.5rem] rotate-3 opacity-20 blur-lg"></div>
                        <div className="relative rounded-[2.5rem] overflow-hidden border-4 border-white/20 shadow-2xl">
                            <img src={bgImage} alt="Hero" className="w-full h-[500px] object-cover hover:scale-105 transition-transform duration-700" />

                            {/* Floating Badge */}
                            <div className="absolute bottom-8 left-8 bg-white/90 backdrop-blur-md p-4 rounded-2xl shadow-xl max-w-[200px] animate-bounce-slow">
                                <div className="flex items-center gap-1 text-yellow-500 mb-1">
                                    <Star size={16} fill="currentColor" />
                                    <Star size={16} fill="currentColor" />
                                    <Star size={16} fill="currentColor" />
                                    <Star size={16} fill="currentColor" />
                                    <Star size={16} fill="currentColor" />
                                </div>
                                <p className="text-slate-900 font-bold text-sm">"Método incrível e professores excelentes!"</p>
                            </div>
                        </div>
                    </motion.div>
                </div>
            </section>

            {/* SOCIAL PROOF */}
            <section className="py-10 bg-white border-b border-gray-100">
                <div className="container mx-auto px-6 flex flex-wrap justify-center gap-8 md:gap-16 opacity-50 grayscale hover:grayscale-0 transition-all duration-500">
                    {/* Fake Logos */}
                    {['Google', 'Forbes', 'TechCrunch', 'Bloomberg'].map((logo, i) => (
                        <span key={i} className="text-xl font-black text-gray-400 uppercase tracking-widest">{logo}</span>
                    ))}
                </div>
            </section>

            {/* COMPARISON SECTION */}
            <section className="py-24 bg-gray-50">
                <div className="container mx-auto px-6">
                    <div className="text-center max-w-3xl mx-auto mb-16">
                        <h2 className="text-3xl lg:text-4xl font-black text-[#002366] mb-4">A evolução que você procurava</h2>
                        <p className="text-gray-600">Veja por que somos a escolha número 1 de quem quer fluência rápida.</p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
                        <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 opacity-70">
                            <h3 className="text-xl font-bold text-gray-500 mb-6 flex items-center gap-2">
                                <XCircle className="text-red-300" /> Cursos Tradicionais
                            </h3>
                            <ul className="space-y-4">
                                {['Foco apenas em gramática', 'Aulas monótonas', 'Turmas lotadas', 'Sem suporte individual'].map((item, i) => (
                                    <li key={i} className="flex items-center gap-3 text-gray-400">
                                        <XCircle size={18} className="text-red-200 shrink-0" />
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>

                        <div className="bg-white p-8 rounded-3xl shadow-xl border-2 border-[#002366] relative transform md:-translate-y-4">
                            <div className="absolute top-0 right-0 bg-[#002366] text-white text-xs font-bold px-3 py-1 rounded-bl-xl rounded-tr-lg">
                                PREFERRED
                            </div>
                            <h3 className="text-xl font-bold text-[#002366] mb-6 flex items-center gap-2">
                                <CheckCircle2 className="text-green-500" /> Wise Wolf
                            </h3>
                            <ul className="space-y-4">
                                {['Foco total em conversação', 'Metodologia Dinâmica', 'Turmas VIP ou Particular', 'Acompanhamento Diário'].map((item, i) => (
                                    <li key={i} className="flex items-center gap-3 text-gray-800 font-bold">
                                        <CheckCircle2 size={18} className="text-green-500 shrink-0" />
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    </div>
                </div>
            </section>

            {/* PRICING SECTION */}
            <section id="plans-section" className="py-24 bg-white relative">
                <div className="absolute top-0 left-0 w-full h-[500px] bg-gray-50 skew-y-3 transform origin-top-left -z-10" />

                <div className="container mx-auto px-6">
                    <div className="text-center mb-16">
                        <h2 className="text-3xl lg:text-4xl font-black text-[#002366] mb-4">Invista no seu futuro</h2>
                        <p className="text-gray-600">Escolha o plano ideal para seus objetivos.</p>
                    </div>

                    {plans && plans.length > 0 ? (
                        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
                            {plans.map((plan, index) => (
                                <motion.div
                                    key={index}
                                    initial={{ opacity: 0, y: 30 }}
                                    whileInView={{ opacity: 1, y: 0 }}
                                    viewport={{ once: true }}
                                    transition={{ delay: index * 0.1 }}
                                    className={`relative bg-white rounded-3xl p-8 border ${index === 1 ? 'border-[#D32F2F] shadow-2xl scale-105 z-10' : 'border-gray-100 shadow-lg'}`}
                                >
                                    {index === 1 && (
                                        <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-[#D32F2F] text-white px-4 py-1 rounded-full text-xs font-black uppercase tracking-wide shadow-lg">
                                            Mais Popular
                                        </div>
                                    )}
                                    <h3 className="text-xl font-bold text-gray-800 mb-2">{plan.name}</h3>
                                    <div className="flex items-baseline gap-1 mb-6">
                                        <span className="text-4xl font-black text-[#002366]">{plan.price}</span>
                                        <span className="text-gray-400 text-sm">/mês</span>
                                    </div>

                                    <ul className="space-y-4 mb-8">
                                        {plan.features.map((feature, idx) => (
                                            <li key={idx} className="flex items-start gap-3 text-sm text-gray-600">
                                                <CheckCircle2 size={16} className="text-green-500 shrink-0 mt-0.5" />
                                                <span>{feature}</span>
                                            </li>
                                        ))}
                                    </ul>

                                    <button
                                        onClick={() => handleOpenModal(`Plano: ${plan.name}`)}
                                        className={`w-full py-4 rounded-xl font-bold transition-all ${index === 1
                                            ? 'bg-[#002366] hover:bg-[#001a4d] text-white shadow-lg shadow-blue-900/20'
                                            : 'bg-gray-100 hover:bg-gray-200 text-gray-800'
                                            }`}>
                                        Quero este plano
                                    </button>
                                </motion.div>
                            ))}
                        </div>
                    ) : (
                        <div className="text-center py-10 bg-gray-50 rounded-3xl border border-dashed border-gray-300">
                            <p className="text-gray-500">Nenhum plano configurado no editor.</p>
                        </div>
                    )}
                </div>
            </section>

            {/* TESTIMONIALS (Dark) */}
            <section className="py-24 bg-[#002366] text-white relative overflow-hidden">
                <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-[#D32F2F] rounded-full blur-[200px] opacity-10" />

                <div className="container mx-auto px-6 relative z-10 text-center">
                    <h2 className="text-3xl lg:text-4xl font-black mb-16">Histórias Reais</h2>
                    <div className="grid md:grid-cols-3 gap-6">
                        {[1, 2, 3].map((i) => (
                            <div key={i} className="bg-white/5 backdrop-blur-md border border-white/10 p-8 rounded-2xl text-left hover:bg-white/10 transition-colors">
                                <div className="flex gap-1 mb-4">
                                    {[1, 2, 3, 4, 5].map(s => <Star key={s} size={14} className="fill-yellow-400 text-yellow-400" />)}
                                </div>
                                <p className="text-blue-100 mb-6 italic text-sm leading-relaxed">"O método superou todas as minhas expectativas. Os professores são fantásticos e a plataforma é muito intuitiva."</p>
                                <div className="flex items-center gap-3">
                                    <div className="w-10 h-10 rounded-full bg-gray-300 overflow-hidden">
                                        <img src={`https://i.pravatar.cc/100?img=${i + 40}`} alt="User" />
                                    </div>
                                    <div>
                                        <p className="font-bold text-sm">Aluno {i}</p>
                                        <p className="text-xs text-blue-300">Fluente em 12 meses</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* FAQ */}
            <section className="py-24 bg-white">
                <div className="container mx-auto px-6 max-w-3xl">
                    <h2 className="text-3xl font-black text-[#002366] mb-12 text-center">Dúvidas Comuns</h2>
                    <div className="space-y-4">
                        {[
                            { q: 'Quanto tempo para atingir a fluência?', a: 'Depende do seu plano e dedicação, mas nossos alunos costumam atingir nível B2 em 12 meses.' },
                            { q: 'Posso cancelar quando quiser?', a: 'Sim, não temos contratos de fidelidade abusivos. Você estuda enquanto estiver satisfeito.' },
                            { q: 'As aulas são gravadas?', a: 'Temos uma plataforma de exercícios gravados, mas o foco do plano são as aulas ao vivo com professores.' }
                        ].map((faq, i) => (
                            <details key={i} className="group bg-gray-50 rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                                <summary className="flex justify-between items-center p-6 cursor-pointer font-bold text-gray-800 hover:text-[#002366]">
                                    {faq.q}
                                    <span className="transition-transform group-open:rotate-180 text-blue-500">
                                        <ChevronDown />
                                    </span>
                                </summary>
                                <div className="px-6 pb-6 text-gray-600 text-sm leading-relaxed">
                                    {faq.a}
                                </div>
                            </details>
                        ))}
                    </div>
                </div>
            </section>

            {/* FOOTER */}
            <footer className="bg-gray-50 border-t border-gray-100 py-12">
                <div className="container mx-auto px-6 text-center">
                    <div className="flex justify-center gap-6 mb-8 text-gray-400">
                        <span>Instagram</span>
                        <span>Facebook</span>
                        <span>LinkedIn</span>
                    </div>
                    <p className="text-gray-400 text-sm">© 2026 Wise Wolf. Todos os direitos reservados.</p>
                </div>
            </footer>



            {/* LEAD MODAL */}
            {
                isModalOpen && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300">
                        <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl relative">
                            <button
                                onClick={() => setIsModalOpen(false)}
                                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                            >
                                <XCircle size={24} />
                            </button>

                            <div className="text-center mb-6">
                                <h3 className="text-2xl font-black text-[#002366]">Fale com um Consultor</h3>
                                <p className="text-gray-500 text-sm mt-1">Preencha seus dados para receber o contato.</p>
                            </div>

                            <form onSubmit={handleSubmit} className="space-y-4">
                                <input
                                    type="text"
                                    placeholder="Nome Completo"
                                    required
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] outline-none"
                                />
                                <input
                                    type="email"
                                    placeholder="Seu melhor e-mail"
                                    required
                                    value={formData.email}
                                    onChange={e => setFormData({ ...formData, email: e.target.value })}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] outline-none"
                                />
                                <input
                                    type="tel"
                                    placeholder="WhatsApp com DDD"
                                    required
                                    value={formData.phone}
                                    onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#002366] outline-none"
                                />
                                <button
                                    type="submit"
                                    disabled={submitting}
                                    className="w-full bg-[#D32F2F] text-white font-bold py-4 rounded-xl hover:bg-red-700 transition-colors flex items-center justify-center gap-2"
                                >
                                    {submitting ? 'Enviando...' : 'Solicitar Contato'}
                                    {!submitting && <ArrowRight size={18} />}
                                </button>
                            </form>
                        </div>
                    </div>
                )
            }

        </div >
    );
};

export default PremiumLandingPreview;
