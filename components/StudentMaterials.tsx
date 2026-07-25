import React, { useState, useEffect } from 'react';
import { Book, Lock, CheckCircle, Play, Star, Sparkles, Layers } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import GamificationHeader from './GamificationHeader';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS, PEDAGOGICAL_EVALUATIONS } from '../constants';

interface StudentMaterialsProps {
    user: UserType;
}

import { useStudentContext } from './contexts/StudentContext';

const StudentMaterials: React.FC<StudentMaterialsProps> = ({ user }) => {
    const { data: studentContext, loading: contextLoading, refresh } = useStudentContext();
    const [showEval, setShowEval] = useState(false);
    const [evalScore, setEvalScore] = useState<number | null>(null);
    const [evalXpEarned, setEvalXpEarned] = useState(0);
    const [evalPassed, setEvalPassed] = useState<boolean | null>(null);

    // Derived from Context
    const profile = studentContext?.profile;

    // Quiz State
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [answers, setAnswers] = useState<number[]>([]);
    const [isFinished, setIsFinished] = useState(false);

    // No useEffect needed for profile fetch anymore!

    const handleAccessBook = (url: string) => {
        window.open(url, '_blank');
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
            // Submit to Backend
            handleSubmitQuiz(newAnswers);
        }
    };

    const handleSubmitQuiz = async (finalAnswers: number[]) => {
        // Optimistic UI or Loading?
        // Let's show a loading state in the modal maybe?
        // For now, simple await.

        try {
            const { data, error } = await supabase.functions.invoke('submit-quiz', {
                body: {
                    bookPart: profile?.current_book_part || `${profile?.module || 'A1'}-1`,
                    answers: finalAnswers
                }
            });

            if (error) throw error;

            setEvalScore(data.score); // Backend score
            setEvalXpEarned(Number(data.xpEarned ?? 0));
            setEvalPassed(data.passed === true);
            setIsFinished(true);

            if (data.passed) {
                confetti({ particleCount: 200, spread: 90, origin: { y: 0.5 } });
                // Refresh context to show new XP/Level/Module immediately
                refresh();
            } else {
                // Logic for failure (maybe retry button?)
            }

        } catch (err) {
            console.error('Quiz Submission Error:', err);
            alert('Erro ao enviar avaliação. Tente novamente.');
            setShowEval(false); // Close on error
        }
    };

    const resetQuiz = () => {
        setShowEval(false);
        setEvalScore(null);
        setEvalXpEarned(0);
        setEvalPassed(null);
        setCurrentQuestionIndex(0);
        setSelectedOption(null);
        setAnswers([]);
        setIsFinished(false);
    };

    if (contextLoading) return (
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
                        <div className="p-2 bg-tenant-primary text-white rounded-lg">
                            <Layers size={20} />
                        </div>
                        <h2 className="text-3xl font-black text-brand-text tracking-tighter">Estante Virtual</h2>
                    </div>
                    <p className="text-brand-muted font-medium">Explore sua coleção de materiais do nível <span className="text-indigo-600 font-black">{currentModule}</span>.</p>
                </div>
                <div className="hidden md:block">
                    <span className="text-xs font-black text-slate-300 uppercase tracking-widest">{parts.length} Títulos Disponíveis</span>
                </div>
            </div>

            <GamificationHeader
                xp={studentContext?.gamification?.xp || 0}
                level={studentContext?.gamification?.level || 1}
                streak={studentContext?.gamification?.streak || 0}
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
                                <div className="absolute top-0 right-0 p-24 bg-brand-surface/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 group-hover:bg-brand-surface/20 transition-all"></div>

                                <div className="relative z-10 w-full">
                                    <div className="flex justify-between items-start">
                                        <span className="px-3 py-1 bg-black/20 backdrop-blur-sm rounded-lg text-[10px] font-black text-white uppercase tracking-widest border border-white/10">
                                            {currentModule}
                                        </span>
                                        {isCurrent && <span className="w-2 h-2 rounded-full bg-brand-surface animate-pulse shadow-[0_0_10px_white]"></span>}
                                    </div>
                                </div>

                                <div className="relative z-10 text-center">
                                    <h3 className="text-4xl md:text-5xl font-black text-white tracking-tighter drop-shadow-md opacity-90">
                                        Part<br />{part.part}
                                    </h3>
                                    <div className="w-8 h-1 bg-brand-surface/30 mx-auto mt-4 rounded-full"></div>
                                </div>

                                <div className="relative z-10 mt-auto flex justify-center opacity-0 group-hover:opacity-100 transition-all transform translate-y-4 group-hover:translate-y-0">
                                    <div className="w-12 h-12 bg-brand-surface rounded-full flex items-center justify-center text-brand-text shadow-xl">
                                        <Play size={20} className="ml-1" fill="currentColor" />
                                    </div>
                                </div>
                            </div>

                            {/* Overlay for Locked */}
                            {isLocked && (
                                <div className="absolute inset-0 bg-brand-surface/50 backdrop-blur-[2px] flex items-center justify-center z-20">
                                    <Lock className="text-white/50" size={48} />
                                </div>
                            )}
                        </div>
                    );
                })}

                {/* Evaluation Logic as a Card if unlocked or as the next step */}
                <div className={`aspect-[3/4] rounded-[2rem] p-1 flex flex-col relative overflow-hidden group transition-all duration-300 ${profile?.evaluation_unlocked
                    ? 'bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 shadow-xl cursor-pointer hover:-translate-y-2 hover:shadow-2xl'
                    : 'bg-brand-surface-2 dark:bg-brand-surface border-2 border-dashed border-brand-border dark:border-brand-border'
                    }`}
                    onClick={() => profile?.evaluation_unlocked && setShowEval(true)}
                >
                    <div className="h-full w-full bg-brand-surface/5 backdrop-blur-sm rounded-[1.8rem] flex flex-col items-center justify-center text-center p-6">
                        {profile?.evaluation_unlocked ? (
                            <>
                                <div className="w-16 h-16 bg-brand-surface rounded-full flex items-center justify-center text-purple-600 mb-6 shadow-lg animate-bounce">
                                    <CheckCircle size={32} />
                                </div>
                                <h3 className="text-2xl font-black text-white uppercase leading-none mb-2">Final<br />Test</h3>
                                <p className="text-white/80 text-xs font-medium">Você desbloqueou a prova final!</p>
                                <div className="mt-8 px-6 py-3 bg-brand-surface text-purple-600 rounded-xl font-black text-[10px] uppercase tracking-widest shadow-xl">Start Exam</div>
                            </>
                        ) : (
                            <>
                                <Lock size={32} className="text-slate-300 dark:text-brand-muted mb-4" />
                                <h3 className="text-lg font-black text-brand-muted dark:text-brand-muted uppercase">Avaliação<br />Bloqueada</h3>
                                <p className="text-[10px] text-brand-muted mt-2 px-4">Complete os módulos anteriores para liberar.</p>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {/* Evaluation Modal */}
            {showEval && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md" onClick={() => !isFinished && setShowEval(false)} />
                    <div className="bg-brand-surface w-full max-w-2xl rounded-[3rem] max-h-[90dvh] overflow-y-auto relative z-10 shadow-2xl animate-in zoom-in duration-300">
                        <div className="p-8 md:p-12">
                            {!isFinished ? (
                                <>
                                    <div className="flex justify-between items-center mb-8">
                                        <h2 className="text-2xl font-black text-brand-text tracking-tight">Avaliação Progressiva</h2>
                                        <span className="px-4 py-1.5 bg-indigo-100 text-indigo-600 rounded-lg text-[10px] font-black uppercase">Questão {currentQuestionIndex + 1}/{questions.length}</span>
                                    </div>

                                    <div className="mb-10">
                                        <p className="text-lg font-bold text-brand-text mb-6">
                                            {questions[currentQuestionIndex]?.question}
                                        </p>

                                        <div className="space-y-3">
                                            {questions[currentQuestionIndex]?.options.map((opt, idx) => (
                                                <button
                                                    key={idx}
                                                    onClick={() => setSelectedOption(idx)}
                                                    className={`w-full p-4 rounded-xl text-left text-sm font-bold transition-all border-2 ${selectedOption === idx
                                                        ? 'border-indigo-500 bg-indigo-500/5 text-indigo-600'
                                                        : 'border-brand-border hover:border-brand-border'}`}
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
                                    <div className={`w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 ${
                                        evalPassed
                                            ? 'bg-emerald-100 text-emerald-600'
                                            : 'bg-amber-100 text-amber-600'
                                    }`}>
                                        <CheckCircle size={48} />
                                    </div>
                                    <h2 className="text-4xl font-black text-brand-text mb-2">{evalScore}/{questions.length}</h2>
                                    <p className="text-brand-muted mb-8 uppercase text-xs font-black tracking-widest">Resultado do Exame {currentPartKey}</p>

                                    <div className={`p-6 rounded-2xl font-bold text-sm mb-8 leading-relaxed ${
                                        evalPassed
                                            ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/10'
                                            : 'bg-amber-50 text-amber-700 dark:bg-amber-900/10 dark:text-amber-300'
                                    }`}>
                                        {evalPassed ? (
                                            <>
                                                Exame concluído com sucesso!
                                                {evalXpEarned > 0 ? ` Você ganhou ${evalXpEarned} XP.` : ''}
                                                {' '}Seu professor já pode visualizar seu desempenho.
                                            </>
                                        ) : (
                                            <>
                                                Você ainda não atingiu os 70% necessários.
                                                Revise este conteúdo e tente novamente quando se sentir pronto.
                                                {' '}Seu desempenho ficou registrado.
                                            </>
                                        )}
                                    </div>

                                    <button
                                        onClick={resetQuiz}
                                        className="px-10 py-4 bg-tenant-primary text-white rounded-xl font-black uppercase text-xs hover:scale-105 transition-all shadow-lg"
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
