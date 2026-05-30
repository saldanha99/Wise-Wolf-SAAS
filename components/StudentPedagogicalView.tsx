
import React, { useState, useEffect } from 'react';
import MaterialsLibrary from './MaterialsLibrary';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { BookOpen, CheckCircle, Clock, Zap } from 'lucide-react';
import StudentQuizModal from './StudentQuizModal';

interface StudentPedagogicalViewProps {
    user: User;
    tenantId?: string;
}

const StudentPedagogicalView: React.FC<StudentPedagogicalViewProps> = ({ user, tenantId }) => {
    const [loading, setLoading] = useState(true);
    const [assignedMaterials, setAssignedMaterials] = useState<any[]>([]);
    const [unlockedTests, setUnlockedTests] = useState<string[]>([]);
    const [wolfieSessions, setWolfieSessions] = useState<any[]>([]);
    const [activeQuiz, setActiveQuiz] = useState<string | null>(null);

    useEffect(() => {
        if (user && tenantId) {
            fetchStudentPedagogicalData();
        }
    }, [user, tenantId]);

    const fetchStudentPedagogicalData = async () => {
        setLoading(true);
        try {
            // 1. Fetch Assigned Materials
            const { data: assignments, error: assignError } = await supabase
                .from('student_assignments')
                .select('*, material:material_id(*)')
                .eq('student_id', user.id)
                .order('assigned_at', { ascending: false });

            if (assignError) console.error('Error fetching assignments:', assignError);

            if (assignments) {
                const clean = assignments.map(a => ({
                    assignment_id: a.id,
                    ...a.material,
                    assigned_at: a.assigned_at
                }));
                setAssignedMaterials(clean);
            }

            // 2. Fetch Unlocked Tests
            const { data: profile } = await supabase
                .from('profiles')
                .select('unlocked_tests')
                .eq('id', user.id)
                .single();

            if (profile?.unlocked_tests) {
                setUnlockedTests(Array.isArray(profile.unlocked_tests) ? profile.unlocked_tests : []);
            }

            // 3. Fetch Wolfie History (Safe Fetch - table might not exist in dev yet)
            const { data: sessions, error: sessionError } = await supabase
                .from('wolfie_sessions')
                .select('*')
                .eq('student_id', user.id)
                .order('created_at', { ascending: false })
                .limit(5);

            if (!sessionError && sessions) {
                setWolfieSessions(sessions);
            }

        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-500">

            {activeQuiz && (
                <StudentQuizModal
                    quizTag={activeQuiz}
                    studentId={user.id}
                    onClose={() => setActiveQuiz(null)}
                />
            )}

            {/* Quizzes Section (If any unlocked) */}
            {unlockedTests.length > 0 && (
                <div className="bg-gradient-to-br from-indigo-500 to-indigo-700 dark:from-indigo-600 dark:to-indigo-900 rounded-[2.5rem] p-8 text-white shadow-lg relative overflow-hidden">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-brand-surface/10 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none" />

                    <h3 className="text-xl font-black mb-6 flex items-center gap-2 relative z-10">
                        <CheckCircle className="text-white" /> Avaliações Liberadas
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 relative z-10">
                        {unlockedTests.map(test => (
                            <div key={test} className="bg-brand-surface/20 backdrop-blur-sm border border-white/20 p-5 rounded-2xl flex items-center justify-between hover:bg-brand-surface/30 transition-all cursor-pointer">
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Prova Final</p>
                                    <h4 className="text-2xl font-black">{test}</h4>
                                </div>
                                <button
                                    onClick={() => setActiveQuiz(test)}
                                    className="px-4 py-2 bg-brand-surface text-indigo-600 rounded-xl text-xs font-black uppercase shadow-sm hover:scale-105 transition-transform"
                                >
                                    INICIAR
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Wolfie History Section */}
            <div className="bg-brand-surface border border-brand-border rounded-[2.5rem] p-8 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 via-indigo-500 to-purple-500" />

                <h3 className="text-xl font-black text-white mb-6 flex items-center gap-2">
                    <span className="p-2 bg-purple-500/20 rounded-lg text-purple-400">
                        <Zap size={20} />
                    </span>
                    Histórico do Tutor IA
                </h3>

                {/* Session List */}
                <div className="grid gap-4">
                    {/* Placeholder for now, simplified fetch logic below */}
                    <div className="p-4 bg-brand-surface-2/50 rounded-2xl border border-brand-border/50 flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-400 font-bold text-xs">
                                18/02
                            </div>
                            <div>
                                <h4 className="text-white font-bold text-sm">Conversation Practice</h4>
                                <p className="text-xs text-brand-muted">Duração: 5 min • 3 Correções</p>
                            </div>
                        </div>
                        <button className="text-xs font-bold text-indigo-400 hover:text-indigo-300 uppercase">
                            Ver Detalhes
                        </button>
                    </div>
                    <div className="p-8 text-center border border-dashed border-brand-border rounded-2xl">
                        <p className="text-brand-muted text-xs">Histórico completo em desenvolvimento (Backend conectado em breve).</p>
                    </div>
                </div>
            </div>

            {/* My Assignments Library */}
            <div className="bg-brand-surface border border-brand-border rounded-[2.5rem] p-8">
                <h3 className="text-xl font-black text-brand-text mb-6 flex items-center gap-2">
                    <BookOpen className="text-indigo-500" /> Meus Materiais
                </h3>

                <MaterialsLibrary
                    materials={assignedMaterials}
                    emptyText="Nenhum material atribuído pelo professor ainda."
                />
            </div>

        </div>
    );
};

export default StudentPedagogicalView;
