import React, { useState, useEffect } from 'react';
import { Book, Lock, CheckCircle, Play, Star, Layers, ChevronRight, FileText, Clock } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';
import GamificationHeader from './GamificationHeader';
import { gamificationService } from '../services/gamificationService';
import confetti from 'canvas-confetti';
import { PEDAGOGICAL_BOOKS, PEDAGOGICAL_EVALUATIONS } from '../constants';
import { useStudentContext } from './contexts/StudentContext';

interface StudentMaterialsProps {
    user: UserType;
}

const StudentMaterials: React.FC<StudentMaterialsProps> = ({ user }) => {
    const { data: studentContext, loading: contextLoading, refresh } = useStudentContext();
    const [directAssignments, setDirectAssignments] = useState<any[]>([]);
    const [loadingDirect, setLoadingDirect] = useState(true);
    const [showEval, setShowEval] = useState(false);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [isFinished, setIsFinished] = useState(false);
    const [evalScore, setEvalScore] = useState<number | null>(null);
    const [answers, setAnswers] = useState<number[]>([]);

    const currentModule = studentContext?.profile?.module || 'A1';
    const currentPartKey = studentContext?.profile?.current_book_part || `${currentModule}-1`;

    useEffect(() => {
        fetchDirectMaterials();
    }, [user.id]);

    const fetchDirectMaterials = async () => {
        setLoadingDirect(true);
        try {
            console.log("Fetching materials for student:", user.id);
            // 1. Get assignments
            const { data: assignments, error: assignError } = await supabase
                .from('student_assignments')
                .select('*, pedagogical_materials(*)')
                .eq('student_id', user.id);

            if (assignError) throw assignError;

            if (assignments) {
                const formatted = assignments.map(a => ({
                    assignment_id: a.id,
                    ...a.pedagogical_materials,
                    assigned_at: a.assigned_at
                }));
                console.log("Direct materials found:", formatted);
                setDirectAssignments(formatted);
            }
        } catch (err) {
            console.error("Error fetching direct materials:", err);
        } finally {
            setLoadingDirect(false);
        }
    };

    const handleAccessBook = (url: string) => {
        if (!url) {
            alert("Material ainda não disponível para este módulo.");
            return;
        }
        window.open(url, '_blank');
    };

    const handleNextQuestion = () => {
        if (selectedOption === null) return;

        const newAnswers = [...answers, selectedOption];
        setAnswers(newAnswers);

        const currentParts = PEDAGOGICAL_EVALUATIONS[currentPartKey as keyof typeof PEDAGOGICAL_EVALUATIONS] || [];
        const questions = currentParts[0]?.questions || [];

        if (currentQuestionIndex < questions.length - 1) {
            setCurrentQuestionIndex(currentQuestionIndex + 1);
            setSelectedOption(null);
        } else {
            // Submit to Backend
            handleSubmitQuiz(newAnswers);
        }
    };

    const handleSubmitQuiz = async (finalAnswers: number[]) => {
        try {
            const { data, error } = await supabase.functions.invoke('submit-quiz', {
                body: {
                    bookPart: studentContext?.profile?.current_book_part || `${studentContext?.profile?.module || 'A1'}-1`,
                    answers: finalAnswers
                }
            });

            if (error) throw error;

            setEvalScore(data.score);
            setIsFinished(true);

            // Celebration
            confetti({
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 },
                colors: ['#4F46E5', '#10B981', '#F59E0B']
            });

            // Gamification
            await gamificationService.addXP(user.id, data.score * 20);
            refresh(); // Refresh context to update evaluation status
        } catch (err) {
            console.error("Error submitting quiz:", err);
            alert("Erro ao enviar avaliação. Tente novamente.");
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

    if (contextLoading || loadingDirect) return (
        <div className="flex items-center justify-center h-96">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
        </div>
    );

    const questions = (PEDAGOGICAL_EVALUATIONS[currentPartKey as keyof typeof PEDAGOGICAL_EVALUATIONS] || [])[0]?.questions || [];

    return (
        <div className="space-y-10 animate-in fade-in duration-700 pb-20">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-2 bg-indigo-600 text-white rounded-lg">
                            <Layers size={20} />
                        </div>
                        <h2 className="text-3xl font-black text-slate-900 dark:text-white tracking-tighter">Estante Virtual</h2>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400 font-medium">Explore sua coleção de materiais do nível <span className="text-indigo-600 font-black">{currentModule}</span>.</p>
                </div>
                <div className="hidden md:block">
                    <span className="text-xs font-black text-slate-300 uppercase tracking-widest">{directAssignments.length} Títulos Disponíveis</span>
                </div>
            </div>

            {/* Gamification Stats */}
            <GamificationHeader studentId={user.id} />

            {/* Gallery Grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 md:gap-8">
                {directAssignments.map((mat: any, index: number) => {
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
                            key={mat.assignment_id || mat.id}
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
                                        <span className="w-2 h-2 rounded-full bg-white animate-pulse shadow-[0_0_10px_white]"></span>
                                    </div>

                                    <div className="mt-8">
                                        <h4 className="text-white font-black text-xl leading-tight uppercase line-clamp-3">
                                            {mat.title}
                                        </h4>
                                        <div className="flex items-center gap-2 mt-2">
                                            <div className="w-6 h-6 rounded-full bg-white/20 flex items-center justify-center">
                                                <Play size={10} className="text-white fill-white" />
                                            </div>
                                            <span className="text-[10px] font-bold text-white/80 uppercase tracking-tighter">
                                                Acessar Agora
                                            </span>
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

                {/* Evaluation Card */}
                <div className={`aspect-[3/4] rounded-[2rem] p-1 flex flex-col relative overflow-hidden group transition-all duration-300 ${studentContext?.profile?.evaluation_unlocked
                    ? 'bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 shadow-xl cursor-pointer hover:-translate-y-2 hover:shadow-2xl'
                    : 'bg-slate-100 dark:bg-slate-900 border-2 border-dashed border-slate-200 dark:border-slate-800'
                    }`}
                    onClick={() => studentContext?.profile?.evaluation_unlocked && setShowEval(true)}
                >
                    <div className="h-full w-full bg-white/5 backdrop-blur-sm rounded-[1.8rem] flex flex-col items-center justify-center text-center p-6">
                        {studentContext?.profile?.evaluation_unlocked ? (
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
                                            {questions[currentQuestionIndex]?.options.map((opt: string, idx: number) => (
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
                                    <p className="text-slate-500 mb-8 uppercase text-xs font-black tracking-widest">Resultado do Exame</p>

                                    <div className="bg-emerald-50 dark:bg-emerald-900/10 p-6 rounded-2xl text-emerald-600 font-bold text-sm mb-8 leading-relaxed">
                                        Exame concluído com sucesso! Você ganhou {(evalScore || 0) * 20} XP extras.
                                        Seu professor já pode visualizar seu desempenho.
                                    </div>

                                    <button
                                        onClick={resetQuiz}
                                        className="px-8 py-4 bg-slate-900 text-white rounded-xl font-black uppercase text-xs tracking-widest hover:bg-black transition-all"
                                    >
                                        Fechar
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
