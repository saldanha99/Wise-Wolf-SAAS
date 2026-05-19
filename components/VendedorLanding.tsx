import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { ArrowRight, Loader2, CheckCircle, User, Mail, Phone, ChevronRight } from 'lucide-react';

// ============================================================
// Número de WhatsApp da escola para redirecionamento final
// Formato: apenas dígitos com código do país (ex: 5511999998888)
// ============================================================
const SCHOOL_WHATSAPP = '5511999998888'; // ← substituir pelo número real

type Step = 'intro' | 'nome' | 'email' | 'whatsapp' | 'success';

const VendedorLanding: React.FC = () => {
    const [step, setStep] = useState<Step>('intro');
    const [nome, setNome] = useState('');
    const [email, setEmail] = useState('');
    const [whatsapp, setWhatsapp] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Foca o input quando muda de step
    useEffect(() => {
        if (['nome', 'email', 'whatsapp'].includes(step)) {
            setTimeout(() => inputRef.current?.focus(), 100);
        }
    }, [step]);

    const formatPhone = (value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, 11);
        if (digits.length <= 2) return digits;
        if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
        return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
    };

    const handleNext = async () => {
        setError('');

        if (step === 'nome') {
            if (!nome.trim() || nome.trim().split(' ').length < 2) {
                setError('Por favor, informe seu nome completo.');
                return;
            }
            setStep('email');
        } else if (step === 'email') {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
                setError('E-mail inválido. Verifique e tente novamente.');
                return;
            }
            setStep('whatsapp');
        } else if (step === 'whatsapp') {
            const digits = whatsapp.replace(/\D/g, '');
            if (digits.length < 10) {
                setError('Número inválido. Informe DDD + número.');
                return;
            }
            await submit();
        }
    };

    const submit = async () => {
        setLoading(true);
        try {
            const { error: dbError } = await supabase
                .from('vendor_leads')
                .insert({
                    nome: nome.trim(),
                    email: email.toLowerCase().trim(),
                    whatsapp: whatsapp.replace(/\D/g, ''),
                });
            if (dbError) throw dbError;
            setStep('success');

            // Redireciona para WhatsApp após 2s
            setTimeout(() => {
                const firstName = nome.trim().split(' ')[0];
                const msg = encodeURIComponent(
                    `Olá! Me chamo ${nome.trim()} e quero confirmar minha candidatura como vendedor na Wise Wolf Language School! 🐺`
                );
                window.location.href = `https://wa.me/${SCHOOL_WHATSAPP}?text=${msg}`;
            }, 2000);
        } catch (err: any) {
            setError('Erro ao salvar. Tente novamente.');
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleNext();
    };

    const progressSteps = ['nome', 'email', 'whatsapp'];
    const currentIndex = progressSteps.indexOf(step);

    // ── INTRO ──
    if (step === 'intro') {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex flex-col items-center justify-center p-6 font-sans">
                <div className="w-full max-w-lg animate-in fade-in duration-500">
                    {/* Logo */}
                    <div className="text-center mb-10">
                        <div className="inline-flex items-center gap-3 mb-2">
                            <span className="text-5xl">🐺</span>
                            <div className="text-left">
                                <p className="text-white font-black text-2xl tracking-tight leading-none">Wise Wolf</p>
                                <p className="text-emerald-400 text-xs font-bold uppercase tracking-widest">Language School</p>
                            </div>
                        </div>
                    </div>

                    {/* Card */}
                    <div className="bg-slate-800/60 border border-slate-700/60 rounded-3xl p-8 shadow-2xl backdrop-blur-sm">
                        <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-1.5 mb-6">
                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                            <span className="text-emerald-400 text-xs font-black uppercase tracking-widest">Processo Seletivo</span>
                        </div>

                        <h1 className="text-3xl font-black text-white leading-tight mb-3">
                            Faça parte do nosso time de vendas! 🚀
                        </h1>
                        <p className="text-slate-400 text-sm leading-relaxed mb-8">
                            Que bom que você quer fazer parte da Wise Wolf! Nosso processo é rápido e tem apenas <strong className="text-white">3 etapas:</strong>
                        </p>

                        <div className="space-y-3 mb-8">
                            {[
                                { num: '1', text: 'Preencher este formulário (menos de 1 minuto)' },
                                { num: '2', text: 'Confirmar sua candidatura pelo WhatsApp' },
                                { num: '3', text: 'Entrevista com nosso time' },
                            ].map(({ num, text }) => (
                                <div key={num} className="flex items-center gap-3">
                                    <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 text-xs font-black shrink-0">
                                        {num}
                                    </div>
                                    <p className="text-slate-300 text-sm">{text}</p>
                                </div>
                            ))}
                        </div>

                        <button
                            onClick={() => setStep('nome')}
                            className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 text-white font-black text-sm uppercase tracking-widest rounded-xl py-4 flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-emerald-500/25"
                        >
                            Começar
                            <ArrowRight size={16} />
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ── SUCCESS ──
    if (step === 'success') {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-950 via-emerald-950/20 to-slate-950 flex items-center justify-center p-6 font-sans">
                <div className="bg-slate-800/60 border border-emerald-700/40 rounded-3xl p-10 max-w-md w-full text-center shadow-2xl animate-in fade-in duration-500">
                    <div className="w-20 h-20 bg-emerald-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-emerald-500/30">
                        <CheckCircle size={36} className="text-emerald-400" />
                    </div>
                    <h2 className="text-2xl font-black text-white mb-3">Candidatura recebida! 🎉</h2>
                    <p className="text-slate-300 text-sm leading-relaxed mb-6">
                        Ótimo, <strong className="text-white">{nome.split(' ')[0]}</strong>! Seus dados foram salvos.
                        <br /><br />
                        Você será redirecionado para o WhatsApp da Wise Wolf para confirmar sua candidatura. Aguarde...
                    </p>
                    <div className="flex items-center justify-center gap-2 text-emerald-400">
                        <Loader2 size={16} className="animate-spin" />
                        <span className="text-xs font-bold">Abrindo WhatsApp...</span>
                    </div>
                </div>
            </div>
        );
    }

    // ── STEPS (nome / email / whatsapp) ──
    const stepConfig = {
        nome: {
            label: 'Qual é o seu nome completo?',
            sublabel: 'Ex: Maria Silva',
            icon: <User size={18} className="text-slate-400" />,
            type: 'text',
            value: nome,
            onChange: (v: string) => setNome(v),
            placeholder: 'Seu nome completo',
        },
        email: {
            label: 'Qual é o seu e-mail?',
            sublabel: 'Vamos usar para contato',
            icon: <Mail size={18} className="text-slate-400" />,
            type: 'email',
            value: email,
            onChange: (v: string) => setEmail(v),
            placeholder: 'seu@email.com',
        },
        whatsapp: {
            label: 'Qual é o seu WhatsApp?',
            sublabel: 'Com DDD, sem espaços',
            icon: <Phone size={18} className="text-slate-400" />,
            type: 'tel',
            value: whatsapp,
            onChange: (v: string) => setWhatsapp(formatPhone(v)),
            placeholder: '(11) 99999-9999',
        },
    };

    const current = stepConfig[step as keyof typeof stepConfig];

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex flex-col items-center justify-center p-6 font-sans">
            {/* Glow */}
            <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[400px] h-[400px] bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

            <div className="relative w-full max-w-lg animate-in fade-in slide-in-from-bottom-4 duration-300">
                {/* Logo + Progress */}
                <div className="flex items-center justify-between mb-8 px-1">
                    <div className="flex items-center gap-2">
                        <span className="text-2xl">🐺</span>
                        <span className="text-white font-black text-sm tracking-tight">Wise Wolf</span>
                    </div>

                    {/* Progress dots */}
                    <div className="flex items-center gap-2">
                        {progressSteps.map((s, i) => (
                            <div
                                key={s}
                                className={`rounded-full transition-all duration-300 ${i < currentIndex
                                    ? 'w-6 h-2 bg-emerald-500'
                                    : i === currentIndex
                                        ? 'w-8 h-2 bg-emerald-400'
                                        : 'w-2 h-2 bg-slate-600'
                                    }`}
                            />
                        ))}
                        <span className="text-slate-500 text-xs ml-1">{currentIndex + 1}/3</span>
                    </div>
                </div>

                {/* Card */}
                <div className="bg-slate-800/60 border border-slate-700/60 rounded-3xl p-8 shadow-2xl backdrop-blur-sm">
                    <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mb-2">
                        Etapa {currentIndex + 1} de 3
                    </p>
                    <h2 className="text-2xl font-black text-white mb-1">{current.label}</h2>
                    <p className="text-slate-400 text-sm mb-6">{current.sublabel}</p>

                    {/* Input */}
                    <div className="relative mb-4">
                        <div className="absolute left-4 top-1/2 -translate-y-1/2">{current.icon}</div>
                        <input
                            ref={inputRef}
                            type={current.type}
                            value={current.value}
                            onChange={e => current.onChange(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={current.placeholder}
                            className="w-full bg-slate-700/50 border border-slate-600/50 text-white placeholder-slate-500 rounded-xl pl-11 pr-4 py-4 text-base focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30 transition-all"
                            autoComplete="off"
                        />
                    </div>

                    {error && (
                        <p className="text-red-400 text-xs font-medium mb-4 px-1">{error}</p>
                    )}

                    <button
                        onClick={handleNext}
                        disabled={loading || !current.value.trim()}
                        className="w-full bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-400 hover:to-teal-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black text-sm uppercase tracking-widest rounded-xl py-4 flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-emerald-500/20"
                    >
                        {loading ? (
                            <Loader2 size={18} className="animate-spin" />
                        ) : (
                            <>
                                {step === 'whatsapp' ? 'Enviar candidatura' : 'Próximo'}
                                <ChevronRight size={16} />
                            </>
                        )}
                    </button>
                </div>

                {/* Voltar */}
                {step !== 'nome' && (
                    <button
                        onClick={() => setStep(step === 'email' ? 'nome' : 'email')}
                        className="w-full text-center text-slate-500 hover:text-slate-300 text-xs mt-4 py-2 transition-colors"
                    >
                        ← Voltar
                    </button>
                )}
            </div>
        </div>
    );
};

export default VendedorLanding;
