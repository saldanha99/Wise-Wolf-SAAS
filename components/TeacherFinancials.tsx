
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
    MessageSquare,
    FileDown
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User } from '../types';
import TeacherActivityReport from './TeacherActivityReport';

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
    const [showReport, setShowReport] = useState(false);
    // Rate real do professor (fonte da verdade = banco), evita cair no default R$8
    const [rate, setRate] = useState<number>(user.hourlyRate || LESSON_RATE);

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
                    payment_hold,
                    verification_status,
                    student:profiles!class_logs_student_id_fkey(full_name)
                 `)
                .eq('teacher_id', user.id)
                .gte('class_date', start)
                .lt('class_date', end)
                .order('class_date', { ascending: true });

            if (logsError) throw logsError;
            setLessons(logs || []);

            // hourly_rate via RPC (a coluna não é mais legível direto em profiles)
            const { data: myPay } = await supabase.rpc('get_my_pay');
            if ((myPay as any)?.hourly_rate) setRate(Number((myPay as any).hourly_rate));

            // 2. Fetch Closing Status (schema unificado — month_year)
            const { data: closingData, error: closingError } = await supabase
                .from('teacher_closings')
                .select('*')
                .eq('teacher_id', user.id)
                .eq('month_year', selectedMonth)
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
        // Aula em conflito de presença (aluno x professor) fica retida até o admin resolver
        const isOnHold = log.payment_hold === true;
        return !isTeacherAbsence && !isReplacement && !isOralTestOnly && !isOnHold;
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
            const paidLessons = lessons.filter(isLessonPaid);
            const totalAmount = paidLessons.length * rate;

            // Schema unificado (igual ao FinancialClosingModal e ao admin):
            // month_year / total_lessons / total_amount / teacher_confirmation_status
            const { error } = await supabase.from('teacher_closings').upsert({
                teacher_id: user.id,
                tenant_id: tenantId,
                month_year: selectedMonth,
                total_lessons: paidLessons.length,
                total_amount: totalAmount,
                status: 'PENDENTE',
                teacher_confirmation_status: 'OK',
                teacher_confirmation_date: new Date().toISOString(),
                teacher_notes: null,
                updated_at: new Date().toISOString()
            }, { onConflict: 'teacher_id, month_year' });

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
            const totalAmount = paidLessons.length * rate;

            const { error } = await supabase.from('teacher_closings').upsert({
                teacher_id: user.id,
                tenant_id: tenantId,
                month_year: selectedMonth,
                total_lessons: paidLessons.length,
                total_amount: totalAmount,
                status: 'PENDENTE',
                teacher_confirmation_status: 'CONTESTADO',
                teacher_confirmation_date: new Date().toISOString(),
                teacher_notes: contestReason,
                updated_at: new Date().toISOString()
            }, { onConflict: 'teacher_id, month_year' });

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
            <div className="flex justify-between items-center bg-brand-surface p-6 rounded-[2rem] border border-brand-border shadow-sm">
                <div>
                    <h2 className="text-2xl font-black text-brand-text tracking-tight">Financeiro</h2>
                    <p className="text-brand-muted text-sm font-medium">Gerencie seus ganhos e fechamentos.</p>
                </div>
                <div className="flex items-center gap-3">
                    <button onClick={() => setShowReport(true)} className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-tenant-primary/10 text-tenant-primary text-xs font-bold" title="Ver/baixar meu relatório de atividades (PDF)">
                        <FileDown size={14} /> Meu Relatório (PDF)
                    </button>
                    <Calendar size={18} className="text-brand-muted" />
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-brand-surface-2 border-none rounded-xl text-sm font-bold text-brand-text dark:text-slate-300 focus:ring-2 focus:ring-tenant-primary outline-none py-2 px-4"
                    />
                </div>
            </div>
            {showReport && <TeacherActivityReport teacherId={user.id} onClose={() => setShowReport(false)} />}

            {/* Forecast Card */}
            <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-[2.5rem] p-8 text-white shadow-xl shadow-indigo-500/20 relative overflow-hidden">
                <div className="absolute top-0 right-0 w-64 h-64 bg-brand-surface/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

                <div className="relative z-10">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="p-2 bg-brand-surface/20 rounded-xl">
                            <TrendingUp size={24} className="text-white" />
                        </div>
                        <span className="text-xs font-bold uppercase tracking-widest opacity-80">Previsão de Ganhos ({new Date(selectedMonth + '-02').toLocaleDateString('pt-BR', { month: 'long' })})</span>
                    </div>

                    <div className="flex items-baseline gap-2">
                        <span className="text-4xl font-black tracking-tight">
                            R$ {lessons.filter(isLessonPaid).reduce((acc, log) => acc + (rate), 0).toFixed(2).replace('.', ',')}
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
                    <div className={`${canCloseMonth() ? 'flex' : 'hidden'} bg-brand-surface p-8 rounded-[2.5rem] text-white flex-col md:flex-row justify-between items-center gap-6 relative overflow-hidden`}>
                        {/* Background Effect */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-tenant-primary/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

                        <div>
                            <h3 className="text-xl font-black tracking-tight relative z-10">
                                Finalizar Fechamento: R$ {lessons.filter(isLessonPaid).reduce((acc, log) => acc + (rate), 0).toFixed(2).replace('.', ',')}
                            </h3>
                            <p className="text-brand-muted text-xs mt-1 relative z-10">
                                Referente a {new Date(selectedMonth + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}. Confirme se os valores estão corretos.
                            </p>
                        </div>
                        <div className="flex gap-4 relative z-10">
                            <button
                                onClick={() => setIsContesting(true)}
                                className="px-6 py-3 border border-brand-border rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-brand-surface-2 transition-colors"
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
                            <h3 className="text-xl font-black text-brand-text tracking-tight">Atenção: Seu fechamento foi recusado.</h3>
                            {closing.admin_notes && (
                                <p className="text-brand-muted text-sm mt-2 max-w-xl bg-brand-surface p-4 rounded-xl border border-red-100 dark:border-red-900/20 italic">
                                    " {closing.admin_notes} "
                                </p>
                            )}
                            <p className="text-brand-muted text-xs mt-2 font-medium">Verifique as observações e conteste novamente ou fale com o suporte.</p>
                        </div>

                        <div className="flex gap-4 relative z-10">
                            <button
                                onClick={() => window.open(`https://wa.me/5511999999999?text=Ol%C3%A1%2C%20gostaria%20de%20falar%20sobre%20meu%20fechamento%20de%20${selectedMonth}`, '_blank')}
                                className="px-6 py-3 bg-brand-surface dark:bg-brand-surface-2 text-brand-text dark:text-slate-200 border border-brand-border rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-brand-surface-2 dark:hover:bg-slate-700 transition-colors"
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
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-brand-surface/60 backdrop-blur-sm">
                        <div className="bg-brand-surface p-6 sm:p-8 rounded-[2.5rem] w-full max-w-md border border-brand-border dark:border-brand-border shadow-2xl max-h-[90dvh] overflow-y-auto">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="p-2 bg-orange-100 dark:bg-orange-900/20 text-orange-600 rounded-xl">
                                    <MessageSquare size={20} />
                                </div>
                                <h3 className="text-xl font-black text-brand-text uppercase tracking-tight">Contestar Fechamento</h3>
                            </div>

                            <p className="text-xs text-brand-muted font-bold uppercase tracking-widest mb-2">Motivo da Contestação</p>
                            <textarea
                                value={contestReason}
                                onChange={(e) => setContestReason(e.target.value)}
                                className="w-full h-32 p-4 bg-brand-surface-2 dark:bg-slate-950 border border-brand-border dark:border-brand-border rounded-2xl text-sm font-medium outline-none focus:ring-2 focus:ring-orange-500 mb-6"
                                placeholder="Descreva aqui quais aulas estão faltando ou qual valor está incorreto..."
                            />

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setIsContesting(false)}
                                    className="flex-1 py-3 text-brand-muted font-bold text-xs uppercase tracking-widest"
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
            <div className="bg-brand-surface rounded-[2.5rem] border border-brand-border overflow-hidden shadow-sm">
                <div className="p-8 border-b border-slate-50 dark:border-brand-border flex justify-between items-center">
                    <h3 className="font-black text-brand-text text-xs uppercase tracking-widest">Extrato de Aulas</h3>
                    <button className="p-2 bg-brand-surface-2 rounded-lg text-brand-muted hover:text-tenant-primary transition-colors">
                        <Download size={18} />
                    </button>
                </div>

                <div className="overflow-x-auto">
                    <table className="w-full min-w-[500px]">
                        <thead>
                            <tr className="bg-brand-surface-2/50 dark:bg-brand-surface-2/30">
                                <th className="px-8 py-4 text-left text-[10px] font-black text-brand-muted uppercase tracking-widest">Data</th>
                                <th className="px-8 py-4 text-left text-[10px] font-black text-brand-muted uppercase tracking-widest">Aluno</th>
                                <th className="px-8 py-4 text-left text-[10px] font-black text-brand-muted uppercase tracking-widest">Status</th>
                                <th className="px-8 py-4 text-left text-[10px] font-black text-brand-muted uppercase tracking-widest">Valor</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                            {lessons.map((log) => (
                                <tr key={log.id} className="hover:bg-brand-surface-2/50 dark:hover:bg-brand-surface-2/50 transition-colors">
                                    <td className="px-8 py-6 text-sm font-bold text-brand-text dark:text-slate-300">
                                        {/* Use class_date if available, fallback to created_at */}
                                        {new Date(log.class_date || log.created_at).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className="text-sm font-black text-brand-text dark:text-slate-100 uppercase">{log.student?.full_name}</span>
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
                                            ? 'text-slate-300 dark:text-brand-muted line-through'
                                            : 'text-emerald-600 dark:text-emerald-400'
                                            }`}>
                                            R$ {!isLessonPaid(log) ? '0,00' : (rate).toFixed(2)}
                                        </span>
                                    </td>
                                </tr>
                            ))}
                            {lessons.length === 0 && (
                                <tr>
                                    <td colSpan={4} className="px-8 py-20 text-center">
                                        <div className="flex flex-col items-center gap-3 text-brand-muted">
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
