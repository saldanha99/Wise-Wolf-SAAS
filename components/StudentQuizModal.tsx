import React, { useState, useEffect } from 'react';
import { X, CheckCircle, AlertCircle, ChevronRight, Check } from 'lucide-react';
import { supabase } from '../lib/supabase';
import confetti from 'canvas-confetti';

interface StudentQuizModalProps {
    quizTag: string; // e.g., 'A1', 'B1'
    studentId: string;
    onClose: () => void;
}

const StudentQuizModal: React.FC<StudentQuizModalProps> = ({ quizTag, studentId, onClose }) => {
    const [step, setStep] = useState<'intro' | 'questions' | 'result'>('intro');
    const [loading, setLoading] = useState(true);
    const [questions, setQuestions] = useState<any[]>([]);
    const [answers, setAnswers] = useState<Record<string, number>>({});
    const [score, setScore] = useState(0);
    const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

    useEffect(() => {
        fetchQuiz();
    }, [quizTag]);

    const fetchQuiz = async () => {
        setLoading(true);
        try {
            // 1. Get the Quiz ID based on the tag (Assuming Title contains tag or we use a separate mapping)
            // For MVP, if we don't have real questions in DB, we mock them to verify the flow.
            // In production, we would query: .from('module_quizzes').select('*, quiz_questions(*)')...

            // Mocking for immediate feedback loop if DB is empty
            const mockQuestions = [
                { id: '1', question_text: `Challenge 1 (${quizTag}): Choose the correct sentence.`, options: ['I has a car', 'I have a car', 'I having car', 'Me have car'], correct_option_index: 1 },
                { id: '2', question_text: `Challenge 2 (${quizTag}): Complete: "She ___ to the park."`, options: ['go', 'going', 'goes', 'gone'], correct_option_index: 2 },
                { id: '3', question_text: `Challenge 3 (${quizTag}): What is the past of "Buy"?`, options: ['Buyed', 'Brought', 'Bought', 'Buying'], correct_option_index: 2 },
            ];

            setQuestions(mockQuestions);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    const handleOptionSelect = (qId: string, optIndex: number) => {
        setAnswers(prev => ({ ...prev, [qId]: optIndex }));
    };

    const handleNext = () => {
        if (currentQuestionIndex < questions.length - 1) {
            setCurrentQuestionIndex(prev => prev + 1);
        } else {
            calculateResult();
        }
    };

    const calculateResult = async () => {
        let correctCount = 0;
        questions.forEach(q => {
            if (answers[q.id] === q.correct_option_index) correctCount++;
        });

        const finalScore = Math.round((correctCount / questions.length) * 100);
        setScore(finalScore);
        setStep('result');

        if (finalScore >= 70) {
            confetti({
                particleCount: 200,
                spread: 70,
                origin: { y: 0.6 }
            });
            // TODO: Save to DB
            await supabase.from('student_quiz_attempts').insert({
                student_id: studentId,
                score: finalScore,
                quiz_id: null, // We need to link this properly later
                answers: answers
            });
        }
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in duration-300">
            <div className="w-full max-w-2xl bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center">
                    <div>
                        <h2 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tighter">Prova Final: {quizTag}</h2>
                        <p className="text-xs text-slate-500 font-bold">Wise Wolf School Assessment</p>
                    </div>
                    <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors">
                        <X size={20} className="text-slate-500" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-8 overflow-y-auto custom-scrollbar">

                    {step === 'intro' && (
                        <div className="text-center py-10">
                            <div className="w-20 h-20 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 rounded-full flex items-center justify-center mx-auto mb-6">
                                <AlertCircle size={40} />
                            </div>
                            <h3 className="text-2xl font-black mb-4 dark:text-white">Instruções</h3>
                            <p className="text-slate-500 mb-8 max-w-md mx-auto">
                                Esta prova contém {questions.length} questões. Você precisa de 70% de acerto para ser aprovado e avançar de nível.
                                <br /><br />
                                <b>Importante:</b> Ao iniciar, não feche a janela.
                            </p>
                            <button onClick={() => setStep('questions')} className="px-8 py-4 bg-tenant-primary text-white rounded-xl font-black uppercase tracking-widest hover:scale-105 transition-transform shadow-lg shadow-indigo-500/20">
                                COMEÇAR AGORA
                            </button>
                        </div>
                    )}

                    {step === 'questions' && questions.length > 0 && (
                        <div className="max-w-xl mx-auto">
                            <div className="mb-6 flex justify-between items-center text-xs font-black uppercase text-slate-400 tracking-widest">
                                <span>Questão {currentQuestionIndex + 1} de {questions.length}</span>
                                <span>Progresso: {Math.round(((currentQuestionIndex) / questions.length) * 100)}%</span>
                            </div>

                            {/* Progress Bar */}
                            <div className="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full mb-8 overflow-hidden">
                                <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${((currentQuestionIndex) / questions.length) * 100}%` }} />
                            </div>

                            <h3 className="text-xl font-bold text-slate-800 dark:text-white mb-6 leading-relaxed">
                                {questions[currentQuestionIndex].question_text}
                            </h3>

                            <div className="space-y-3 mb-8">
                                {questions[currentQuestionIndex].options.map((opt: string, idx: number) => {
                                    const isSelected = answers[questions[currentQuestionIndex].id] === idx;
                                    return (
                                        <button
                                            key={idx}
                                            onClick={() => handleOptionSelect(questions[currentQuestionIndex].id, idx)}
                                            className={`w-full p-4 rounded-xl text-left font-medium text-sm transition-all border-2 ${isSelected
                                                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-300'
                                                    : 'border-slate-100 dark:border-slate-800 hover:border-indigo-200 dark:hover:border-slate-700 text-slate-600 dark:text-slate-400'
                                                }`}
                                        >
                                            <span className="mr-3 font-black opacity-30">{String.fromCharCode(65 + idx)}.</span> {opt}
                                        </button>
                                    );
                                })}
                            </div>

                            <div className="flex justify-end">
                                <button
                                    onClick={handleNext}
                                    disabled={answers[questions[currentQuestionIndex].id] === undefined}
                                    className="flex items-center gap-2 px-8 py-3 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-xl font-black uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed hover:scale-105 transition-transform"
                                >
                                    {currentQuestionIndex === questions.length - 1 ? 'FINALIZAR PROVA' : 'PRÓXIMA'} <ChevronRight size={16} />
                                </button>
                            </div>
                        </div>
                    )}

                    {step === 'result' && (
                        <div className="text-center py-10">
                            <div className={`w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 ${score >= 70 ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                                {score >= 70 ? <CheckCircle size={48} /> : <X size={48} />}
                            </div>
                            <h3 className="text-4xl font-black mb-2 dark:text-white">{score}%</h3>
                            <p className="text-lg font-bold text-slate-700 dark:text-slate-300 mb-8">
                                {score >= 70 ? 'Parabéns! Você foi aprovado.' : 'Não foi dessa vez. Continue estudando!'}
                            </p>

                            <button onClick={onClose} className="px-8 py-3 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl font-black uppercase tracking-widest hover:bg-slate-300 transition-colors">
                                FECHAR
                            </button>
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
};

export default StudentQuizModal;
