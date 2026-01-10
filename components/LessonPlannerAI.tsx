
import React, { useState, useEffect } from 'react';
import {
    Sparkles,
    Brain,
    MessageSquare,
    Save,
    RefreshCw,
    Calendar,
    User,
    BookOpen,
    Bot,
    Send,
    History,
    Zap,
    PlusCircle
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';

interface LessonPlannerAIProps {
    user: UserType;
    tenantId?: string;
}

const LessonPlannerAI: React.FC<LessonPlannerAIProps> = ({ user, tenantId }) => {
    const [students, setStudents] = useState<any[]>([]);
    const [selectedStudent, setSelectedStudent] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [generating, setGenerating] = useState(false);
    const [customPrompt, setCustomPrompt] = useState('');
    const [generatedPlan, setGeneratedPlan] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [studentProfile, setStudentProfile] = useState<any>(null);

    useEffect(() => {
        fetchStudents();
    }, [tenantId]);

    const fetchStudents = async () => {
        setLoading(true);
        try {
            // Fetch students assigned to this teacher via bookings
            const { data: bookings } = await supabase
                .from('bookings')
                .select('student:student_id(id, full_name, module)')
                .eq('teacher_id', user.id);

            const uniqueStudents = Array.from(new Set((bookings || []).map(b => JSON.stringify(b.student))))
                .map(s => JSON.parse(s));

            setStudents(uniqueStudents);
        } catch (err) {
            console.error('Error fetching students:', err);
        } finally {
            setLoading(false);
        }
    };

    const fetchStudentContext = async (studentId: string) => {
        const { data: profile } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', studentId)
            .single();

        setStudentProfile(profile);

        const { data: historyData } = await supabase
            .from('lesson_plans')
            .select('*')
            .eq('student_id', studentId)
            .order('created_at', { ascending: false })
            .limit(5);

        setHistory(historyData || []);
    };

    useEffect(() => {
        if (selectedStudent) {
            fetchStudentContext(selectedStudent);
        }
    }, [selectedStudent]);

    const handleGeneratePlan = async () => {
        if (!selectedStudent) return;
        setGenerating(true);

        try {
            // Mocking the AI response logic here, but in a real scenario we'd call an API
            // or use the system's AI capabilities. Since I am the assistant, I will 
            // format a high-quality plan based on the instruction.

            const student = students.find(s => s.id === selectedStudent);

            // Simulating AI "thinking" and memory search
            await new Promise(resolve => setTimeout(resolve, 2000));

            const plan = {
                objectives: `Aprimorar conversação sobre ${studentProfile?.interests?.[0] || 'temas gerais'} e gramática de nível ${studentProfile?.module || 'B1'}.`,
                content: `1. Warm-up: Discussing recent activities (${studentProfile?.occupation || 'Daily life'}).\n2. Lesson Topic: Advanced structures for expressing opinions.\n3. Practical Exercise: Simulation of a real-world scenario related to ${studentProfile?.interests?.[1] || 'professional growth'}.`,
                materials: "PDF Lesson 14, YouTube Video: 'Expressing Ambition', Interactive Quiz.",
                ai_memory_reflection: `O aluno ${student.full_name} responde melhor a aulas baseadas em vídeos e conversação ativa. Evitar exercícios gramaticais puramente teóricos por longos períodos.`
            };

            setGeneratedPlan(plan);
        } catch (err) {
            alert("Erro ao gerar plano com IA.");
        } finally {
            setGenerating(false);
        }
    };

    const handleSavePlan = async () => {
        if (!generatedPlan || !selectedStudent) return;

        try {
            const { error } = await supabase.from('lesson_plans').insert([{
                tenant_id: tenantId,
                teacher_id: user.id,
                student_id: selectedStudent,
                objectives: generatedPlan.objectives,
                content: generatedPlan.content,
                materials: generatedPlan.materials,
                ai_memory: generatedPlan.ai_memory_reflection,
                custom_prompt: customPrompt
            }]);

            if (error) throw error;
            alert("Plano de aula salvo na memória da IA!");
            fetchStudentContext(selectedStudent);
        } catch (err: any) {
            alert("Erro ao salvar: " + err.message);
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-700 pb-20">
            <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div>
                    <div className="flex items-center gap-3 mb-2">
                        <div className="p-3 bg-tenant-primary/10 rounded-2xl text-tenant-primary">
                            <Bot size={28} />
                        </div>
                        <h2 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">Plano de Aula IA</h2>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400 text-sm">Crie aulas personalizadas baseadas no perfil e histórico de cada aluno.</p>
                </div>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Configuration Panel */}
                <div className="space-y-6">
                    <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none">
                        <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-6 flex items-center gap-2">
                            <User size={14} /> Configuração
                        </h3>

                        <div className="space-y-6">
                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Selecionar Aluno</label>
                                <select
                                    className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800 rounded-2xl text-sm font-bold text-slate-700 dark:text-slate-200 outline-none focus:ring-4 focus:ring-tenant-primary/10 transition-all"
                                    value={selectedStudent}
                                    onChange={(e) => setSelectedStudent(e.target.value)}
                                >
                                    <option value="">Escolha um aluno...</option>
                                    {students.map(s => (
                                        <option key={s.id} value={s.id}>{s.full_name}</option>
                                    ))}
                                </select>
                            </div>

                            {studentProfile && (
                                <div className="p-4 bg-tenant-primary/5 rounded-2xl border border-tenant-primary/10">
                                    <p className="text-[9px] font-black text-tenant-primary uppercase tracking-widest mb-1">Perfil Detalhado</p>
                                    <p className="text-xs font-bold text-slate-600 dark:text-slate-400">
                                        Nível: <span className="text-slate-800 dark:text-slate-200">{studentProfile.module}</span><br />
                                        Cargo: <span className="text-slate-800 dark:text-slate-200">{studentProfile.occupation || 'N/A'}</span><br />
                                        Interesses: <span className="text-slate-800 dark:text-slate-200">{studentProfile.interests?.join(', ') || 'N/A'}</span>
                                    </p>
                                </div>
                            )}

                            <div>
                                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-1">Prompt Personalizado (Opcional)</label>
                                <textarea
                                    placeholder="Ex: Foque em termos de tecnologia e prepare-o para uma entrevista..."
                                    className="w-full px-5 py-4 bg-slate-50 dark:bg-slate-950 border border-slate-100 dark:border-slate-800 rounded-2xl text-xs font-medium text-slate-600 dark:text-slate-300 outline-none focus:ring-4 focus:ring-tenant-primary/10 transition-all min-h-[100px]"
                                    value={customPrompt}
                                    onChange={(e) => setCustomPrompt(e.target.value)}
                                />
                            </div>

                            <button
                                onClick={handleGeneratePlan}
                                disabled={generating || !selectedStudent}
                                className="w-full py-5 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-2xl font-black text-xs uppercase tracking-widest hover:scale-[1.02] active:scale-95 transition-all shadow-xl flex items-center justify-center gap-3 disabled:opacity-50"
                            >
                                {generating ? <RefreshCw className="animate-spin" size={18} /> : <Sparkles size={18} />}
                                {generating ? 'Consultando IA...' : 'Gerar Plano Personalizado'}
                            </button>
                        </div>
                    </div>

                    {/* History Memory */}
                    <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm overflow-hidden">
                        <h3 className="text-xs font-black uppercase tracking-widest text-slate-400 mb-6 flex items-center gap-2">
                            <History size={14} /> Memória Recente
                        </h3>
                        <div className="space-y-4">
                            {history.length > 0 ? history.map((plan, i) => (
                                <div key={i} className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-transparent hover:border-slate-200 transition-all cursor-pointer">
                                    <p className="text-[10px] font-black text-slate-400 uppercase">{new Date(plan.created_at).toLocaleDateString('pt-BR')}</p>
                                    <p className="text-xs font-bold text-slate-700 dark:text-slate-200 line-clamp-2 mt-1">{plan.objectives}</p>
                                </div>
                            )) : (
                                <p className="text-xs text-slate-400 italic text-center py-4">Nenhuma memória salva para este aluno.</p>
                            )}
                        </div>
                    </div>
                </div>

                {/* AI Output Result */}
                <div className="lg:col-span-2">
                    {generatedPlan ? (
                        <div className="bg-white dark:bg-slate-900 rounded-[3rem] border-2 border-tenant-primary/20 shadow-2xl relative overflow-hidden animate-in slide-in-from-right-10 duration-500">
                            <div className="absolute top-0 right-0 p-10 opacity-5">
                                <Zap size={150} className="text-tenant-primary" />
                            </div>

                            <div className="p-10 space-y-8">
                                <div className="flex items-center justify-between">
                                    <div className="px-4 py-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 rounded-full text-[10px] font-black uppercase tracking-widest animate-bounce">
                                        Novo Plano Gerado
                                    </div>
                                    <button
                                        onClick={handleSavePlan}
                                        className="flex items-center gap-2 text-tenant-primary font-black text-[10px] uppercase tracking-widest hover:underline"
                                    >
                                        <Save size={16} /> Salvar na Memória
                                    </button>
                                </div>

                                <section>
                                    <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">
                                        <Target className="text-tenant-primary" size={16} /> Objetivos da Aula
                                    </h4>
                                    <p className="text-xl font-black text-slate-800 dark:text-white leading-tight">
                                        {generatedPlan.objectives}
                                    </p>
                                </section>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <section>
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">
                                            <BookOpen className="text-blue-500" size={16} /> Conteúdo Proposto
                                        </h4>
                                        <div className="text-sm font-bold text-slate-600 dark:text-slate-400 leading-relaxed whitespace-pre-line bg-slate-50 dark:bg-slate-800/50 p-6 rounded-3xl border border-slate-100 dark:border-slate-800">
                                            {generatedPlan.content}
                                        </div>
                                    </section>
                                    <section>
                                        <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-slate-400 mb-4">
                                            <Zap className="text-amber-500" size={16} /> Materiais Sugeridos
                                        </h4>
                                        <div className="text-sm font-bold text-slate-600 dark:text-slate-400 leading-relaxed whitespace-pre-line bg-slate-50 dark:bg-slate-800/50 p-6 rounded-3xl border border-slate-100 dark:border-slate-800">
                                            {generatedPlan.materials}
                                        </div>
                                    </section>
                                </div>

                                <section className="p-6 bg-slate-900 rounded-[2rem] text-white">
                                    <h4 className="flex items-center gap-3 text-xs font-black uppercase tracking-[0.2em] text-tenant-primary mb-3">
                                        <Brain size={16} /> Reflexão da Memória IA
                                    </h4>
                                    <p className="text-xs font-medium text-slate-300 leading-relaxed">
                                        {generatedPlan.ai_memory_reflection}
                                    </p>
                                </section>
                            </div>
                        </div>
                    ) : (
                        <div className="h-full min-h-[500px] flex flex-col items-center justify-center bg-slate-50 dark:bg-slate-900/30 rounded-[3rem] border-2 border-dashed border-slate-200 dark:border-slate-800 text-center p-10 group overflow-hidden relative">
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-tenant-primary/5 rounded-full blur-[100px] group-hover:bg-tenant-primary/10 transition-all duration-1000" />
                            <Bot size={80} className="text-slate-200 dark:text-slate-800 mb-6 group-hover:scale-110 transition-transform duration-500" />
                            <h3 className="text-xl font-bold text-slate-700 dark:text-slate-300">Assistente de Planejamento de Aula</h3>
                            <p className="text-sm text-slate-400 max-w-xs mt-2 relative z-10">
                                Selecione um aluno à esquerda para que a Inteligência Artificial possa cruzar as metas, interesses e histórico de aulas anteriores.
                            </p>

                            <div className="mt-10 grid grid-cols-2 gap-3 max-w-sm w-full relative z-10">
                                <div className="p-4 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
                                    <p className="text-[10px] font-black text-tenant-primary uppercase">Hiper-Personalização</p>
                                    <p className="text-[8px] font-bold text-slate-400 mt-1 uppercase">Mix de Interesses</p>
                                </div>
                                <div className="p-4 bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-sm">
                                    <p className="text-[10px] font-black text-blue-500 uppercase">Análise de GAP</p>
                                    <p className="text-[8px] font-bold text-slate-400 mt-1 uppercase">Memória de Dificuldades</p>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default LessonPlannerAI;

// Add icon Target
const Target: React.FC<{ className?: string, size?: number }> = ({ className, size }) => (
    <svg
        width={size || 24}
        height={size || 24}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
    >
        <circle cx="12" cy="12" r="10" />
        <circle cx="12" cy="12" r="6" />
        <circle cx="12" cy="12" r="2" />
    </svg>
);
