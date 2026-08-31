
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
    ChevronDown,
    ChevronRight,
    ClipboardCheck,
    Loader2,
    MessageSquare,
    Pencil,
    RotateCcw,
    Check,
    X,
    FileDown
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { localMonth, monthRange } from '../lib/dateUtils';
import { User } from '../types';
import TeacherActivityReport from './TeacherActivityReport';
import TeacherPayrollReportModal from './TeacherPayrollReportModal';
import TeacherPayoutDetails from './TeacherPayoutDetails';
import NfIssuanceTour from './NfIssuanceTour';

// Linha do resumo por aluno (get_teacher_closing_report → students[]).
interface StudentRow {
    student_id: string | null;
    student: string;
    tipo: 'Regular' | 'Aula experimental';
    frequencia: string;
    duracao_min: number;
    aulas: number;
    faltas_aluno: number;
    valor_base: number;
    qtd_tarifas: number;
    valor: number;
    tem_ajuste: boolean;
    detalhe: { id: string; date: string; presence: string; subtype: string | null; valor: number; override: boolean }[];
}

interface TeacherFinancialsProps {
    user: User;
    tenantId?: string;
    viewOnly?: boolean;
    /** Diretor abrindo a ficha do professor: libera a edição de valor base e duração. */
    directorMode?: boolean;
}

