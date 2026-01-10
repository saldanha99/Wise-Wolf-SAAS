
import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { BookOpen, CheckCircle, Clock } from 'lucide-react';
import StudentQuizModal from './StudentQuizModal';

interface StudentPedagogicalViewProps {
    user: User;
    tenantId?: string;
}

const StudentPedagogicalView: React.FC<StudentPedagogicalViewProps> = ({ user, tenantId }) => {
    const [loading, setLoading] = useState(true);
    const [assignedMaterials, setAssignedMaterials] = useState<any[]>([]);
    const [unlockedTests, setUnlockedTests] = useState<string[]>([]);
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
                    <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-16 -mt-16 pointer-events-none" />

                    <h3 className="text-xl font-black mb-6 flex items-center gap-2 relative z-10">
                        <CheckCircle className="text-white" /> Avaliações Liberadas
                    </h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 relative z-10">
                        {unlockedTests.map(test => (
                            <div key={test} className="bg-white/20 backdrop-blur-sm border border-white/20 p-5 rounded-2xl flex items-center justify-between hover:bg-white/30 transition-all cursor-pointer">
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Prova Final</p>
                                    <h4 className="text-2xl font-black">{test}</h4>
                                </div>
                                <button
                                    onClick={() => setActiveQuiz(test)}
                                    className="px-4 py-2 bg-white text-indigo-600 rounded-xl text-xs font-black uppercase shadow-sm hover:scale-105 transition-transform"
                                >
                                    INICIAR
                                </button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* My Assignments Library */}
            <div className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 rounded-[2.5rem] p-8">
                <h3 className="text-xl font-black text-slate-800 dark:text-white mb-6 flex items-center gap-2">
                    <BookOpen className="text-indigo-500" /> Meus Materiais
                </h3>

                {assignedMaterials.length === 0 ? (
                    <div className="text-center py-12 border-2 border-dashed border-slate-100 dark:border-slate-800 rounded-2xl">
                        <BookOpen className="mx-auto text-slate-300 mb-2" size={32} />
                        <p className="text-slate-400 text-xs font-bold">Nenhum material atribuído pelo professor ainda.</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {assignedMaterials.map(m => (
                            <a href={m.file_url} target="_blank" rel="noreferrer" key={m.id || m.assignment_id} className="p-4 border border-slate-100 dark:border-slate-800 rounded-2xl hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:shadow-md transition-all flex items-center gap-4 group">
                                <div className={`w-12 h-12 rounded-xl flex items-center justify-center font-bold text-xs shadow-sm ${m.type === 'PDF' ? 'bg-red-100 text-red-600' :
                                        m.type === 'VIDEO' ? 'bg-blue-100 text-blue-600' : 'bg-green-100 text-green-600'
                                    }`}>
                                    {m.type}
                                </div>
                                <div>
                                    <h4 className="font-bold text-sm text-slate-800 dark:text-white group-hover:text-indigo-600 transition-colors line-clamp-1">{m.title}</h4>
                                    <span className="text-[10px] text-slate-400 uppercase font-bold">{m.level_tag || 'Geral'} • {new Date(m.assigned_at).toLocaleDateString()}</span>
                                </div>
                            </a>
                        ))}
                    </div>
                )}
            </div>

        </div>
    );
};

export default StudentPedagogicalView;
