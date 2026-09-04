
import React, { useCallback, useEffect, useState } from 'react';
import MaterialsLibrary from './MaterialsLibrary';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import { AlertCircle, BookOpen, RefreshCw, Zap } from 'lucide-react';
import StudentMaterials from './StudentMaterials';

interface StudentPedagogicalViewProps {
    user: User;
    tenantId?: string;
}

const StudentPedagogicalView: React.FC<StudentPedagogicalViewProps> = ({ user }) => {
    const [loading, setLoading] = useState(true);
    const [assignedMaterials, setAssignedMaterials] = useState<any[]>([]);
    const [wolfieSessions, setWolfieSessions] = useState<any[]>([]);
    const [loadError, setLoadError] = useState('');

    const fetchStudentPedagogicalData = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        try {
            const [assignmentResult, sessionResult] = await Promise.all([
                supabase
                    .from('student_assignments')
                    .select('*, material:material_id(*)')
                    .eq('student_id', user.id)
                    .order('assigned_at', { ascending: false }),
                supabase
                    .from('wolfie_sessions')
                    .select('*')
                    .eq('student_id', user.id)
                    .order('created_at', { ascending: false })
                    .limit(5),
            ]);

            if (assignmentResult.error) throw assignmentResult.error;

            if (assignmentResult.data) {
                const clean = assignmentResult.data.map(a => ({
                    assignment_id: a.id,
                    ...a.material,
                    assigned_at: a.assigned_at
                }));
                setAssignedMaterials(clean);
            }

            // O histórico do Wolfie é complementar; uma indisponibilidade dele
            // não deve esconder os materiais nem a avaliação do aluno.
            if (!sessionResult.error && sessionResult.data) {
                setWolfieSessions(sessionResult.data);
            }
        } catch (err) {
            console.error('Student pedagogical data failed:', err);
            setLoadError('Não foi possível carregar seus materiais agora. Tente novamente.');
        } finally {
            setLoading(false);
        }
    }, [user.id]);

    useEffect(() => {
        if (user?.id) void fetchStudentPedagogicalData();
    }, [fetchStudentPedagogicalData, user?.id]);

    return (
        <div className="space-y-4 sm:space-y-8 animate-in fade-in duration-500">
            {/* Jornada e avaliação progressiva validadas no servidor. */}
            <StudentMaterials user={user} />

            {loadError && (
                <div role="alert" className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 sm:flex-row sm:items-center sm:justify-between dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-100">
                    <div className="flex items-start gap-3">
                        <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <p className="text-sm font-bold">{loadError}</p>
                    </div>
                    <button type="button" onClick={() => void fetchStudentPedagogicalData()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-xs font-black uppercase tracking-wider text-white hover:bg-amber-700">
                        <RefreshCw size={14} aria-hidden="true" /> Tentar novamente
                    </button>
                </div>
            )}

            {/* Wolfie History Section — só aparece se houver sessões reais */}
            {wolfieSessions.length > 0 && (
                <div className="bg-brand-surface border border-brand-border rounded-[2.5rem] p-5 sm:p-8 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 via-indigo-500 to-purple-500" />

                    <h3 className="text-xl font-black text-brand-text mb-6 flex items-center gap-2">
                        <span className="p-2 bg-purple-500/20 rounded-lg text-purple-400">
                            <Zap size={20} />
                        </span>
                        Histórico do Tutor IA
                    </h3>

                    <div className="grid gap-3">
                        {wolfieSessions.map(s => {
                            const d = new Date(s.created_at || s.started_at);
                            const dia = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
                            const mins = s.duration_seconds ? Math.max(1, Math.round(s.duration_seconds / 60)) : null;
                            return (
                                <div key={s.id} className="p-4 bg-brand-surface-2/50 rounded-2xl border border-brand-border/50 flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-4 min-w-0">
                                        <div className="w-11 h-11 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-400 font-bold text-xs shrink-0">
                                            {dia}
                                        </div>
                                        <div className="min-w-0">
                                            <h4 className="text-brand-text font-bold text-sm truncate">{s.topic || s.subtopic || 'Prática de Conversação'}</h4>
                                            <p className="text-xs text-brand-muted">
                                                {mins ? `${mins} min` : '—'}
                                                {s.turn_count ? ` • ${s.turn_count} interações` : ''}
                                                {s.student_level ? ` • ${s.student_level}` : ''}
                                            </p>
                                        </div>
                                    </div>
                                    {typeof s.overall_score === 'number' && (
                                        <div className="shrink-0 text-center">
                                            <p className="text-lg font-black text-indigo-500 leading-none">{s.overall_score}</p>
                                            <p className="text-[9px] font-bold text-brand-muted uppercase tracking-wider">score</p>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Biblioteca real: somente materiais atribuídos e existentes. */}
            <div className="bg-brand-surface border border-brand-border rounded-[2.5rem] p-5 sm:p-8">
                <div className="mb-6 flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-xl font-black text-brand-text flex items-center gap-2">
                            <BookOpen className="text-indigo-500" aria-hidden="true" /> Minha biblioteca
                        </h3>
                        <p className="mt-1 text-xs font-medium text-brand-muted">
                            Conteúdos selecionados e enviados pela sua equipe pedagógica.
                        </p>
                    </div>
                    {loading && <RefreshCw size={18} className="animate-spin text-indigo-500" aria-label="Carregando materiais" />}
                </div>

                {loadError ? (
                    <div className="rounded-2xl border border-dashed border-amber-200 bg-amber-50/70 px-5 py-8 text-center text-xs font-bold text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-100" role="status">
                        Não foi possível confirmar sua biblioteca. Use “Tentar novamente” acima para recarregar sem perder seu progresso.
                    </div>
                ) : (
                    <MaterialsLibrary
                        materials={assignedMaterials}
                        emptyText={loading ? 'Carregando seus materiais...' : 'Sua próxima recomendação aparecerá aqui assim que o professor enviar.'}
                    />
                )}
            </div>

        </div>
    );
};

export default StudentPedagogicalView;