const money = (v: number) => `R$ ${(Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const TeacherFinancials: React.FC<TeacherFinancialsProps> = ({ user, tenantId, viewOnly = false, directorMode = false }) => {
    const [loading, setLoading] = useState(true);
    const [selectedMonth, setSelectedMonth] = useState(localMonth());
    const [lessons, setLessons] = useState<any[]>([]);
    const [closing, setClosing] = useState<any>(null); // { status, admin_notes, id, total_value }
    const [isContesting, setIsContesting] = useState(false);
    const [contestReason, setContestReason] = useState('');
    const [isConfirming, setIsConfirming] = useState(false);
    const [showReport, setShowReport] = useState(false);
    const [showPayroll, setShowPayroll] = useState(false);
    // Relatório oficial do fechamento (get_teacher_closing_report) — MESMA fonte que o admin
    // usa no painel Pagamentos. Nenhum valor monetário é reconstruído no navegador.
    const [report, setReport] = useState<any>(null);
    const [reportError, setReportError] = useState<string | null>(null);
    // Resumo por aluno: linhas abertas e edição do diretor (valor base / duração).
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [editingRow, setEditingRow] = useState<string | null>(null);
    const [draftRate, setDraftRate] = useState('');
    const [draftDuration, setDraftDuration] = useState('');
    const [savingRow, setSavingRow] = useState<string | null>(null);
    const [rowError, setRowError] = useState<string | null>(null);
    // Cobertura: aula lançada por um professor que quem deu foi outro.
    const [transferLog, setTransferLog] = useState<{ id: string; date: string; student: string } | null>(null);
    const [transferTargets, setTransferTargets] = useState<{ id: string; full_name: string }[]>([]);
    const [transferTo, setTransferTo] = useState('');
    const [transferReason, setTransferReason] = useState('');
    const [transferring, setTransferring] = useState(false);
    // Ajustes do fechamento: acordos que não são aula (reserva de agenda, bônus,
    // desconto). Antes a direção editava valor de aula na mão para "encaixar".
    const [adjustments, setAdjustments] = useState<{ id: string; description: string; amount: number }[]>([]);
    const [adjOpen, setAdjOpen] = useState(false);
    const [adjDesc, setAdjDesc] = useState('');
    const [adjAmount, setAdjAmount] = useState('');
    const [adjSaving, setAdjSaving] = useState(false);

    useEffect(() => {
        fetchFinancials();
    }, [user.id, selectedMonth, tenantId]);

    // Lista de destinos só faz sentido para a direção.
    useEffect(() => {
        if (!directorMode) return;
        supabase.rpc('list_tenant_teachers_for_transfer').then(({ data }) => {
            setTransferTargets(((data as any[]) || []).filter(t => t.id !== user.id));
        });
    }, [directorMode, user.id]);

    const handleTransfer = async () => {
        if (!transferLog || !transferTo) return;
        setTransferring(true);
        setRowError(null);
        try {
            const { error } = await supabase.rpc('transfer_class_coverage', {
                p_log_id: transferLog.id,
                p_to_teacher: transferTo,
                p_reason: transferReason || null,
            });
            if (error) throw error;
            setTransferLog(null);
            setTransferTo('');
            setTransferReason('');
            await fetchFinancials();
        } catch (err: any) {
            setRowError(err.message || 'Não foi possível transferir a aula.');
        } finally {
            setTransferring(false);
        }
    };

    const fetchFinancials = async () => {
        setLoading(true);
        setReport(null);
        setReportError(null);
        setAdjustments([]);
        setClosing(null);
        try {
            // Janela [dia 1, dia 1 do mês seguinte). O cálculo antigo com new Date()+
            // setMonth() escorregava no fuso e trazia o dia 1º do mês SEGUINTE para dentro
            // da lista — a mesma aula aparecia em dois meses e não batia com o total oficial.
            const { start, endExclusive: end } = monthRange(selectedMonth);

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

            // Valores oficiais do mês (tiers, vínculos faturáveis e retenções no servidor).
            const { data: reportData, error: officialReportError } = await supabase.rpc('get_teacher_closing_report', {
                p_teacher_id: user.id,
                p_month: selectedMonth,
            });
            if (officialReportError) throw officialReportError;
            const officialSummary = (reportData as any)?.resumo;
            const rawOfficialTotal = officialSummary?.valor_total;
            const rawOfficialLessons = officialSummary?.total_aulas;
            const officialTotalValue = Number(rawOfficialTotal);
            const officialLessonCount = Number(rawOfficialLessons);
            if (
                !reportData ||
                rawOfficialTotal == null ||
                rawOfficialLessons == null ||
                !Number.isFinite(officialTotalValue) ||
                !Number.isFinite(officialLessonCount)
            ) {
                throw new Error('official_closing_report_invalid');
            }
            setReport(reportData);

            const { data: adj, error: adjustmentsError } = await supabase.rpc('teacher_closing_adjustments', {
                p_teacher_id: user.id, p_month: selectedMonth,
            });
            if (adjustmentsError) throw adjustmentsError;
            if (!Array.isArray(adj)) throw new Error('official_closing_adjustments_invalid');
            const officialAdjustments = adj.map(a => ({ ...a, amount: Number(a.amount) }));
            if (officialAdjustments.some((adjustment) => !Number.isFinite(adjustment.amount))) {
                throw new Error('official_closing_adjustments_invalid');
            }
            setAdjustments(officialAdjustments);

            // 2. Fetch Closing Status (schema unificado — month_year)
            const { data: closingData, error: closingError } = await supabase
                .from('teacher_closings')
                .select('*')
                .eq('teacher_id', user.id)
                .eq('month_year', selectedMonth)
                .maybeSingle();

            if (closingError) throw closingError;
            setClosing(closingData);

        } catch (error) {
            console.error('Error fetching authoritative teacher financials:', error);
            setReport(null);
            setAdjustments([]);
            setReportError('Não foi possível carregar o fechamento oficial deste mês. Nenhum valor estimado foi exibido.');
        } finally {
            setLoading(false);
        }
    };

    // Estes acessores só são alcançados depois da validação do relatório oficial.
    const officialTotal = (): number => {
        return Number(report.resumo.valor_total);
    };
    const officialLessons = (): number => {
        return Number(report.resumo.total_aulas);
    };
    // Resumo por aluno — é como a escola sempre conferiu a folha (e o que o
    // professor consegue ler). O extrato aula-a-aula vira o detalhe da linha.
    const studentRows: StudentRow[] = (report?.students || []) as StudentRow[];

    const rowKey = (row: StudentRow, idx: number) => `${row.student_id ?? 'sem-id'}:${row.tipo}:${idx}`;

    const toggleRow = (key: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });
    };

    const startEdit = (key: string, row: StudentRow) => {
        setRowError(null);
        setEditingRow(key);
        setDraftRate(String(row.valor_base ?? '').replace('.', ','));
        setDraftDuration(String(row.duracao_min ?? 30));
    };

    // Diretor ajusta o valor base e/ou a duração do aluno no MÊS INTEIRO.
    // A RPC revalida o papel no servidor — o flag directorMode é só de UI.
    const saveRow = async (row: StudentRow, clear = false) => {
        if (!row.student_id) {
            setRowError('Este lançamento não tem aluno vinculado — ajuste pelo detalhamento oficial.');
            return;
        }
        const key = editingRow || '';
        setSavingRow(key);
        setRowError(null);
        try {
            let rate: number | null = null;
            if (!clear) {
                rate = Number(draftRate.replace(',', '.'));
                if (!isFinite(rate) || rate < 0) throw new Error('Informe um valor válido (ex: 8 ou 8,50).');
            }
            const duration = Number(draftDuration);
            if (!clear && (!isFinite(duration) || duration <= 0)) throw new Error('Informe uma duração válida em minutos.');

            const { error } = await supabase.rpc('set_student_month_pay', {
                p_teacher_id: user.id,
                p_student_id: row.student_id,
                p_month: selectedMonth,
                p_rate: clear ? null : rate,
                p_duration_minutes: clear ? null : Math.round(duration),
                p_clear_rate: clear,
            });
            if (error) throw error;
            setEditingRow(null);
            await fetchFinancials();
        } catch (err: any) {
            setRowError(err.message || 'Não foi possível salvar.');
        } finally {
            setSavingRow(null);
        }
    };

    const adjustmentsTotal = adjustments.reduce((sum, a) => sum + a.amount, 0);
    const grandTotal = () => officialTotal() + adjustmentsTotal;

    const saveAdjustment = async (deleteId?: string) => {
        setAdjSaving(true);
        setRowError(null);
        try {
            if (!deleteId) {
                const value = Number(adjAmount.replace(',', '.'));
                if (!isFinite(value) || value === 0) throw new Error('Informe um valor (use - para desconto).');
                if (!adjDesc.trim()) throw new Error('Descreva o motivo do ajuste.');
                const { error } = await supabase.rpc('set_closing_adjustment', {
                    p_teacher_id: user.id, p_month: selectedMonth,
                    p_description: adjDesc.trim(), p_amount: value,
                });
                if (error) throw error;
            } else {
                const { error } = await supabase.rpc('set_closing_adjustment', {
                    p_teacher_id: user.id, p_month: selectedMonth,
                    p_description: '-', p_amount: 0, p_delete_id: deleteId,
                });
                if (error) throw error;
            }
            setAdjOpen(false); setAdjDesc(''); setAdjAmount('');
            await fetchFinancials();
        } catch (err: any) {
            setRowError(err.message || 'Não foi possível salvar o ajuste.');
        } finally {
            setAdjSaving(false);
        }
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
            // A confirmação NÃO carrega valor. O professor não escreve mais direto na
            // tabela (a RLS de UPDATE/INSERT dele foi revogada): a RPC grava só o
            // "confiro", e o total quem calcula é o servidor, pela mesma regra do
            // fechamento. Enquanto a tela mandava o número, o total gravado divergia
            // do oficial — julho da Lais foi R$ 632,00 gravado contra R$ 608,00 reais.
            const { error } = await supabase.rpc('teacher_submit_closing', {
                p_month: selectedMonth,
                p_confirmation: 'OK',
            });

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
            // Contestar é opinião sobre o número, não escrita do número (ver handleConfirm).
            const { error } = await supabase.rpc('teacher_submit_closing', {
                p_month: selectedMonth,
                p_confirmation: 'CONTESTADO',
                p_notes: contestReason,
            });

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

    const handleDownloadStatement = () => {
        const csvCell = (value: string | number) => {
            const text = String(value);
            const formulaSafe = /^[=+\-@]/.test(text) ? `'${text}` : text;
            return `"${formulaSafe.replace(/"/g, '""')}"`;
        };
        // Exporta o MESMO recorte da tela (por aluno) — é o formato que a escola
        // confere. O detalhe por data continua visível ao abrir a linha.
        const rows = studentRows.map((row) => [
            row.student,
            `${row.duracao_min} minutos`,
            row.aulas,
            Number(row.valor_base).toFixed(2).replace('.', ','),
            `${row.aulas} x ${Number(row.valor_base).toFixed(2).replace('.', ',')}`,
            Number(row.valor).toFixed(2).replace('.', ','),
        ]);
        const csv = [
            ['Aluno', 'Tempo', 'Qtd aulas', 'Valor base (R$)', 'Cálculo', 'Valor total (R$)'],
            ...rows,
            ['TOTAL', '', officialLessons(), '', '', officialTotal().toFixed(2).replace('.', ',')],
        ].map((row) => row.map(csvCell).join(';')).join('\r\n');
        const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `folha-por-aluno-${selectedMonth}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    if (loading) {
        return (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 text-brand-muted" role="status">
                <Loader2 className="animate-spin text-tenant-primary" size={30} />
                <p className="text-xs font-black uppercase tracking-widest">Carregando fechamento oficial...</p>
            </div>
        );
    }

    if (reportError || !report) {
        return (
            <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-[2rem] border border-red-200 bg-red-50/70 p-8 text-center dark:border-red-900/40 dark:bg-red-950/20" role="alert">
                <AlertCircle className="text-red-600" size={32} />
                <div>
                    <h2 className="text-xl font-black text-brand-text">Fechamento indisponível</h2>
                    <p className="mt-2 max-w-xl text-sm font-medium text-brand-muted">
                        {reportError || 'O servidor não retornou um fechamento financeiro válido.'}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => void fetchFinancials()}
                    className="inline-flex items-center gap-2 rounded-xl bg-tenant-primary px-5 py-3 text-xs font-black uppercase tracking-widest text-white"
                >
                    <RotateCcw size={15} /> Tentar novamente
                </button>
            </div>
        );
    }

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            {/* Pagamento autorizado e nota ainda não enviada: as instruções de
                emissão vêm antes do dinheiro. `viewOnly` é o diretor olhando a
                tela de um professor — nesse caso não há nada a instruir. */}
            {!viewOnly && <NfIssuanceTour />}
            {/* Month Selector code ... */}
            <div className="flex flex-col items-stretch justify-between gap-4 bg-brand-surface p-4 sm:p-6 rounded-[2rem] border border-brand-border shadow-sm sm:flex-row sm:items-center">
                <div className="min-w-0">
                    <h2 className="text-2xl font-black text-brand-text tracking-tight">Financeiro</h2>
                    <p className="text-brand-muted text-sm font-medium">Gerencie seus ganhos e fechamentos.</p>
                </div>
                <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
                    <button onClick={() => setShowReport(true)} className="flex w-full shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl bg-tenant-primary/10 px-3 py-2 text-xs font-bold text-tenant-primary sm:w-auto" title="Ver/baixar meu relatório de atividades (PDF)">
                        <FileDown size={14} /> Meu Relatório (PDF)
                    </button>
                    <div className="flex w-full items-center gap-2 sm:w-auto">
                        <Calendar size={18} className="shrink-0 text-brand-muted" aria-hidden="true" />
                        <input
                            type="month"
                            aria-label="Mês do fechamento"
                            value={selectedMonth}
                            onChange={(e) => setSelectedMonth(e.target.value)}
                            className="min-w-0 flex-1 rounded-xl border-none bg-brand-surface-2 px-4 py-2 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary dark:text-slate-300 sm:flex-none"
                        />
                    </div>
                </div>
            </div>
            {showReport && <TeacherActivityReport teacherId={user.id} onClose={() => setShowReport(false)} />}
            {showPayroll && <TeacherPayrollReportModal teacherId={user.id} month={selectedMonth} onClose={() => setShowPayroll(false)} />}

            {/* Forecast Card */}
            <div className="relative overflow-hidden rounded-[2.5rem] bg-indigo-700 bg-gradient-to-br from-indigo-500 to-purple-600 p-6 text-white shadow-xl shadow-indigo-500/20 sm:p-8">
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
                            R$ {officialTotal().toFixed(2).replace('.', ',')}
                        </span>
                        <span className="text-sm font-medium opacity-70">acumulado</span>
                    </div>

                    <button
                        onClick={() => setShowPayroll(true)}
                        className="mt-3 shrink-0 whitespace-nowrap rounded-lg bg-brand-surface/20 px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest transition-colors hover:bg-brand-surface/30"
                    >
                        Ver detalhamento oficial →
                    </button>

                    <div className="mt-4 flex flex-col gap-2 text-xs font-medium opacity-80 sm:flex-row sm:gap-4">
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
                    <div className={`${canCloseMonth() ? 'flex' : 'hidden'} relative flex-col items-stretch justify-between gap-6 overflow-hidden rounded-[2.5rem] bg-slate-900 p-6 text-white md:flex-row md:items-center md:p-8`}>
                        {/* Background Effect */}
                        <div className="absolute top-0 right-0 w-64 h-64 bg-tenant-primary/10 rounded-full blur-3xl -mr-32 -mt-32 pointer-events-none" />

                        <div className="min-w-0">
                            <h3 className="text-xl font-black tracking-tight relative z-10">
                                Finalizar Fechamento: R$ {officialTotal().toFixed(2).replace('.', ',')}
                            </h3>
                            <p className="relative z-10 mt-1 text-xs text-slate-300">
                                Referente a {new Date(selectedMonth + '-02').toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}. Confirme se os valores estão corretos.
                            </p>
                        </div>
                        <div className="relative z-10 flex w-full flex-col gap-3 sm:flex-row md:w-auto">
                            <button
                                onClick={() => setIsContesting(true)}
                                className="w-full shrink-0 whitespace-nowrap rounded-xl border border-slate-600 px-6 py-3 text-xs font-bold uppercase tracking-widest transition-colors hover:bg-slate-800 sm:w-auto"
                            >
                                Contestar Valor
                            </button>
                            <button
                                onClick={handleConfirm}
                                className="flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-blue-700 bg-tenant-primary px-8 py-3 text-xs font-black uppercase tracking-widest text-white shadow-xl shadow-tenant-primary/20 transition-all hover:scale-105 active:scale-95 sm:w-auto"
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
                    <div className="relative flex flex-col items-stretch justify-between gap-6 overflow-hidden rounded-[2.5rem] border border-red-100 bg-red-50 p-6 dark:border-red-900/30 dark:bg-red-900/10 md:flex-row md:items-center md:p-8">
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

                        <div className="relative z-10 flex w-full flex-col gap-3 sm:flex-row md:w-auto">
                            <button
                                onClick={() => window.open(`https://wa.me/5511999999999?text=Ol%C3%A1%2C%20gostaria%20de%20falar%20sobre%20meu%20fechamento%20de%20${selectedMonth}`, '_blank')}
                                className="w-full shrink-0 whitespace-nowrap rounded-xl border border-brand-border bg-brand-surface px-6 py-3 text-xs font-bold uppercase tracking-widest text-brand-text transition-colors hover:bg-brand-surface-2 dark:bg-brand-surface-2 dark:text-slate-200 dark:hover:bg-slate-700 sm:w-auto"
                            >
                                Falar com Suporte
                            </button>
                            <button
                                onClick={() => setIsContesting(true)}
                                className="flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-red-500 px-6 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-red-500/20 transition-colors hover:bg-red-600 sm:w-auto"
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

                            <div className="flex flex-col-reverse gap-3 sm:flex-row">
                                <button
                                    onClick={() => setIsContesting(false)}
                                    className="flex-1 shrink-0 whitespace-nowrap py-3 text-xs font-bold uppercase tracking-widest text-brand-muted"
                                >
                                    Cancelar
                                </button>
                                <button
                                    onClick={handleContest}
                                    className="flex-1 shrink-0 whitespace-nowrap rounded-xl bg-orange-500 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-orange-500/20"
                                >
                                    Enviar Contestação
                                </button>
                            </div>
                        </div>
                    </div>
                )
            }

            {/* Resumo por aluno — substitui o extrato aula-a-aula, que ficava com
                mais de 100 linhas e ninguém conseguia conferir. */}
            <div className="bg-brand-surface rounded-[2.5rem] border border-brand-border overflow-hidden shadow-sm">
                <div className="flex items-center justify-between border-b border-slate-50 p-5 dark:border-brand-border sm:p-8">
                    <div className="min-w-0">
                        <h3 className="font-black text-brand-text text-xs uppercase tracking-widest">Resumo por aluno</h3>
                        <p className="mt-1 text-xs font-medium text-brand-muted">
                            {directorMode
                                ? 'Clique no lápis para corrigir o valor base ou a duração do aluno no mês.'
                                : 'Toque na linha para ver as datas das aulas.'}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleDownloadStatement}
                        disabled={studentRows.length === 0}
                        aria-label="Baixar folha por aluno em CSV"
                        title={studentRows.length > 0 ? 'Baixar folha por aluno em CSV' : 'Nenhuma aula para exportar'}
                        className="rounded-lg bg-brand-surface-2 p-2 text-brand-muted transition-colors hover:text-tenant-primary disabled:cursor-not-allowed disabled:opacity-40"
                    >
                        <Download size={18} />
                    </button>
                </div>

                {rowError && (
                    <div className="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-red-700 sm:mx-8">
                        <AlertCircle size={15} className="mt-0.5 shrink-0" />
                        <p className="text-xs font-medium">{rowError}</p>
                    </div>
                )}

                {/* Mobile: um cartão por aluno */}
                <div className="space-y-3 p-4 md:hidden">
                    {studentRows.map((row, idx) => {
                        const key = rowKey(row, idx);
                        const isOpen = expanded.has(key);
                        return (
                            <article key={key} className="rounded-2xl border border-brand-border bg-brand-surface-2/50 p-4">
                                <button
                                    type="button"
                                    onClick={() => toggleRow(key)}
                                    className="flex w-full items-start justify-between gap-3 text-left"
                                >
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Aluno</p>
                                        <p className="mt-1 text-sm font-black uppercase text-brand-text">{row.student}</p>
                                    </div>
                                    <span className="mt-1 shrink-0 text-brand-muted">
                                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                                    </span>
                                </button>
                                <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-brand-border pt-4">
                                    <div>
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Tempo</dt>
                                        <dd className="mt-1 text-sm font-bold text-brand-text">{row.duracao_min} minutos</dd>
                                    </div>
                                    <div className="text-right">
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Qtd aulas</dt>
                                        <dd className="mt-1 text-sm font-bold text-brand-text">{row.aulas}</dd>
                                    </div>
                                    <div>
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Valor base</dt>
                                        <dd className="mt-1 text-sm font-bold text-brand-text">
                                            {money(row.valor_base)}
                                            {row.qtd_tarifas > 1 && <span className="ml-1 text-[10px] font-medium text-brand-muted">(média)</span>}
                                        </dd>
                                    </div>
                                    <div className="text-right">
                                        <dt className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Valor total</dt>
                                        <dd className="mt-1 text-sm font-black text-emerald-600 dark:text-emerald-400">{money(row.valor)}</dd>
                                        <dd className="mt-0.5 text-[10px] font-medium text-brand-muted">{row.aulas} × {money(row.valor_base)}</dd>
                                    </div>
                                </dl>
                                {directorMode && (
                                    <button
                                        type="button"
                                        onClick={() => startEdit(key, row)}
                                        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-surface px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-brand-text"
                                    >
                                        <Pencil size={12} /> Ajustar valor / duração
                                    </button>
                                )}
                                {isOpen && (
                                    <div className="mt-4 flex flex-col gap-1.5 border-t border-brand-border pt-4">
                                        {row.detalhe.map((d, i) => (
                                            <div key={d.id || i} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-[11px] font-bold ${d.presence === 'COMPLETED'
                                                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                                : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                                                <span>{new Date(`${d.date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span>
                                                <span>{money(d.valor)}{d.override ? ' ✎' : ''}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </article>
                        );
                    })}
                    {studentRows.length === 0 && (
                        <div className="flex flex-col items-center gap-3 py-12 text-center text-brand-muted">
                            <FileText size={40} className="opacity-20" />
                            <p className="text-sm font-bold uppercase tracking-widest">Nenhuma aula remunerada neste mês.</p>
                        </div>
                    )}
                </div>

                {/* Desktop: Aluno · Tempo · Qtd aulas · Valor base · Valor total */}
                <div className="hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[720px]">
                        <thead>
                            <tr className="bg-brand-surface-2/50 dark:bg-brand-surface-2/30">
                                <th className="px-8 py-4 text-left text-[10px] font-black text-brand-muted uppercase tracking-widest">Aluno</th>
                                <th className="px-6 py-4 text-left text-[10px] font-black text-brand-muted uppercase tracking-widest">Tempo</th>
                                <th className="px-6 py-4 text-center text-[10px] font-black text-brand-muted uppercase tracking-widest">Qtd aulas</th>
                                <th className="px-6 py-4 text-right text-[10px] font-black text-brand-muted uppercase tracking-widest">Valor base</th>
                                <th className="px-6 py-4 text-right text-[10px] font-black text-brand-muted uppercase tracking-widest">Cálculo</th>
                                <th className="px-8 py-4 text-right text-[10px] font-black text-brand-muted uppercase tracking-widest">Valor total</th>
                                {directorMode && <th className="px-6 py-4 text-right text-[10px] font-black text-brand-muted uppercase tracking-widest">Ajustar</th>}
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
                            {studentRows.map((row, idx) => {
                                const key = rowKey(row, idx);
                                const isOpen = expanded.has(key);
                                const isEditing = editingRow === key;
                                const isSaving = savingRow === key;
                                const colSpan = directorMode ? 7 : 6;
                                return (
                                    <React.Fragment key={key}>
                                        <tr
                                            onClick={() => !isEditing && toggleRow(key)}
                                            className="cursor-pointer transition-colors hover:bg-brand-surface-2/50 dark:hover:bg-brand-surface-2/50"
                                        >
                                            <td className="px-8 py-5">
                                                <span className="flex items-center gap-2">
                                                    <span className="shrink-0 text-brand-muted">
                                                        {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                                    </span>
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-black uppercase text-brand-text dark:text-slate-100">{row.student}</span>
                                                        {row.tipo === 'Aula experimental' && (
                                                            <span className="mt-1 inline-block whitespace-nowrap rounded-full border border-purple-200 bg-purple-100 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-purple-700">
                                                                Experimental
                                                            </span>
                                                        )}
                                                    </span>
                                                </span>
                                            </td>
                                            <td className="whitespace-nowrap px-6 py-5 text-sm font-bold uppercase text-brand-muted">
                                                {isEditing ? (
                                                    <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                                                        <input
                                                            type="text"
                                                            inputMode="numeric"
                                                            value={draftDuration}
                                                            onChange={(e) => setDraftDuration(e.target.value)}
                                                            aria-label={`Duração da aula de ${row.student} em minutos`}
                                                            className="w-16 rounded-md border border-brand-border bg-brand-surface px-2 py-1 text-right text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary"
                                                        />
                                                        <span className="text-xs">min</span>
                                                    </span>
                                                ) : (
                                                    `${row.duracao_min} minutos`
                                                )}
                                            </td>
                                            <td className="px-6 py-5 text-center text-sm font-bold text-brand-text dark:text-slate-300">{row.aulas}</td>
                                            <td className="px-6 py-5 text-right">
                                                {isEditing ? (
                                                    <span className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                                                        <span className="text-xs text-brand-muted">R$</span>
                                                        <input
                                                            type="text"
                                                            inputMode="decimal"
                                                            autoFocus
                                                            value={draftRate}
                                                            onChange={(e) => setDraftRate(e.target.value)}
                                                            onKeyDown={(e) => { if (e.key === 'Enter') saveRow(row); if (e.key === 'Escape') setEditingRow(null); }}
                                                            aria-label={`Valor base da aula de ${row.student}`}
                                                            className="w-20 rounded-md border border-brand-border bg-brand-surface px-2 py-1 text-right text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary"
                                                        />
                                                    </span>
                                                ) : (
                                                    <span className={`text-sm font-bold ${row.tem_ajuste ? 'text-tenant-primary' : 'text-brand-text dark:text-slate-300'}`}
                                                        title={row.tem_ajuste ? 'Valor ajustado manualmente pela direção' : undefined}>
                                                        {money(row.valor_base)}{row.tem_ajuste ? ' ✎' : ''}
                                                        {row.qtd_tarifas > 1 && (
                                                            <span className="ml-1 text-[10px] font-medium text-brand-muted">média</span>
                                                        )}
                                                    </span>
                                                )}
                                            </td>
                                            {/* Conferência: a conta que gera o valor, do jeito que a
                                                escola confere na planilha (14 × R$ 8,00). */}
                                            <td className="whitespace-nowrap px-6 py-5 text-right text-xs font-bold text-brand-muted">
                                                {row.aulas} × {money(row.valor_base)}
                                            </td>
                                            <td className="px-8 py-5 text-right text-sm font-black text-emerald-600 dark:text-emerald-400">
                                                {money(row.valor)}
                                            </td>
                                            {directorMode && (
                                                <td className="px-6 py-5 text-right" onClick={(e) => e.stopPropagation()}>
                                                    {isEditing ? (
                                                        <span className="flex items-center justify-end gap-1">
                                                            <button type="button" onClick={() => saveRow(row)} disabled={isSaving}
                                                                title="Salvar" aria-label="Salvar ajuste"
                                                                className="rounded-md p-1.5 text-emerald-600 hover:bg-emerald-100 disabled:opacity-50">
                                                                {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                                                            </button>
                                                            {row.tem_ajuste && (
                                                                <button type="button" onClick={() => saveRow(row, true)} disabled={isSaving}
                                                                    title="Voltar ao valor automático" aria-label="Voltar ao valor automático"
                                                                    className="rounded-md p-1.5 text-brand-muted hover:bg-brand-surface-2 disabled:opacity-50">
                                                                    <RotateCcw size={14} />
                                                                </button>
                                                            )}
                                                            <button type="button" onClick={() => setEditingRow(null)} disabled={isSaving}
                                                                title="Cancelar" aria-label="Cancelar edição"
                                                                className="rounded-md p-1.5 text-brand-muted hover:bg-brand-surface-2 disabled:opacity-50">
                                                                <X size={14} />
                                                            </button>
                                                        </span>
                                                    ) : (
                                                        <button type="button" onClick={() => startEdit(key, row)}
                                                            title="Ajustar valor base e duração deste aluno no mês"
                                                            aria-label={`Ajustar valores de ${row.student}`}
                                                            className="rounded-md p-1.5 text-brand-muted transition-colors hover:bg-tenant-primary/10 hover:text-tenant-primary">
                                                            <Pencil size={14} />
                                                        </button>
                                                    )}
                                                </td>
                                            )}
                                        </tr>
                                        {isOpen && (
                                            <tr className="bg-brand-surface-2/40">
                                                <td colSpan={colSpan} className="px-10 pb-5 pt-2">
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {row.detalhe.map((d, i) => (
                                                            <span key={d.id || i}
                                                                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] font-bold ${d.presence === 'COMPLETED'
                                                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                                                                    : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
                                                                {new Date(`${d.date}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                                                                {' · '}{money(d.valor)}{d.override ? ' ✎' : ''}
                                                                {/* Cobertura: se quem deu a aula foi outro professor, a aula
                                                                    (e o pagamento) muda de dono aqui mesmo. */}
                                                                {directorMode && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => setTransferLog({ id: d.id, date: d.date, student: row.student })}
                                                                        title="Esta aula foi dada por outro professor"
                                                                        aria-label={`Transferir a aula de ${row.student} em ${d.date} para outro professor`}
                                                                        className="rounded p-0.5 opacity-60 transition-opacity hover:bg-black/5 hover:opacity-100"
                                                                    >
                                                                        <ArrowRight size={12} />
                                                                    </button>
                                                                )}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </React.Fragment>
                                );
                            })}
                            {studentRows.length === 0 && (
                                <tr>
                                    <td colSpan={directorMode ? 7 : 6} className="px-8 py-20 text-center">
                                        <div className="flex flex-col items-center gap-3 text-brand-muted">
                                            <FileText size={48} className="opacity-20" />
                                            <p className="text-sm font-bold uppercase tracking-widest">Nenhuma aula remunerada neste mês.</p>
                                        </div>
                                    </td>
                                </tr>
                            )}
                        </tbody>
                        {studentRows.length > 0 && (
                            <tfoot>
                                <tr className="border-t-2 border-brand-border bg-brand-surface-2/60">
                                    <td className="px-8 py-5 text-xs font-black uppercase tracking-widest text-brand-muted">Total do mês</td>
                                    <td />
                                    <td className="px-6 py-5 text-center text-sm font-black text-brand-text">{officialLessons()}</td>
                                    <td />
                                    <td />
                                    <td className="px-8 py-5 text-right text-lg font-black tracking-tight text-tenant-primary">{money(officialTotal())}</td>
                                    {directorMode && <td />}
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
            </div>

            {/* Ajustes do fechamento — o que não é aula */}
            {(directorMode || adjustments.length > 0) && (
                <div className="overflow-hidden rounded-[2.5rem] border border-brand-border bg-brand-surface shadow-sm">
                    <div className="flex flex-col gap-3 border-b border-brand-border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-8">
                        <div className="min-w-0">
                            <h3 className="text-xs font-black uppercase tracking-widest text-brand-text">Ajustes do fechamento</h3>
                            <p className="mt-1 text-xs font-medium text-brand-muted">
                                Acordos que não são aula — reserva de agenda, bônus, desconto.
                            </p>
                        </div>
                        {directorMode && !adjOpen && (
                            <button
                                type="button"
                                onClick={() => setAdjOpen(true)}
                                className="shrink-0 whitespace-nowrap rounded-xl bg-tenant-primary/10 px-4 py-2 text-xs font-bold text-tenant-primary"
                            >
                                + Lançar ajuste
                            </button>
                        )}
                    </div>

                    {adjOpen && (
                        <div className="grid gap-3 border-b border-brand-border bg-brand-surface-2/40 p-5 sm:grid-cols-[1fr_auto_auto] sm:items-end sm:p-6">
                            <label className="block">
                                <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Motivo</span>
                                <input
                                    value={adjDesc}
                                    onChange={(e) => setAdjDesc(e.target.value)}
                                    list="ajuste-sugestoes"
                                    placeholder="Ex: Reserva de agenda — aluno começa depois"
                                    className="w-full rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-sm font-medium text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                                />
                                <datalist id="ajuste-sugestoes">
                                    <option value="Reserva de agenda" />
                                    <option value="Bônus acordado com a direção" />
                                    <option value="Desconto acordado" />
                                    <option value="Ajuste de fechamento anterior" />
                                </datalist>
                            </label>
                            <label className="block">
                                <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Valor (R$)</span>
                                <input
                                    value={adjAmount}
                                    onChange={(e) => setAdjAmount(e.target.value)}
                                    inputMode="decimal"
                                    placeholder="30,00"
                                    className="w-full rounded-xl border border-brand-border bg-brand-surface px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30 sm:w-32"
                                />
                            </label>
                            <div className="flex gap-2">
                                <button type="button" onClick={() => { setAdjOpen(false); setAdjDesc(''); setAdjAmount(''); }}
                                    className="shrink-0 rounded-xl px-4 py-3 text-xs font-bold uppercase tracking-widest text-brand-muted">
                                    Cancelar
                                </button>
                                <button type="button" onClick={() => saveAdjustment()} disabled={adjSaving}
                                    className="flex shrink-0 items-center gap-2 rounded-xl bg-tenant-primary px-5 py-3 text-xs font-black uppercase tracking-widest text-white disabled:opacity-50">
                                    {adjSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Lançar
                                </button>
                            </div>
                            <p className="text-[11px] font-medium text-brand-muted sm:col-span-3">
                                Use valor negativo para desconto. O ajuste aparece na folha do professor com o motivo escrito.
                            </p>
                        </div>
                    )}

                    {adjustments.length === 0 ? (
                        <p className="p-8 text-center text-xs font-bold uppercase tracking-widest text-brand-muted">
                            Nenhum ajuste neste mês.
                        </p>
                    ) : (
                        <ul className="divide-y divide-brand-border">
                            {adjustments.map(a => (
                                <li key={a.id} className="flex items-center justify-between gap-4 px-5 py-4 sm:px-8">
                                    <span className="min-w-0 text-sm font-bold text-brand-text">{a.description}</span>
                                    <span className="flex shrink-0 items-center gap-3">
                                        <span className={`text-sm font-black ${a.amount < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                            {a.amount < 0 ? '- ' : '+ '}{money(Math.abs(a.amount))}
                                        </span>
                                        {directorMode && (
                                            <button type="button" onClick={() => saveAdjustment(a.id)} disabled={adjSaving}
                                                aria-label={`Remover ajuste ${a.description}`}
                                                className="rounded-md p-1.5 text-brand-muted hover:bg-red-50 hover:text-red-500">
                                                <X size={14} />
                                            </button>
                                        )}
                                    </span>
                                </li>
                            ))}
                            <li className="flex items-center justify-between gap-4 bg-brand-surface-2/60 px-5 py-5 sm:px-8">
                                <span className="text-xs font-black uppercase tracking-widest text-brand-muted">Total a receber</span>
                                <span className="text-xl font-black tracking-tight text-tenant-primary">{money(grandTotal())}</span>
                            </li>
                        </ul>
                    )}
                </div>
            )}

            {/* Cobertura: mover a aula (e o pagamento) para quem realmente deu */}
            {transferLog && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
                    <div className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-[2rem] border border-brand-border bg-brand-surface p-6 shadow-2xl sm:p-8">
                        <h3 className="text-lg font-black uppercase tracking-tight text-brand-text">Quem deu esta aula?</h3>
                        <p className="mt-1 text-sm font-medium text-brand-muted">
                            {transferLog.student} · {new Date(`${transferLog.date}T12:00:00`).toLocaleDateString('pt-BR')}
                        </p>
                        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-800">
                            A aula sai da folha deste professor e entra na de quem você escolher. O valor vai junto.
                        </p>

                        <label className="mt-5 block">
                            <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Professor que cobriu</span>
                            <select
                                value={transferTo}
                                onChange={(e) => setTransferTo(e.target.value)}
                                className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-bold text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                            >
                                <option value="">Selecione…</option>
                                {transferTargets.map(t => <option key={t.id} value={t.id}>{t.full_name}</option>)}
                            </select>
                        </label>

                        <label className="mt-4 block">
                            <span className="mb-1.5 block text-[10px] font-black uppercase tracking-widest text-brand-muted">Motivo (opcional)</span>
                            <input
                                value={transferReason}
                                onChange={(e) => setTransferReason(e.target.value)}
                                placeholder="Ex: professor passou mal, cobertura de última hora"
                                className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-4 py-3 text-sm font-medium text-brand-text outline-none focus:ring-2 focus:ring-tenant-primary/30"
                            />
                        </label>

                        <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                            <button
                                type="button"
                                onClick={() => { setTransferLog(null); setTransferTo(''); setTransferReason(''); }}
                                disabled={transferring}
                                className="shrink-0 whitespace-nowrap rounded-xl px-5 py-3 text-xs font-bold uppercase tracking-widest text-brand-muted"
                            >
                                Cancelar
                            </button>
                            <button
                                type="button"
                                onClick={handleTransfer}
                                disabled={transferring || !transferTo}
                                className="flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-tenant-primary px-6 py-3 text-xs font-black uppercase tracking-widest text-white shadow-lg shadow-tenant-primary/20 disabled:opacity-50"
                            >
                                {transferring ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                                {transferring ? 'Transferindo…' : 'Transferir aula'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Dados de recebimento + nota fiscal, na mesma tela (antes eram outras duas). */}
            <TeacherPayoutDetails
                teacherId={user.id}
                teacherName={(user as any).full_name || user.name}
                tenantId={tenantId}
                month={selectedMonth}
                canEdit={!viewOnly && !directorMode}
                onChanged={fetchFinancials}
            />
        </div>
    );
};

export default TeacherFinancials;
