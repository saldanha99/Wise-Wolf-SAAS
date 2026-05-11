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

import { useStudentContext } from './contexts/StudentContext';

const StudentMaterials: React.FC<StudentMaterialsProps> = ({ user }) => {
    const { data: studentContext, loading: contextLoading, refresh } = useStudentContext();
    const [showEval, setShowEval] = useState(false);
    const [evalScore, setEvalScore] = useState<number | null>(null);

    // Derived from Context
    const profile = studentContext?.profile;

    // Quiz State
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [answers, setAnswers] = useState<number[]>([]);
    const [isFinished, setIsFinished] = useState(false);
    const [libraryMaterials, setLibraryMaterials] = useState<any[]>([]);

    useEffect(() => {
        fetchLibraryMaterials();
    }, []);

    const fetchLibraryMaterials = async () => {
        try {
            const { data, error } = await supabase
                .from('pedagogical_materials')
                .select('*')
                .order('level_tag', { ascending: true });
            
            if (error) throw error;
            setLibraryMaterials(data || []);
        } catch (err) {
            console.error('Error fetching library materials:', err);
        }
    };

    const handleAccessBook = async (url: string) => {
        if (!url) {
            alert('Erro: Link do material não encontrado. Contate seu professor.');
            return;
        }

        // Use window.open for external links/PDFs
        window.open(url, '_blank');

        try {
            // Fix: Pass correct arguments to gamification service (userId, tenantId, amount, source)
            const result = await gamificationService.addXP(user.id, user.tenantId, 15, 'PEDAGOGICAL_MATERIAL');
            if (result?.leveledUp) {
                confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
            }
        } catch (err) {
            console.error('Error adding XP for material access:', err);
        }
        
        refresh(); // Update global context
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

    const currentPartIndex = parseInt(currentPartKey.split('-')[1]) || 1;

    return (
        <div className="space-y-10 animate-in fade-in duration-700 pb-20">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-tenant-primary text-white rounded-lg">
                            <Layers size={20} />
                        </div>
                        <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">Estante Virtual</h2>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400 font-medium">Explore sua coleção de materiais do nível <span className="text-indigo-600 font-black">{currentModule}</span>.</p>
                </div>
                <div className="hidden md:block">
                    <span className="text-xs font-black text-slate-300 uppercase tracking-widest">{libraryMaterials.filter(m => m.level_tag === currentModule).length} Títulos Disponíveis</span>
                </div>
            </div>

            <GamificationHeader
                xp={studentContext?.gamification?.xp || 0}
                level={studentContext?.gamification?.level || 1}
                streak={studentContext?.gamification?.streak || 0}
            />

            {/* Gallery Grid */}
            {/* Dynamic Gallery Grid from Library */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 md:gap-8">
                {libraryMaterials.filter(m => m.level_tag === currentModule || m.scope === 'GLOBAL').map((mat: any, index: number) => {
                    const gradients = [
                        'from-emerald-400 to-teal-600',
                        'from-blue-400 to-indigo-600',
                        'from-violet-400 to-purple-600',
                        'from-fuchsia-400 to-pink-600',
                        'from-orange-400 to-red-600',
                        'from-amber-400 to-orange-600'
                    ];
                    const gradient = gradients[index % gradients.length];
                    
                    return (
                        <div
                            key={mat.id}
                            onClick={() => handleAccessBook(mat.file_url)}
                            className="group relative aspect-[3/4] rounded-[2rem] overflow-hidden transition-all duration-300 cursor-pointer hover:-translate-y-2 hover:shadow-2xl shadow-lg"
                        >
                            {/* Cover Art Background */}
                            <div className={`absolute inset-0 bg-gradient-to-br ${gradient} p-6 flex flex-col justify-between`}>
                                <div className="absolute top-0 right-0 p-24 bg-white/10 rounded-full blur-2xl -translate-y-1/2 translate-x-1/2 group-hover:bg-white/20 transition-all"></div>

                                <div className="relative z-10 w-full">
                                    <div className="flex justify-between items-start">
                                        <span className="px-3 py-1 bg-black/20 backdrop-blur-sm rounded-lg text-[10px] font-black text-white uppercase tracking-widest border border-white/10">
                                            {mat.level_tag || 'GERAL'}
                                        </span>
                                    </div>

                                    <div className="mt-8">
                                        <h4 className="text-white font-black text-xl leading-tight uppercase line-clamp-3">
                                            {mat.title}
                                        </h4>
                                        <div className="flex items-center gap-2 mt-2">
                                            <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                                                <Play size={10} className="text-white fill-white" />
                                            </div>
                                            <span className="text-[10px] font-bold text-white/80 uppercase tracking-tighter">Acessar Agora</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="relative z-10 flex justify-between items-center">
                                    <div className="flex -space-x-2">
                                        <div className="w-8 h-8 rounded-full border-2 border-white/20 bg-white/10 flex items-center justify-center backdrop-blur-md">
                                            <Star size={12} className="text-yellow-400 fill-yellow-400" />
                                        </div>
                                    </div>
                                    <div className="p-3 bg-white/20 backdrop-blur-md rounded-2xl group-hover:bg-white/30 transition-colors">
                                        <ChevronRight size={20} className="text-white" />
                                    </div>
                                </div>
                            </div>
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

            {/* Assigned Materials Section */}
            {(studentContext?.assignedMaterials?.length || 0) > 0 && (
                <div className="pt-10 border-t border-slate-100 dark:border-slate-800">
                    <div className="flex items-center gap-3 mb-8">
                        <div className="p-2 bg-indigo-500 text-white rounded-lg">
                            <Book size={20} />
                        </div>
                        <div>
                            <h3 className="text-2xl font-black text-slate-800 dark:text-white tracking-tight">Materiais do Professor</h3>
                            <p className="text-xs text-slate-500 font-medium">Conteúdo personalizado atribuído para você.</p>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {studentContext?.assignedMaterials?.map((m: any) => (
                            <div 
                                key={m.assignment_id} 
                                onClick={() => handleAccessBook(m.file_url)}
                                className="group bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-5 rounded-[2rem] hover:shadow-xl transition-all cursor-pointer flex items-center gap-5"
                            >
                                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-black text-[10px] shadow-sm transition-transform group-hover:scale-110 ${
                                    m.type === 'PDF' ? 'bg-red-50 text-red-600' :
                                    m.type === 'VIDEO' ? 'bg-blue-50 text-blue-600' : 
                                    'bg-emerald-50 text-emerald-600'
                                }`}>
                                    {m.type}
                                </div>
                                <div className="flex-1">
                                    <h4 className="font-black text-sm text-slate-800 dark:text-white group-hover:text-indigo-600 transition-colors line-clamp-1">
                                        {m.title}
                                    </h4>
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <span className="text-[9px] bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full uppercase font-black text-slate-500">
                                            {m.level_tag || 'Geral'}
                                        </span>
                                        {m.niche && m.niche !== 'GENERAL' && (
                                            <span className={`text-[9px] px-2 py-0.5 rounded-full uppercase font-black ${
                                                m.niche === 'MEDICINE' ? 'bg-emerald-50 text-emerald-600' :
                                                m.niche === 'TECH' ? 'bg-blue-50 text-blue-600' :
                                                m.niche === 'BUSINESS' ? 'bg-purple-50 text-purple-600' :
                                                m.niche === 'TRAVEL' ? 'bg-orange-50 text-orange-600' :
                                                'bg-slate-100 text-slate-500'
                                            }`}>
                                                {m.niche}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1 mt-2 text-slate-400">
                                        <Clock size={10} />
                                        <span className="text-[9px] uppercase font-black tracking-tighter">
                                            {new Date(m.assigned_at).toLocaleDateString()}
                                        </span>
                                    </div>
                                </div>
                                <div className="w-8 h-8 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                                    <Play size={12} fill="currentColor" />
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

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
