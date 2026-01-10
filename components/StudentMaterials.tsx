import React, { useState, useEffect } from 'react';
import { Book, Lock, CheckCircle, Play, Star, Sparkles, Layers } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import GamificationHeader from './GamificationHeader';
import { gamificationService } from '../services/gamificationService';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS, PEDAGOGICAL_EVALUATIONS } from '../constants';

interface StudentMaterialsProps {
    user: UserType;
}

const StudentMaterials: React.FC<StudentMaterialsProps> = ({ user }) => {
    const [loading, setLoading] = useState(true);
    const [profile, setProfile] = useState<any>(null);
    const [showEval, setShowEval] = useState(false);
    const [evalScore, setEvalScore] = useState<number | null>(null);

    // Quiz State
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [answers, setAnswers] = useState<number[]>([]);
    const [isFinished, setIsFinished] = useState(false);

    useEffect(() => {
        fetchProfile();
    }, []);

    const fetchProfile = async () => {
        setLoading(true);
        try {
            const { data } = await supabase.from('profiles').select('*').eq('id', user.id).single();
            if (data) {
                setProfile(data);
            }
        } catch (err) {
            console.error('Error fetching profile:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleAccessBook = async (url: string) => {
        window.open(url, '_blank');
        const result = await gamificationService.addXP(user.id, 15);
        if (result?.leveledUp) {
            confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        }
        fetchProfile();
    };

    const currentModule = profile?.module || 'A1';
    const currentPartKey = profile?.current_book_part || `${currentModule}-1`;
    const questions = PEDAGOGICAL_EVALUATIONS[currentPartKey] || [];

    const handleNextQuestion = () => {
        if (selectedOption === null) return;

        const newAnswers = [...answers, selectedOption];
        setAnswers(newAnswers);

        if (currentQuestionIndex < questions.length - 1) {
            setCurrentQuestionIndex(prev => prev + 1);
            setSelectedOption(null);
        } else {
            // Calculate Score
            let score = 0;
            newAnswers.forEach((ans, idx) => {
                if (ans === questions[idx].correct) score++;
            });
            handleCompleteEval(score, newAnswers);
        }
    };

    const handleCompleteEval = async (score: number, finalAnswers: number[]) => {
        setEvalScore(score);
        setIsFinished(true);

        const result = await gamificationService.addXP(user.id, score * 20); // Award 20 XP per correct answer
        if (result?.leveledUp) {
            confetti({ particleCount: 200, spread: 90, origin: { y: 0.5 } });
        }

        // Save result
        await supabase.from('student_evaluations').insert({
            student_id: user.id,
            book_part: currentPartKey,
            score: score,
            total_questions: questions.length,
            answers: finalAnswers,
            tenant_id: user.tenantId
        });

        // Relock evaluation in DB
        await supabase.from('profiles').update({ evaluation_unlocked: false }).eq('id', user.id);

        // Local update
        setProfile(prev => ({ ...prev, evaluation_unlocked: false }));
    };

    const resetQuiz = () => {
        setShowEval(false);
        setEvalScore(null);
        setCurrentQuestionIndex(0);
        setSelectedOption(null);
        setAnswers([]);
        setIsFinished(false);
    };

    if (loading) return (
        <div className="flex items-center justify-center h-96">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-tenant-primary"></div>
        </div>
    );

    const parts = (PEDAGOGICAL_BOOKS as any)[currentModule] || [];
    const currentPartIndex = parseInt(currentPartKey.split('-')[1]) || 1;
    const currentPartData = parts.find((p: any) => p.part === currentPartIndex);

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
                <div>
                    <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Biblioteca Wise Wolf</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Seu material didático atual e avaliações de progresso.</p>
                </div>
                <div className="flex items-center gap-2 px-4 py-2 bg-tenant-primary/10 rounded-2xl border border-tenant-primary/20">
                    <Layers size={16} className="text-tenant-primary" />
                    <span className="text-xs font-black text-tenant-primary uppercase tracking-widest">{currentModule} • Parte {currentPartIndex}</span>
                </div>
            </header>

            <GamificationHeader
                xp={profile?.xp || 0}
                level={profile?.level || 1}
                streak={profile?.streak_count || 0}
            />

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Main Book Card */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="bg-white dark:bg-slate-900 rounded-[3rem] p-8 border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden group">
                        <div className="absolute -right-16 -top-16 w-64 h-64 bg-tenant-primary/5 rounded-full blur-3xl group-hover:bg-tenant-primary/10 transition-all" />

                        <div className="relative z-10">
                            <div className="flex justify-between items-start mb-8">
                                <div className="p-4 bg-tenant-primary/10 text-tenant-primary rounded-3xl">
                                    <Book size={40} />
                                </div>
                                <div className="text-right">
                                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</p>
                                    <p className="text-xs font-bold text-emerald-500 uppercase">Em Estudo</p>
                                </div>
                            </div>

                            <h3 className="text-2xl font-black text-slate-800 dark:text-white mb-2">Wise Wolf Book {currentModule}</h3>
                            <p className="text-slate-500 dark:text-slate-400 text-sm mb-8 leading-relaxed">
                                Você está atualmente estudando a <strong>Parte {currentPartIndex}</strong> do material {currentModule}.
                                Clique no botão abaixo para abrir o PDF original e continuar seus estudos.
                            </p>

                            {currentPartData ? (
                                <button
                                    onClick={() => handleAccessBook(currentPartData.url)}
                                    className="w-full md:w-auto px-10 py-5 bg-tenant-primary text-white rounded-2xl font-black text-xs uppercase tracking-widest flex items-center justify-center gap-3 shadow-xl shadow-tenant-primary/20 hover:scale-105 active:scale-95 transition-all"
                                >
                                    <Play size={18} fill="currentColor" /> ABRIR LIVRO AGORA
                                </button>
                            ) : (
                                <p className="text-red-500 text-xs font-bold italic">Link do material não configurado para este módulo/parte.</p>
                            )}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="bg-slate-50 dark:bg-slate-800/50 p-6 rounded-[2rem] border border-slate-200 dark:border-slate-700">
                            <div className="flex items-center gap-3 mb-4 text-tenant-primary">
                                <Sparkles size={24} />
                                <h4 className="font-black text-sm uppercase tracking-tight">Próximos Passos</h4>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400">Após concluir esta parte, seu professor liberará a Parte {currentPartIndex + 1} ou a avaliação final do nível.</p>
                        </div>
                        <div className="bg-yellow-50 dark:bg-yellow-900/10 p-6 rounded-[2rem] border border-yellow-200 dark:border-yellow-900/30">
                            <div className="flex items-center gap-3 mb-4 text-yellow-600">
                                <Star size={24} />
                                <h4 className="font-black text-sm uppercase tracking-tight">Dica WW</h4>
                            </div>
                            <p className="text-xs text-slate-500 dark:text-slate-400">Tente revisar o conteúdo pelo menos 15 minutos por dia para manter sua ofensiva alta e dobrar seu XP!</p>
                        </div>
                    </div>
                </div>

                {/* Evaluation Card */}
                <div className="lg:col-span-1">
                    <div className={`h-full rounded-[3rem] p-8 flex flex-col items-center justify-center text-center transition-all ${profile?.evaluation_unlocked
                        ? 'bg-gradient-to-b from-indigo-600 to-indigo-800 text-white shadow-2xl shadow-indigo-500/30'
                        : 'bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 shadow-sm grayscale opacity-80'
                        }`}>
                        <div className={`p-6 rounded-full mb-6 ${profile?.evaluation_unlocked ? 'bg-white/20' : 'bg-slate-100 dark:bg-slate-800 text-slate-400'}`}>
                            {profile?.evaluation_unlocked ? <CheckCircle size={48} className="animate-bounce" /> : <Lock size={48} />}
                        </div>

                        <h3 className={`text-xl font-black mb-2 ${profile?.evaluation_unlocked ? 'text-white' : 'text-slate-800 dark:text-white'}`}>Avaliação Final</h3>
                        <p className={`text-xs mb-8 max-w-[200px] leading-relaxed ${profile?.evaluation_unlocked ? 'text-indigo-100' : 'text-slate-500'}`}>
                            {profile?.evaluation_unlocked
                                ? 'Sua avaliação de 10 questões está disponível! Prepare-se bem antes de clicar.'
                                : 'Esta avaliação será liberada pelo seu professor assim que você concluir o conteúdo deste livro.'}
                        </p>

                        <button
                            disabled={!profile?.evaluation_unlocked}
                            onClick={() => setShowEval(true)}
                            className={`w-full py-5 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] transition-all ${profile?.evaluation_unlocked
                                ? 'bg-white text-indigo-600 hover:scale-105 active:scale-95 shadow-xl'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed'
                                }`}
                        >
                            {profile?.evaluation_unlocked ? 'INICIAR EXAME (+200 XP)' : 'BLOQUEADO'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Evaluation Modal */}
            {showEval && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md" onClick={() => !isFinished && setShowEval(false)} />
                    <div className="bg-white dark:bg-slate-900 w-full max-w-2xl rounded-[3rem] overflow-hidden relative z-10 shadow-2xl animate-in zoom-in duration-300">
                        <div className="p-8 md:p-12">
                            {!isFinished ? (
                                <>
                                    <div className="flex justify-between items-center mb-8">
                                        <h2 className="text-2xl font-black text-slate-800 dark:text-white tracking-tight">Avaliação Progressiva</h2>
                                        <span className="px-4 py-1.5 bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-black uppercase">Questão {currentQuestionIndex + 1}/{questions.length}</span>
                                    </div>

                                    <div className="mb-10">
                                        <p className="text-lg font-bold text-slate-800 dark:text-white mb-6">
                                            {questions[currentQuestionIndex]?.question}
                                        </p>

                                        <div className="space-y-3">
                                            {questions[currentQuestionIndex]?.options.map((opt, idx) => (
                                                <button
                                                    key={idx}
                                                    onClick={() => setSelectedOption(idx)}
                                                    className={`w-full p-4 rounded-xl text-left text-sm font-bold transition-all border-2 ${selectedOption === idx
                                                        ? 'border-tenant-primary bg-tenant-primary/5 text-tenant-primary'
                                                        : 'border-slate-100 dark:border-slate-800 hover:border-slate-200'}`}
                                                >
                                                    {opt}
                                                </button>
                                            ))}
                                        </div>
                                    </div>

                                    <button
                                        onClick={handleNextQuestion}
                                        disabled={selectedOption === null}
                                        className="w-full py-5 bg-indigo-600 text-white rounded-2xl font-black uppercase tracking-widest hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-500/30 disabled:opacity-50 disabled:grayscale"
                                    >
                                        {currentQuestionIndex === questions.length - 1 ? 'CONCLUIR AVALIAÇÃO' : 'PRÓXIMA QUESTÃO'}
                                    </button>
                                </>
                            ) : (
                                <div className="text-center py-10">
                                    <div className="w-24 h-24 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-6">
                                        <CheckCircle size={48} />
                                    </div>
                                    <h2 className="text-4xl font-black text-slate-800 dark:text-white mb-2">{evalScore}/{questions.length}</h2>
                                    <p className="text-slate-500 mb-8 uppercase text-xs font-black tracking-widest">Resultado do Exame {currentPartKey}</p>

                                    <div className="bg-emerald-50 dark:bg-emerald-900/10 p-6 rounded-2xl text-emerald-600 font-bold text-sm mb-8 leading-relaxed">
                                        Exame concluído com sucesso! Você ganhou {(evalScore || 0) * 20} XP extras.
                                        Seu professor já pode visualizar seu desempenho.
                                    </div>

                                    <button
                                        onClick={resetQuiz}
                                        className="px-10 py-4 bg-slate-900 dark:bg-white dark:text-slate-900 text-white rounded-xl font-black uppercase text-xs hover:scale-105 transition-all shadow-lg"
                                    >
                                        FECHAR E CONTINUAR ESTUDOS
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default StudentMaterials;
