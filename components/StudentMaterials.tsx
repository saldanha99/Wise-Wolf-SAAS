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
            tenant_id: (user as any).tenantId
        });

        // Relock evaluation in DB
        await supabase.from('profiles').update({ evaluation_unlocked: false }).eq('id', user.id);

        // Local update
        setProfile((prev: any) => ({ ...prev, evaluation_unlocked: false }));
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
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
        </div>
    );

    const parts = (PEDAGOGICAL_BOOKS as any)[currentModule] || [];
    const currentPartIndex = parseInt(currentPartKey.split('-')[1]) || 1;

    const gradients = [
        'from-emerald-400 to-teal-600',
        'from-blue-400 to-indigo-600',
        'from-violet-400 to-purple-600',
        'from-fuchsia-400 to-pink-600',
        'from-orange-400 to-red-600',
        'from-amber-400 to-orange-600'
    ];

    return (
        <div className="space-y-10 animate-in fade-in duration-700 pb-20">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-slate-900 dark:bg-white rounded-lg text-white dark:text-slate-900">
                            <Layers size={20} />
                        </div>
                        <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">Estante Virtual</h2>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400 font-medium">Explore sua coleção de materiais do nível <span className="text-indigo-600 font-black">{currentModule}</span>.</p>
                </div>
                <div className="hidden md:block">
                    <span className="text-xs font-black text-slate-300 uppercase tracking-widest">{parts.length} Títulos Disponíveis</span>
                </div>
            </div>

            <GamificationHeader
                xp={profile?.xp || 0}
                level={profile?.level || 1}
                streak={profile?.streak_count || 0}
            />

            {/* Gallery Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 md:gap-8">
                {parts.map((part: any, index: number) => {
                    const gradient = gradients[index % gradients.length];
                    const isCurrent = part.part === currentPartIndex;
                    const isLocked = part.part > currentPartIndex;

                    return (
                        <div
                            key={index}
                            onClick={() => !isLocked && handleAccessBook(part.url)}
                            className={`group relative aspect-[3/4] rounded-[2rem] overflow-hidden transition-all duration-300 ${isLocked ? 'grayscale opacity-60 cursor-not-allowed' : 'cursor-pointer hover:-translate-y-2 hover:shadow-2xl shadow-lg'}`}
                        >
                            {/* Cover Art Background */}
                            <div className={`absolute inset-0 bg-gradient-to-br ${gradient} p-6 flex flex-col justify-between`}>
                                <div className="absolute top-0 right-0 p-24 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 group-hover:bg-white/20 transition-all"></div>

                                <div className="relative z-10 w-full">
                                    <div className="flex justify-between items-start">
                                        <span className="px-3 py-1 bg-black/20 backdrop-blur-sm rounded-lg text-[10px] font-black text-white uppercase tracking-widest border border-white/10">
                                            {currentModule}
                                        </span>
                                        {isCurrent && <span className="w-2 h-2 rounded-full bg-white animate-pulse shadow-[0_0_10px_white]"></span>}
                                    </div>
                                </div>

                                <div className="relative z-10 text-center">
                                    <h3 className="text-4xl md:text-5xl font-black text-white tracking-tighter drop-shadow-md opacity-90">
                                        Part<br />{part.part}
                                    </h3>
                                    <div className="w-8 h-1 bg-white/30 mx-auto mt-4 rounded-full"></div>
                                </div>

                                <div className="relative z-10 mt-auto flex justify-center opacity-0 group-hover:opacity-100 transition-all transform translate-y-4 group-hover:translate-y-0">
                                    <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-slate-900 shadow-xl">
                                        <Play size={20} className="ml-1" fill="currentColor" />
                                    </div>
                                </div>
                            </div>

                            {/* Overlay for Locked */}
                            {isLocked && (
                                <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px] flex items-center justify-center z-20">
                                    <Lock className="text-white/50" size={48} />
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Evaluation Logic as a Card if unlocked or as the next step */}
                <div className={`aspect-[3/4] rounded-[2rem] p-1 flex flex-col relative overflow-hidden group transition-all duration-300 ${profile?.evaluation_unlocked
                        ? 'bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 shadow-xl cursor-pointer hover:-translate-y-2 hover:shadow-2xl'
                        : 'bg-slate-100 dark:bg-slate-900 border-2 border-dashed border-slate-200 dark:border-slate-800'
                    }`}
                    onClick={() => profile?.evaluation_unlocked && setShowEval(true)}
                >
                    <div className="h-full w-full bg-white/5 backdrop-blur-sm rounded-[1.8rem] flex flex-col items-center justify-center text-center p-6">
                        {profile?.evaluation_unlocked ? (
                            <>
                                <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center text-purple-600 mb-6 shadow-lg animate-bounce">
                                    <CheckCircle size={32} />
                                </div>
                                <h3 className="text-2xl font-black text-white uppercase leading-none mb-2">Final<br />Test</h3>
                                <p className="text-white/80 text-xs font-medium">Você desbloqueou a prova final!</p>
                                <div className="mt-8 px-6 py-3 bg-white text-purple-600 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-xl">Start Exam</div>
                            </>
                        ) : (
                            <>
                                <Lock size={32} className="text-slate-300 dark:text-slate-600 mb-4" />
                                <h3 className="text-lg font-black text-slate-400 dark:text-slate-600 uppercase">Avaliação<br />Bloqueada</h3>
                                <p className="text-[10px] text-slate-400 mt-2 px-4">Complete os módulos anteriores para liberar.</p>
                            </>
                        )}
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
                                                        ? 'border-indigo-500 bg-indigo-500/5 text-indigo-600'
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
