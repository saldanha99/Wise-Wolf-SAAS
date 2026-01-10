import React from 'react';
import { Check, X, Star, Play, Clock, Shield, Globe, ChevronRight, Lock, ArrowRight, Phone } from 'lucide-react';
import { motion } from 'framer-motion';

interface HighConversionLandingPreviewProps {
    headline: string;
    subheadline: string;
    heroImage?: string;
    ctaText: string;
    onSubmit?: (data: any) => void;
}

const HighConversionLandingPreview: React.FC<HighConversionLandingPreviewProps> = ({
    headline,
    subheadline,
    heroImage,
    ctaText,
    onSubmit
}) => {
    const [formData, setFormData] = React.useState({ name: '', email: '', phone: '' });

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit?.(formData);
    };

    return (
        <div className="w-full h-full bg-white overflow-y-auto font-sans text-slate-900 scrollbar-hide">

            {/* 1. HERO SECTION WITH FORM */}
            <section className="relative bg-[#0052cc] text-white overflow-hidden pb-16 pt-8 lg:pt-12 px-6">
                {/* Background Blobs */}
                <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-red-600 rounded-full blur-3xl opacity-20 -mr-20 -mt-20 pointer-events-none" />
                <div className="absolute bottom-0 left-0 w-[600px] h-[600px] bg-blue-500 rounded-full blur-3xl opacity-30 -ml-20 -mb-20 pointer-events-none" />

                <div className="max-w-6xl mx-auto relative z-10 grid lg:grid-cols-2 gap-12 items-center">
                    <div className="space-y-6 text-center lg:text-left">
                        <div className="inline-flex items-center gap-2 bg-white/10 px-4 py-1.5 rounded-full backdrop-blur-sm border border-white/20">
                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-[11px] font-bold uppercase tracking-widest text-white/90">Oferta por Tempo Limitado</span>
                        </div>

                        <h1 className="text-3xl md:text-5xl lg:text-5xl font-extrabold leading-tight tracking-tight">
                            {headline || "Aprenda Inglês Online com Aulas Particulares 4x por Semana"}
                        </h1>
                        <p className="text-lg md:text-xl text-blue-100 font-medium leading-relaxed max-w-xl mx-auto lg:mx-0">
                            {subheadline || "Acelere sua fluência com nosso método exclusivo focado em conversação e resultados reais."}
                        </p>

                        <div className="flex flex-col sm:flex-row items-center gap-4 justify-center lg:justify-start pt-4">
                            <div className="flex -space-x-3">
                                {[1, 2, 3, 4].map(i => (
                                    <img key={i} src={`https://i.pravatar.cc/100?img=${i + 10}`} className="w-10 h-10 rounded-full border-2 border-[#0052cc]" />
                                ))}
                            </div>
                            <div className="text-left">
                                <div className="flex items-center gap-1 text-yellow-400">
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                    <Star size={14} fill="currentColor" />
                                </div>
                                <p className="text-xs font-bold text-white/80">Mais de 7.000 alunos aprovados</p>
                            </div>
                        </div>
                    </div>

                    {/* High Conversion Form */}
                    <div className="bg-white text-slate-900 p-6 md:p-8 rounded-[2rem] shadow-2xl relative">
                        <div className="absolute -top-6 -right-6 bg-red-600 text-white w-20 h-20 rounded-full flex flex-col items-center justify-center font-black transform rotate-12 shadow-lg z-20 border-4 border-[#0052cc]">
                            <span className="text-xs uppercase">Grátis</span>
                            <span className="text-xl">1ª</span>
                            <span className="text-[10px] uppercase">Aula</span>
                        </div>

                        <div className="text-center mb-6">
                            <h3 className="text-2xl font-black text-slate-800">Garanta sua Vaga</h3>
                            <p className="text-sm text-slate-500 font-medium mt-1">Preencha para agendar sua experimental</p>
                        </div>

                        <form className="space-y-4" onSubmit={handleSubmit}>
                            <div>
                                <input
                                    type="text"
                                    placeholder="Seu Nome Completo"
                                    className="w-full h-12 px-4 rounded-xl bg-slate-50 border border-slate-200 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 outline-none font-bold text-sm transition-all"
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                />
                            </div>
                            <div>
                                <input
                                    type="email"
                                    placeholder="Seu Melhor E-mail"
                                    className="w-full h-12 px-4 rounded-xl bg-slate-50 border border-slate-200 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 outline-none font-bold text-sm transition-all"
                                    value={formData.email}
                                    onChange={e => setFormData({ ...formData, email: e.target.value })}
                                />
                            </div>
                            <div>
                                <input
                                    type="tel"
                                    placeholder="Seu WhatsApp (com DDD)"
                                    className="w-full h-12 px-4 rounded-xl bg-slate-50 border border-slate-200 focus:border-blue-600 focus:ring-4 focus:ring-blue-100 outline-none font-bold text-sm transition-all"
                                    value={formData.phone}
                                    onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                />
                            </div>

                            <button className="w-full h-14 bg-red-600 hover:bg-red-700 text-white rounded-xl font-black text-lg uppercase tracking-wide shadow-lg shadow-red-600/30 transform hover:scale-[1.02] active:scale-95 transition-all flex items-center justify-center gap-2">
                                {ctaText || "Começar Agora"} <ChevronRight strokeWidth={4} size={20} />
                            </button>

                            <div className="flex items-center justify-center gap-2 text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-4">
                                <Lock size={12} /> Seus dados estão seguros
                            </div>
                        </form>
                    </div>
                </div>
            </section>

            {/* 2. SOCIAL PROOF & LOGOS */}
            <section className="bg-slate-50 border-b border-slate-100 py-8">
                <div className="max-w-6xl mx-auto px-6 text-center">
                    <p className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-6">Método validado por grandes empresas</p>
                    <div className="flex flex-wrap justify-center items-center gap-8 md:gap-16 opacity-50 grayscale hover:grayscale-0 transition-all duration-500">
                        {/* Placeholder Logos */}
                        <div className="h-8 w-24 bg-slate-400/20 rounded-lg animate-pulse" />
                        <div className="h-8 w-24 bg-slate-400/20 rounded-lg animate-pulse" />
                        <div className="h-8 w-24 bg-slate-400/20 rounded-lg animate-pulse" />
                        <div className="h-8 w-24 bg-slate-400/20 rounded-lg animate-pulse" />
                    </div>
                </div>
            </section>

            {/* 3. COMPARISON SECTION (RED background-ish transition) */}
            <section className="py-20 bg-white relative overflow-hidden">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-16">
                        <span className="text-blue-600 font-black uppercase tracking-widest text-xs mb-2 block">Comparativo</span>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900">Por que somos diferentes?</h2>
                    </div>

                    <div className="grid md:grid-cols-2 gap-8 relative z-10">
                        {/* Traditional School */}
                        <div className="bg-white border-2 border-slate-100 rounded-[2rem] p-8 opacity-80 hover:opacity-100 transition-opacity">
                            <h3 className="text-xl font-black text-slate-400 mb-8 flex items-center gap-3">
                                <span className="w-3 h-3 rounded-full bg-slate-300" />
                                Escola Tradicional
                            </h3>
                            <ul className="space-y-6">
                                <li className="flex items-start gap-4 text-slate-500 font-medium">
                                    <div className="min-w-6 h-6 rounded-full bg-red-100 text-red-500 flex items-center justify-center">
                                        <X size={14} strokeWidth={4} />
                                    </div>
                                    Turmas lotadas (15+ alunos)
                                </li>
                                <li className="flex items-start gap-4 text-slate-500 font-medium">
                                    <div className="min-w-6 h-6 rounded-full bg-red-100 text-red-500 flex items-center justify-center">
                                        <X size={14} strokeWidth={4} />
                                    </div>
                                    Foco excessivo em gramática
                                </li>
                                <li className="flex items-start gap-4 text-slate-500 font-medium">
                                    <div className="min-w-6 h-6 rounded-full bg-red-100 text-red-500 flex items-center justify-center">
                                        <X size={14} strokeWidth={4} />
                                    </div>
                                    Contratos longos e multas
                                </li>
                                <li className="flex items-start gap-4 text-slate-500 font-medium">
                                    <div className="min-w-6 h-6 rounded-full bg-red-100 text-red-500 flex items-center justify-center">
                                        <X size={14} strokeWidth={4} />
                                    </div>
                                    Horários fixos e rígidos
                                </li>
                            </ul>
                        </div>

                        {/* Wise Wolf / King */}
                        <div className="bg-white border-2 border-blue-600 rounded-[2rem] p-8 shadow-2xl relative overflow-hidden transform md:-translate-y-4">
                            <div className="absolute top-0 right-0 bg-blue-600 text-white text-[10px] font-black uppercase px-4 py-1.5 rounded-bl-xl">
                                Recomendado
                            </div>
                            <h3 className="text-2xl font-black text-blue-900 mb-8 flex items-center gap-3">
                                <Shield className="text-blue-600 fill-blue-100" />
                                Nossa Metodologia
                            </h3>
                            <ul className="space-y-6">
                                <li className="flex items-start gap-4 text-slate-700 font-bold text-lg">
                                    <div className="min-w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-sm">
                                        <Check size={14} strokeWidth={4} />
                                    </div>
                                    Aulas particulares ou duplas
                                </li>
                                <li className="flex items-start gap-4 text-slate-700 font-bold text-lg">
                                    <div className="min-w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-sm">
                                        <Check size={14} strokeWidth={4} />
                                    </div>
                                    100% focado em conversação
                                </li>
                                <li className="flex items-start gap-4 text-slate-700 font-bold text-lg">
                                    <div className="min-w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-sm">
                                        <Check size={14} strokeWidth={4} />
                                    </div>
                                    Sem multa de fidelidade
                                </li>
                                <li className="flex items-start gap-4 text-slate-700 font-bold text-lg">
                                    <div className="min-w-6 h-6 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shadow-sm">
                                        <Check size={14} strokeWidth={4} />
                                    </div>
                                    Horários flexíveis (7h às 22h)
                                </li>
                            </ul>
                        </div>
                    </div>

                    {/* CTA #2 */}
                    <div className="text-center mt-12">
                        <button
                            onClick={(e) => {
                                const form = document.querySelector('form');
                                form?.scrollIntoView({ behavior: 'smooth' });
                                form?.querySelector('input')?.focus();
                            }}
                            className="bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-xl font-black text-sm uppercase tracking-widest shadow-lg shadow-blue-600/30 transform hover:scale-105 transition-all">
                            Quero agendar uma aula experimental
                        </button>
                    </div>
                </div>
            </section>

            {/* 3.5. NEW SECTION: WHO IS THIS FOR? */}
            <section className="bg-slate-900 py-20 px-6 text-white relative overflow-hidden">
                <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-blue-600 rounded-full blur-[120px] opacity-20 -mr-20 -mt-20 pointer-events-none" />
                <div className="max-w-6xl mx-auto relative z-10">
                    <div className="text-center mb-16">
                        <span className="text-emerald-400 font-black uppercase tracking-widest text-xs mb-2 block">Público Alvo</span>
                        <h2 className="text-3xl md:text-4xl font-black">Para quem é este método?</h2>
                    </div>

                    <div className="grid md:grid-cols-3 gap-6">
                        {[
                            { title: 'Profissionais', desc: 'Que precisam do inglês para reuniões, apresentações e crescer na carreira.', icon: '💼' },
                            { title: 'Viajantes', desc: 'Que querem viajar o mundo sem passar perrengue ou depender de tradutor.', icon: '✈️' },
                            { title: 'Universitários', desc: 'Que buscam bolsas de estudo fora do país ou acesso a conteúdos globais.', icon: '🎓' }
                        ].map((item, i) => (
                            <div key={i} className="bg-slate-800/50 p-8 rounded-3xl border border-slate-700 hover:bg-slate-800 transition-colors">
                                <div className="text-4xl mb-4">{item.icon}</div>
                                <h3 className="text-xl font-bold mb-2">{item.title}</h3>
                                <p className="text-slate-400 text-sm leading-relaxed">{item.desc}</p>
                            </div>
                        ))}
                    </div>

                    {/* CTA #3 */}
                    <div className="text-center mt-12">
                        <button
                            onClick={(e) => {
                                const form = document.querySelector('form');
                                form?.scrollIntoView({ behavior: 'smooth' });
                                form?.querySelector('input')?.focus();
                            }}
                            className="bg-emerald-500 hover:bg-emerald-600 text-white px-8 py-4 rounded-xl font-black text-sm uppercase tracking-widest shadow-lg shadow-emerald-500/30 transform hover:scale-105 transition-all">
                            Me encaixo nesse perfil
                        </button>
                    </div>
                </div>
            </section>

            {/* 4. METHODOLOGY (Timeline) */}
            <section className="bg-slate-50 py-20 px-6">
                <div className="max-w-4xl mx-auto">
                    <div className="text-center mb-16">
                        <span className="text-red-500 font-black uppercase tracking-widest text-xs mb-2 block">Jornada do Aluno</span>
                        <h2 className="text-3xl md:text-4xl font-black text-slate-900">Como você vai aprender?</h2>
                    </div>

                    <div className="space-y-12 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-300 before:to-transparent">
                        {[
                            { title: 'Nivelamento', desc: 'Identificamos exatamente onde você está para não perder tempo.', icon: '01' },
                            { title: 'Plano Personalizado', desc: 'Criamos uma rota de estudos baseada nos SEUS objetivos (viagem, trabalho, etc).', icon: '02' },
                            { title: 'Prática Intensiva', desc: 'Aulas ao vivo focadas em destravar a fala desde o primeiro dia.', icon: '03' },
                            { title: 'Fluência Real', desc: 'Você dominando o idioma com confiança e certificado.', icon: '04' }
                        ].map((step, i) => (
                            <div key={i} className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group is-active">
                                <div className="flex items-center justify-center w-10 h-10 rounded-full border-4 border-white bg-blue-600 text-white font-black text-xs shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-lg z-10">
                                    {step.icon}
                                </div>
                                <div className="w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] bg-white p-6 rounded-3xl shadow-sm border border-slate-100 md:group-odd:mr-auto md:group-even:ml-auto hover:border-blue-200 transition-colors">
                                    <h3 className="text-lg font-black text-slate-800 mb-2">{step.title}</h3>
                                    <p className="text-sm text-slate-500 font-medium leading-relaxed">{step.desc}</p>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* CTA #4 */}
                    <div className="text-center mt-12">
                        <button
                            onClick={(e) => {
                                const form = document.querySelector('form');
                                form?.scrollIntoView({ behavior: 'smooth' });
                                form?.querySelector('input')?.focus();
                            }}
                            className="bg-slate-900 hover:bg-slate-800 text-white px-8 py-4 rounded-xl font-black text-sm uppercase tracking-widest shadow-lg shadow-slate-900/30 transform hover:scale-105 transition-all">
                            Começar minha jornada agora
                        </button>
                    </div>
                </div>
            </section>

            {/* 5. VIDEO TESTIMONIALS */}
            <section className="bg-slate-900 text-white py-24 px-6 relative overflow-hidden">
                <div className="absolute top-0 inset-x-0 h-24 bg-gradient-to-b from-slate-50 to-transparent pointer-events-none" />

                <div className="max-w-6xl mx-auto relative z-10">
                    <div className="text-center mb-16">
                        <h2 className="text-3xl md:text-5xl font-black mb-4">Eles já chegaram lá 🚀</h2>
                        <p className="text-slate-400 font-medium max-w-2xl mx-auto">Veja o que nossos alunos estão dizendo sobre a metodologia.</p>
                    </div>

                    <div className="grid md:grid-cols-3 gap-6">
                        {[1, 2, 3].map((_, i) => (
                            <div key={i} className="group relative aspect-[9/16] md:aspect-video rounded-3xl bg-slate-800 border border-slate-700 overflow-hidden cursor-pointer shadow-2xl">
                                <div className="absolute inset-0 bg-black/40 flex items-center justify-center group-hover:bg-black/20 transition-all">
                                    <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center group-hover:scale-110 transition-transform">
                                        <Play fill="white" className="text-white ml-1" />
                                    </div>
                                </div>
                                <div className="absolute bottom-0 inset-x-0 p-6 bg-gradient-to-t from-black/90 to-transparent">
                                    <p className="font-bold text-white">Aluno {i + 1}</p>
                                    <p className="text-xs text-slate-300">Fluente em 12 meses</p>
                                </div>
                                {/* Placeholder Image */}
                                <img src={`https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=600&q=80`} className="w-full h-full object-cover -z-10" />
                            </div>
                        ))}
                    </div>

                    {/* 5.5 GUARANTEE + CTA #5 */}
                    <div className="mt-20 bg-gradient-to-br from-slate-800 to-slate-900 rounded-[2rem] p-8 md:p-12 border border-slate-700 flex flex-col md:flex-row items-center gap-8 relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500 rounded-full blur-[100px] opacity-10 pointer-events-none" />

                        <div className="shrink-0 w-24 h-24 bg-emerald-500/20 rounded-full flex items-center justify-center border-2 border-emerald-500/50">
                            <Shield size={48} className="text-emerald-400" />
                        </div>
                        <div className="flex-1 text-center md:text-left">
                            <h3 className="text-2xl font-black mb-2 text-white">Garantia Incondicional de 7 Dias</h3>
                            <p className="text-slate-300 font-medium leading-relaxed">
                                Se você não se adaptar à nossa metodologia na primeira semana, devolvemos 100% do seu investimento. O risco é todo nosso.
                            </p>
                        </div>
                        <div className="shrink-0">
                            <button
                                onClick={(e) => {
                                    const form = document.querySelector('form');
                                    form?.scrollIntoView({ behavior: 'smooth' });
                                    form?.querySelector('input')?.focus();
                                }}
                                className="w-full md:w-auto bg-emerald-500 hover:bg-emerald-600 text-white px-8 py-4 rounded-xl font-black text-sm uppercase tracking-widest shadow-lg shadow-emerald-500/30 transform hover:scale-105 transition-all">
                                Quero testar sem riscos
                            </button>
                        </div>
                    </div>
                </div>
            </section>

            {/* 6. URGENCY & FINAL CTA */}
            <section className="bg-red-600 py-24 relative overflow-hidden">
                <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10" />
                <div className="max-w-4xl mx-auto px-6 text-center text-white relative z-10">
                    <h2 className="text-3xl md:text-5xl font-black mb-8 leading-tight">
                        Daqui a um ano, você vai desejar ter começado hoje.
                    </h2>
                    <p className="text-white/80 text-xl font-medium mb-12 max-w-2xl mx-auto">
                        Não deixe para depois. As vagas para o valor promocional encerram em breve.
                    </p>

                    <button className="bg-white text-red-600 px-12 py-5 rounded-full font-black text-lg uppercase tracking-widest shadow-[0_20px_50px_rgba(0,0,0,0.3)] hover:scale-105 hover:shadow-[0_20px_60px_rgba(0,0,0,0.4)] transition-all">
                        {ctaText || "Quero Agendar Minha Aula"}
                    </button>

                    <div className="mt-8 flex items-center justify-center gap-4 text-sm font-bold text-white/60 uppercase tracking-widest">
                        <span className="flex items-center gap-2"><Clock size={16} /> Oferta por tempo limitado</span>
                    </div>
                </div>
            </section>

            {/* Footer */}
            <footer className="bg-slate-950 text-slate-500 py-12 text-center text-xs font-bold uppercase tracking-widest border-t border-slate-900">
                <p>&copy; {new Date().getFullYear()} - Todos os direitos reservados</p>
            </footer>

        </div>
    );
};

export default HighConversionLandingPreview;
