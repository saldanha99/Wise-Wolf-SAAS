import React, { useState, useEffect } from 'react';
import { X, CheckCircle2, AlertCircle, DollarSign, TrendingUp, MessageSquare } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User } from '../types';

interface FinancialClosingModalProps {
    user: User;
    tenantId?: string;
    month: string; // YYYY-MM
    onClose: () => void;
    onSuccess: () => void;
}

const FinancialClosingModal: React.FC<FinancialClosingModalProps> = ({ user, tenantId, month, onClose, onSuccess }) => {
    const [loading, setLoading] = useState(true);
    const [lessons, setLessons] = useState<any[]>([]);
    const [totalEarned, setTotalEarned] = useState(0);
    const [isContesting, setIsContesting] = useState(false);
    const [contestReason, setContestReason] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        fetchFinancialData();
    }, [user.id, month]);

    const fetchFinancialData = async () => {
        setLoading(true);
        try {
            const startOfMonth = `${month}-01T00:00:00Z`;
            const nextMonth = new Date(month);
            nextMonth.setMonth(nextMonth.getMonth() + 1);
            const endOfMonth = nextMonth.toISOString();

            // Fetch logs
            const { data: logs, error } = await supabase
                .from('class_logs')
                .select(`
          id, 
          created_at,
          class_date,
          presence,
          subtype,
          payment_hold
        `)
                .eq('teacher_id', user.id)
                .gte('class_date', startOfMonth)
                .lt('class_date', endOfMonth);

            if (error) throw error;

            // hourly_rate real via RPC (fonte da verdade; coluna não é mais legível
            // direto em profiles). get_tenant_teacher_pay retorna os profs do tenant p/ admin.
            const { data: payRows } = await supabase.rpc('get_tenant_teacher_pay');
            const teacherPay = (payRows as any[] || []).find((p: any) => p.id === user.id);
            const rate = Number(teacherPay?.hourly_rate) || user.hourlyRate || 8.00;

            // FIX: regra de pagamento idêntica à visão diária (isLessonPaid em TeacherFinancials).
            // Os enums reais são em INGLÊS (TEACHER_ABSENCE), não 'Falta do Professor' —
            // o filtro antigo nunca casava, então faltas do professor eram pagas indevidamente
            // e o fechamento divergia do que o professor via no dia a dia.
            const paidLessons = (logs || []).filter(l =>
                l.presence !== 'TEACHER_ABSENCE' &&
                l.presence !== 'Falta do Professor' &&
                l.subtype !== 'REPOSIÇÃO' &&
                l.subtype !== 'Teste Oral' &&
                // Aula com presença em conflito (aluno x professor) fica retida até o admin resolver
                l.payment_hold !== true
            );

            // Fetch Paid Trainings (Ao Vivo / Meet)
            const { data: completedTrainings } = await supabase
                .from('training_assignments')
                .select(`
                  status,
                  completed_at,
                  module:module_id(resource_type)
                `)
                .eq('teacher_id', user.id)
                .eq('status', 'COMPLETED')
                .gte('completed_at', startOfMonth)
                .lt('completed_at', endOfMonth);

            const paidTrainings = (completedTrainings || []).filter(t => 
                (t.module as any)?.resource_type === 'meet'
            );

            const combinedItems = [...paidLessons, ...paidTrainings];

            setLessons(combinedItems);
            setTotalEarned(combinedItems.length * rate);

        } catch (err) {
            console.error('Error fetching modal data:', err);
        } finally {
            setLoading(false);
        }
    };

    const handleConfirm = async () => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            const { error } = await supabase
                .from('teacher_closings')
                .upsert({
                    teacher_id: user.id,
                    tenant_id: tenantId,
                    month_year: month,
                    total_lessons: lessons.length,
                    total_amount: totalEarned,
                    status: 'PENDENTE', // Still pending admin approval
                    teacher_confirmation_status: 'OK',
                    teacher_confirmation_date: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'teacher_id, month_year' });

            if (error) throw error;
            alert('Fechamento confirmado com sucesso!');
            onSuccess();
            onClose();
        } catch (err) {
            alert('Erro ao confirmar fechamento.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleContest = async () => {
        if (!contestReason.trim() || isSubmitting) return;
        setIsSubmitting(true);
        try {
            const { error } = await supabase
                .from('teacher_closings')
                .upsert({
                    teacher_id: user.id,
                    tenant_id: tenantId,
                    month_year: month,
                    total_lessons: lessons.length,
                    total_amount: totalEarned,
                    status: 'PENDENTE', // Keep pending until resolved
                    teacher_confirmation_status: 'CONTESTADO',
                    teacher_confirmation_date: new Date().toISOString(),
                    teacher_notes: contestReason,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'teacher_id, month_year' });

            if (error) throw error;
            alert('Contestação enviada com sucesso.');
            onSuccess();
            onClose();
        } catch (err: any) {
            alert('Erro ao enviar contestação: ' + err.message);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (loading) return null;

    const monthName = new Date(month + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-brand-surface/80 backdrop-blur-sm animate-in fade-in duration-300">
            <div className="bg-brand-surface p-6 sm:p-8 rounded-[2.5rem] w-full max-w-lg border border-brand-border dark:border-brand-border shadow-2xl relative max-h-[90dvh] overflow-y-auto">

                {/* Background blobs */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-tenant-primary/5 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

                <div className="relative z-10">
                    {!isContesting ? (
                        <>
                            <div className="flex justify-between items-start mb-6">
                                <div>
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="px-3 py-1 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded-full text-[10px] font-black uppercase tracking-widest border border-yellow-200 dark:border-yellow-800">Ação Necessária</span>
                                    </div>
                                    <h3 className="text-2xl font-black text-brand-text tracking-tight">Fechamento Mensal</h3>
                                    <p className="text-brand-muted text-sm mt-1 font-medium">Confirme seus ganhos de <span className="text-tenant-primary capitalize font-bold">{monthName}</span>.</p>
                                </div>
                            </div>

                            <div className="bg-brand-surface-2/50 p-6 rounded-[2rem] border border-brand-border mb-8">
                                <div className="flex justify-between items-center mb-4">
                                    <p className="text-xs font-black text-brand-muted uppercase tracking-widest">Total Acumulado</p>
                                    <div className="flex items-center gap-1 text-emerald-500 text-xs font-black uppercase tracking-widest bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1 rounded-lg">
                                        <TrendingUp size={12} /> {lessons.length} Aulas
                                    </div>
                                </div>
                                <p className="text-4xl font-black text-brand-text tracking-tighter">R$ {totalEarned.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                            </div>

                            <div className="flex flex-col gap-3">
                                <button
                                    onClick={handleConfirm}
                                    disabled={isSubmitting}
                                    className="w-full py-4 bg-tenant-primary text-white rounded-xl font-black text-sm uppercase tracking-widest hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-tenant-primary/20 flex items-center justify-center gap-2"
                                >
                                    <CheckCircle2 size={18} /> Confirmar e Autorizar
                                </button>
                                <div className="flex gap-3">
                                    <button
                                        onClick={() => setIsContesting(true)}
                                        className="flex-1 py-3 bg-red-50 dark:bg-red-900/10 text-red-600 dark:text-red-400 border border-red-100 dark:border-red-900/30 rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-red-100 dark:hover:bg-red-900/20 transition-colors"
                                    >
                                        Contestar Valor
                                    </button>
                                    <button
                                        onClick={onClose}
                                        className="px-6 py-3 text-brand-muted font-bold text-xs uppercase tracking-widest hover:text-brand-muted dark:hover:text-slate-200 transition-colors"
                                    >
                                        Fechar
                                    </button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="flex items-center gap-3 mb-6">
                                <button onClick={() => setIsContesting(false)} className="p-2 -ml-2 hover:bg-brand-surface-2 dark:hover:bg-brand-surface-2 rounded-full transition-colors">
                                    <X size={20} className="text-brand-muted" />
                                </button>
                                <h3 className="text-xl font-black text-brand-text uppercase tracking-tight">Contestar Fechamento</h3>
                            </div>

                            <p className="text-xs text-brand-muted font-bold uppercase tracking-widest mb-2">Motivo da Contestação</p>
                            <textarea
                                value={contestReason}
                                onChange={(e) => setContestReason(e.target.value)}
                                className="w-full h-32 p-4 bg-brand-surface-2 dark:bg-slate-950 border border-brand-border dark:border-brand-border rounded-2xl text-sm font-medium outline-none focus:ring-2 focus:ring-red-500 mb-6"
                                placeholder="Descreva o erro encontrado..."
                            />

                            <div className="flex gap-3">
                                <button
                                    onClick={handleContest}
                                    disabled={isSubmitting}
                                    className="w-full py-3 bg-red-500 text-white rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-red-500/20 flex items-center justify-center gap-2"
                                >
                                    <MessageSquare size={16} /> Enviar Contestação
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default FinancialClosingModal;
