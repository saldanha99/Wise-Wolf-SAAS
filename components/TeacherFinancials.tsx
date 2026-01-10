
import React, { useState, useEffect } from 'react';
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
}

const TeacherFinancials: React.FC<TeacherFinancialsProps> = ({ user, tenantId }) => {
    const [loading, setLoading] = useState(true);
    const [lessons, setLessons] = useState<any[]>([]);
    const [closing, setClosing] = useState<any>(null);
    const [selectedMonth, setSelectedMonth] = useState(new Date().toISOString().substring(0, 7)); // YYYY-MM
    const [isContesting, setIsContesting] = useState(false);
    const [contestReason, setContestReason] = useState('');

    const fetchFinancialData = async () => {
        setLoading(true);
        try {
            const startOfMonth = `${selectedMonth}-01T00:00:00Z`;
            const nextMonth = new Date(selectedMonth);
            nextMonth.setMonth(nextMonth.getMonth() + 1);
            const endOfMonth = nextMonth.toISOString();

            // 1. Fetch Class Logs for the month
            // We now filter by class_date if possible, but for range we use created_at OR class_date to catch all.
            // Ideally should filter by class_date range.
            const { data: logs, error: logsError } = await supabase
                .from('class_logs')
                .select(`
          id, 
          created_at,
          class_date,
          presence, 
          subtype,
          student:student_id(full_name),
          content
        `)
                .eq('teacher_id', user.id)
                .gte('class_date', startOfMonth) // Filter by class_date range
                .lt('class_date', endOfMonth);

            if (logsError) throw logsError;

            // Filter paid classes 
            // Teacher ONLY loses pay if HE/SHE missed ("Falta do Professor")
            // Makeups (reposições) are NOT paid again because the original missed class was already paid.
            const paidLessons = (logs || []).filter(l =>
                l.presence !== 'Falta do Professor' &&
                l.subtype !== 'REPOSIÇÃO'
            );
            setLessons(paidLessons);

            // 2. Fetch Closing Status
            const { data: closingData } = await supabase
                .from('teacher_closings')
                .select('*')
                .eq('teacher_id', user.id)
                .eq('month_year', selectedMonth)
                .maybeSingle();

            setClosing(closingData);

        } catch (err) {
            console.error('Error fetching financial data:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (user.id) fetchFinancialData();
    }, [user.id, selectedMonth]);

    const handleConfirm = async () => {
        try {
            const totalAmount = lessons.length * (user.hourlyRate || 7.50);

            const { error } = await supabase
                .from('teacher_closings')
                .upsert({
                    teacher_id: user.id,
                    tenant_id: tenantId,
                    month_year: selectedMonth,
                    total_lessons: lessons.length,
                    total_amount: totalAmount,
                    status: 'CONFIRMADO',
                    updated_at: new Date().toISOString()
                });

            if (error) throw error;
            alert('Relatório confirmado com sucesso!');
            fetchFinancialData();
        } catch (err) {
            alert('Erro ao confirmar fechamento.');
        }
    };

    const handleContest = async () => {
        if (!contestReason.trim()) return;
        try {
            const totalAmount = lessons.length * (user.hourlyRate || 0);

            let query;
            const payload = {
                teacher_id: user.id,
                tenant_id: tenantId || user.tenantId, // Ensure tenantId is present
                month_year: selectedMonth,
                total_lessons: lessons.length,
                total_amount: totalAmount,
                status: 'CONTESTADO',
                teacher_notes: contestReason,
                updated_at: new Date().toISOString()
            };

            if (closing?.id) {
                // Update existing
                query = supabase
                    .from('teacher_closings')
                    .update(payload)
                    .eq('id', closing.id);
            } else {
                // Insert new (Upsert logic fallback)
                query = supabase
                    .from('teacher_closings')
                    .upsert(payload, { onConflict: 'teacher_id, month_year' });
            }

            const { error } = await query;

            if (error) throw error;
            alert('Contestação enviada para análise.');
            setIsContesting(false);
            fetchFinancialData();
        } catch (err: any) {
            console.error('Contest Error:', err);
            alert(`Erro ao enviar contestação: ${err.message || 'Erro desconhecido'}`);
        }
    };

    const totalEarned = (lessons || []).reduce((acc, log) => {
        if (log.presence === 'Falta do Professor' || log.subtype === 'REPOSIÇÃO') return acc;
        return acc + (user.hourlyRate || 7.50);
    }, 0);

    return (
        <div className="space-y-8 animate-in fade-in duration-700">
            {(!user.hourlyRate) && (
                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800 p-4 rounded-2xl flex items-center gap-3 text-amber-700 dark:text-amber-400">
                    <AlertCircle size={20} />
                    <p className="text-xs font-bold uppercase tracking-wide">Aviso: Seu valor de hora não está configurado. Entre em contato com a administração.</p>
                </div>
            )}

            <header className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div>
                    <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tight">Cofre do Professor</h2>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">Gestão de remuneração e fechamento mensal.</p>
                </div>

                <div className="flex items-center gap-3">
                    <input
                        type="month"
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(e.target.value)}
                        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-tenant-primary"
                    />
                </div>
            </header>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-3xl -mr-16 -mt-16 group-hover:bg-emerald-500/10 transition-colors" />
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Total a Receber</p>
                    <p className="text-4xl font-black text-emerald-600 dark:text-emerald-400">R$ {totalEarned.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                    <div className="mt-4 flex items-center gap-2 text-[10px] font-bold text-emerald-600/60 bg-emerald-50 dark:bg-emerald-900/20 px-3 py-1 rounded-full w-fit">
                        <TrendingUp size={12} /> {lessons.length} Aulas remuneradas
                    </div>
                </div>

                <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden group">
                    <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 rounded-full blur-3xl -mr-16 -mt-16 group-hover:bg-blue-500/10 transition-colors" />
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Valor da Aula</p>
                    <p className="text-4xl font-black text-slate-800 dark:text-white">R$ {(user.hourlyRate || 7.50).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                    <p className="mt-4 text-[10px] font-bold text-slate-400">Contrato: Wise Wolf Professional</p>
                </div>

                <div className="bg-white dark:bg-slate-900 p-8 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 shadow-sm relative overflow-hidden">
                    <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Status do Fechamento</p>
                    <div className="flex items-center gap-3">
                        <div className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest ${closing?.status === 'CONFIRMADO' ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600' :
                            closing?.status === 'CONTESTADO' ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-600' :
                                closing?.status === 'PAGO' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' :
                                    closing?.status === 'AGUARDANDO_PAGAMENTO' ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-600' :
                                        'bg-slate-50 dark:bg-slate-800 text-slate-500'
                            }`}>
                            {closing?.status === 'AGUARDANDO_PAGAMENTO' ? 'APROVADO - AGUARDANDO PAGAMENTO' : (closing?.status || 'AGUARDANDO/PENDENTE')}
                        </div>
                        {closing?.status === 'CONFIRMADO' && <CheckCircle2 className="text-emerald-500" size={20} />}
                        {closing?.status === 'AGUARDANDO_PAGAMENTO' && <CheckCircle2 className="text-amber-500" size={20} />}
                        {closing?.status === 'PAGO' && <CheckCircle2 className="text-blue-500" size={20} />}
                    </div>
                    <p className="mt-4 text-[10px] font-bold text-slate-400">
                        {closing?.status === 'PAGO' ? 'Pagamento efetuado! Recibo disponível.' :
                            closing?.status === 'AGUARDANDO_PAGAMENTO' ? 'Sua NF foi aprovada. O pagamento será processado em breve.' :
                                'Pagamento até o 6º dia útil.'}
                    </p>

                    {(closing?.status === 'CONFIRMADO' || closing?.status === 'REJEITADO' || closing?.status === 'PAGO' || closing?.status === 'EM ANÁLISE' || closing?.status === 'AGUARDANDO_PAGAMENTO') && (
                        <button
                            onClick={() => window.location.hash = 'invoices'}
                            className={`mt-4 w-full py-3 text-[10px] font-black uppercase tracking-widest rounded-lg transition-colors flex items-center justify-center gap-2 ${closing?.status === 'CONFIRMADO' || closing?.status === 'REJEITADO'
                                ? 'bg-tenant-primary text-white hover:bg-tenant-primary/90 shadow-lg shadow-tenant-primary/20 animate-pulse'
                                : closing?.status === 'PAGO'
                                    ? 'bg-blue-500 text-white hover:bg-blue-600 shadow-lg shadow-blue-500/20'
                                    : 'bg-slate-50 dark:bg-slate-800 text-tenant-primary hover:bg-slate-100'
                                }`}
                        >
                            <FileText size={12} />
                            {closing?.status === 'CONFIRMADO' ? '⚠️ Pendente: Anexar Nota Fiscal' :
                                closing?.status === 'REJEITADO' ? '⚠️ Reenviar Nota Fiscal' :
                                    closing?.status === 'PAGO' ? 'Visualizar Recibo e NFs' :
                                        'Ver Notas Fiscais'}
                        </button>
                    )}
                </div>
            </div>

            {/* Action Bar */}
            {(!closing || closing.status === 'PENDENTE') && (
                <div className="bg-slate-900 p-8 rounded-[2.5rem] text-white flex flex-col md:flex-row justify-between items-center gap-6">
                    <div>
                        <h3 className="text-xl font-black tracking-tight">Finalizar Fechamento de {new Date(selectedMonth + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}?</h3>
                        <p className="text-slate-400 text-xs mt-1">Confirme se todos os lançamentos estão corretos antes do envio da NF.</p>
                    </div>
                    <div className="flex gap-4">
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
            )}

            {/* Rejection Action Bar */}
            {closing?.status === 'REJEITADO' && (
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
            )}

            {/* Contest Modal */}
            {isContesting && (
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
            )}

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
                                        <div className={`inline-block px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${log.presence === 'Falta do Professor' ? 'bg-red-50 dark:bg-red-900/20 text-red-600' :
                                            log.subtype === 'REPOSIÇÃO' ? 'bg-purple-50 dark:bg-purple-900/20 text-purple-600' :
                                                log.presence === 'Falta' ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-600' :
                                                    log.presence === 'Falta Justificada' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600' :
                                                        'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600'
                                            }`}>
                                            {log.subtype === 'REPOSIÇÃO' ? 'Reposição' : log.presence}
                                        </div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className={`text-sm font-black ${(log.presence === 'Falta do Professor' || log.subtype === 'REPOSIÇÃO')
                                            ? 'text-slate-300 dark:text-slate-600 line-through'
                                            : 'text-emerald-600 dark:text-emerald-400'
                                            }`}>
                                            R$ {(log.presence === 'Falta do Professor' || log.subtype === 'REPOSIÇÃO') ? '0,00' : (user.hourlyRate || 7.50).toFixed(2)}
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
