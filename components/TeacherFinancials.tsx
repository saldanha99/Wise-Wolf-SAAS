
import React, { useState, useEffect } from 'react';
import { MOCK_ACCOUNTS, MOCK_TENANTS, LESSON_RATE } from '../constants';
import {
    DollarSign,
    Calendar,
    FileText,
    AlertCircle,
    CheckCircle2,
    TrendingUp,
    Download,
    Search,
    ArrowRight,
    ClipboardCheck,
    MessageSquare
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User } from '../types';

interface TeacherFinancialsProps {
    user: User;
    tenantId?: string;
    viewOnly?: boolean;
}

const TeacherFinancials: React.FC<TeacherFinancialsProps> = ({ user, tenantId, viewOnly = false }) => {
    const [loading, setLoading] = useState(true);
    const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().slice(0, 7));
    const [lessons, setLessons] = useState<any[]>([]);
    const [closing, setClosing] = useState<any>(null); // { status, admin_notes, id, total_value }
    const [isContesting, setIsContesting] = useState(false);
    const [contestReason, setContestReason] = useState('');
    const [isConfirming, setIsConfirming] = useState(false);

    useEffect(() => {
        fetchFinancials();
    }, [user.id, selectedMonth, tenantId]);

    const fetchFinancials = async () => {
        setLoading(true);
        try {
            const start = `${selectedMonth}-01`;
            // Calculate end as first day of next month
            const nextMonth = new Date(selectedMonth + '-02');
            nextMonth.setMonth(nextMonth.getMonth() + 1);
            const end = nextMonth.toISOString().slice(0, 10);

            // 1. Fetch Lessons
            const { data: logs, error: logsError } = await supabase
                .from('class_logs')
                .select(`
                    id, 
                    created_at, 
                    class_date, 
                    presence, 
                    subtype, 
                    student:profiles!class_logs_student_id_fkey(full_name)
                 `)
                .eq('teacher_id', user.id)
                .gte('class_date', start)
                .lt('class_date', end)
                .order('class_date', { ascending: true });

            if (logsError) throw logsError;
            setLessons(logs || []);

            // 2. Fetch Closing Status (Using new schema)
            const { data: closingData, error: closingError } = await supabase
                .from('teacher_closings')
                .select('*')
                .eq('teacher_id', user.id)
                // We check if period_start matches selected month
                .eq('period_start', start)
                .maybeSingle();

            if (closingError) console.error("Error fetching closing", closingError);
            setClosing(closingData);

        } catch (error) {
            console.error(error);
        } finally {
            setLoading(false);
        }
    };

    const isLessonPaid = (log: any) => {
        // Regra de pagamento ao professor:
        // - TEACHER_ABSENCE: professor faltou → não recebe
        // - REPOSIÇÃO: aluno faltou em aula anterior justificada (que já foi paga ao professor);
        //   a reposição é entrega da aula devida, não gera nova hora-aula
        // - Teste Oral: avaliação periódica, fora do cômputo de hora-aula regular
        // - FALTA do aluno (não-justificada): conta como aula paga (professor estava disponível)
        const isTeacherAbsence = log.presence === 'TEACHER_ABSENCE' || log.presence === 'Falta do Professor';
        const isReplacement = log.subtype === 'REPOSIÇÃO';
        const isOralTestOnly = log.subtype === 'Teste Oral';
        return !isTeacherAbsence && !isReplacement && !isOralTestOnly;
    };

    const canCloseMonth = () => {
        const today = new Date();
        const currentYear = today.getFullYear();
        const currentMonthIndex = today.getMonth(); // 0-11

        const [selYear, selMonth] = selectedMonth.split('-').map(Number);
        const selectedMonthIndex = selMonth - 1; // 0-11 (Adjust for 1-based string)

        // 1. Past Year -> True
        if (selYear < currentYear) return true;

        // 2. Future Year -> False
        if (selYear > currentYear) return false;

        // 3. Same Year: Compare Months
        if (selectedMonthIndex < currentMonthIndex) return true; // Past Month
        if (selectedMonthIndex > currentMonthIndex) return false; // Future Month

        // 4. Current Month: Only allow on Last Day
        const lastDayOfCurrentMonth = new Date(currentYear, currentMonthIndex + 1, 0).getDate();
        if (today.getDate() === lastDayOfCurrentMonth) return true;

        return false;
    };

    const handleConfirm = async () => {
        if (isConfirming) return;
        setIsConfirming(true);
        try {
            // New Logic: Use Cents and Snapshot
            const paidLessons = lessons.filter(isLessonPaid);
            const hourlyRate = user.hourlyRate || LESSON_RATE;

            if (!user.hourlyRate) {
                console.warn(`User has no hourlyRate defined. Using default: ${LESSON_RATE}`);
            }

            const totalCents = Math.round(paidLessons.length * hourlyRate * 100);
            const logIds = paidLessons.map(l => l.id);

            const { error } = await supabase.from('teacher_closings').upsert({
                teacher_id: user.id,
                tenant_id: tenantId,
                period_start: `${selectedMonth}-01`,
                period_end: new Date(new Date(selectedMonth + '-02').setMonth(new Date(selectedMonth + '-02').getMonth() + 1) - 1).toISOString().split('T')[0], // Last day of month
                total_lessons_count: paidLessons.length,
                total_amount_cents: totalCents,
                class_log_ids: logIds,
                status: 'CONFIRMED_TEACHER',
                notes_teacher: null, // Clear notes if confirming
                updated_at: new Date().toISOString()
            }, { onConflict: 'teacher_id, period_start' });

            if (error) throw error;
            await fetchFinancials();
            alert("Fechamento enviado com sucesso!");
        } catch (err: any) {
            alert("Erro ao confirmar: " + err.message);
        } finally {
            setIsConfirming(false);
        }
    };

    const handleContest = async () => {
        if (!contestReason) return;
        setIsConfirming(true);
        try {
            const paidLessons = lessons.filter(isLessonPaid);
            const totalCents = Math.round(paidLessons.length * (user.hourlyRate || LESSON_RATE) * 100);
            const logIds = paidLessons.map(l => l.id);

            const { error } = await supabase.from('teacher_closings').upsert({
                teacher_id: user.id,
                tenant_id: tenantId,
                period_start: `${selectedMonth}-01`,
                period_end: new Date(new Date(selectedMonth + '-02').setMonth(new Date(selectedMonth + '-02').getMonth() + 1) - 1).toISOString().split('T')[0],
                total_lessons_count: paidLessons.length,
                total_amount_cents: totalCents,
                class_log_ids: logIds,
                status: 'DISPUTED',
                notes_teacher: contestReason,
                updated_at: new Date().toISOString()
            }, { onConflict: 'teacher_id, period_start' });

            if (error) throw error;
            setIsContesting(false);
            setContestReason('');
            await fetchFinancials();
            alert("Contestação enviada.");
        } catch (err: any) {
            alert("Erro: " + err.message);
        } finally {
            setIsConfirming(false);
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Month Selector code ... */}
            <div className="flex justify-between items-center bg-white dark:bg-slate-900 p-6 rounded-[2rem] border border-slate-100 dark:border-slate-800 shadow-sm">
                <div>
                    <h2 className="text-2xl font-black text-slate-800 dark:text-white tracking-tight">Financeiro</h2>
                    <p className="text-slate-500 dark:text-slate-400 text-sm font-medium">Gerencie seus ganhos e fechamentos.</p>
                </div>
                <div className="flex items-center gap-3">
                    <Calendar size={18} className="text-slate-400" />
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-slate-50 dark:bg-slate-800 border-none rounded-xl text-sm font-bold text-slate-700 dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none py-2 px-4"
                    />
                </div>
            </div>

            {/* Forecast Card */}
            <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[2.5rem] p-8 text-white shadow-xl shadow-indigo-500/20 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

                <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 bg-white/20 rounded-xl">
                            <TrendingUp size={24} className="text-white" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-widest opacity-80">Previsão de Ganhos ({new Date(selectedMonth + '-02').toLocaleDateString('pt-BR', { month: 'long' })})</span>
                    </div>

                    <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-black tracking-tight">
                            R$ {lessons.filter(isLessonPaid).reduce((acc, log) => acc + (user.hourlyRate || LESSON_RATE), 0).toFixed(2).replace('.', ',')}
                        </span>
                        <span className="text-sm font-medium opacity-70">acumulado</span>
                    </div>

                    <div className="mt-4 flex gap-4 text-xs font-medium opacity-80">
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-emerald-400" />
                            {lessons.filter(l => l.presence === 'COMPLETED').length} Aulas Realizadas
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full bg-orange-400" />
                            {lessons.filter(l => l.presence === 'STUDENT_ABSENCE').length} Faltas (Aluno)
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            {
                (!closing || closing.status === 'PENDING_TEACHER' || closing.status === 'PENDENTE') && !viewOnly && (
                    <div className={`${canCloseMonth() ? 'flex' : 'hidden'} bg-slate-900 p-8 rounded-[2.5rem] text-white flex-col md:flex-row justify-between items-center gap-6 relative overflow-hidden`}>
                        {/* Background Effect */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-tenant-primary/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

                        <div>
                            <h3 className="text-xl font-black tracking-tight relative z-10">
                                Finalizar Fechamento: R$ {lessons.filter(isLessonPaid).reduce((acc, log) => acc + (user.hourlyRate || LESSON_RATE), 0).toFixed(2).replace('.', ',')}
                            </h3>
                            <p className="text-slate-400 text-xs mt-1 relative z-10">
                                Referente a {new Date(selectedMonth + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}. Confirme se os valores estão corretos.
                            </p>
                        </div>
                        <div className="flex gap-4 relative z-10">
                            <button
                                onClick={() => setIsContesting(true)}
                                className="px-6 py-3 border border-slate-700 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-slate-800 transition-colors"
                            >
                                Contestar Valor
                            </button>
                            <button
                                onClick={handleConfirm}
                                className="px-8 py-3 bg-tenant-primary text-white rounded-xl font-black text-xs uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-xl shadow-tenant-primary/20 flex items-center gap-2"
                            >
                                <ClipboardCheck size={16} /> Confirmar e Fechar
                            </button>
                        </div>
                    </div>
                )
            }

            {/* Rejection Action Bar */}
            {
                closing?.status === 'REJEITADO' && (
                    <div className="bg-red-50 dark:bg-red-900/10 border border-red-100 dark:border-red-900/30 p-8 rounded-[2.5rem] flex flex-col md:flex-row justify-between items-center gap-6 relative overflow-hidden">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-red-500/5 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

                        <div className="relative z-10">
                            <div className="flex items-center gap-3 mb-2">
                                <div className="p-2 bg-red-100 dark:bg-red-900/20 text-red-600 rounded-xl">
                                    <AlertCircle size={20} />
                                </div>
                                <span className="text-xs font-black text-red-500 uppercase tracking-widest">Fechamento Rejeitado</span>
                            </div>
                            <h3 className="text-xl font-black text-slate-800 dark:text-white tracking-tight">Atenção: Seu fechamento foi recusado.</h3>
                            {closing.admin_notes && (
                                <p className="text-slate-600 dark:text-slate-300 text-sm mt-2 max-w-xl bg-white dark:bg-slate-900 p-4 rounded-xl border border-red-100 dark:border-red-900/20 italic">
                                    " {closing.admin_notes} "
                                </p>
                            )}
                            <p className="text-slate-500 dark:text-slate-400 text-xs mt-2 font-medium">Verifique as observações e conteste novamente ou fale com o suporte.</p>
                        </div>

                        <div className="flex gap-4 relative z-10">
                            <button
                                onClick={() => window.open(`https://wa.me/5511999999999?text=Ol%C3%A1%2C%20gostaria%20de%20falar%20sobre%20meu%20fechamento%20de%20${selectedMonth}`, '_blank')}
                                className="px-6 py-3 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
                            >
                                Falar com Suporte
                            </button>
                            <button
                                onClick={() => setIsContesting(true)}
                                className="px-6 py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase tracking-widest hover:bg-red-600 transition-colors shadow-lg shadow-red-500/20 flex items-center gap-2"
                            >
                                <MessageSquare size={16} /> Contestar Novamente
                            </button>
                        </div>
                    </div>
                )
            }

            {/* Contest Modal */}
            {
                isContesting && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
                        <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] w-full max-w-md border border-slate-200 dark:border-slate-800 shadow-2xl">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="p-2 bg-orange-100 dark:bg-orange-900/20 text-orange-600 rounded-xl">
                                    <MessageSquare size={20} />
                                </div>
                                <h3 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tight">Contestar Fechamento</h3>
                            </div>

                            <p className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mb-2">Motivo da Contestação</p>
                            <textarea
                                value={contestReason}
                                onChange={(e) => setContestReason(e.target.value)}
                                className="w-full h-32 p-4 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl text-sm font-medium outline-none focus:ring-2 focus:ring-orange-500 mb-6"
                                placeholder="Descreva aqui quais aulas estão faltando ou qual valor está incorreto..."
                            />

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setIsContesting(false)}
                                    className="flex-1 py-3 text-slate-500 font-bold text-xs uppercase tracking-widest"
                                >
                                    Cancelar
                                </button>
                                <button
                                    onClick={handleContest}
                                    className="flex-1 py-3 bg-orange-500 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-orange-500/20"
                                >
                                    Enviar Contestação
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Lesson List */}
            <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 overflow-hidden shadow-sm">
                <div className="p-8 border-b border-slate-50 dark:border-slate-800 flex justify-between items-center">
                    <h3 className="font-black text-slate-800 dark:text-white text-xs uppercase tracking-widest">Extrato de Aulas</h3>
                    <button className="p-2 bg-slate-50 dark:bg-slate-800 rounded-lg text-slate-400 hover:text-tenant-primary transition-colors">
                        <Download size={18} />
                    </button>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full">
                        <thead>
                            <tr className="bg-slate-50/50 dark:bg-slate-800/30">
                                <th className="px-8 py-4 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Data</th>
                                <th className="px-8 py-4 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Aluno</th>
                                <th className="px-8 py-4 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Status</th>
                                <th className="px-8 py-4 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Valor</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                            {lessons.map((log) => (
                                <tr key={log.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/50 transition-colors">
                                    <td className="px-8 py-6 text-sm font-bold text-slate-800 dark:text-slate-300">
                                        {/* Use class_date if available, fallback to created_at */}
                                        {new Date(log.class_date || log.created_at).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className="text-sm font-black text-slate-800 dark:text-slate-100 uppercase">{log.student?.full_name}</span>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className={`inline-block px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${(log.presence === 'TEACHER_ABSENCE' || log.presence === 'Falta do Professor' || log.presence === 'EXPIRED') ? 'bg-red-50 dark:bg-red-900/20 text-red-600' :
                                            log.subtype === 'REPOSIÇÃO' ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-600' :
                                                (log.presence === 'STUDENT_ABSENCE' || log.presence === 'Falta') ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-600' :
                                                    log.presence === 'Falta Justificada' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' :
                                                        'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600'
                                            }`}>
                                            {log.subtype === 'REPOSIÇÃO' ? 'Reposição' :
                                                log.presence === 'COMPLETED' ? 'Realizada' :
                                                    log.presence === 'STUDENT_ABSENCE' ? 'Falta Aluno' :
                                                        log.presence === 'TEACHER_ABSENCE' ? 'Falta Prof.' :
                                                            log.presence === 'EXPIRED' ? 'Expirada (Prazo)' :
                                                                log.presence}
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className={`text-sm font-black ${!isLessonPaid(log)
                                            ? 'text-slate-300 dark:text-slate-600 line-through'
                                            : 'text-emerald-600 dark:text-emerald-400'
                                            }`}>
                                            R$ {!isLessonPaid(log) ? '0,00' : (user.hourlyRate || LESSON_RATE).toFixed(2)}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                            {lessons.length === 0 && (
                                <tr>
                                    <td colSpan={4} className="px-8 py-20 text-center">
                                        <div className="flex flex-col items-center gap-3 text-slate-400">
                                            <FileText size={48} className="opacity-20" />
                                            <p className="text-sm font-bold uppercase tracking-widest">Nenhuma aula registrada neste mês.</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

export default TeacherFinancials;
