import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Sparkles, Brain, Plane, Briefcase, GraduationCap, MessageCircle, ArrowRight, Loader2, Target, Zap, Shield, Music, Film, Trophy, Cpu, Globe, TrendingUp, Gamepad2, DollarSign, UtensilsCrossed, BookOpen } from 'lucide-react';

interface WolfieOnboardingProps {
    user: any;
    onComplete: (settings: any) => void;
}

export const WolfieOnboarding: React.FC<WolfieOnboardingProps> = ({ user, onComplete }) => {
    const [step, setStep] = useState(1);
    const [isSaving, setIsSaving] = useState(false);

    // Default settings
    const [goal, setGoal] = useState('');
    const [level, setLevel] = useState('A1');
    const [strictness, setStrictness] = useState<1 | 2 | 3>(2);
    const [interests, setInterests] = useState<string[]>([]);
    const [duration, setDuration] = useState(15);

    const goals = [
        { id: 'travel', icon: Plane, title: 'Travel & Survival', desc: 'Viagens, aeroportos, restaurantes', color: 'bg-blue-500' },
        { id: 'career', icon: Briefcase, title: 'Work & Career', desc: 'Entrevistas, reuniões, networking', color: 'bg-indigo-500' },
        { id: 'exams', icon: GraduationCap, title: 'Exams (IELTS/TOEFL)', desc: 'Preparação para provas', color: 'bg-purple-500' },
        { id: 'fluency', icon: MessageCircle, title: 'General Fluency', desc: 'Falar naturalmente no dia a dia', color: 'bg-emerald-500' },
    ];

    const levels = [
        { id: 'A1', label: 'A1 - Beginner', desc: 'Sei apenas o básico (Hi, How are you)' },
        { id: 'A2', label: 'A2 - Elementary', desc: 'Consigo ter conversas muito simples' },
        { id: 'B1', label: 'B1 - Intermediate', desc: 'Me viro bem, mas travo às vezes' },
        { id: 'B2', label: 'B2 - Upper Intermediate', desc: 'Falo com confiança sobre vários temas' },
        { id: 'C1', label: 'C1 - Advanced', desc: 'Falo fluentemente e com naturalidade' },
        { id: 'C2', label: 'C2 - Mastery', desc: 'Quase nativo, procuro aperfeiçoamento' },
    ];

    const styles = [
        { id: 1, icon: Heart, label: 'Chill & Supportive', desc: 'Foco total na fluência. Poucas correções.', strictness: 1 },
        { id: 2, icon: Target, label: 'Balanced Coach', desc: 'Corrige erros importantes sem travar você.', strictness: 2 },
        { id: 3, icon: Shield, label: 'Tough Mentor', desc: 'Corrige quase tudo para máxima precisão.', strictness: 3 },
    ];

    const interestOptions = [
        { id: 'music', icon: Music, label: 'Música' },
        { id: 'movies', icon: Film, label: 'Séries/Filmes' },
        { id: 'sports', icon: Trophy, label: 'Esportes' },
        { id: 'tech', icon: Cpu, label: 'Tecnologia' },
        { id: 'travel', icon: Globe, label: 'Viagem' },
        { id: 'career', icon: TrendingUp, label: 'Carreira' },
        { id: 'games', icon: Gamepad2, label: 'Games' },
        { id: 'business', icon: DollarSign, label: 'Negócios' },
        { id: 'food', icon: UtensilsCrossed, label: 'Comida' },
        { id: 'books', icon: BookOpen, label: 'Livros' },
    ];

    const toggleInterest = (id: string) => {
        setInterests(prev => prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]);
    };

    const handleComplete = async () => {
        setIsSaving(true);
        const settings = {
            goal,
            level,
            correctionStrictness: strictness,
            dailyGoalMinutes: duration,
            completedAt: new Date().toISOString()
        };

        try {
            const { error } = await supabase
                .from('profiles')
                .update({ wolfie_settings: settings, interests })
                .eq('id', user.id);

            if (error) throw error;
            onComplete(settings);
        } catch (error) {
            console.error("Error saving Wolfie settings:", error);
            alert("Erro ao salvar configurações. Tente novamente.");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-[calc(100vh-120px)] w-full rounded-3xl overflow-hidden bg-slate-950 font-sans border border-slate-800 shadow-2xl relative">

            {/* Background Effects */}
            <div className="absolute inset-0 z-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-indigo-900/20 via-slate-950 to-slate-950 pointer-events-none"></div>
            <div className="absolute top-0 w-full h-1 bg-slate-800">
                <div className="h-full bg-indigo-500 transition-all duration-500 ease-out" style={{ width: `${(step / 5) * 100}%` }}></div>
            </div>

            <div className="relative z-10 w-full max-w-2xl p-8 flex flex-col items-center animate-in fade-in slide-in-from-bottom-8 duration-500">

                {/* Header */}
                <div className="flex flex-col items-center mb-12 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 p-[2px] shadow-lg shadow-indigo-500/20 mb-6">
                        <div className="w-full h-full bg-slate-950 rounded-2xl flex items-center justify-center">
                            <Brain className="text-indigo-400 w-8 h-8" />
                        </div>
                    </div>
                    {step === 1 && (
                        <>
                            <h1 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-3">Why are you learning English?</h1>
                            <p className="text-slate-400 text-lg">Choose your main goal to personalize your AI Coach.</p>
                        </>
                    )}
                    {step === 2 && (
                        <>
                            <h1 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-3">What's your current level?</h1>
                            <p className="text-slate-400 text-lg">Be honest. Wolfie will adapt to your vocabulary.</p>
                        </>
                    )}
                    {step === 3 && (
                        <>
                            <h1 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-3">Choose your practice style</h1>
                            <p className="text-slate-400 text-lg">How do you want Wolfie to correct your mistakes?</p>
                        </>
                    )}
                    {step === 4 && (
                        <>
                            <h1 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-3">Sobre o que você curte conversar?</h1>
                            <p className="text-slate-400 text-lg">Escolha pelo menos 2. Wolfie vai usar esses temas nas conversas.</p>
                        </>
                    )}
                    {step === 5 && (
                        <>
                            <h1 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-3">Preparation complete</h1>
                            <p className="text-slate-400 text-lg">Wolfie is calibrating your personal curriculum.</p>
                        </>
                    )}
                </div>

                {/* Content Details */}
                <div className="w-full">
                    {step === 1 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {goals.map(g => {
                                const Icon = g.icon;
                                const isSelected = goal === g.id;
                                return (
                                    <button
                                        key={g.id}
                                        onClick={() => setGoal(g.id)}
                                        className={`flex flex-col items-start p-6 rounded-2xl border text-left transition-all duration-200 ${isSelected ? 'bg-indigo-500/10 border-indigo-500 shadow-[0_0_30px_rgba(99,102,241,0.2)]' : 'bg-slate-900 border-white/5 hover:bg-slate-800'}`}
                                    >
                                        <div className={`p-3 rounded-xl ${g.color} bg-opacity-20 mb-4`}>
                                            <Icon className={`${g.color.replace('bg-', 'text-')} w-6 h-6`} />
                                        </div>
                                        <h3 className="text-white font-bold text-lg mb-1">{g.title}</h3>
                                        <p className="text-slate-400 text-sm font-medium">{g.desc}</p>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {step === 2 && (
                        <div className="grid grid-cols-1 gap-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
                            {levels.map(l => (
                                <button
                                    key={l.id}
                                    onClick={() => setLevel(l.id)}
                                    className={`flex items-center justify-between p-4 rounded-xl border text-left transition-all duration-200 ${level === l.id ? 'bg-indigo-500/10 border-indigo-500 shadow-[0_0_20px_rgba(99,102,241,0.15)]' : 'bg-slate-900 border-white/5 hover:bg-slate-800'}`}
                                >
                                    <div>
                                        <h3 className="text-white font-bold text-base">{l.label}</h3>
                                        <p className="text-slate-400 text-sm mt-0.5">{l.desc}</p>
                                    </div>
                                    <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center ${level === l.id ? 'border-indigo-500' : 'border-slate-700'}`}>
                                        {level === l.id && <div className="w-3 h-3 bg-indigo-500 rounded-full" />}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}

                    {step === 3 && (
                        <div className="grid grid-cols-1 gap-4">
                            {styles.map(s => {
                                const Icon = s.icon;
                                const isSelected = strictness === s.strictness;
                                return (
                                    <button
                                        key={s.id}
                                        onClick={() => setStrictness(s.strictness as 1 | 2 | 3)}
                                        className={`flex items-center gap-4 p-5 rounded-2xl border text-left transition-all duration-200 ${isSelected ? 'bg-indigo-500/10 border-indigo-500 shadow-[0_0_20px_rgba(99,102,241,0.15)]' : 'bg-slate-900 border-white/5 hover:bg-slate-800'}`}
                                    >
                                        <div className={`p-4 rounded-xl ${isSelected ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-800 text-slate-400'}`}>
                                            <Icon className="w-6 h-6" />
                                        </div>
                                        <div>
                                            <h3 className="text-white font-bold text-lg">{s.label}</h3>
                                            <p className="text-slate-400 text-sm mt-1">{s.desc}</p>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {step === 4 && (
                        <div className="flex flex-wrap gap-3 justify-center">
                            {interestOptions.map(opt => {
                                const Icon = opt.icon;
                                const isSelected = interests.includes(opt.id);
                                return (
                                    <button
                                        key={opt.id}
                                        onClick={() => toggleInterest(opt.id)}
                                        className={`flex items-center gap-2 px-5 py-3 rounded-full border text-sm font-bold transition-all duration-200 ${isSelected ? 'bg-indigo-500/20 border-indigo-500 text-white shadow-[0_0_20px_rgba(99,102,241,0.15)]' : 'bg-slate-900 border-white/10 text-slate-400 hover:bg-slate-800 hover:text-white'}`}
                                    >
                                        <Icon className="w-4 h-4" />
                                        {opt.label}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Footer Controls */}
                <div className="w-full mt-12 flex items-center justify-between border-t border-white/5 pt-6">
                    {step > 1 && step < 5 ? (
                        <button onClick={() => setStep(step - 1)} className="px-6 py-3 text-slate-400 font-bold hover:text-white transition-colors">
                            Back
                        </button>
                    ) : <div></div>}

                    {step < 4 ? (
                        <button
                            onClick={() => setStep(step + 1)}
                            disabled={step === 1 && !goal}
                            className="flex items-center gap-2 px-8 py-4 bg-white text-slate-900 rounded-xl font-black uppercase tracking-wider hover:bg-indigo-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Continue <ArrowRight className="w-5 h-5" />
                        </button>
                    ) : step === 4 ? (
                        <button
                            onClick={() => {
                                setStep(5);
                                handleComplete();
                            }}
                            disabled={interests.length < 2}
                            className="flex items-center gap-2 px-8 py-4 bg-indigo-600 text-white rounded-xl font-black uppercase tracking-wider hover:bg-indigo-500 transition-colors shadow-[0_0_30px_rgba(79,70,229,0.4)] disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            Start Practicing <Sparkles className="w-5 h-5" />
                        </button>
                    ) : (
                        <div className="flex w-full justify-center">
                            <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
};

// Temp mock for Heart icon missing in import
const Heart = ({ className }: { className?: string }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
);
