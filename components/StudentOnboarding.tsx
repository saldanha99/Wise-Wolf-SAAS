import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { supabase } from '../lib/supabase';
import { Map, Flame, Trophy, MessageCircle, ArrowRight, Check } from 'lucide-react';

/**
 * Tour de boas-vindas do aluno (1º acesso à plataforma).
 * Carrossel de slides explicando trilhas, gamificação e tutor.
 * Ao concluir, marca profiles.onboarded = true.
 */
interface Props { userId: string; nome?: string; onComplete: () => void; }

const StudentOnboarding: React.FC<Props> = ({ userId, nome, onComplete }) => {
    const [step, setStep] = useState(0);
    const [saving, setSaving] = useState(false);

    const slides = [
        {
            icon: <Map size={40} />, cor: '#8b5cf6',
            titulo: `Bem-vindo${nome ? `, ${nome.split(' ')[0]}` : ''}! 🐺`,
            texto: 'Aqui você aprende inglês numa trilha divertida, no seu ritmo. Vamos te mostrar como funciona em 30 segundos.',
        },
        {
            icon: <Map size={40} />, cor: '#6366f1',
            titulo: 'Siga a trilha',
            texto: 'Cada lição é um passo na sua jornada. Complete uma para desbloquear a próxima — como num jogo.',
        },
        {
            icon: <Flame size={40} />, cor: '#f97316',
            titulo: 'Mantenha a ofensiva 🔥',
            texto: 'Pratique todos os dias para acender sua chama. Ganhe XP, suba de nível e cuide das suas 5 vidas ❤️.',
        },
        {
            icon: <Trophy size={40} />, cor: '#f59e0b',
            titulo: 'Dispute a liga',
            texto: 'Ganhe XP e suba de divisão: Bronze → Prata → Ouro → Platina → Diamante. Compare com seus colegas!',
        },
        {
            icon: <MessageCircle size={40} />, cor: '#10b981',
            titulo: 'Converse com o Wolfie',
            texto: 'Seu tutor de IA está pronto pra praticar conversação com você a qualquer hora. Bora começar?',
        },
    ];

    const isLast = step === slides.length - 1;

    const finish = async () => {
        setSaving(true);
        try {
            await supabase.from('profiles').update({ onboarded: true }).eq('id', userId);
        } catch (e) { console.error('onboarding finish:', e); }
        finally { setSaving(false); onComplete(); }
    };

    const s = slides[step];

    return (
        <div className="fixed inset-0 z-[400] bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4">
            <motion.div
                initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                className="bg-white dark:bg-slate-900 rounded-3xl max-w-md w-full p-8 text-center shadow-2xl"
            >
                <AnimatePresence mode="wait">
                    <motion.div
                        key={step}
                        initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -40, opacity: 0 }}
                        transition={{ duration: 0.25 }}
                    >
                        <div className="w-20 h-20 rounded-3xl flex items-center justify-center mx-auto mb-5 text-white"
                            style={{ background: s.cor, boxShadow: `0 8px 0 ${s.cor}99` }}>
                            {s.icon}
                        </div>
                        <h2 className="text-2xl font-black text-slate-800 dark:text-white mb-3">{s.titulo}</h2>
                        <p className="text-slate-500 dark:text-slate-400 leading-relaxed">{s.texto}</p>
                    </motion.div>
                </AnimatePresence>

                {/* Dots */}
                <div className="flex justify-center gap-2 mt-7">
                    {slides.map((_, i) => (
                        <button key={i} onClick={() => setStep(i)}
                            className="h-2 rounded-full transition-all"
                            style={{ width: i === step ? 24 : 8, background: i === step ? s.cor : '#cbd5e1' }} />
                    ))}
                </div>

                {/* CTA */}
                <button
                    onClick={() => isLast ? finish() : setStep(step + 1)}
                    disabled={saving}
                    className="mt-7 w-full py-3.5 rounded-2xl text-white font-black text-sm uppercase tracking-wider transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                    style={{ background: s.cor, boxShadow: `0 5px 0 ${s.cor}99` }}
                >
                    {isLast ? <>Começar agora <Check size={16} /></> : <>Próximo <ArrowRight size={16} /></>}
                </button>

                {!isLast && (
                    <button onClick={finish} className="mt-3 text-xs text-slate-400 hover:text-slate-600 font-bold">
                        Pular tour
                    </button>
                )}
            </motion.div>
        </div>
    );
};

export default StudentOnboarding;
