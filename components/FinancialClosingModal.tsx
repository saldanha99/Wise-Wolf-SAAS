import React, { useState, useEffect } from 'react';
import { X, CheckCircle2, AlertCircle, DollarSign, TrendingUp, MessageSquare } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { monthRange } from '../lib/dateUtils';
import { User } from '../types';

interface FinancialClosingModalProps {
    user: User;
    tenantId?: string;
    month: string; // YYYY-MM
    onClose: () => void;
    onSuccess: () => void;
}

const FinancialClosingModal: React.FC<FinancialClosingModalProps> = ({ user, month, onClose, onSuccess }) => {
    const [loading, setLoading] = useState(true);
    const [totalLessons, setTotalLessons] = useState(0);
    const [totalEarned, setTotalEarned] = useState(0);
    const [isContesting, setIsContesting] = useState(false);
    const [contestReason, setContestReason] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Não deixa o professor confirmar R$ 0,00 por falha de carregamento (era possível
    // fechar o mês inteiro com o valor errado sem nenhum aviso na tela).
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        fetchFinancialData();
    }, [user.id, month]);

    const fetchFinancialData = async () => {
        setLoading(true);
        setLoadError(null);
        try {
            // Fonte da verdade: MESMO RPC que o admin usa para pagar (tiers por aluno,
            // rate_override, aluno não-faturável fora, reposição paga). O cálculo local
            // que existia aqui divergia do valor pago e virava contestação.
            const { data: report, error: reportError } = await supabase.rpc('get_teacher_closing_report', {
                p_teacher_id: user.id,
                p_month: month,
            });

            const totalAulas = (report as any)?.resumo?.total_aulas;
            if (!reportError && totalAulas != null) {
                setTotalLessons(Number(totalAulas));
                setTotalEarned(Number((report as any).resumo.valor_total) || 0);
                return;
            }

            // Fallback (só se o relatório oficial falhar): contagem local pela regra canônica.
            // monthRange: janela [dia 1, dia 1 do mês seguinte) — o cálculo antigo com
            // new Date(month) cortava o ÚLTIMO dia do mês (as aulas do dia 31 sumiam do
            // fechamento) e em meses de 30 dias ainda puxava o dia 1º do mês seguinte.
            const { start, endExclusive } = monthRange(month);

            const { data: logs, error } = await supabase
                .from('class_logs')
                .select('id, created_at, class_date, presence, subtype, payment_hold')
                .eq('teacher_id', user.id)
                .gte('class_date', start)
                .lt('class_date', endExclusive);

            if (error) throw error;

            const { data: myPay } = await supabase.rpc('get_my_pay');
            const rate = Number((myPay as any)?.hourly_rate) || user.hourlyRate || 8.00;

            // Regra canônica de pagamento (idêntica a isLessonPaid / run_monthly_teacher_closing):
            // não paga só falta do PROFESSOR, Teste Oral e aula retida por conflito.
            const paidLessons = (logs || []).filter(l =>
                l.presence !== 'TEACHER_ABSENCE' &&
                l.presence !== 'Falta do Professor' &&
                l.subtype !== 'Teste Oral' &&
                l.payment_hold !== true
            );

            setTotalLessons(paidLessons.length);
            setTotalEarned(paidLessons.length * rate);

        } catch (err: any) {
            console.error('Error fetching modal data:', err);
            setLoadError(err?.message || 'Não foi possível carregar os valores do mês.');
        } finally {
            setLoading(false);
        }
    };

    // O tenant deixou de ser problema da tela: quem insere a linha agora é a RPC,
    // que lê o tenant do próprio perfil no servidor. Não há mais como o fechamento
    // quebrar com "null value in column tenant_id" por falha ao resolver o tenant.

    const handleConfirm = async () => {
        if (isSubmitting || loadError) return;
        setIsSubmitting(true);
        try {
            // Só o "confiro" vai para o servidor. O valor exibido aqui é uma conta
            // local (aulas × hourly_rate), que não conhece faixa por aluno, ajuste
            // nem carry-over — gravá-lo sobrescreveria a folha oficial com um número
            // menor. Quem calcula é a RPC, pela mesma regra do fechamento mensal.
            const { error } = await supabase.rpc('teacher_submit_closing', {
                p_month: month,
                p_confirmation: 'OK',
            });

            if (error) throw error;
            alert('Fechamento confirmado com sucesso!');
            onSuccess();
            onClose();
        } catch (err: any) {
            alert('Erro ao confirmar fechamento: ' + (err?.message || 'tente novamente.'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleContest = async () => {
        if (!contestReason.trim() || isSubmitting) return;
        setIsSubmitting(true);
        try {
            const { error } = await supabase.rpc('teacher_submit_closing', {
                p_month: month,
                p_confirmation: 'CONTESTADO',
                p_notes: contestReason,
            });

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
                                        <TrendingUp size={12} /> {totalLessons} Aulas
                                    </div>
                                </div>
                                <p className="text-4xl font-black text-brand-text tracking-tighter">R$ {totalEarned.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
                            </div>

                            {loadError && (
                                <div className="flex items-start gap-3 p-4 rounded-2xl bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-800/40 mb-6">
                                    <AlertCircle size={18} className="text-red-500 shrink-0 mt-0.5" />
                                    <p className="text-xs text-red-700 dark:text-red-300 font-medium leading-relaxed">
                                        Não conseguimos carregar seus valores deste mês, então a confirmação está bloqueada
                                        (confirmar agora registraria um valor errado). Recarregue a página e tente de novo —
                                        se persistir, avise a direção. Detalhe técnico: {loadError}
                                    </p>
                                </div>
                            )}

                            <div className="flex flex-col gap-3">
                                <button
                                    onClick={handleConfirm}
                                    disabled={isSubmitting || !!loadError}
                                    className="w-full py-4 bg-tenant-primary text-white rounded-xl font-black text-sm uppercase tracking-widest hover:scale-[1.02] active:scale-95 transition-all shadow-xl shadow-tenant-primary/20 flex items-center justify-center gap-2 disabled:opacity-50 disabled:hover:scale-100"
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
